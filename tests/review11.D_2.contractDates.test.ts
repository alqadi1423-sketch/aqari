/**
 * المراجعة ١١ · تدقيق إصلاح D-2 · العقد: الحارس الأخير لا يبلغ تاريخ بداية العقد ولا تاريخ إلغائه
 *
 * المهمة: «Validate ... in the domain (... e.g. src/domain/contracts/service.ts) so no path accepts a non YYYY-MM-DD real
 * calendar date». والإصلاح وضع requireISODate في postEntry وrequireOpenPeriod وموضع isFiledDate، ولم يبلغ مسارين في الملف نفسه
 * يحملان تاريخاً من حقل التاريخ نفسه (DateField) ولا يمرّان بأيٍّ منها:
 *
 *  ١) confirmContract بـstart «2026-1-15»: validateConfirmedContract يفحص الحضور وحده، وتاريخ قيد التأمين correctionDate يحوّل
 *     المعيب إلى «اليوم» بصمت، فيُنشأ العقد بلا قسطٍ واحد (generateInstallments لا يعرف التاريخ) وبرقم «EJ-NaN-001»، ويُرحَّل
 *     قيد التأمين بتاريخ اليوم لا بتاريخ العقد.
 *  ٢) cancelContract بتاريخ «2026-3-15» وبلا تسوية: لا قيد ولا requireOpenPeriod، فيُلغى العقد بتاريخٍ معيب، و«الأقساط بعد تاريخ
 *     الإلغاء تُلغى» بمقارنةٍ حرفية (due_date >= '2026-3-15') لا يقع فيها أي قسطٍ من 2026، فيبقى المستأجر مَديناً بأقساطٍ بعد
 *     إلغاء عقده.
 *
 * السلوك الصحيح: الدومين يرفض التاريخ المعيب في المسارين برسالة (كما يرفضه في الدفعة) ولا يكتب شيئاً، والصحيح يمرّ كما كان.
 * بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, cancelContract } from '@/domain/contracts/service';
import type { DB } from '@/db/adapter';

const count = (db: DB, sql: string, p: string[] = []) => Number(db.get<{ n: number }>(sql, p)!.n);

test('D-2 العقد: تأكيد عقدٍ ببداية «2026-1-15» يُرفض ولا يُكتب عقدٌ ولا قيد تأمين', () => {
  const db = memDb();
  const unit = addUnit(db, addProperty(db, { name: 'عقار عقدٍ مصطنع' }));
  expect(() => confirmContract(db, contractInput(unit, { tenant: 'مستأجر عقدٍ مصطنع', idNumber: '1000000931', phone: '0500000931',
    start: '2026-1-15', end: '2026-12-31', valueHalalas: 1200000, depositHalalas: 100000 }))).toThrow();
  expect(count(db, `SELECT COUNT(*) AS n FROM contracts WHERE status != 'مسودة'`)).toBe(0);
  expect(count(db, `SELECT COUNT(*) AS n FROM journal_entries`)).toBe(0);
  db.close();
});

test('D-2 العقد: إلغاء عقدٍ بتاريخ «2026-3-15» يُرفض، وبالتاريخ الصحيح «2026-03-15» تُلغى أقساطه التسعة الباقية', () => {
  const db = memDb();
  const unit = addUnit(db, addProperty(db, { name: 'عقار إلغاءٍ مصطنع' }));
  // ١٢٬٠٠٠ ريال سنوياً شهرياً: ١٢ قسطاً كل منها ١٬٠٠٠ ريال (١٠٠٬٠٠٠ هللة) أول كل شهر من 2026-01-01
  const cid = confirmContract(db, contractInput(unit, { tenant: 'مستأجر إلغاءٍ مصطنع', idNumber: '1000000932', phone: '0500000932',
    start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, depositHalalas: 0 }));
  const cancel = (date: string) => cancelContract(db, cid, { date, reason: 'إلغاء مصطنع', installmentsFate: 'cancel', settle: false,
    deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });
  expect(() => cancel('2026-3-15')).toThrow();
  expect(db.get<{ s: string }>(`SELECT status AS s FROM contracts WHERE id = ?`, [cid])!.s).not.toBe('ملغى');
  // الضابط: بالتاريخ الصحيح تُلغى أقساط أبريل إلى ديسمبر: ٩ أقساط · ٩ × ١٠٠٬٠٠٠ = ٩٠٠٬٠٠٠ هللة
  cancel('2026-03-15');
  const off = db.get<{ n: number; s: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_halalas), 0) AS s FROM contract_installments WHERE contract_id = ? AND status = 'ملغية'`, [cid])!;
  expect(Number(off.n)).toBe(9);
  expect(Number(off.s)).toBe(900000);
  db.close();
});

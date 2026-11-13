/**
 * المراجعة ١١ · تدقيق إصلاح D-2 · البيانات القائمة: ما كتبه الحقل القديم بتاريخٍ بغير صيغته صار لا يُلغى ولا يُعكس
 *
 * قبل الإصلاح كان حقل التاريخ يمرّر المكتوب كما هو، فعند المستخدمين دفعاتٌ وقيودٌ بتواريخ مثل «2026-3-15» و«2026-02-31»
 * (التقرير نفسه، D-2: «والكتابة اليدوية تقبل أيضاً «2026-11» و«2026-02-31»»، والخطة البند ٣: فحصها واقتراح تصحيحها). والإصلاح
 * أضاف الحارس requireISODate في postEntry، فصار كل قيد تصحيحٍ يُكتب بتاريخ الأصل المعيب يُرفض، ولا طريق غيره لإزالة أثره:
 *
 *  ١) إلغاء دفعة إيجار بتاريخ «2026-3-15»: تاريخ الإلغاء الافتراضي defaultDateOf يقارن «2026-3-15» باليوم حرفاً حرفاً فيراه
 *     أكبر (الحرف «3» بعد «1»)، فيكون تاريخ الإلغاء «2026-3-15» نفسه فيرفضه postEntry («التاريخ «2026-3-15» غير صحيح» ولم
 *     يكتب المستخدم شيئاً). وإن اختار تاريخاً صحيحاً كاليوم رفضه cancelDateError («تاريخ الإلغاء قبل تاريخ الدفعة»)، لأن كل تاريخٍ
 *     صحيح في 2026 أصغر حرفياً من «2026-3-15». فالدفعة لا تُلغى بأي تاريخٍ في سنتها (src/domain/contracts/cancelPayment.ts).
 *  ٢) عكس قيدٍ يدوي بتاريخ «2026-02-31» من شاشة الدفتر: correctionDate يقبل «\d{4}-\d{2}-\d{2}» فيعيد «2026-02-31» تاريخاً
 *     للعاكس، فيرفضه postEntry (src/domain/vatFilings.ts:85). وكذلك كل عكسٍ أو إعادة ترحيلٍ تمرّ بـcorrectionDate.
 *
 *  ٣) والخطة نفسها (D-2 · الإصلاح ٣) تطلب فحصاً لهذه الصفوف في «فحص المطابقة» مع اقتراح تصحيحها، ولم يُضَف: integrityChecks
 *     تعدّ الدفترَ سليماً وفيه قيدٌ ودفعةٌ بتاريخٍ لا يقع في شهرٍ ولا ربع.
 *
 * السلوك الصحيح: القيد أو الدفعة بتاريخٍ معيبٍ قائمٍ من قبل يُلغى ويُعكس بقيد تصحيحٍ بتاريخٍ صحيح (اليوم في فترةٍ مفتوحة، كما
 * يفعل correctionDate اليوم مع «2026-1-15»)، ولا يُكتب العاكس بالتاريخ المعيب، ويرجع المال كما دخل · ويُظهره «فحص المطابقة».
 * بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { postManualEntry } from '@/domain/accounting/post';
import { reverseFromJournal } from '@/domain/accounting/journalReversal';
import { isISODate } from '@/domain/dates';
import { integrityChecks } from '@/domain/accounting/integrity';
import type { DB } from '@/db/adapter';

/** ما كتبه الإصدار السابق: تاريخ القيد المرحّل كما مرّ من الحقل (المحفّز يجمّد رأس القيد فيُرفع لحظة الكتابة ثم يعود) */
function legacyEntryDate(db: DB, entryId: string, date: string) {
  const sql = db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'trg_je_frozen_hdr'`)!.sql;
  db.exec('DROP TRIGGER trg_je_frozen_hdr');
  db.run(`UPDATE journal_entries SET date = ? WHERE id = ?`, [date, entryId]);
  db.exec(sql);
}
const cashNet = (db: DB, where: string, params: string[]) => Number(db.get<{ n: number }>(
  `SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas), 0) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
   WHERE e.status = 'مرحّل' AND l.account_code = '1100' AND ${where}`, params)!.n);

beforeEach(() => { jest.useFakeTimers({ now: new Date('2026-11-13T09:00:00Z') }); });
afterEach(() => { jest.useRealTimers(); });

test('D-2 قائم: دفعة إيجار سجّلها الحقل القديم بتاريخ «2026-3-15» تُلغى بتاريخ الإلغاء الافتراضي، وعاكسها بتاريخٍ صحيح', () => {
  const db = memDb();
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار قائم مصطنع' })),
    { tenant: 'مستأجر قائم مصطنع', idNumber: '1000000921', phone: '0500000921', depositHalalas: 0,
      start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000 }));
  const inst = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  const pid = recordRentPayment(db, cid, { installmentId: inst.id, period: 'مارس', date: '2026-03-15',
    lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  const je = db.get<{ j: string }>(`SELECT journal_entry_id AS j FROM contract_payments WHERE id = ?`, [pid])!.j;
  // كما كتبها الإصدار السابق: الدفعة وقيدها بالتاريخ المكتوب يدوياً
  db.run(`UPDATE contract_payments SET date = '2026-3-15' WHERE id = ?`, [pid]);
  legacyEntryDate(db, je, '2026-3-15');
  // ٥٠٠ ريال نقداً دخلت المحفظة بقيدها
  expect(cashNet(db, 'e.id = ?', [je])).toBe(50000);

  expect(() => cancelPayment(db, pid, { reason: 'تصحيح دفعةٍ بتاريخٍ معيب' })).not.toThrow();
  const p = db.get<{ c: string | null; ce: string | null }>(`SELECT cancelled_at AS c, cancel_entry_id AS ce FROM contract_payments WHERE id = ?`, [pid])!;
  expect(p.c).not.toBeNull();
  expect(isISODate(p.c)).toBe(true);
  const rev = db.get<{ date: string }>(`SELECT date FROM journal_entries WHERE id = ?`, [p.ce ?? ''])!;
  expect(isISODate(rev.date)).toBe(true);
  // العاكس يُخرج الـ٥٠٠ ريال نفسها: ٥٠٬٠٠٠ − ٥٠٬٠٠٠ = ٠
  expect(cashNet(db, '(e.id = ? OR e.id = ?)', [je, p.ce!])).toBe(0);
  db.close();
});

test('D-2 قائم: قيدٌ يدوي بتاريخ «2026-02-31» من الحقل القديم يُعكس من الدفتر بقيد تصحيحٍ بتاريخٍ صحيح', () => {
  const db = memDb();
  // ١٠٠ ريال إيداع مالك نقداً: مدين 1100 / دائن 3100
  const e = postManualEntry(db, { date: '2026-02-28', memo: 'قيد يدوي مصطنع قائم',
    lines: [{ account: '1100', debit: 10000, credit: 0 }, { account: '3100', debit: 0, credit: 10000 }] })!;
  legacyEntryDate(db, e.id, '2026-02-31');

  let rev: { id: string } | null = null;
  expect(() => { rev = reverseFromJournal(db, e.id); }).not.toThrow();
  expect(rev).not.toBeNull();
  const d = db.get<{ date: string }>(`SELECT date FROM journal_entries WHERE id = ?`, [rev!.id])!.date;
  expect(isISODate(d)).toBe(true);
  // ١٠٬٠٠٠ − ١٠٬٠٠٠ = ٠ هللة في النقدية بعد العكس
  expect(cashNet(db, '(e.id = ? OR e.id = ?)', [e.id, rev!.id])).toBe(0);
  db.close();
});

test('D-2 قائم: «فحص المطابقة» يُظهر دفعةً وقيدها بتاريخ «2026-3-15» (خطة D-2 · الإصلاح ٣)', () => {
  const db = memDb();
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار فحصٍ مصطنع' })),
    { tenant: 'مستأجر فحصٍ مصطنع', idNumber: '1000000922', phone: '0500000922', depositHalalas: 0,
      start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000 }));
  const inst = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  const pid = recordRentPayment(db, cid, { installmentId: inst.id, period: 'مارس', date: '2026-03-15',
    lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  // الضابط: الدفتر سليم قبل التاريخ المعيب
  expect(integrityChecks(db).filter((c) => !c.ok)).toEqual([]);
  const je = db.get<{ j: string }>(`SELECT journal_entry_id AS j FROM contract_payments WHERE id = ?`, [pid])!.j;
  db.run(`UPDATE contract_payments SET date = '2026-3-15' WHERE id = ?`, [pid]);
  legacyEntryDate(db, je, '2026-3-15');
  expect(integrityChecks(db).filter((c) => !c.ok).length).toBeGreaterThan(0);
  db.close();
});

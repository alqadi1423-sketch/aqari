/**
 * المراجعة ١٢ · مدقق المرحلة ١ المستقل · الاستعادة · A1-2 (fb0ee46) مع ضمّ المرحّل (keepPosted · C-1) · متوسط
 * src/domain/backup/keepPosted.ts:158 (دفعة «من التأمين» تُحمل متى وُجد في النسخة أيُّ صفّ تسويةٍ لعقدها)
 *
 * السيناريو (بيانات مصطنعة): عقد ثلاثة أشهر بأقساط ١٬٠٠٠٫٠٠ وتأمين ١٬٠٠٠٫٠٠ لدى المكتب · سُدّد يناير وفبراير نقداً.
 *  ١) تسوية التأمين في 2026-04-05: خصم ٥٠٠٫٠٠ أضراراً وردّ ٥٠٠٫٠٠ نقداً · ثم نسخة احتياطية.
 *  ٢) يعدّل المالك التسوية: التأمين كله ١٬٠٠٠٫٠٠ «منها مقابل أقساطٍ متأخرة» عن مارس، ولا ردّ (A1-2) · فتُعكس قيود الخصم والرد السابقة
 *     ويُسدَّد قسط مارس بدفعة «من التأمين» وقيدها deposit_rent · وكل الفحوص خضراء.
 *  ٣) يستعيد النسخة.
 * النتيجة الفعلية: planKeepPosted يضمّ عاكسَي الخصم والرد ويُدرجهما في المراجعة («مستنده في النسخة بحاله قبل العكس») فيخرج أثرهما من
 * المطابقة · ويحمل دفعة «من التأمين» وقيدها بلا مراجعة لأن في النسخة صفّ تسويةٍ للعقد، وهو صفّ التسوية القديمة (خصم ٥٠٠ ورد ٥٠٠) ·
 * فبعد الاستعادة:
 *  - مستندات العقد تقول إن التأمين (١٬٠٠٠) رُدّ منه ٥٠٠ وسُدّد منه قسط مارس ١٬٠٠٠: استُعمل ١٬٥٠٠ من تأمين ١٬٠٠٠.
 *  - و«فحص المطابقة» أحمر: «تأمينات المستأجرين = التأمينات المحتجزة (غير المُسوَّاة)» −1,000.00 / 0.00 · خارجها قيود بلا مستند 1,000.00،
 *    وكان أخضر قبل الاستعادة.
 * والضابط: التعديل نفسه بلا «أقساط متأخرة» (الرد بدل الخصم) يُستعاد والفحوص خضراء، لأن قيوده كلها تُراجَع معاً · فالعيب في شرط حمل
 * الدفعة الجديد وحده: يكفيه وجود صفّ تسويةٍ ما، لا التسوية التي سُدّدت الدفعة بها.
 *
 * لماذا يهم: المالك يرى بعد الاستعادة فرقاً أحمر بألف ريال في التأمينات لا يقابله خطأ، ومستنداتٍ تصرف التأمين مرةً ونصفاً · وقرار
 * المالك 2026-10-04 «لا تمرّ بيانات في أحدهما وتُرفض في الآخر» والفحوص نفسها في النسخ والاستعادة.
 *
 * السلوك الصحيح: ما يُحمل من تعديل التسوية يُحمل كله أو يُراجَع كله: الفحوص بعد الاستعادة خضراء كما قبلها، ولا يزيد المردود من التأمين
 * والمسدَّد منه في مستندات العقد على التأمين: ردّ التسوية + دفعات «من التأمين» الحيّة ≤ ١٠٠٬٠٠٠ هللة.
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment } from '@/domain/contracts/service';
import { DEPOSIT_RENT_METHOD } from '@/domain/contracts/installments';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

const DEPOSIT = 100_000;
const red = (db: DB) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')');
/** ما صُرف من التأمين في مستندات العقد: ردّ التسوية ودفعات «من التأمين» الحيّة */
const depositUsed = (db: DB, cid: string) => {
  const refund = Number(db.get<{ r: number }>(`SELECT refund_halalas AS r FROM deposit_settlements WHERE contract_id = ?`, [cid])?.r ?? 0);
  const rent = Number(db.get<{ s: number }>(`SELECT COALESCE(SUM(net_halalas), 0) AS s FROM contract_payments
    WHERE contract_id = ? AND method_label = ? AND cancelled_at IS NULL`, [cid, DEPOSIT_RENT_METHOD])!.s);
  return refund + rent;
};

test('A1-2 · تسويةٌ عُدّلت بعد النسخة إلى «مقابل أقساطٍ متأخرة»: الاستعادة لا تُحمّر فحص التأمينات ولا تصرف التأمين مرةً ونصفاً', async () => {
  const d = tempDir('aq-r12-deprent-edit-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  const db = env.db;
  const unit = addUnit(db, addProperty(db, { name: 'عقار تسوية مصطنع' }), { unit_no: 'R12-DR' });
  const cid = confirmContract(db, contractInput(unit, { tenant: 'مستأجر تسوية مصطنع', idNumber: '1000001212', phone: '0500001212',
    valueHalalas: 300_000, cycle: 'شهرية', start: '2026-01-01', end: '2026-03-31', depositHalalas: DEPOSIT }));
  const insts = db.all<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  for (const i of insts.slice(0, 2)) {
    recordRentPayment(db, cid, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100_000 }], discountHalalas: 0, notes: '' });
  }
  // ١) التسوية الأولى: ٥٠٠ أضرار و٥٠٠ ردّ · ثم النسخة
  saveDepositSettlement(db, cid, { date: '2026-04-05', deductionHalalas: 50_000, deductionReason: 'أضرار مصطنعة', refundHalalas: 50_000, notes: '' });
  const archive = path.join(d, 'after-first-settlement.aqbk');
  await createBackup(env, archive);

  // ٢) تعديلها: التأمين كله عن قسط مارس (A1-2)
  saveDepositSettlement(db, cid, { date: '2026-04-05', deductionHalalas: DEPOSIT, deductionReason: 'إيجار مارس مصطنع', refundHalalas: 0, notes: '', arrearsHalalas: DEPOSIT });
  expect(red(db)).toEqual([]);
  expect(depositUsed(db, cid)).toBe(DEPOSIT);

  // ٣) الاستعادة
  const live = (await commitRestore(env, await prepareRestore(env, archive))).db;
  const used = depositUsed(live, cid);
  expect({ red: red(live), withinDeposit: used <= DEPOSIT, used }).toEqual({ red: [], withinDeposit: true, used });
  env.closeLive();
});

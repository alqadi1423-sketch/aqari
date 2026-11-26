/**
 * توأم review12.r.chainRestoreEdit في العقد الواحد (تعارض R12-DEP-2 مع R12-BAK-2 · keepPosted.ts) · بيانات مصطنعة، والأرقام بالهللة
 * محسوبة باليد.
 *
 * السيناريو: (أ) ستة أقساط ١٬٠٠٠ وتأمين ١٬٠٠٠ نقداً، سُدّد منها خمسة وبقي ديسمبر · بلا تجديد · سوّى المالك (أ): التأمين كله مقابل
 *   ديسمبر · نسخةٌ احتياطية · ثم عدّل التسوية: ردّ التأمين كله بدل الخصم (يعكس سداد ديسمبر) · ثم استعاد النسخة.
 * ما أعطاه بتوقعات السلسلة يومها (ديسمبر مستحق وفحص الدفعات أخضر):
 *  - قبل R12-BAK-2 (9f06537): ديسمبر مستحق، وفحص التأمينات أحمر 1,000.00 / 0.00 (حُمل إلغاء الدفعة وروجع قيد الردّ).
 *  - بعد R12-BAK-2 وقبل القرار: ديسمبر { p: 100000, s: 'مدفوعة' } وفحص الدفعات أحمر «1 بلا قيد» · كالسلسلة سواءً بسواء.
 *  - بالقرار الأول (فحص الدفعات يقبل عاكساً معلَّماً): ديسمبر مدفوع والفحوص خضراء، لكن المزامنة تلغي الدفعة بعاكسها بعدها
 *    (review12.r2.restoreSyncDepositRent) · وأي حفظٍ للتسوية بعدها يُحمّر فحص التأمينات أبداً (review12.r2.markedReversalAfterEdit).
 * القرار (بعد المراجع المعاكس الثاني): تعديل التسوية بعد النسخة يُراجَع كله (R12-BAK-2) في العقد الواحد والسلسلة، وصفّ التسوية كما في
 *   النسخة · والدفعة التي عُكس قيدها ملغاةٌ بعاكسه (Z١-١ وZ٢-٢ وY١)، فيُحمل إلغاؤها ويبقى العاكس في المراجعة مع قيد الردّ.
 *   TZ=Asia/Riyadh npx jest tests/review12.r.singleRestoreEdit.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { keptForReview } from '@/domain/accounting/orphans';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-single-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}
const insts = (db: DB, c: string) => db.all<{ id: string; due_date: string }>(
  `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);
const payCash = (db: DB, c: string, n: number) => {
  for (const i of insts(db, c).slice(0, n)) {
    recordRentPayment(db, c, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
};
const PAYMENTS_CHECK = 'كل دفعة محصَّلة لها قيد مرحّل';

test('توأم R12-DEP-2 في العقد الواحد · استعادة نسخةٍ قبل تعديل التسوية: إلغاء الدفعة يُحمل مع عاكسها، والتعديل يُراجَع كله كالسلسلة، وكل الفحوص خضراء', async () => {
  const env = newEnv();
  const db0 = env.db;
  const u = addUnit(db0, addProperty(db0, { name: 'عقار عقدٍ واحدٍ واستعادةٍ مصطنع' }), { unit_no: 'RSG-1' });
  const a = confirmContract(db0, contractInput(u, { tenant: 'مستأجر عقدٍ واحدٍ واستعادةٍ مصطنع', idNumber: '1000012052', phone: '0500012052',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  payCash(db0, a, 5);
  const dec = insts(db0, a)[5].id;
  saveDepositSettlement(db0, a, { date: '2026-01-05', deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر غير المدفوع', refundHalalas: 0,
    notes: '', arrearsHalalas: 100000 });
  const archive = await backup(env);
  // التعديل: ردّ التأمين كله · فيُعكس سداد ديسمبر وتُلغى دفعته ويعود مستحقاً
  saveDepositSettlement(db0, a, { date: '2026-01-05', deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 });
  expect(db0.get(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE id = ?`, [dec])).toEqual({ p: 0, s: 'مستحقة' });

  const db = (await commitRestore(env, await prepareRestore(env, archive))).db;
  // 1100 = ٥ أقساط نقداً ٥٬٠٠٠ + تأمين ١٬٠٠٠ − ردّه ١٬٠٠٠ = ٥٬٠٠٠ · 4200 = ٥٬٠٠٠ نقداً + ١٬٠٠٠ من التأمين − عكسه ١٬٠٠٠ = ٥٬٠٠٠
  expect([accountBalance(db, '1100'), accountBalance(db, '4200')]).toEqual([500000, 500000]);
  // قسط ديسمبر مستحقٌ كما في الدفتر: p = ٠ لأن دفعته «من التأمين» ملغاةٌ بعاكس قيدها المحمول معها ولا دفعة غيرها (وكان { p: 100000, s: 'مدفوعة' })
  expect(db.get(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE id = ?`, [dec])).toEqual({ p: 0, s: 'مستحقة' });
  // ودفعته ملغاةٌ بعاكس قيدها نفسه، كما تصلحها المزامنة
  expect(db.get(`SELECT p.cancel_entry_id = e.reversed_by AS same FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
    WHERE p.installment_id = ? AND p.cancelled_at IS NOT NULL`, [dec])).toEqual({ same: 1 });
  // وصفّ التسوية كما في النسخة، والعاكس وقيد الردّ كلاهما في المراجعة
  expect(db.get(`SELECT deduction_halalas AS d, refund_halalas AS r FROM deposit_settlements WHERE contract_id = ?`, [a])).toEqual({ d: 100000, r: 0 });
  expect(keptForReview(db).map((k) => db.get<{ t: string }>(`SELECT src_type AS t FROM journal_entries WHERE id = ?`, [k.id])!.t).sort())
    .toEqual(['deposit_refund', 'deposit_rent_rev']);
  // والعاكس مربوطٌ بأصله كما في الدفتر: فتعديل التسوية بعدها لا يعكس قيد ديسمبر مرةً ثانية
  expect(db.get(`SELECT r.src_type AS t FROM journal_entries e JOIN journal_entries r ON r.id = e.reversed_by
    WHERE e.src_type = 'deposit_rent' AND e.src_id = ?`, [a])).toEqual({ t: 'deposit_rent_rev' });
  // وكل دفعةٍ حيّة لها قيدٌ مرحّل حيّ
  expect(integrityChecks(db).find((c) => c.name.startsWith(PAYMENTS_CHECK))?.ok).toBe(true);
  // وكل فحوص المطابقة خضراء بعد الاستعادة
  expect(integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')')).toEqual([]);
  env.closeLive();
});

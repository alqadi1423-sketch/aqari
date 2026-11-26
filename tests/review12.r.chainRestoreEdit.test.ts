/**
 * المراجع المعاكس على R12-DEP-2 (المراجعة الشاملة 2026-11-13) · الاستعادة و«القيد المرحّل لا يُحذف» (keepPosted.ts) · بيانات مصطنعة،
 * والأرقام بالهللة محسوبة باليد.
 *
 * العيب: R12-DEP-2 يكتب دفعة «من التأمين» لقسط العقد السابق على عقد القسط (أ)، وقيدها مصدره العقد صاحب التأمين (ب) · وkeepPosted.ts:158
 *   يحمل الدفعة «إلا وصفّ التسوية في النسخة» بعقد الدفعة نفسه (p.contract_id = أ)، و(أ) لا تسوية له أبداً بعد ترحيل تأمينه · فإلغاء دفعة
 *   السلسلة الذي كتبه تعديل التسوية لا يُحمل ولو كان صفّ تسوية (ب) في النسخة، بخلاف دفعة العقد الواحد التي يُحمل إلغاؤها (قارن
 *   review11.A1_2.restoreKept).
 * السيناريو: (أ) ستة أقساط ١٬٠٠٠ وتأمين ١٬٠٠٠ نقداً، سُدّد منها خمسة وبقي ديسمبر · جُدّد إلى (ب) بترحيل التأمين وسُدّدت أقساطه الستة ·
 *   سوّى المالك (ب): التأمين كله مقابل ديسمبر في (أ) · نسخةٌ احتياطية · ثم عدّل التسوية: ردّ التأمين كله بدل الخصم (يعكس سداد ديسمبر) ·
 *   ثم استعاد النسخة.
 * اليوم بعد الاستعادة: عاكس قيد السداد مضمومٌ (الدفتر: 4200 = ١١٬٠٠٠ فقط)، ودفعة ديسمبر «من التأمين» حيّةٌ من النسخة بلا قيدٍ حيّ ·
 *   فقسط ديسمبر «مدفوعة» ولا إيراد له ولا يُطالَب به المستأجر، وفحص «كل دفعة محصَّلة لها قيد مرحّل» أحمر.
 * الصحيح (كدفعة العقد الواحد): يُحمل إلغاء الدفعة مع عاكسها، فيعود ديسمبر مستحقاً ويخضرّ فحص الدفعات.
 * القرار (تعارض R12-DEP-2 مع R12-BAK-2 بعد المراجع المعاكس الثاني): تعديل التسوية بعد النسخة يُراجَع كله، وصفّ التسوية كما في النسخة ·
 *   لكن الدفعة التي عُكس قيدها ملغاةٌ بعاكسه (قاعدة المزامنة Z١-١ وZ٢-٢، والإلغاء لا رجعة فيه Y١)، فيُحمل إلغاؤها مع عاكسها ويبقى العاكس
 *   في المراجعة مع قيد الردّ · فديسمبر مستحق، وصفّ التسوية في النسخة يطابقه أصل القيد، والعاكس وقيد الردّ خارج المطابقة معاً ·
 *   وكل الفحوص خضراء، والاستعادة والمزامنة سواء (review12.r2.restoreSyncDepositRent) · وتوأمه review12.r.singleRestoreEdit.
 *   TZ=Asia/Riyadh npx jest tests/review12.r.chainRestoreEdit.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment, renewContract } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { keptForReview } from '@/domain/accounting/orphans';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-chain-'); dirs.push(d); return makeBackupEnv(d); };
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

test('R12-DEP-2 مع R12-BAK-2 · استعادة نسخةٍ قبل تعديل التسوية: إلغاء دفعة قسط العقد السابق يُحمل مع عاكسها، والتعديل يُراجَع كله، وكل الفحوص خضراء', async () => {
  const env = newEnv();
  const db0 = env.db;
  const u = addUnit(db0, addProperty(db0, { name: 'عقار سلسلةٍ واستعادةٍ مصطنع' }), { unit_no: 'RCH-1' });
  const a = confirmContract(db0, contractInput(u, { tenant: 'مستأجر سلسلةٍ واستعادةٍ مصطنع', idNumber: '1000012051', phone: '0500012051',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  payCash(db0, a, 5);
  const b = renewContract(db0, a, { start: '2026-01-01', end: '2026-06-30', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  payCash(db0, b, 6);
  const dec = insts(db0, a)[5].id;
  saveDepositSettlement(db0, b, { date: '2026-07-05', deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر غير المدفوع', refundHalalas: 0,
    notes: '', arrearsHalalas: 100000 });
  const archive = await backup(env);
  // التعديل: ردّ التأمين كله · فيُعكس سداد ديسمبر وتُلغى دفعته ويعود مستحقاً
  saveDepositSettlement(db0, b, { date: '2026-07-05', deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 });
  expect(db0.get(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE id = ?`, [dec])).toEqual({ p: 0, s: 'مستحقة' });

  const db = (await commitRestore(env, await prepareRestore(env, archive))).db;
  // الدفتر بعد الضمّ: 1100 = ١١ قسطاً نقداً ١١٬٠٠٠ + تأمين ١٬٠٠٠ − ردّه ١٬٠٠٠ = ١١٬٠٠٠ · 4200 = ١١٬٠٠٠ نقداً + ١٬٠٠٠ من التأمين − عكسه ١٬٠٠٠ = ١١٬٠٠٠
  expect([accountBalance(db, '1100'), accountBalance(db, '4200')]).toEqual([1100000, 1100000]);
  // فقسط ديسمبر في (أ) مستحقٌ ١٬٠٠٠ كما في الدفتر: p = ٠ لأن دفعته «من التأمين» ملغاةٌ بعاكس قيدها المحمول معها ولا دفعة غيرها
  expect(db.get(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE id = ?`, [dec])).toEqual({ p: 0, s: 'مستحقة' });
  // ودفعته ملغاةٌ بعاكس قيدها نفسه، كما تصلحها المزامنة
  expect(db.get(`SELECT p.cancel_entry_id = e.reversed_by AS same FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
    WHERE p.installment_id = ? AND p.cancelled_at IS NOT NULL`, [dec])).toEqual({ same: 1 });
  // وصفّ التسوية كما في النسخة، والعاكس وقيد الردّ كلاهما في المراجعة
  expect(db.get(`SELECT deduction_halalas AS d, refund_halalas AS r FROM deposit_settlements WHERE contract_id = ?`, [b])).toEqual({ d: 100000, r: 0 });
  expect(keptForReview(db).map((k) => db.get<{ t: string }>(`SELECT src_type AS t FROM journal_entries WHERE id = ?`, [k.id])!.t).sort())
    .toEqual(['deposit_refund', 'deposit_rent_rev']);
  // وكل دفعةٍ حيّة لها قيدٌ مرحّل حيّ (كان «1 بلا قيد»)
  expect(integrityChecks(db).find((c) => c.name.startsWith(PAYMENTS_CHECK))?.ok).toBe(true);
  // وكل فحوص المطابقة خضراء بعد الاستعادة
  expect(integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')')).toEqual([]);
  env.closeLive();
});

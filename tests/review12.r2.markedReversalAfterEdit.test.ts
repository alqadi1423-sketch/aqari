/**
 * المراجع المعاكس الثاني على قرار تعارض R12-DEP-2 مع R12-BAK-2 · أداة المراجعة بعد الاستعادة (orphans.ts وintegrity.ts ٣) · بيانات
 * مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * السيناريو (review12.r.singleRestoreEdit): (أ) ستة أقساط ١٬٠٠٠ وتأمين ١٬٠٠٠، سُدّد خمسة · التسوية: التأمين كله مقابل ديسمبر (P1 وقيدها E)
 *   · نسخة · التعديل: ردّ التأمين كله (العاكس R وقيد الردّ F) · الاستعادة: المستندات كما في النسخة، وR وF في المراجعة، والفحوص خضراء.
 * العيب: القرار جعل تسوية النسخة هي الحقيقة · فإن أكّدها المالك من شاشة العقد (الزرّ الوحيد في المراجعة: F «مستنده»، وR بلا زرّ)
 *   صار الدفتر كما في النسخة تماماً (1100 = 4200 = ٦٠٠٬٠٠٠ وديسمبر مدفوع بدفعةٍ جديدة) ومع ذلك يحمرّ فحص التأمينات أبداً
 *   (-1,000.00 / 0.00 · خارجها 1,000.00): R معلَّمٌ فهو خارج المطابقة وإن صار له مستند (إلغاء P1)، وأصله E داخلها · و«تمّت مراجعته»
 *   تُبقيه خارجها · فلا طريق في أداة المراجعة إلى الأخضر بعد أي حفظٍ للتسوية (وإعادة التعديل نفسه كذلك، ذكره المحلّل بقيةً خارج البند).
 * والتوأم بلا أقساط (أضرار ثم ردّ، العاكس D′ معلَّم وأصله D داخل المطابقة) كذلك منذ ما قبل هذا التغيير: العلّة في نموذج المراجعة لا في
 *   هذا البند وحده، لكن القرار يحيل إليه حلّ ما ضمّه.
 * الصحيح: بعد أن يحفظ المالك تسويةً يطابقها الدفتر تماماً تخضرّ الفحوص كلها.
 *   TZ=Asia/Riyadh npx jest tests/review12.r2.markedReversalAfterEdit.test.ts
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
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r2-marked-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}
const insts = (db: DB, c: string) => db.all<{ id: string; due_date: string }>(
  `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);
const red = (db: DB) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')');
const REFUND = { deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 };

async function lease(n: number) {
  const env = newEnv();
  const db0 = env.db;
  const u = addUnit(db0, addProperty(db0, { name: 'عقار تأكيدٍ مصطنع ' + n }), { unit_no: 'R2M-' + n });
  const a = confirmContract(db0, contractInput(u, { tenant: 'مستأجر تأكيدٍ مصطنع ' + n, idNumber: '100001209' + n, phone: '050001209' + n,
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  for (const i of insts(db0, a).slice(0, 5)) {
    recordRentPayment(db0, a, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  return { env, a, dec: insts(db0, a)[5].id };
}

test('القرار: المالك يؤكد تسوية النسخة (التأمين مقابل ديسمبر) بعد الاستعادة: الدفتر كالنسخة والفحوص كلها خضراء', async () => {
  const { env, a, dec } = await lease(1);
  const ARREARS = { deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر غير المدفوع', refundHalalas: 0, notes: '', arrearsHalalas: 100000 };
  saveDepositSettlement(env.db, a, { date: '2026-01-05', ...ARREARS });
  const archive = await backup(env);
  saveDepositSettlement(env.db, a, { date: '2026-01-05', ...REFUND });
  const db = (await commitRestore(env, await prepareRestore(env, archive))).db;
  expect(red(db)).toEqual([]);
  saveDepositSettlement(db, a, { date: '2026-01-05', ...ARREARS });
  // 1100 = ٥ أقساط ٥٠٠٬٠٠٠ + تأمين ١٠٠٬٠٠٠ − ردّ F ١٠٠٬٠٠٠ + عكسه ١٠٠٬٠٠٠ = ٦٠٠٬٠٠٠ (كالنسخة) ·
  // 4200 = ٥٠٠٬٠٠٠ + E ١٠٠٬٠٠٠ − R ١٠٠٬٠٠٠ + قيد الدفعة الجديدة ١٠٠٬٠٠٠ = ٦٠٠٬٠٠٠ (كالنسخة) · ديسمبر مدفوع
  // اليوم: الدفتر صحيح وفحص التأمينات أحمر (-1,000.00 / 0.00 · خارجها قيود بلا مستند 1,000.00)
  expect({
    c1100: accountBalance(db, '1100'), c4200: accountBalance(db, '4200'),
    dec: db.get(`SELECT paid_halalas AS p, status AS s FROM contract_installments WHERE id = ?`, [dec]), red: red(db),
  }).toEqual({ c1100: 600000, c4200: 600000, dec: { p: 100000, s: 'مدفوعة' }, red: [] });
  env.closeLive();
});

test('التوأم بلا أقساط (قائمٌ قبل هذا التغيير): المالك يؤكد تسوية النسخة (أضرار) بعد الاستعادة: الدفتر كالنسخة والفحوص كلها خضراء', async () => {
  const { env, a } = await lease(2);
  const DAMAGES = { deductionHalalas: 100000, deductionReason: 'أضرار مصطنعة', refundHalalas: 0, notes: '', arrearsHalalas: 0 };
  saveDepositSettlement(env.db, a, { date: '2026-01-05', ...DAMAGES });
  const archive = await backup(env);
  saveDepositSettlement(env.db, a, { date: '2026-01-05', ...REFUND });
  const db = (await commitRestore(env, await prepareRestore(env, archive))).db;
  expect(red(db)).toEqual([]);
  saveDepositSettlement(db, a, { date: '2026-01-05', ...DAMAGES });
  // 1100 = ٥٠٠٬٠٠٠ + تأمين ١٠٠٬٠٠٠ − ردّ F ١٠٠٬٠٠٠ + عكسه ١٠٠٬٠٠٠ = ٦٠٠٬٠٠٠ · 4300 = D ١٠٠٬٠٠٠ − D′ ١٠٠٬٠٠٠ + الخصم المؤكَّد ١٠٠٬٠٠٠ = ١٠٠٬٠٠٠
  expect({ c1100: accountBalance(db, '1100'), c4300: accountBalance(db, '4300'), red: red(db) })
    .toEqual({ c1100: 600000, c4300: 100000, red: [] });
  env.closeLive();
});

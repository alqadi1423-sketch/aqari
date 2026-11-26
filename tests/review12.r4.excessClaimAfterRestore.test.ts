/**
 * المراجع المعاكس الرابع على R12-BAK-2 · مطالبة زيادة التسوية بعد استعادةٍ ضمّت تعديلها (قائمٌ قبل dcab693 وبعده: «صار له مستند»
 *   documentedSql لقيود التسوية التي مصدرها العقد وحدها، وقيد المطالبة مصدره المطالبة) · بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * تعديل تسويةٍ لها مطالبة زيادةٍ مفتوحة يلزمه حذف المطالبة أولاً (deposit.claimFirst)، والحذف يعكس قيدها (claims.ts: deleteClaim) ·
 *   فاستعادة نسخةٍ قبل التعديل تضمّ عاكس قيد المطالبة C1′ معلَّماً («عكس قيد مطالبة · مستنده في النسخة بحاله قبل العكس») وتعيد المطالبة
 *   مفتوحة · ثم حين يعيد المالك ما فعله بعد النسخة (يحذف المطالبة ثم يحفظ التسوية) لا يعكس الحذف شيئاً (C1 معكوسٌ بـ C1′) ويبقى C1′
 *   معلَّماً خارج المطابقة أبداً: لا يصير له مستند، ولا زرّ له في أداة المراجعة (مرآة قيد)، و«تمّت مراجعته» تبقيه خارجها ·
 *   فيحمرّ فحص المطالبات بمبلغ المطالبة ولا شيء في التطبيق يخضّره.
 * السيناريو: ستة أقساط ١٬٠٠٠ سُدّد خمسة نقداً، وتأمين ١٬٠٠٠ لدى المكتب · التسوية S1: خصم ١٬٥٠٠ أضراراً (D1 بـ ١٬٠٠٠ من التأمين،
 *   ومطالبة زيادة ٥٠٠ بقيدها C1: مدين 1250 ٥٠٬٠٠٠) · مزامنة · نسخة B1 · يحذف المالك المطالبة (C1′) ويحفظ S2: خصم ١٬٠٠٠ أضراراً
 *   (D1′ وD2) · مزامنة · استعادة B1 واعتمادها: المطالبة مفتوحة ٥٠٠ و1250 = C1 − C1′ = ٠ والمعلَّم C1′ (دائن ٥٠٬٠٠٠) خارج المطابقة:
 *   ٠ + ٥٠٬٠٠٠ = ٥٠٬٠٠٠ = المفتوح ٥٠٬٠٠٠ أخضر · ثم يحذف المالك المطالبة ويحفظ S2 ثانيةً.
 * الصحيح: الدفتر 1250 = ٠ والمفتوح ٠، فالمطابقة ٠ = ٠ والفحوص خضراء والمراجعة فارغة (كل مستندٍ في البيانات بحاله الأخيرة).
 * اليوم: C1′ باقٍ خارج المطابقة: «ذمم المطالبات = المطالبات المفتوحة (500.00 / 0.00 · خارجها قيود بلا مستند -500.00)» وC1′ في المراجعة.
 *   TZ=Asia/Riyadh npx jest tests/review12.r4.excessClaimAfterRestore.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment } from '@/domain/contracts/service';
import { deleteClaim } from '@/domain/claims';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { keptForReview } from '@/domain/accounting/orphans';
import { enableSync, syncOnce, readCloud, planFromSnapshot, adoptAsCloudTruth } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'user-r12-r4-claim';
const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r4-claim-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}
const insts = (db: DB, c: string) => db.all<{ id: string; due_date: string }>(
  `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const EXCESS = { deductionHalalas: 150000, deductionReason: 'أضرار في الوحدة', refundHalalas: 0, notes: '', arrearsHalalas: 0 };
const DAMAGES = { deductionHalalas: 100000, deductionReason: 'أضرار في الوحدة', refundHalalas: 0, notes: '', arrearsHalalas: 0 };
const openClaim = (db: DB, a: string) => db.get<{ id: string }>(`SELECT id FROM claims WHERE contract_id = ? AND deleted_at IS NULL AND status = 'مفتوحة'`, [a])?.id;
const view = (db: DB) => ({
  c1250: accountBalance(db, '1250'), c4300: accountBalance(db, '4300'),
  red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
  review: keptForReview(db).map((k) => db.get<{ t: string }>(`SELECT src_type AS t FROM journal_entries WHERE id = ?`, [k.id])!.t).sort(),
});

test('مطالبة زيادة التسوية: حذفها وحفظ التسوية بعد استعادةٍ ضمّت حذفها يُبقي فحص المطالبات أخضر ولا يترك عاكسها في المراجعة', async () => {
  const r = new MemoryRemote();
  const env = newEnv();
  enableSync(env.db, UID);
  const db0 = env.db;
  const u = addUnit(db0, addProperty(db0, { name: 'عقار مطالبة الزيادة المصطنع' }), { unit_no: 'R4C-1' });
  const a = confirmContract(db0, contractInput(u, { tenant: 'مستأجر مطالبة الزيادة المصطنع', idNumber: '1000014401', phone: '0500014401',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  for (const i of insts(db0, a).slice(0, 5)) {
    recordRentPayment(db0, a, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  const date = '2026-01-05';
  saveDepositSettlement(db0, a, { date, ...EXCESS });
  // D1 ١٠٠٬٠٠٠ و C1 ٥٠٬٠٠٠: 1250 = ٥٠٬٠٠٠ · 4300 = ١٥٠٬٠٠٠
  expect(view(db0)).toEqual({ c1250: 50000, c4300: 150000, red: [], review: [] });
  await sync(db0, r);
  const archive = await backup(env);
  deleteClaim(db0, openClaim(db0, a)!);
  saveDepositSettlement(db0, a, { date, ...DAMAGES });
  // C1′ وD1′ وD2: 1250 = ٠ · 4300 = ١٠٠٬٠٠٠
  expect(view(db0)).toEqual({ c1250: 0, c4300: 100000, red: [], review: [] });
  await sync(db0, r);

  const snap = await readCloud(r);
  const db = (await commitRestore(env, await prepareRestore(env, archive, undefined, { cloud: async () => snap.docs }))).db;
  adoptAsCloudTruth(db, UID, planFromSnapshot(db, snap));
  for (let i = 0; i < 2; i++) await sync(db, r);
  // بعد الاستعادة: المطالبة مفتوحة ٥٠٠ · 1250 = C1 − C1′ = ٠، وC1′ خارج المطابقة: ٠ + ٥٠٬٠٠٠ = المفتوح ٥٠٬٠٠٠ · 4300 = D1 − D1′ + D2 + C1 − C1′ = ١٠٠٬٠٠٠
  expect(view(db)).toEqual({ c1250: 0, c4300: 100000, red: [], review: ['claim_rev', 'deposit_deduct', 'deposit_deduct_rev'] });

  // يعيد المالك ما فعله بعد النسخة: يحذف المطالبة ثم يحفظ S2
  deleteClaim(db, openClaim(db, a)!);
  saveDepositSettlement(db, a, { date, ...DAMAGES });
  for (let i = 0; i < 2; i++) await sync(db, r);
  // 1250 = ٠ والمفتوح ٠ · 4300 = ١٠٠٬٠٠٠ − D2 + D3 = ١٠٠٬٠٠٠ · اليوم: «ذمم المطالبات … (500.00 / 0.00 · خارجها قيود بلا مستند -500.00)»
  expect(view(db)).toEqual({ c1250: 0, c4300: 100000, red: [], review: [] });
  env.closeLive();
});

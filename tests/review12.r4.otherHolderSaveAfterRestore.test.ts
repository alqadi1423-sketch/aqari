/**
 * المراجع المعاكس الرابع على R12-BAK-2 (dcab693: «صار له مستند» مشتقٌّ: documentedSql في orphans.ts) · تأمينٌ لدى طرف آخر ·
 * بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * الشرط الثالث للاشتقاق «لعقده قيد تسويةٍ حيّ غير معلَّم» يفترض أن كل حفظٍ للتسوية يرحّل قيداً · وتأمين «طرف آخر» (قرار المالك #26) لا قيد
 *   لردّه ولا لخصمٍ لم يصل (post.ts: depositRefundLines وdepositDeductLines تعيدان null) · فحفظ الردّ بعد الاستعادة يعكس ما بقي حيّاً ولا
 *   يرحّل شيئاً، فلا يصح «صار له مستند» أبداً ويبقى العاكس المعلَّم في أداة المراجعة بلا زرٍّ إلا «تمّت مراجعته» · وفي 31bb43e كان
 *   documentKeptSettlement يوثّقه بحفظ المالك (زوجٌ أثره صفر لقيود هذه التسوية) فتفرغ المراجعة.
 * السيناريو: ستة أقساط ١٬٠٠٠ سُدّد خمسة نقداً، وتأمين ١٬٠٠٠ لدى طرف آخر · التسوية S1: خصم ١٬٠٠٠ أضراراً وصل للمكتب (D1: مدين 1100
 *   ١٠٠٬٠٠٠ / دائن 4300) · مزامنة · نسخة B1 · التعديل S2: ردّ التأمين كله (D1′ يعكس D1، ولا قيد للردّ) · مزامنة · استعادة B1 واعتمادها:
 *   صفّ التسوية S1، وD1′ معلَّم («عكس قيد خصم من التأمين · مستنده في النسخة بحاله قبل العكس») · ثم يحفظ المالك الردّ ثانيةً من شاشة العقد.
 * بعد الحفظ: 4300 = D1 − D1′ = ٠ · 1100 = ٥٠٠٬٠٠٠ + D1 − D1′ = ٥٠٠٬٠٠٠ · وصفّ التسوية S2 (ردٌّ بلا قيد) يطابقه الدفتر كله، فلا يبقى
 *   ما يُراجَع: الصحيح أن تفرغ المراجعة كحفظ تسوية «المكتب» (review12.r2.settlementAfterRestore) · اليوم: D1′ باقٍ فيها.
 *   TZ=Asia/Riyadh npx jest tests/review12.r4.otherHolderSaveAfterRestore.test.ts
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { makeBackupEnv, type TestBackupEnv } from './helpers/backupEnv';
import { confirmContract, saveDepositSettlement, recordRentPayment } from '@/domain/contracts/service';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';
import { keptForReview } from '@/domain/accounting/orphans';
import { enableSync, syncOnce, readCloud, planFromSnapshot, adoptAsCloudTruth } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'user-r12-r4-other';
const dirs: string[] = [];
const newEnv = () => { const d = tempDir('aq-r12-r4-other-'); dirs.push(d); return makeBackupEnv(d); };
afterAll(() => { for (const d of dirs) rmrf(d); });
async function backup(env: TestBackupEnv): Promise<string> {
  const out = path.join(env.root, 'b-' + Math.random().toString(36).slice(2) + '.aqbk');
  await createBackup(env, out);
  return out;
}
const insts = (db: DB, c: string) => db.all<{ id: string; due_date: string }>(
  `SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const DAMAGES = { deductionHalalas: 100000, deductionReason: 'أضرار في الوحدة', refundHalalas: 0, notes: '', arrearsHalalas: 0, deductReceived: true };
const REFUND = { deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '', arrearsHalalas: 0 };
const view = (db: DB) => ({
  c1100: accountBalance(db, '1100'), c4300: accountBalance(db, '4300'),
  red: integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')'),
  review: keptForReview(db).map((k) => db.get<{ t: string }>(`SELECT src_type AS t FROM journal_entries WHERE id = ?`, [k.id])!.t).sort(),
});

test('تأمينٌ لدى طرف آخر: حفظ التسوية بعد استعادةٍ ضمّت تعديلها يُخرج عاكسها المعلَّم من المراجعة كتأمين المكتب', async () => {
  const r = new MemoryRemote();
  const env = newEnv();
  enableSync(env.db, UID);
  const db0 = env.db;
  const u = addUnit(db0, addProperty(db0, { name: 'عقار تأمين الطرف الآخر المصطنع' }), { unit_no: 'R4H-1' });
  const a = confirmContract(db0, { ...contractInput(u, { tenant: 'مستأجر تأمين الطرف الآخر المصطنع', idNumber: '1000014201', phone: '0500014201',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }), depositHolder: 'طرف آخر', depositHolderName: 'وسيط مصطنع' });
  for (const i of insts(db0, a).slice(0, 5)) {
    recordRentPayment(db0, a, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  const date = '2026-01-05';
  saveDepositSettlement(db0, a, { date, ...DAMAGES });
  // D1: 1100 = ٥٠٠٬٠٠٠ + ١٠٠٬٠٠٠ · 4300 = ١٠٠٬٠٠٠
  expect(view(db0)).toEqual({ c1100: 600000, c4300: 100000, red: [], review: [] });
  await sync(db0, r);
  const archive = await backup(env);
  saveDepositSettlement(db0, a, { date, ...REFUND });
  // D1′ يعكس D1 ولا قيد للردّ: 1100 = ٥٠٠٬٠٠٠ · 4300 = ٠
  expect(view(db0)).toEqual({ c1100: 500000, c4300: 0, red: [], review: [] });
  await sync(db0, r);

  const snap = await readCloud(r);
  const db = (await commitRestore(env, await prepareRestore(env, archive, undefined, { cloud: async () => snap.docs }))).db;
  adoptAsCloudTruth(db, UID, planFromSnapshot(db, snap));
  for (let i = 0; i < 2; i++) await sync(db, r);
  // بعد الاستعادة: صفّ التسوية S1 · D1′ مضمومٌ معلَّم · 1100 = ٥٠٠٬٠٠٠ · 4300 = ٠
  expect(view(db)).toEqual({ c1100: 500000, c4300: 0, red: [], review: ['deposit_deduct_rev'] });

  // المالك يحفظ الردّ ثانيةً: لا قيد حيّ يُعكس ولا قيد يُرحَّل · الدفتر بحاله ويطابقه صفّ التسوية S2 · اليوم: D1′ باقٍ في المراجعة
  saveDepositSettlement(db, a, { date, ...REFUND });
  for (let i = 0; i < 2; i++) await sync(db, r);
  expect(db.get(`SELECT deduction_halalas AS d, refund_halalas AS f FROM deposit_settlements WHERE contract_id = ?`, [a])).toEqual({ d: 0, f: 100000 });
  expect(view(db)).toEqual({ c1100: 500000, c4300: 0, red: [], review: [] });
  env.closeLive();
});

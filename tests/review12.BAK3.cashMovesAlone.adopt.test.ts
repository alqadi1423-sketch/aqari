/**
 * قرار المالك 2026-11-14 (R12-BAK-3): نقل النقد بين المحفظة والبنوك بعد النسخة يبقى ولو لم يُضمّ معه قيدٌ مرحّل · مسار اعتماد نسخةٍ
 * استُعيدت قبل الدخول (planAdoptPending ثم adoptPendingWithKeep في cloud.ts): planKeepPosted بلقطة السحابة وحدها ثم keepShortages
 * ('adopt') ثم applyKeepPosted على القاعدة الحية، ثم planFromSnapshot وadoptAsCloudTruth.
 * كان: لا قيد في السحابة بعد النسخة فلا يُحمل شيء، والاعتماد يرفع حال النسخة فيمحو الإيداع من السحابة ومن كل جهاز.
 *
 * بيانات مصطنعة والأرقام بالهللة محسوبة باليد · المحفظة = 1100 − أرصدة البنوك − افتتاحياتها.
 */
import * as path from 'node:path';
import { memDb, tempDir, rmrf } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { addBank } from './helpers/fixtures';
import { ownerCashIn, depositCashToBank, withdrawCashFromBank } from '@/domain/cashOps';
import { deleteBankTx } from '@/domain/bankTx';
import { bankBalance, walletCashBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { enableSync, syncOnce, readCloud, planFromSnapshot, adoptAsCloudTruth } from '@/sync/engine';
import { planKeepPosted, applyKeepPosted, keepShortages } from '@/domain/backup/keepPosted';
import { openNodeDb } from '@/db/nodeAdapter';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'user-bak3-alone';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const red = (db: DB) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name);

let dir: string;
beforeEach(() => { dir = tempDir('aq-bak3-alone-adopt-'); });
afterEach(() => rmrf(dir));

/** كما في planAdoptPending ثم adoptPendingWithKeep */
async function adopt(restored: DB, r: MemoryRemote) {
  const snap = await readCloud(r);
  const keep = planKeepPosted(restored, { cloud: snap.docs });
  const short = keepShortages(restored, keep, 'adopt');
  if (short.length) throw new Error(short.join(' · '));
  applyKeepPosted(restored, keep);
  adoptAsCloudTruth(restored, UID, planFromSnapshot(restored, snap));
  await sync(restored, r);
  return keep;
}

test('إيداعٌ وحده في السحابة بعد النسخة: يبقى عند الاعتماد فأ ٦٠٬٠٠٠ والمحفظة ٤٠٬٠٠٠ على الجهاز المستعاد وعلى المنضمّ', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  const bank = addBank(a, 'بنك أ مصطنع', 0);
  ownerCashIn(a, { amountHalalas: 100_000, date: '2026-03-01' }); // المحفظة ١٠٠٬٠٠٠
  await sync(a, r);
  const backupFile = path.join(dir, 'restored.db').replace(/\\/g, '/');
  a.exec(`VACUUM INTO '${backupFile}'`);
  depositCashToBank(a, { bankId: bank, amountHalalas: 60_000, date: '2026-03-02' }); // أ ٦٠٬٠٠٠ والمحفظة ٤٠٬٠٠٠
  await sync(a, r);
  a.close();

  const restored = openNodeDb(backupFile);
  expect([bankBalance(restored, bank), walletCashBalance(restored)]).toEqual([0, 100_000]);
  const keep = await adopt(restored, r);
  expect(keep.entries).toEqual([]);
  expect(keep.cashMoves).toBe(1);

  const c = memDb();
  enableSync(c, UID);
  await sync(c, r);
  const view = (db: DB) => [bankBalance(db, bank), walletCashBalance(db)];
  // أ ٠ + ٦٠٬٠٠٠ = ٦٠٬٠٠٠ · المحفظة ١٠٠٬٠٠٠ − ٦٠٬٠٠٠ = ٤٠٬٠٠٠ (كان: ٠ و١٠٠٬٠٠٠، والإيداع يُحذف من السحابة)
  expect({ restored: view(restored), joined: view(c) }).toEqual({ restored: [60_000, 40_000], joined: [60_000, 40_000] });
  expect({ restored: red(restored), joined: red(c) }).toEqual({ restored: [], joined: [] });
  restored.close(); c.close();
});

test('إيداعٌ في النسخة نُقل إلى السلة في السحابة بعدها وحده: يُنقل إلى السلة عند الاعتماد فأ صفر والمحفظة ١٠٠٬٠٠٠', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  const bank = addBank(a, 'بنك أ مصطنع', 0);
  ownerCashIn(a, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(a, { bankId: bank, amountHalalas: 100_000, date: '2026-03-01' }); // أ ١٠٠٬٠٠٠ والمحفظة ٠
  await sync(a, r);
  const backupFile = path.join(dir, 'restored.db').replace(/\\/g, '/');
  a.exec(`VACUUM INTO '${backupFile}'`);
  const dep = a.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ?`, [bank])!.id;
  deleteBankTx(a, dep); // أ ٠ والمحفظة ١٠٠٬٠٠٠
  await sync(a, r);
  a.close();

  const restored = openNodeDb(backupFile);
  const keep = await adopt(restored, r);
  expect([keep.entries.length, keep.cashMoves]).toEqual([0, 1]);
  expect([bankBalance(restored, bank), walletCashBalance(restored)]).toEqual([0, 100_000]);
  expect(red(restored)).toEqual([]);
  restored.close();
});

test('سالب: سحبٌ في السحابة من بنكٍ أُنشئ بعد النسخة لا يُحمل والإيداع الذي موّله يُحمل: الاعتماد يُرفض بسببٍ يسمّي المحفظة والناقص', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  const bank = addBank(a, 'بنك أ مصطنع', 0);
  await sync(a, r);
  const backupFile = path.join(dir, 'restored.db').replace(/\\/g, '/');
  a.exec(`VACUUM INTO '${backupFile}'`); // أ ٠ والمحفظة ٠
  const fresh = addBank(a, 'بنك جديد مصطنع', 100_000);
  withdrawCashFromBank(a, { bankId: fresh, amountHalalas: 100_000, date: '2026-03-02' }); // المحفظة ١٠٠٬٠٠٠
  depositCashToBank(a, { bankId: bank, amountHalalas: 100_000, date: '2026-03-03' }); // أ ١٠٠٬٠٠٠ والمحفظة ٠
  await sync(a, r);
  a.close();

  const restored = openNodeDb(backupFile);
  // المحفظة ٠ − ١٠٠٬٠٠٠ = −١٠٠٬٠٠٠، ينقصها ١٠٠٬٠٠٠
  let msg = '';
  try { await adopt(restored, r); } catch (e) { msg = String((e as Error).message); }
  expect(msg).toContain('المحفظة');
  expect(msg).toContain('-1,000.00');
  expect(msg).toContain('لم تُعتمد');
  expect([bankBalance(restored, bank), walletCashBalance(restored)]).toEqual([0, 0]);
  restored.close();
});

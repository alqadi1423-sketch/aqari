/**
 * المراجعة ١٢ · R12-BAK-3 · الاستعادة وحركات نقل النقد بلا قيد بين المحفظة والبنوك (keepPosted.ts · القرار ٥٥: لا يُنزل بنكٌ ولا المحفظة
 * تحت الصفر في أي مسار) · بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * الأساس في كل حالة: «إيداع المالك» ١٬٠٠٠٫٠٠ نقداً (1100 = ١٠٠٬٠٠٠) ثم ما يُذكر، ثم نسخة، ثم ما بعدها، ثم الاستعادة.
 * المحفظة = 1100 − أرصدة البنوك (walletCashBalance).
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addBank } from './helpers/fixtures';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { ownerCashIn, depositCashToBank, transferBetweenBanks, pettyCashExpense, recordManualBankTx } from '@/domain/cashOps';
import { deleteBankTx } from '@/domain/bankTx';
import { bankBalance, walletCashBalance } from '@/domain/accounting/ledger';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
const env0 = () => { const d = tempDir('aq-r12-cashmoves-'); dirs.push(d); return makeBackupEnv(d); };

test('إيداعٌ في البنك بعد النسخة ثم رسومٌ منه: الإيداع يُحمل مع قيد الرسوم فالبنك صفر والمحفظة صفر، ويُذكر في الحوار', async () => {
  const env = env0();
  const bank = addBank(env.db, 'بنك نقلٍ مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' });
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive);
  depositCashToBank(env.db, { bankId: bank, amountHalalas: 100_000, date: '2026-03-02' }); // البنك ١٠٠٬٠٠٠ والمحفظة ٠
  recordManualBankTx(env.db, { kind: 'fee', bankId: bank, amountHalalas: 100_000, date: '2026-03-03', descr: 'رسوم مصطنعة' }); // البنك ٠

  const plan = await prepareRestore(env, archive);
  expect(plan.keptCashMoves).toBe(1); // الإيداع وحده
  const db = (await commitRestore(env, plan)).db;
  // البنك ٠ + ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠ = ٠ · والمحفظة ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠ (الرسوم) − ٠ (البنك) = ٠
  expect([bankBalance(db, bank), walletCashBalance(db)]).toEqual([0, 0]);
  env.closeLive();
});

test('تحويلٌ بين بنكين بعد النسخة ثم رسومٌ من الوارد: ساقا التحويل تُحملان فالبنكان والمحفظة أصفار', async () => {
  const env = env0();
  const a = addBank(env.db, 'بنك صادرٍ مصطنع', 0);
  const b = addBank(env.db, 'بنك واردٍ مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(env.db, { bankId: a, amountHalalas: 100_000, date: '2026-03-01' }); // أ ١٠٠٬٠٠٠ والمحفظة ٠
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive);
  transferBetweenBanks(env.db, { fromBankId: a, toBankId: b, amountHalalas: 100_000, date: '2026-03-02' }); // أ ٠ وب ١٠٠٬٠٠٠
  recordManualBankTx(env.db, { kind: 'fee', bankId: b, amountHalalas: 100_000, date: '2026-03-03', descr: 'رسوم مصطنعة' }); // ب ٠

  const db = (await commitRestore(env, await prepareRestore(env, archive))).db;
  // أ ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠ = ٠ · ب ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠ = ٠ · المحفظة ١٠٠٬٠٠٠ − ١٠٠٬٠٠٠ − ٠ = ٠
  expect([bankBalance(db, a), bankBalance(db, b), walletCashBalance(db)]).toEqual([0, 0, 0]);
  env.closeLive();
});

test('إيداعٌ في النسخة حُذف بعدها ثم صُرف نقده: يبقى في السلة بعد الاستعادة فلا تصير المحفظة سالبة', async () => {
  const env = env0();
  const bank = addBank(env.db, 'بنك حذفٍ مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(env.db, { bankId: bank, amountHalalas: 100_000, date: '2026-03-01' }); // البنك ١٠٠٬٠٠٠ والمحفظة ٠
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive);
  const dep = env.db.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ?`, [bank])!.id;
  deleteBankTx(env.db, dep); // البنك ٠ والمحفظة ١٠٠٬٠٠٠
  pettyCashExpense(env.db, { amountHalalas: 100_000, descr: 'مصروف مصطنع', date: '2026-03-03' }); // المحفظة ٠

  const db = (await commitRestore(env, await prepareRestore(env, archive))).db;
  // كان: الإيداع يعود حياً من النسخة فالبنك ١٠٠٬٠٠٠ والمحفظة ٠ − ١٠٠٬٠٠٠ = −١٠٠٬٠٠٠
  expect([bankBalance(db, bank), walletCashBalance(db)]).toEqual([0, 0]);
  env.closeLive();
});

test('ما لا يُحمل (بنكٌ أُنشئ بعد النسخة) ويُنزل المحفظة تحت الصفر: تُرفض الاستعادة بسببٍ يسمّي الناقص وبياناتك كما هي', async () => {
  const env = env0();
  const a = addBank(env.db, 'بنك قديم مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(env.db, { bankId: a, amountHalalas: 100_000, date: '2026-03-01' }); // أ ١٠٠٬٠٠٠ والمحفظة ٠
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive);
  const b = addBank(env.db, 'بنك جديد مصطنع', 0); // ليس في النسخة
  transferBetweenBanks(env.db, { fromBankId: a, toBankId: b, amountHalalas: 100_000, date: '2026-03-02' });
  recordManualBankTx(env.db, { kind: 'fee', bankId: b, amountHalalas: 100_000, date: '2026-03-03', descr: 'رسوم مصطنعة' });
  const view = (db: DB) => [bankBalance(db, a), bankBalance(db, b), walletCashBalance(db)];
  expect(view(env.db)).toEqual([0, 0, 0]);

  // في النسخة: أ ١٠٠٬٠٠٠ والمحفظة ٠ · قيد الرسوم يُضمّ (1100 −١٠٠٬٠٠٠) وحركته على ب لا تُحمل، والتحويل لا يُحمل بساقيه ·
  // فالمحفظة بعد الضمّ ٠ − ١٠٠٬٠٠٠ = −١٠٠٬٠٠٠، ينقصها ١٠٠٬٠٠٠
  let msg = '';
  try { await prepareRestore(env, archive); } catch (e) { msg = String((e as Error).message); }
  expect(msg).toContain('المحفظة');
  expect(msg).toContain('1,000.00');
  expect(view(env.live())).toEqual([0, 0, 0]);
  env.closeLive();
});

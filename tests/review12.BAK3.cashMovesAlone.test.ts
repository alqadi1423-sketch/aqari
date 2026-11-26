/**
 * قرار المالك 2026-11-14 («اختار توصيتك» على R12-BAK-3 · docs/حوكمة/سجل-القرارات.md): نقل النقد بين المحفظة والبنوك بعد النسخة
 * (إيداع أو سحب أو تحويل) يبقى بعد الاستعادة ولو لم يُضمّ معه قيدٌ مرحّل، لأنه حركة مالٍ حقيقية والمال فعلاً في البنك.
 * كان: planKeepPosted يعود فارغاً حين لا قيد يُضمّ، فترجع البنوك والمحفظة إلى حال النسخة.
 *
 * بيانات مصطنعة والأرقام بالهللة محسوبة باليد · المحفظة = 1100 − أرصدة البنوك − افتتاحياتها (walletCashBalance).
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addBank } from './helpers/fixtures';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { keptMovesText } from '@/domain/backup/keepPosted';
import { ownerCashIn, depositCashToBank, transferBetweenBanks, withdrawCashFromBank } from '@/domain/cashOps';
import { deleteBankTx } from '@/domain/bankTx';
import { restoreFromTrash, purgeFromTrash } from '@/domain/trash';
import { bankBalance, walletCashBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { buildDoc } from '@/sync/engine';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
const env0 = () => { const d = tempDir('aq-bak3-alone-'); dirs.push(d); return makeBackupEnv(d); };
const red = (db: DB) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name);
const entries = (db: DB) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n);

test('إيداعٌ وحده بعد النسخة: يبقى بعد الاستعادة فالبنك ٦٠٬٠٠٠ والمحفظة ٤٠٬٠٠٠، والحوار يذكر حركةً واحدة', async () => {
  const env = env0();
  const a = addBank(env.db, 'بنك أ مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' }); // المحفظة ١٠٠٬٠٠٠
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive);
  const before = entries(env.db);
  depositCashToBank(env.db, { bankId: a, amountHalalas: 60_000, date: '2026-03-02' }); // أ ٦٠٬٠٠٠ والمحفظة ٤٠٬٠٠٠
  expect(entries(env.db)).toBe(before); // لا قيد بعد النسخة

  const plan = await prepareRestore(env, archive);
  expect(plan.kept).toEqual([]);
  expect(plan.keptCashMoves).toBe(1);
  expect(plan.keptRevivedMoves).toBe(0);
  // نص الحوار: عدد الحركات التي تبقى، بلا «ومعها» لأنه لا قيد يُضمّ
  const text = keptMovesText(plan.keptCashMoves, plan.keptRevivedMoves, false);
  expect(text).toContain('1 حركة');
  expect(text).toContain('تبقى');
  expect(text.startsWith('ومعها')).toBe(false);
  const db = (await commitRestore(env, plan)).db;
  // أ ٠ + ٦٠٬٠٠٠ = ٦٠٬٠٠٠ · المحفظة ١٠٠٬٠٠٠ − ٦٠٬٠٠٠ = ٤٠٬٠٠٠ (كان: ٠ و١٠٠٬٠٠٠)
  expect([bankBalance(db, a), walletCashBalance(db)]).toEqual([60_000, 40_000]);
  expect(red(db)).toEqual([]);
  env.closeLive();
});

test('تحويلٌ وحده من أ إلى ب بعد النسخة: ساقاه تبقيان فأ ٧٠٬٠٠٠ وب ٣٠٬٠٠٠ والمحفظة صفر', async () => {
  const env = env0();
  const a = addBank(env.db, 'بنك أ مصطنع', 0);
  const b = addBank(env.db, 'بنك ب مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(env.db, { bankId: a, amountHalalas: 100_000, date: '2026-03-01' }); // أ ١٠٠٬٠٠٠ والمحفظة ٠
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive);
  transferBetweenBanks(env.db, { fromBankId: a, toBankId: b, amountHalalas: 30_000, date: '2026-03-02' }); // أ ٧٠٬٠٠٠ وب ٣٠٬٠٠٠

  const plan = await prepareRestore(env, archive);
  expect(plan.kept).toEqual([]);
  expect(plan.keptCashMoves).toBe(2); // ساقا التحويل
  const db = (await commitRestore(env, plan)).db;
  // أ ١٠٠٬٠٠٠ − ٣٠٬٠٠٠ = ٧٠٬٠٠٠ · ب ٣٠٬٠٠٠ · المحفظة ١٠٠٬٠٠٠ − ٧٠٬٠٠٠ − ٣٠٬٠٠٠ = ٠
  expect([bankBalance(db, a), bankBalance(db, b), walletCashBalance(db)]).toEqual([70_000, 30_000, 0]);
  expect(red(db)).toEqual([]);
  env.closeLive();
});

test('تحويلٌ وحده إلى بنكٍ أُنشئ بعد النسخة: لا تُحمل ساقاه (كما مع القيود المضمومة) فأ يعود ١٠٠٬٠٠٠ ولا نقص', async () => {
  const env = env0();
  const a = addBank(env.db, 'بنك أ مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(env.db, { bankId: a, amountHalalas: 100_000, date: '2026-03-01' }); // أ ١٠٠٬٠٠٠ والمحفظة ٠
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive);
  const c = addBank(env.db, 'بنك جديد مصطنع', 0); // ليس في النسخة
  transferBetweenBanks(env.db, { fromBankId: a, toBankId: c, amountHalalas: 40_000, date: '2026-03-02' });

  const plan = await prepareRestore(env, archive);
  expect(plan.keptCashMoves).toBe(0);
  const db = (await commitRestore(env, plan)).db;
  // البنك الجديد ليس في النسخة · أ ١٠٠٬٠٠٠ والمحفظة ٠ كما في النسخة
  expect([bankBalance(db, a), walletCashBalance(db)]).toEqual([100_000, 0]);
  expect(db.get(`SELECT 1 FROM banks WHERE id = ?`, [c])).toBeUndefined();
  env.closeLive();
});

test('إيداعٌ في النسخة نُقل إلى السلة بعدها وحده: يبقى في السلة بعد الاستعادة فأ صفر والمحفظة ١٠٠٬٠٠٠', async () => {
  const env = env0();
  const a = addBank(env.db, 'بنك أ مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(env.db, { bankId: a, amountHalalas: 100_000, date: '2026-03-01' }); // أ ١٠٠٬٠٠٠ والمحفظة ٠
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive);
  const dep = env.db.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ?`, [a])!.id;
  deleteBankTx(env.db, dep); // أ ٠ والمحفظة ١٠٠٬٠٠٠

  const plan = await prepareRestore(env, archive);
  expect(plan.keptCashMoves).toBe(1);
  const db = (await commitRestore(env, plan)).db;
  // كان: الإيداع يعود حيّاً من النسخة فأ ١٠٠٬٠٠٠ والمحفظة ٠
  expect([bankBalance(db, a), walletCashBalance(db)]).toEqual([0, 100_000]);
  expect(db.get<{ d: string | null }>(`SELECT deleted_at AS d FROM bank_tx WHERE id = ?`, [dep])!.d).not.toBeNull();
  expect(red(db)).toEqual([]);
  env.closeLive();
});

test('إيداعٌ في سلة النسخة استُعيد منها بعدها وحده: يخرج من السلة فأ ١٠٠٬٠٠٠ والمحفظة صفر', async () => {
  const env = env0();
  const a = addBank(env.db, 'بنك أ مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(env.db, { bankId: a, amountHalalas: 100_000, date: '2026-03-01' });
  const dep = env.db.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ?`, [a])!.id;
  deleteBankTx(env.db, dep); // أ ٠ والمحفظة ١٠٠٬٠٠٠
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive);
  restoreFromTrash(env.db, 'bank_tx', dep); // أ ١٠٠٬٠٠٠ والمحفظة ٠

  const plan = await prepareRestore(env, archive);
  expect(plan.keptCashMoves).toBe(1);
  const db = (await commitRestore(env, plan)).db;
  expect([bankBalance(db, a), walletCashBalance(db)]).toEqual([100_000, 0]);
  expect(red(db)).toEqual([]);
  env.closeLive();
});

test('إيداعٌ حُذف نهائياً بعد النسخة وشاهد حذفه في السحابة، بلا قيدٍ بعدها: يُنقل إلى السلة فأ صفر والمحفظة ١٠٠٬٠٠٠', async () => {
  const env = env0();
  const a = addBank(env.db, 'بنك أ مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(env.db, { bankId: a, amountHalalas: 100_000, date: '2026-03-01' });
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive);
  const dep = env.db.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ?`, [a])!.id;
  deleteBankTx(env.db, dep);
  purgeFromTrash(env.db, 'bank_tx', dep); // أ ٠ والمحفظة ١٠٠٬٠٠٠
  const tombstone = buildDoc(env.db, 'bank_tx', dep, 'delete', new Date().toISOString(), 'DEV-THIS');

  const plan = await prepareRestore(env, archive, undefined, { cloud: async () => [tombstone] });
  expect([plan.keptCashMoves, plan.keptRevivedMoves]).toEqual([1, 0]);
  const db = (await commitRestore(env, plan)).db;
  expect([bankBalance(db, a), walletCashBalance(db)]).toEqual([0, 100_000]);
  expect(red(db)).toEqual([]);
  env.closeLive();
});

test('إيداعٌ حُذف نهائياً بعد النسخة على جهازٍ بلا حساب، بلا قيدٍ بعدها: يعود كما في النسخة ويُذكر عدده في الحوار', async () => {
  const env = env0();
  const a = addBank(env.db, 'بنك أ مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(env.db, { bankId: a, amountHalalas: 100_000, date: '2026-03-01' });
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive);
  const dep = env.db.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ?`, [a])!.id;
  deleteBankTx(env.db, dep);
  purgeFromTrash(env.db, 'bank_tx', dep);

  const plan = await prepareRestore(env, archive);
  expect([plan.keptCashMoves, plan.keptRevivedMoves]).toEqual([0, 1]);
  expect(keptMovesText(plan.keptCashMoves, plan.keptRevivedMoves, false)).toContain('1 حركة');
  const db = (await commitRestore(env, plan)).db;
  expect([bankBalance(db, a), walletCashBalance(db)]).toEqual([100_000, 0]);
  env.closeLive();
});

test('نسخةٌ تُستعاد على جهازٍ جديد لا يعرف بنوكها: لا حركة تُحمل ولا «تعود» تُعدّ، والحوار بلا سطر نقل النقد', async () => {
  const src = env0();
  const a = addBank(src.db, 'بنك أ مصطنع', 0);
  ownerCashIn(src.db, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(src.db, { bankId: a, amountHalalas: 60_000, date: '2026-03-01' });
  const archive = path.join(src.root, 'b.aqbk');
  await createBackup(src, archive);
  src.closeLive();

  const fresh = env0();
  const plan = await prepareRestore(fresh, archive);
  expect([plan.keptCashMoves, plan.keptRevivedMoves]).toEqual([0, 0]);
  expect(keptMovesText(plan.keptCashMoves, plan.keptRevivedMoves, false)).toBe('');
  const db = (await commitRestore(fresh, plan)).db;
  expect([bankBalance(db, a), walletCashBalance(db)]).toEqual([60_000, 40_000]);
  fresh.closeLive();
});

test('سالب: سحبٌ من بنكٍ أُنشئ بعد النسخة لا يُحمل، والإيداع الذي موّله يُحمل فينزل بالمحفظة: تُرفض الاستعادة بسببٍ يسمّي الناقص', async () => {
  const env = env0();
  const a = addBank(env.db, 'بنك أ مصطنع', 0);
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive); // أ ٠ والمحفظة ٠
  const c = addBank(env.db, 'بنك جديد مصطنع', 100_000); // افتتاحيه ١٠٠٬٠٠٠ · ليس في النسخة
  withdrawCashFromBank(env.db, { bankId: c, amountHalalas: 100_000, date: '2026-03-02' }); // المحفظة ١٠٠٬٠٠٠
  depositCashToBank(env.db, { bankId: a, amountHalalas: 100_000, date: '2026-03-03' }); // أ ١٠٠٬٠٠٠ والمحفظة ٠
  const view = (db: DB) => [bankBalance(db, a), bankBalance(db, c), walletCashBalance(db)];
  expect(view(env.db)).toEqual([100_000, 0, 0]);

  // في النسخة المحفظة ٠ · السحب على البنك الجديد لا يُحمل والإيداع إلى أ يُحمل: المحفظة ٠ − ١٠٠٬٠٠٠ = −١٠٠٬٠٠٠، ينقصها ١٠٠٬٠٠٠
  let msg = '';
  try { await prepareRestore(env, archive); } catch (e) { msg = String((e as Error).message); }
  expect(msg).toContain('المحفظة');
  expect(msg).toContain('-1,000.00');
  expect(msg).toContain('حركات نقل النقد');
  expect(msg).toContain('لم تُستعد');
  expect(view(env.live())).toEqual([100_000, 0, 0]);
  env.closeLive();
});

test('سالب: تحويلٌ من بنكٍ أُنشئ بعد النسخة إلى أ لا يُحمل بساقيه، وسحبٌ من أ يُحمل فينزل به: تُرفض الاستعادة بسببٍ يسمّي البنك', async () => {
  const env = env0();
  const a = addBank(env.db, 'بنك أ مصطنع', 0);
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive); // أ ٠ والمحفظة ٠
  const c = addBank(env.db, 'بنك جديد مصطنع', 100_000);
  transferBetweenBanks(env.db, { fromBankId: c, toBankId: a, amountHalalas: 100_000, date: '2026-03-02' }); // أ ١٠٠٬٠٠٠
  withdrawCashFromBank(env.db, { bankId: a, amountHalalas: 100_000, date: '2026-03-03' }); // أ ٠ والمحفظة ١٠٠٬٠٠٠

  // في النسخة أ ٠ · السحب وحده يُحمل: أ ٠ − ١٠٠٬٠٠٠ = −١٠٠٬٠٠٠، ينقصه ١٠٠٬٠٠٠
  let msg = '';
  try { await prepareRestore(env, archive); } catch (e) { msg = String((e as Error).message); }
  expect(msg).toContain('«بنك أ مصطنع»');
  expect(msg).toContain('-1,000.00');
  expect(msg).toContain('1,000.00');
  expect(bankBalance(env.live(), a)).toBe(0);
  env.closeLive();
});

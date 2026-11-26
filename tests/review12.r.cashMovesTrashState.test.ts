/**
 * المراجعة ١٢ · مراجعة إصلاح R12-BAK-3 (المراجع المستقل) · بيانات مصطنعة والأرقام بالهللة محسوبة باليد.
 *
 * planCashMoves (keepPosted.ts) يقول إنه يحمل حركات نقل النقد «بحالها في المصدر» مع القيود المضمومة، لكنه يعالج اتجاهاً واحداً للسلة:
 * حركةٌ حيّة في النسخة وفي سلة المصدر تُنقل إلى السلة. أمّا:
 *  أ) حركةٌ في سلة النسخة استُعيدت من السلة بعدها (requireBankTxRestorable ثم deleted_at = NULL)، فتبقى في السلة بعد الاستعادة؛
 *  ب) وحركةٌ حيّة في النسخة حُذفت بعدها نهائياً (purgeFromTrash، أو كنس السلة الدوري purgeExpiredTrash بعد مدتها)، فلا صفّ لها على الجهاز،
 *     وشاهد حذفها في لقطة السحابة ({del: true}) يتخطّاه planCashMoves، فلا تُنقل إلى السلة وتعود حيّة من النسخة.
 * وفي الحالتين لا ينزل شيء تحت الصفر فلا يمنع keepShortages، فتتمّ الاستعادة بصمت والمال في غير مكانه: نقدٌ في المحفظة ليس في اليد أو
 * مالٌ في البنك ليس فيه، وهو عين ما وصفه البند.
 *
 * الأساس: «إيداع المالك» ١٬٠٠٠٫٠٠ نقداً (1100 = ١٠٠٬٠٠٠) · بنكٌ افتتاحيه صفر · والقيد المضموم بعد النسخة «إيداع المالك» ٥٠٠٫٠٠ نقداً
 * (قيد cash_op مستنده نفسه) ليُحمل معه نقل النقد. المحفظة = 1100 − أرصدة البنوك (walletCashBalance).
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addBank } from './helpers/fixtures';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { ownerCashIn, depositCashToBank } from '@/domain/cashOps';
import { deleteBankTx } from '@/domain/bankTx';
import { restoreFromTrash, purgeFromTrash } from '@/domain/trash';
import { bankBalance, walletCashBalance } from '@/domain/accounting/ledger';
import { buildDoc } from '@/sync/engine';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
const env0 = () => { const d = tempDir('aq-r12r-cashtrash-'); dirs.push(d); return makeBackupEnv(d); };

test('أ) إيداعٌ في سلة النسخة استُعيد من السلة بعدها: يبقى حيّاً بعد الاستعادة فلا يعود نقده إلى المحفظة', async () => {
  const env = env0();
  const bank = addBank(env.db, 'بنك سلةٍ مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(env.db, { bankId: bank, amountHalalas: 100_000, date: '2026-03-01' }); // البنك ١٠٠٬٠٠٠ والمحفظة ٠
  const dep = env.db.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ?`, [bank])!.id;
  deleteBankTx(env.db, dep); // البنك ٠ والمحفظة ١٠٠٬٠٠٠
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive);

  restoreFromTrash(env.db, 'bank_tx', dep); // البنك ١٠٠٬٠٠٠ والمحفظة ٠
  ownerCashIn(env.db, { amountHalalas: 50_000, date: '2026-03-05' }); // المحفظة ٥٠٬٠٠٠
  expect([bankBalance(env.db, bank), walletCashBalance(env.db)]).toEqual([100_000, 50_000]);

  const db = (await commitRestore(env, await prepareRestore(env, archive))).db;
  // البنك ١٠٠٬٠٠٠ (الإيداع حيّ كما في المصدر) · المحفظة ١٠٠٬٠٠٠ + ٥٠٬٠٠٠ − ١٠٠٬٠٠٠ = ٥٠٬٠٠٠
  expect([bankBalance(db, bank), walletCashBalance(db)]).toEqual([100_000, 50_000]);
  env.closeLive();
});

test('ب) إيداعٌ حيّ في النسخة حُذف بعدها نهائياً: لا يعود حيّاً بالاستعادة فيبقى نقده في المحفظة', async () => {
  const env = env0();
  const bank = addBank(env.db, 'بنك حذفٍ نهائي مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100_000, date: '2026-03-01' });
  depositCashToBank(env.db, { bankId: bank, amountHalalas: 100_000, date: '2026-03-01' }); // البنك ١٠٠٬٠٠٠ والمحفظة ٠
  const archive = path.join(env.root, 'b.aqbk');
  await createBackup(env, archive);

  const dep = env.db.get<{ id: string }>(`SELECT id FROM bank_tx WHERE bank_id = ?`, [bank])!.id;
  deleteBankTx(env.db, dep); // البنك ٠ والمحفظة ١٠٠٬٠٠٠
  purgeFromTrash(env.db, 'bank_tx', dep); // كما يفعل كنس السلة الدوري بعد مدتها
  ownerCashIn(env.db, { amountHalalas: 50_000, date: '2026-03-05' }); // المحفظة ١٥٠٬٠٠٠
  expect([bankBalance(env.db, bank), walletCashBalance(env.db)]).toEqual([0, 150_000]);
  // والاستعادة مع الدخول بحساب: لقطة السحابة فيها شاهد حذف الإيداع ({d: null, del: true}) كما رفعه الحذف النهائي، فالخطة تعرف أنه حُذف
  const tombstone = buildDoc(env.db, 'bank_tx', dep, 'delete', new Date().toISOString(), 'DEV-THIS');
  expect(tombstone.del).toBe(true);

  const db = (await commitRestore(env, await prepareRestore(env, archive, undefined, { cloud: async () => [tombstone] }))).db;
  // البنك ٠ (الإيداع محذوف كما في المصدر) · المحفظة ١٠٠٬٠٠٠ + ٥٠٬٠٠٠ − ٠ = ١٥٠٬٠٠٠
  expect([bankBalance(db, bank), walletCashBalance(db)]).toEqual([0, 150_000]);
  env.closeLive();
});

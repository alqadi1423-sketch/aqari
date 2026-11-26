/**
 * مدقق المرحلة ١ المستقل (2026-11-13) · المال · «لا يُنزل البنك تحت الصفر في كل المسارات» (القرار ٥٥ · A2.2) مع الاستعادة التي تُبقي
 * المرحّل (C-1 · keepPosted.ts) · بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * السيناريو:
 *  ١) بنكٌ افتتاحيه صفر، و«إيداع المالك» ١٬٠٠٠٫٠٠ نقداً في المحفظة (قيد).
 *  ٢) نسخة احتياطية.
 *  ٣) إيداع الألف من المحفظة في البنك (حركة بنكٍ بلا قيد: depositCashToBank) · المحفظة صفر والبنك ١٬٠٠٠٫٠٠.
 *  ٤) رسوم بنكية ١٬٠٠٠٫٠٠ من البنك (قيدٌ مرحّل وحركة بنكٍ سالبة مربوطة برقمه) · البنك صفر والمحفظة صفر.
 *  ٥) استعادة النسخة.
 * الخطأ: planKeepPosted يضمّ قيد الرسوم المرحّل وحركته (−١٬٠٠٠) ولا يضمّ الإيداع الذي سبقه لأنه حركة بنكٍ بلا قيد، فبعد الاستعادة:
 * البنك −١٬٠٠٠٫٠٠ والمحفظة +١٬٠٠٠٫٠٠ (نقدٌ ليس في اليد يُصرف منه) وفحوص المطابقة كلها خضراء، ولا يذكر الحوار شيئاً.
 * حارس A2.2 (bankShortages) يفحص العكس وإعادة الترحيل من السلة ولا يفحص ما تضمّه الاستعادة · وهو خللٌ قائم قبل المرحلة ١ لم يغطّه
 * إصلاحها.
 *
 * السلوك الصحيح: إمّا تُرفض الاستعادة بسببٍ يسمّي البنك وما ينقصه، وإمّا تُبقي البنك والمحفظة على حقيقتهما (البنك صفر والمحفظة صفر).
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addBank } from './helpers/fixtures';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { ownerCashIn, depositCashToBank, recordManualBankTx } from '@/domain/cashOps';
import { bankBalance, walletCashBalance } from '@/domain/accounting/ledger';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

test('الاستعادة لا تترك بنكاً تحت الصفر ولا نقداً في المحفظة ليس في اليد', async () => {
  const d = tempDir('aq-r12-restore-bank-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  const bank = addBank(env.db, 'بنك استعادةٍ مصطنع', 0);
  ownerCashIn(env.db, { amountHalalas: 100000, date: '2026-03-01' });
  const archive = path.join(d, 'b.aqbk');
  await createBackup(env, archive);

  depositCashToBank(env.db, { bankId: bank, amountHalalas: 100000, date: '2026-03-02' });
  recordManualBankTx(env.db, { kind: 'fee', bankId: bank, amountHalalas: 100000, date: '2026-03-03', descr: 'رسوم مصطنعة' });
  expect([bankBalance(env.db, bank), walletCashBalance(env.db)]).toEqual([0, 0]);

  let refused = false;
  let after: number[] = [];
  try {
    const plan = await prepareRestore(env, archive);
    const db = (await commitRestore(env, plan)).db;
    after = [bankBalance(db, bank), walletCashBalance(db)];
  } catch {
    refused = true; // رفضٌ بسببٍ ظاهر مقبول
  }
  // اليوم: تُقبل والنتيجة [−١٬٠٠٠٫٠٠، +١٬٠٠٠٫٠٠]
  if (!refused) expect(after).toEqual([0, 0]);
  env.closeLive();
});

/**
 * المراجعة ١٢ · مراجعة إصلاح R12-BAK-1 (المراجع المستقل) · بيانات مصطنعة والأرقام بالهللة محسوبة باليد.
 *
 * carryAccounts (keepPosted.ts) يحمل الحساب الذي «ليس في دليل النسخة» بوجود صفّه وحده، ولا ينظر في حاله: حسابٌ في النسخة في السلة
 * (deleted_at) ثم استُعيد من السلة بعدها ورُحّل عليه قيد · فالاستعادة تضمّ القيد المرحّل على حسابٍ يبقى في السلة.
 * فيخرج الحساب من دليل الحسابات وميزان المراجعة (allAccounts وgetAccount بلا المحذوف)، ويصير رصيده صفراً والقيد مرحّلاً عليه،
 * فلا تتوازن أرصدة الميزان: النقدية نقصت ٢٠٠٬٠٠٠ ولا مصروف يقابلها.
 *
 * السيناريو: رأس مال ١٠٬٠٠٠٫٠٠ نقداً · حساب 5155 أُنشئ ثم حُذف إلى السلة بلا سطور · ثم النسخة · بعدها استُعيد 5155 من السلة ورُحّل
 * عليه صرف ٢٬٠٠٠٫٠٠ نقداً · ثم تُستعاد النسخة.
 * المتوقع: 5155 حيٌّ بعد الاستعادة ورصيده ٢٠٠٬٠٠٠ والنقدية ١٬٠٠٠٬٠٠٠ − ٢٠٠٬٠٠٠ = ٨٠٠٬٠٠٠ ·
 * ومجموع أرصدة الميزان المدينة = الدائنة (٨٠٠٬٠٠٠ + ٢٠٠٬٠٠٠ = ١٬٠٠٠٬٠٠٠ رأس المال).
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { postEntry, postManualEntry } from '@/domain/accounting/post';
import { saveAccount, deleteAccount } from '@/domain/accounting/chart';
import { restoreFromTrash } from '@/domain/trash';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { accountBalance, trialBalance } from '@/domain/accounting/ledger';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

test('حسابٌ في سلة النسخة استُعيد بعدها ورُحّل عليه: الاستعادة تُعيده حيّاً مع قيده فلا يخرج من الميزان', async () => {
  const d = tempDir('aq-r12r-kept-trashed-acc-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  postEntry(env.db, { date: '2026-03-01', memo: 'رأس مال مصطنع', lines: [
    { account: '1100', debit: 1_000_000, credit: 0 }, { account: '3100', debit: 0, credit: 1_000_000 }] });
  saveAccount(env.db, { code: '5155', name: 'صيانة مصاعد مصطنعة', type: 'مصروف', openingHalalas: 0 });
  deleteAccount(env.db, '5155'); // بلا سطور فيُحذف إلى السلة
  const archive = path.join(d, 'trashed-account.aqbk');
  await createBackup(env, archive);

  // بعد النسخة: يُستعاد 5155 من السلة ويُرحّل عليه صرف ٢٬٠٠٠٫٠٠ نقداً
  restoreFromTrash(env.db, 'accounts', '5155');
  const spend = postManualEntry(env.db, { date: '2026-03-05', memo: 'صيانة مصعد مصطنعة', lines: [
    { account: '5155', debit: 200_000, credit: 0 }, { account: '1100', debit: 0, credit: 200_000 }] })!;
  expect(accountBalance(env.db, '5155')).toBe(200_000);

  const plan = await prepareRestore(env, archive);
  expect(plan.kept.map((k) => k.id)).toContain(spend.id);
  await commitRestore(env, plan);

  const live = env.live();
  const tb = trialBalance(live, null, null);
  const sumDebit = tb.reduce((s, r) => s + Math.max(0, r.closingHalalas), 0);
  const sumCredit = tb.reduce((s, r) => s + Math.max(0, -r.closingHalalas), 0);
  expect({
    live5155: live.get<{ x: number }>(`SELECT deleted_at IS NULL AS x FROM accounts WHERE code = '5155'`)?.x ?? null,
    cash: accountBalance(live, '1100'), // ١٬٠٠٠٬٠٠٠ − ٢٠٠٬٠٠٠ = ٨٠٠٬٠٠٠
    maintenance: accountBalance(live, '5155'), // ٢٠٠٬٠٠٠
    balanced: [sumDebit, sumCredit], // ٨٠٠٬٠٠٠ + ٢٠٠٬٠٠٠ = ١٬٠٠٠٬٠٠٠ مقابل رأس المال ١٬٠٠٠٬٠٠٠
  }).toEqual({ live5155: 1, cash: 800_000, maintenance: 200_000, balanced: [1_000_000, 1_000_000] });
  env.closeLive();
});

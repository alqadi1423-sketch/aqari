/**
 * المراجعة ١٢ · إصلاح مراجعة R12-BAK-1 · بيانات مصطنعة والأرقام بالهللة محسوبة باليد.
 *
 * carryAccounts يحمل الحساب الحيّ وحده من المصدر · فحسابٌ لا صفّ حيّاً له في أي مصدر (في سلة النسخة وفي سلة الجهاز) لا يُحمل في السلة
 * فيبقى القيد المرحّل عليه خارج الميزان، بل تمتنع الاستعادة قبل أي كتابة برسالةٍ تسمّي القيد ومبلغه والحساب وأنه في السلة.
 *
 * السيناريو: رأس مال ١٠٬٠٠٠٫٠٠ نقداً · 5155 أُنشئ ثم حُذف إلى السلة · النسخة · بعدها استُعيد ورُحّل عليه صرف ٢٬٠٠٠٫٠٠، ثم صار في السلة
 * على الجهاز بكتابةٍ مباشرة (كقيد عضوٍ وصل بعد حذف المالك الحساب) · المبلغ في الرسالة مجموع مدين القيد ٢٠٠٬٠٠٠ = ٢٬٠٠٠٫٠٠.
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { postEntry, postManualEntry } from '@/domain/accounting/post';
import { saveAccount, deleteAccount } from '@/domain/accounting/chart';
import { restoreFromTrash } from '@/domain/trash';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore } from '@/domain/backup/restore';
import { accountBalance } from '@/domain/accounting/ledger';
import { fmt } from '@/domain/money';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

test('حسابُ قيدٍ مضموم في السلة في كل مصدر: لا يُحمل في السلة بل تمتنع الاستعادة برسالةٍ تسمّيه وأنه في السلة', async () => {
  const d = tempDir('aq-r12-kept-acc-trashed-src-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  postEntry(env.db, { date: '2026-03-01', memo: 'رأس مال مصطنع', lines: [
    { account: '1100', debit: 1_000_000, credit: 0 }, { account: '3100', debit: 0, credit: 1_000_000 }] });
  saveAccount(env.db, { code: '5155', name: 'صيانة مصاعد مصطنعة', type: 'مصروف', openingHalalas: 0 });
  deleteAccount(env.db, '5155');
  const archive = path.join(d, 'trashed-everywhere.aqbk');
  await createBackup(env, archive);

  restoreFromTrash(env.db, 'accounts', '5155');
  const spend = postManualEntry(env.db, { date: '2026-03-05', memo: 'صيانة مصعد مصطنعة', lines: [
    { account: '5155', debit: 200_000, credit: 0 }, { account: '1100', debit: 0, credit: 200_000 }] })!;
  expect(accountBalance(env.db, '5155')).toBe(200_000);
  env.db.run(`UPDATE accounts SET deleted_at = '2026-03-06T09:00:00.000Z' WHERE code = '5155'`);

  let msg = '';
  try { await prepareRestore(env, archive); } catch (e) { msg = String((e as Error).message); }
  expect(msg).toContain(spend.no);
  expect(msg).toContain('5155');
  expect(msg).toContain(fmt(200_000)); // مجموع مدين القيد ٢٠٠٬٠٠٠ هللة
  expect(msg).toContain('سلة المحذوفات');
  // لم يُمسّ شيء: القاعدة الحية كما هي
  expect(env.live().get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE id = ?`, [spend.id])?.n).toBe(1);
  env.closeLive();
});

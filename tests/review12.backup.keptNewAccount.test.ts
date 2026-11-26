/**
 * المراجعة ١٢ · مدقق المرحلة ١ المستقل · النسخ والاستعادة · ضمّ المرحّل بعد النسخة (keepPosted · C-1) · عالٍ
 * src/domain/backup/keepPosted.ts:291 (insertRow لسطور القيد المضموم) مع src/db/schema.ts:53 (journal_lines.account_code REFERENCES accounts)
 *
 * السيناريو (بيانات مصطنعة):
 *  ١) المالك يودع رأس مال ١٠٬٠٠٠٫٠٠ نقداً (مدين 1100 / دائن 3100)، ثم يأخذ نسخة احتياطية.
 *  ٢) بعد النسخة يضيف إلى دليل الحسابات حساب مصروفٍ جديداً «5155 صيانة مصاعد» (saveAccount)، ويرحّل عليه صرفاً ٢٬٠٠٠٫٠٠ نقداً.
 *  ٣) يستعيد النسخة (أي نسخةٍ أقدم من الحساب الجديد).
 * النتيجة الفعلية: التجهيز يفشل كله بـ«FOREIGN KEY constraint failed» (إنجليزية خام): planKeepPosted يضمّ قيد الصرف المرحّل بعد النسخة
 * (القيد المرحّل لا يُحذف بالاستعادة) ولا يحمل معه حسابه، فسطره على 5155 يُدرج في قاعدة نسخةٍ ليس في دليلها 5155، فيرفضه مفتاح
 * journal_lines.account_code · فلا تُستعاد النسخة أبداً ما دام على الجهاز (أو في السحابة) قيدٌ مرحّل على حسابٍ أُنشئ بعدها.
 *
 * لماذا يهم: إضافة حساب مصروفٍ أو إيرادٍ خاص استعمالٌ عادي لدليل الحسابات، والاستعادة طريق الطوارئ · فيصير كل ما قبل أول حسابٍ
 * جديد من النسخ (التصدير وDrive ونسخ الأمان وما قبل الترقية) غير قابلٍ للاستعادة، برسالةٍ لا يفهمها المالك ولا تسمّي السبب ·
 * وقرار المالك 2026-10-03 «القيد المرحّل لا يُحذف أبداً بالاستعادة» يقتضي أن يُضمّ القيد بحسابه، لا أن تمتنع الاستعادة.
 *
 * السلوك الصحيح: الاستعادة تتمّ، والقيد المضموم يبقى مرحّلاً بحسابه: يُحمل صفّ الحساب من المصدر (الجهاز أو لقطة السحابة) إلى النسخة
 * إن لم يكن فيها · فالنقدية بعد الاستعادة ١٠٬٠٠٠٫٠٠ − ٢٬٠٠٠٫٠٠ = ٨٬٠٠٠٫٠٠ (٨٠٠٬٠٠٠ هللة) كما قبلها، ورصيد 5155 هو ٢٬٠٠٠٫٠٠ (٢٠٠٬٠٠٠ هللة).
 */
import * as path from 'node:path';
import { tempDir, rmrf, memDb } from './helpers/testDb';
import { buildDoc } from '@/sync/engine';
import type { RemoteDoc } from '@/sync/types';
import { makeBackupEnv } from './helpers/backupEnv';
import { postEntry, postManualEntry } from '@/domain/accounting/post';
import { saveAccount } from '@/domain/accounting/chart';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { accountBalance } from '@/domain/accounting/ledger';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

test('قيدٌ مرحّل بعد النسخة على حسابٍ أُنشئ بعدها لا يُفشل الاستعادة: يُضمّ بحسابه والنقدية ٨٬٠٠٠٫٠٠', async () => {
  const d = tempDir('aq-r12-kept-acc-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  // ١) رأس مال ١٠٬٠٠٠٫٠٠ ثم النسخة
  postEntry(env.db, { date: '2026-03-01', memo: 'رأس مال مصطنع', lines: [
    { account: '1100', debit: 1_000_000, credit: 0 }, { account: '3100', debit: 0, credit: 1_000_000 }] });
  const archive = path.join(d, 'before-new-account.aqbk');
  await createBackup(env, archive);

  // ٢) حساب مصروفٍ جديد بعد النسخة وصرفٌ عليه ٢٬٠٠٠٫٠٠
  saveAccount(env.db, { code: '5155', name: 'صيانة مصاعد مصطنعة', type: 'مصروف', openingHalalas: 0 });
  const spend = postManualEntry(env.db, { date: '2026-03-05', memo: 'صيانة مصعد مصطنعة', lines: [
    { account: '5155', debit: 200_000, credit: 0 }, { account: '1100', debit: 0, credit: 200_000 }] })!;
  expect(accountBalance(env.db, '1100')).toBe(800_000);

  // ٣) الاستعادة
  let err: unknown = null;
  try {
    const plan = await prepareRestore(env, archive);
    expect(plan.kept.map((k) => k.id)).toContain(spend.id);
    await commitRestore(env, plan);
  } catch (e) { err = e; }
  expect(err === null ? null : String((err as Error).message)).toBeNull();

  const live = env.live();
  const entry = live.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = ?`, [spend.id]);
  expect({
    status: entry?.s ?? null,
    cash: accountBalance(live, '1100'),
    maintenance: accountBalance(live, '5155'),
  }).toEqual({ status: 'مرحّل', cash: 800_000, maintenance: 200_000 });
  env.closeLive();
});

/**
 * وفرع السحابة (المسار نفسه في الاستعادة مع الدخول بحساب، وفي adoptPendingWithKeep عند اعتماد نسخةٍ استُعيدت قبل الدخول): جهاز المالك
 * الآخر أنشأ الحساب ورحّل عليه بعد النسخة · فالقيد في لقطة السحابة والحساب معه، وليس في النسخة ولا على هذا الجهاز.
 */
test('فرع السحابة: قيدٌ مرحّل في السحابة على حسابٍ أنشأه جهازٌ آخر بعد النسخة لا يُفشل الاستعادة', async () => {
  const d = tempDir('aq-r12-kept-acc-cloud-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  postEntry(env.db, { date: '2026-03-01', memo: 'رأس مال مصطنع', lines: [
    { account: '1100', debit: 1_000_000, credit: 0 }, { account: '3100', debit: 0, credit: 1_000_000 }] });
  const archive = path.join(d, 'before-cloud-account.aqbk');
  await createBackup(env, archive);

  // جهاز المالك الآخر: الحساب الجديد وصرفٌ عليه ٢٬٠٠٠٫٠٠ · كما يصلان في لقطة السحابة
  const other = memDb();
  saveAccount(other, { code: '5155', name: 'صيانة مصاعد مصطنعة', type: 'مصروف', openingHalalas: 0 });
  const spend = postEntry(other, { date: '2026-03-05', memo: 'صيانة مصعد مصطنعة', lines: [
    { account: '5155', debit: 200_000, credit: 0 }, { account: '1100', debit: 0, credit: 200_000 }] })!;
  const at = new Date().toISOString();
  const snapshot: RemoteDoc[] = [
    buildDoc(other, 'accounts', '5155', 'upsert', at, 'DEV-OTHER'),
    buildDoc(other, 'journal_entries', spend.id, 'upsert', at, 'DEV-OTHER'),
  ];
  other.close();

  let err: unknown = null;
  try {
    const plan = await prepareRestore(env, archive, undefined, { cloud: async () => snapshot });
    expect(plan.kept.map((k) => k.id)).toContain(spend.id);
    await commitRestore(env, plan);
  } catch (e) { err = e; }
  expect(err === null ? null : String((err as Error).message)).toBeNull();
  const live = env.live();
  expect({ cash: accountBalance(live, '1100'), maintenance: accountBalance(live, '5155') }).toEqual({ cash: 800_000, maintenance: 200_000 });
  env.closeLive();
});

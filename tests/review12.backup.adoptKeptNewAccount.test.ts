/**
 * المراجعة ١٢ · R12-BAK-1 (ALSO) · اعتماد نسخةٍ استُعيدت قبل الدخول (planAdoptPending ثم adoptPendingWithKeep في cloud.ts):
 * المسار نفسه planKeepPosted ثم applyKeepPosted على القاعدة الحية بلقطة السحابة وحدها، ثم planFromSnapshot وadoptAsCloudTruth ·
 * بيانات مصطنعة والأرقام بالهللة محسوبة باليد.
 *
 * السيناريو: رأس مال ١٠٬٠٠٠٫٠٠ نقداً ثم نسخة · بعدها حساب مصروفٍ جديد 5155 وصرفٌ عليه ٢٬٠٠٠٫٠٠ نقداً، ورُفع كلاهما إلى السحابة ·
 * ثم تُستعاد النسخة خارج الحساب ويُعتمد ما فيها بعد الدخول.
 * كان: applyKeepPosted يرمي «FOREIGN KEY constraint failed» لأن سطر القيد على 5155 والحساب ليس في النسخة، فلا يُعتمد شيء.
 * الصحيح: يُحمل صفّ الحساب من لقطة السحابة مع قيده، والاعتماد لا يحذف الحساب من السحابة (لا شاهد حذف له)، وجهازٌ ينضمّ بعدها يرى
 * النقدية ١٠٬٠٠٠٫٠٠ − ٢٬٠٠٠٫٠٠ = ٨٬٠٠٠٫٠٠ (٨٠٠٬٠٠٠ هللة) و5155 = ٢٠٠٬٠٠٠ هللة.
 */
import * as path from 'node:path';
import { memDb, tempDir, rmrf } from './helpers/testDb';
import { MemoryRemote } from './helpers/memoryRemote';
import { postEntry, postManualEntry } from '@/domain/accounting/post';
import { saveAccount } from '@/domain/accounting/chart';
import { accountBalance } from '@/domain/accounting/ledger';
import { enableSync, syncOnce, readCloud, planFromSnapshot, adoptAsCloudTruth, buildDoc } from '@/sync/engine';
import { makeBackupEnv } from './helpers/backupEnv';
import { createBackup } from '@/domain/backup/create';
import { prepareRestore } from '@/domain/backup/restore';
import { planKeepPosted, applyKeepPosted } from '@/domain/backup/keepPosted';
import { openNodeDb } from '@/db/nodeAdapter';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

const UID = 'user-r12-acc';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);

let dir: string;
beforeEach(() => { dir = tempDir('aq-r12-adopt-acc-'); });
afterEach(() => rmrf(dir));

test('اعتماد نسخةٍ استُعيدت قبل الدخول: قيدٌ في السحابة على حسابٍ أُنشئ بعد النسخة يُضمّ بحسابه ولا يُحذف الحساب من السحابة', async () => {
  const r = new MemoryRemote();
  const a = memDb();
  enableSync(a, UID);
  postEntry(a, { date: '2026-03-01', memo: 'رأس مال مصطنع', lines: [
    { account: '1100', debit: 1_000_000, credit: 0 }, { account: '3100', debit: 0, credit: 1_000_000 }] });
  await sync(a, r);
  const backupFile = path.join(dir, 'before-account.db').replace(/\\/g, '/');
  a.exec(`VACUUM INTO '${backupFile}'`);

  saveAccount(a, { code: '5155', name: 'صيانة مصاعد مصطنعة', type: 'مصروف', openingHalalas: 0 });
  const spend = postManualEntry(a, { date: '2026-03-05', memo: 'صيانة مصعد مصطنعة', lines: [
    { account: '5155', debit: 200_000, credit: 0 }, { account: '1100', debit: 0, credit: 200_000 }] })!;
  await sync(a, r);
  a.close();

  // النسخة على الجهاز بلا 5155 · ثم الاعتماد كما في planAdoptPending وadoptPendingWithKeep
  const restored = openNodeDb(backupFile);
  expect(restored.get(`SELECT 1 FROM accounts WHERE code = '5155'`)).toBeUndefined();
  const snap = await readCloud(r);
  const keep = planKeepPosted(restored, { cloud: snap.docs });
  expect(keep.entries.map((e) => e.id)).toEqual([spend.id]);
  applyKeepPosted(restored, keep);
  const plan = planFromSnapshot(restored, snap);
  expect(plan.tombstones.filter((x) => x.t === 'accounts').map((x) => x.k)).toEqual([]);
  adoptAsCloudTruth(restored, UID, plan);
  await sync(restored, r);

  // جهازٌ ينضمّ بعد الاعتماد يرى ما على الجهاز المستعاد
  const c = memDb();
  enableSync(c, UID);
  await sync(c, r);
  const view = (db: DB) => ({
    status: db.get<{ s: string }>(`SELECT status AS s FROM journal_entries WHERE id = ?`, [spend.id])?.s ?? null,
    account: db.get<{ n: string }>(`SELECT name AS n FROM accounts WHERE code = '5155' AND deleted_at IS NULL`)?.n ?? null,
    cash: accountBalance(db, '1100'), // ١٬٠٠٠٬٠٠٠ − ٢٠٠٬٠٠٠ = ٨٠٠٬٠٠٠
    maintenance: accountBalance(db, '5155'), // ٢٠٠٬٠٠٠
  });
  const want = { status: 'مرحّل', account: 'صيانة مصاعد مصطنعة', cash: 800_000, maintenance: 200_000 };
  expect({ restored: view(restored), joined: view(c) }).toEqual({ restored: want, joined: want });
  restored.close(); c.close();
});

/**
 * وحسابٌ لا صفّ له في أي مصدر (قيدٌ في لقطة السحابة على حسابٍ ليس فيها ولا في النسخة ولا على الجهاز): التجهيز يُرفض برسالة عربية
 * تسمّي القيد ومبلغه والحساب، لا بـ«FOREIGN KEY constraint failed» · والبيانات الحية كما هي.
 */
test('قيدٌ مضموم على حسابٍ لا صفّ له في أي مصدر: رسالة عربية تسمّي الحساب والقيد ومبلغه بدل خطأ المفتاح', async () => {
  const env = makeBackupEnv(dir);
  postEntry(env.db, { date: '2026-03-01', memo: 'رأس مال مصطنع', lines: [
    { account: '1100', debit: 1_000_000, credit: 0 }, { account: '3100', debit: 0, credit: 1_000_000 }] });
  const archive = path.join(dir, 'no-account-anywhere.aqbk');
  await createBackup(env, archive);

  const other = memDb();
  saveAccount(other, { code: '5156', name: 'حساب مصطنع غائب', type: 'مصروف', openingHalalas: 0 });
  const spend = postEntry(other, { date: '2026-03-05', memo: 'صرف مصطنع', lines: [
    { account: '5156', debit: 200_000, credit: 0 }, { account: '1100', debit: 0, credit: 200_000 }] })!;
  // اللقطة فيها القيد وحده · مستند الحساب ليس فيها
  const snapshot = [buildDoc(other, 'journal_entries', spend.id, 'upsert', new Date().toISOString(), 'DEV-OTHER')];
  other.close();

  let msg = '';
  try { await prepareRestore(env, archive, undefined, { cloud: async () => snapshot }); } catch (e) { msg = String((e as Error).message); }
  expect(msg).not.toMatch(/FOREIGN KEY/);
  expect(msg).toContain('5156');
  expect(msg).toContain(spend.no);
  expect(msg).toContain('2,000.00'); // مجموع مدينه ٢٠٠٬٠٠٠ هللة
  // البيانات الحية لم تُمسّ: النقدية ١٬٠٠٠٬٠٠٠ كما كانت
  expect(accountBalance(env.live(), '1100')).toBe(1_000_000);
  env.closeLive();
});

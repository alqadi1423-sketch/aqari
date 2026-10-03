/**
 * نسخة كاملة قبل كل ترقية لقاعدة فيها بيانات · بالتحقق الكامل، ويُحتفظ بآخر ثلاث،
 * وإن فشلت فلا ترقية وسببها بالعربية · والنسخة تُستعاد فتعود البيانات كما كانت ثم تترقّى.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { openNodeDb } from '@/db/nodeAdapter';
import { SCHEMA_VERSION } from '@/db/schema';
import { currentSchemaVersion } from '@/db/migrations';
import { nodeFs, nodeHasher } from '@/files/nodeFs';
import type { DB } from '@/db/adapter';
import type { BackupEnv } from '@/domain/backup/types';
import { verifyArchiveAt, makeSafetyBackup, safetyBackupsDir } from '@/domain/backup/create';
import {
  upgradeState, hasUserData, makePreUpgradeBackup, guardedUpgrade, preUpgradeBackups,
  UpgradeBackupError, PRE_UPGRADE_KEEP,
} from '@/domain/backup/upgrade';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { semanticIssues } from '@/domain/backup/semantic';
import { tempDir, rmrf } from './helpers/testDb';
import { schemaAt, fill, snapshot, ins } from './helpers/oldSchema';

/** بيئة نسخ فوق قاعدة بإصدار قديم كما يجدها التطبيق الجديد عند أول فتح */
function oldEnv(root: string, v: number, withData = true): BackupEnv & { live(): DB } {
  const dbPath = path.join(root, 'data.db').replace(/\\/g, '/');
  let db = schemaAt(dbPath, v);
  if (withData) fill(db);
  return {
    get db() { return db; },
    dbPath,
    fs: nodeFs,
    hasher: nodeHasher,
    attachmentsDir: path.join(root, 'attachments').replace(/\\/g, '/'),
    tmpDir: path.join(root, 'tmp').replace(/\\/g, '/'),
    appVersion: '1.0.0-test',
    openDb: (p) => openNodeDb(p),
    closeLive: () => { try { db.close(); } catch { /* مغلقة */ } },
    reopenLive: () => { db = openNodeDb(dbPath); return db; },
    live: () => db,
  };
}

/** مرفق حقيقي على القرص بصفّيه · لنسخه والتحقق من بصمته */
async function addAttachment(env: BackupEnv, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const sha = await nodeHasher(bytes);
  env.fs.mkdirp(env.attachmentsDir);
  env.fs.write(path.join(env.attachmentsDir, `${sha}.txt`).replace(/\\/g, '/'), bytes);
  ins(env.db, 'blobs', { sha256: sha, ext: 'txt', size_bytes: bytes.byteLength, created_at: '2026-01-01' });
  ins(env.db, 'attachments', { id: 'A-' + sha.slice(0, 6), sha256: sha, entity_type: 'contract', entity_id: 'C1', kind: 'عقد', original_name: 'عقد.txt', created_at: '2026-01-01' });
  return sha;
}

let root: string;
beforeEach(() => { root = tempDir('aqari-preup-'); });
afterEach(() => rmrf(root));

test('قاعدة قديمة فيها بيانات تحتاج نسخة · وجديدة أو فارغة لا تحتاج', () => {
  const env = oldEnv(root, 16);
  expect(upgradeState(env.db)).toEqual({ from: 16, to: SCHEMA_VERSION, needsBackup: true });
  env.db.close();

  fs.mkdirSync(path.join(root, 'e'), { recursive: true });
  const empty = oldEnv(path.join(root, 'e'), 16, false);
  expect(hasUserData(empty.db)).toBe(false);
  expect(upgradeState(empty.db).needsBackup).toBe(false);
  empty.db.close();

  const fresh = openNodeDb(':memory:');
  expect(upgradeState(fresh)).toEqual({ from: 0, to: SCHEMA_VERSION, needsBackup: false });
  fresh.close();
});

test('النسخة قبل الترقية كاملة ومتحقَّق منها · ثم تُرقّى القاعدة', async () => {
  const env = oldEnv(root, 16);
  const sha = await addAttachment(env, 'مرفق ما قبل الترقية');
  const before = snapshot(env.db);

  const { from, backupPath } = await guardedUpgrade(env);
  expect(from).toBe(16);
  expect(currentSchemaVersion(env.live())).toBe(SCHEMA_VERSION);
  expect(snapshot(env.live())).toEqual(before);
  expect(backupPath).toBeTruthy();

  // الأرشيف يُعاد فتحه ويُتحقَّق منه كاملاً · بإصدار ما قبل الترقية وبمرفقه
  const { manifest } = await verifyArchiveAt(env, backupPath!);
  expect(manifest.schema_version).toBe(16);
  expect(manifest.files.map((f) => f.sha256)).toEqual([sha]);
  expect(manifest.missing_files).toEqual([]);
  expect(manifest.complete).toBe(true);
  expect(manifest.integrity.every((c) => c.ok)).toBe(true);
  expect(manifest.table_counts.contract_payments).toBe(2);
  env.live().close();
});

test('النسخة تُستعاد على تطبيق مرقّى · فتعود البيانات كما كانت ثم تترقّى في الاستعادة', async () => {
  const env = oldEnv(root, 16);
  const before = snapshot(env.db);
  const { backupPath } = await guardedUpgrade(env);
  // بعد الترقية تغيّرت البيانات · ثم استُعيدت نسخة ما قبلها
  env.live().run(`UPDATE contracts SET tenant_name = 'تغيّر بعد الترقية' WHERE id = 'C1'`);

  const plan = await prepareRestore(env, backupPath!);
  expect(plan.migrated).toBe(true);
  const res = await commitRestore(env, plan);
  expect(currentSchemaVersion(res.db)).toBe(SCHEMA_VERSION);
  expect(snapshot(res.db)).toEqual(before);
  expect(semanticIssues(res.db)).toEqual([]);
  res.db.close();
});

test('يُحتفظ بآخر ثلاث نسخ قبل الترقية · ولا تحذفها نسخة استعادة أو مسح', async () => {
  const env = oldEnv(root, 16);
  const made: string[] = [];
  for (let i = 0; i < 5; i++) {
    const at = new Date(Date.UTC(2026, 0, 1 + i));
    made.push(path.basename((await makePreUpgradeBackup(env, undefined, at)).path));
  }
  expect(preUpgradeBackups(env)).toEqual(made.slice(-PRE_UPGRADE_KEEP).reverse());

  // نسخة الأمان قبل الاستعادة تحذف سابقاتها من نوعها وحده
  await makeSafetyBackup(env, 'pre-restore');
  await makeSafetyBackup(env, 'pre-restore');
  const all = fs.readdirSync(safetyBackupsDir(env));
  expect(all.filter((n) => n.startsWith('pre-upgrade-'))).toHaveLength(PRE_UPGRADE_KEEP);
  expect(all.filter((n) => n.startsWith('pre-restore-'))).toHaveLength(1);
  env.db.close();
});

test('فشل النسخة يمنع الترقية · سبب عربي، والقاعدة بإصدارها وبنيتها وبياناتها', async () => {
  const env = oldEnv(root, 16);
  const before = snapshot(env.db);
  const shape = JSON.stringify(env.db.all(`SELECT name, sql FROM sqlite_master ORDER BY name`));

  // القرص لا يسع النسخة
  const tight: BackupEnv = { ...env, get db() { return env.live(); }, fs: { ...env.fs, usableSpace: async () => 1024 } };
  const err = await guardedUpgrade(tight).catch((e) => e);
  expect(err).toBeInstanceOf(UpgradeBackupError);
  expect(err.message).toMatch(/لم تُرقَّ بياناتك/);
  expect(err.message).toMatch(/المساحة المتاحة/);
  expect(err.message).not.toMatch(/[A-Za-z]{4,}/);

  // وحدة البصمة معطّلة
  const noHash: BackupEnv = { ...env, get db() { return env.live(); }, hasher: null };
  const err2 = await guardedUpgrade(noHash).catch((e) => e);
  expect(err2).toBeInstanceOf(UpgradeBackupError);
  expect(err2.message).toMatch(/لم تُرقَّ بياناتك/);

  expect(currentSchemaVersion(env.live())).toBe(16);
  expect(JSON.stringify(env.live().all(`SELECT name, sql FROM sqlite_master ORDER BY name`))).toBe(shape);
  expect(snapshot(env.live())).toEqual(before);
  expect(preUpgradeBackups(env)).toEqual([]);
  env.live().close();
});

test('مرفق مفقود من القرص لا يحبس المستخدم · يُسمّى في النسخة وتُوسم غير كاملة', async () => {
  const env = oldEnv(root, 16);
  const sha = await addAttachment(env, 'سيُحذف من القرص');
  fs.rmSync(path.join(env.attachmentsDir, `${sha}.txt`));
  const { backupPath } = await guardedUpgrade(env);
  const { manifest } = await verifyArchiveAt(env, backupPath!);
  expect(manifest.missing_files).toEqual([`${sha}.txt`]);
  expect(manifest.complete).toBe(false);
  expect(currentSchemaVersion(env.live())).toBe(SCHEMA_VERSION);
  env.live().close();
});

test.each([1, 3, 8, 12, 17, 19])('نسخة ما قبل الترقية تعمل على بنية الإصدار %i', async (v) => {
  const env = oldEnv(root, v);
  const { backupPath } = await guardedUpgrade(env);
  const { manifest } = await verifyArchiveAt(env, backupPath!);
  expect(manifest.schema_version).toBe(v);
  expect(currentSchemaVersion(env.live())).toBe(SCHEMA_VERSION);
  env.live().close();
});

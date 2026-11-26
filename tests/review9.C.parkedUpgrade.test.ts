/**
 * C-4 · متوسط · src/services/slotsApp.ts:20 (reopen = db.reopen(); migrate(db)) · مع src/services/accountSlots.ts:109
 *
 * السيناريو (بيانات مصطنعة): على الجوال حسابان. نسخة الحساب A مركونة في accounts/A ببنية إصدارٍ قديم (٤٠) وفيها بيانات، لأن
 * التطبيق حُدِّث والحساب B هو النشط · بوابة الترقية (UpgradeGate) نسخت قاعدة B وحدها. ثم يدخل صاحب A فيعود حسابه
 * (switchTo → restoreParked → env.reopen) فتُرقّى قاعدته من ٤٠ إلى الأحدث مباشرةً بلا نسخة ما قبل الترقية.
 *
 * لماذا يهم: قرار المالك 2026-10-03 «قبل أي ترحيلة على قاعدة فيها بيانات: نسخة كاملة بكل تحققاتها، تُحفظ محلياً، ويُحتفظ بآخر
 * ثلاث. إن فشلت النسخة لا تجري الترقية» · وهنا ترحيلةٌ على بيانات حقيقية بلا نسخة: خطأٌ في منطق هجرةٍ ما لا رجعة منه لهذا الحساب.
 * وإن رمت الهجرة على نسخةٍ مركونة فقد نُقلت ملفاتها مكان النشطة قبل ذلك، فيبقى الحساب بين الحالين.
 *
 * السلوك الصحيح: نسخة الحساب العائدة إن كانت أقدم من التطبيق وفيها بيانات لا تُرقّى إلا بعد نسخة ما قبل الترقية بالتحقق الكامل
 * (makePreUpgradeBackup) في مجلد نسخ ذلك الحساب، وفشلها يوقف العودة ويُبقي النسخة مركونة كما هي.
 */
import * as path from 'node:path';

const disk = { root: '' };
// expoFs على القرص الحقيقي · ويقبل مسار file:// كما على الجهاز (slotsApp يمرّر dbFile به)
jest.mock('@/files/expoFs', () => {
  const n = jest.requireActual('@/files/nodeFs').nodeFs;
  const p = (x: string) => x.replace(/^file:\/\//, '');
  return {
    appDataRoot: () => disk.root,
    expoFs: {
      ...n,
      read: (a: string) => n.read(p(a)), write: (a: string, b: Uint8Array) => n.write(p(a), b), exists: (a: string) => n.exists(p(a)),
      remove: (a: string) => n.remove(p(a)), mkdirp: (a: string) => n.mkdirp(p(a)), list: (a: string) => n.list(p(a)),
      rename: (a: string, b: string) => n.rename(p(a), p(b)), size: (a: string) => n.size(p(a)),
    },
  };
});

import { tempDir, rmrf } from './helpers/testDb';
import { schemaAt, fill } from './helpers/oldSchema';
import { openNodeDb } from '@/db/nodeAdapter';
import { migrate, currentSchemaVersion } from '@/db/migrations';
import { SCHEMA_VERSION } from '@/db/schema';
import { seed, ensureDeviceId } from '@/db/seed';
import { nodeFs } from '@/files/nodeFs';
import { enableSync } from '@/sync/engine';
import { switchTo, slotDir, activeAccount, upgradeReturned, hasParked } from '@/services/accountSlots';
import { appSlotEnv } from '@/services/slotsApp';
import { nodeHasher } from '@/files/nodeFs';
import { nodeCipher } from '@/files/nodeCipher';
import type { DB } from '@/db/adapter';
import type { AppDB } from '@/db/expoAdapter';
import type { BackupEnv } from '@/domain/backup/types';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

/** قاعدة التطبيق كائنٌ واحد يبقى بعد الإغلاق وإعادة الفتح كما في expoAdapter (databasePath وreopen) */
function appDbAt(file: string): AppDB {
  let conn: DB = openNodeDb(file);
  const wrapper = new Proxy({} as AppDB, {
    get: (_t, k) => {
      if (k === 'databasePath') return file;
      if (k === 'reopen') return () => { try { conn.close(); } catch { /* مغلقة */ } conn = openNodeDb(file); };
      if (k === 'close') return () => conn.close();
      const v = (conn as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(conn) : v;
    },
  });
  return wrapper;
}

/** بيئة النسخ فوق القاعدة الحية نفسها كما في backupService.appBackupEnv */
function backupEnvOf(db: AppDB, root: string, failBackup = false): BackupEnv {
  return {
    db, dbPath: db.databasePath, hasher: nodeHasher, cipher: nodeCipher,
    // قرصٌ ممتلئ لحالة فشل النسخة
    fs: failBackup ? { ...nodeFs, usableSpace: async () => 0 } : nodeFs,
    attachmentsDir: root + '/attachments', tmpDir: root + '/tmp', appVersion: '1.0.0-test',
    openDb: (p) => openNodeDb(p),
    closeLive: () => db.close(), reopenLive: () => { db.reopen(); return db; },
  };
}

/** نسخة A المركونة ببنية الإصدار ٤٠ وبياناتها، وB النشط بالبنية الأحدث */
function phone(prefix: string) {
  const root = tempDir(prefix).replace(/\\/g, '/');
  dirs.push(root);
  disk.root = root;
  const aDir = slotDir({ root }, 'ACC-A');
  nodeFs.mkdirp(aDir);
  const old = schemaAt(path.join(aDir, 'aqari.db'), 40);
  fill(old);
  old.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  old.close();
  nodeFs.mkdirp(root + '/SQLite');
  const db = appDbAt(root + '/SQLite/aqari.db');
  migrate(db); seed(db); ensureDeviceId(db);
  enableSync(db, 'ACC-B');
  return { root, db };
}

test('C-4 عودة حسابٍ مركون ببنية أقدم: لا تُرقّى بياناته بلا نسخة ما قبل الترقية', async () => {
  const root = tempDir('aq-r9c-park-').replace(/\\/g, '/');
  dirs.push(root);
  disk.root = root;

  // نسخة A المركونة ببنية الإصدار ٤٠ وبياناتها
  const aDir = slotDir({ root }, 'ACC-A');
  nodeFs.mkdirp(aDir);
  const old = schemaAt(path.join(aDir, 'aqari.db'), 40);
  fill(old);
  old.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  old.close();

  // B النشط بالبنية الأحدث
  nodeFs.mkdirp(root + '/SQLite');
  const db = appDbAt(root + '/SQLite/aqari.db');
  migrate(db); seed(db); ensureDeviceId(db);
  enableSync(db, 'ACC-B');

  const env = appSlotEnv(db);
  expect(switchTo(env, 'ACC-A')).toBe('switched');
  // عادت نسخة A ببنيتها، وتُرقّى بحراستها كما يفعل activateAccount
  expect(await upgradeReturned(env, 'ACC-A', backupEnvOf(db, root), true)).toMatch(/pre-upgrade-.*-v40\.aqbk$/);
  expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(activeAccount(db)).toBeNull(); // بيانات المصفوفة بلا حساب مسجّل · لا يغيّر المسألة

  // نسخة ما قبل الترقية لبيانات A في مجلد نسخها (backups ينتقل مع الحساب: accountSlots ITEMS)
  const backups = nodeFs.list(root + '/backups').filter((n) => n.startsWith('pre-upgrade-') && n.endsWith('-v40.aqbk'));
  expect(backups.length).toBeGreaterThan(0);
  db.close();
});

test('C-4 · فشل نسخة ما قبل الترقية: لا ترقية، وتعود نسخة A إلى مركنها كما هي، والسبب عربي', async () => {
  const { root, db } = phone('aq-r9c-park-fail-');
  const env = appSlotEnv(db);
  expect(switchTo(env, 'ACC-A')).toBe('switched');
  await expect(upgradeReturned(env, 'ACC-A', backupEnvOf(db, root, true), true)).rejects.toThrow(/لم تُرقَّ بياناتك/);
  // نسخة A مركونة ببنيتها وبياناتها لم تُمسّ، والنشطة فارغةٌ بالبنية الأحدث
  expect(hasParked(env, 'ACC-A')).toBe(true);
  const parked = openNodeDb(slotDir({ root }, 'ACC-A') + '/aqari.db');
  expect(currentSchemaVersion(parked)).toBe(40);
  expect(parked.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n).toBeGreaterThan(0);
  parked.close();
  expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n).toBe(0);
  expect(nodeFs.exists(root + '/backups') ? nodeFs.list(root + '/backups').filter((n) => n.endsWith('.aqbk')) : []).toEqual([]);
  // وإعادة المحاولة بعد معالجة السبب تكمل: نسخة ثم ترقية
  expect(switchTo(env, 'ACC-A')).toBe('switched');
  expect(await upgradeReturned(env, 'ACC-A', backupEnvOf(db, root), true)).toMatch(/-v40\.aqbk$/);
  expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
  db.close();
});

test('C-4 · نسخة حسابٍ ببنية التطبيق: لا نسخة ولا شيء', async () => {
  const { root, db } = phone('aq-r9c-park-same-');
  const env = appSlotEnv(db);
  // B يُركن ويعود ببنيته الأحدث
  expect(switchTo(env, 'ACC-A')).toBe('switched');
  await upgradeReturned(env, 'ACC-A', backupEnvOf(db, root), true);
  enableSync(db, 'ACC-A');
  expect(switchTo(env, 'ACC-B')).toBe('switched');
  expect(await upgradeReturned(env, 'ACC-B', backupEnvOf(db, root), true)).toBeNull();
  expect(activeAccount(db)).toBe('ACC-B');
  db.close();
});

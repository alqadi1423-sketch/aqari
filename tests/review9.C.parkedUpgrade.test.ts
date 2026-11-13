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
import { switchTo, slotDir, activeAccount } from '@/services/accountSlots';
import { appSlotEnv } from '@/services/slotsApp';
import type { DB } from '@/db/adapter';
import type { AppDB } from '@/db/expoAdapter';

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

test.failing('C-4 عودة حسابٍ مركون ببنية أقدم: لا تُرقّى بياناته بلا نسخة ما قبل الترقية', () => {
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
  // عادت نسخة A ورُقّيت
  expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(activeAccount(db)).toBeNull(); // بيانات المصفوفة بلا حساب مسجّل · لا يغيّر المسألة

  // نسخة ما قبل الترقية لبيانات A في مجلد نسخها (backups ينتقل مع الحساب: accountSlots ITEMS)
  const backups = nodeFs.list(root + '/backups').filter((n) => n.startsWith('pre-upgrade-') && n.endsWith('-v40.aqbk'));
  expect(backups.length).toBeGreaterThan(0);
  db.close();
});

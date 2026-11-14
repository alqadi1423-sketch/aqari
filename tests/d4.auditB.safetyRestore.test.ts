/**
 * أُصلح في الجولة نفسها: نسخة القاعدة الفارغة تُوسم «-empty» وتبقى آخرها وحدها، والقائمة بالوقت، والزرّ يقدّم ما فيه بيانات.
 * مدقق خارجي B · 35d35ab البند ١٦: «نسخة الأمان من قاعدةٍ بلا بيانات لا تحذف ما قبلها» · فصار في مجلد نسخ الأمان أكثر من ملف، وزر
 * «استعادة» في «البيانات والمساحة» (prepareRestoreFromSafety) يختار آخر الأسماء بترتيب النص: مسحٌ ثم مسحٌ يُبقي نسخة البيانات على القرص
 * ويستعيد الزرّ النسخة الفارغة · واسم «pre-wipe-» يغلب «pre-restore-» الأحدث منه · بيانات مصطنعة.
 */
import * as path from 'node:path';
import { openNodeDb } from '@/db/nodeAdapter';
import { nodeFs, nodeHasher } from '@/files/nodeFs';
import { fileDb, tempDir, rmrf } from './helpers/testDb';
import { addProperty } from './helpers/fixtures';
import { wipeAllData } from '@/domain/wipe';
import { makeSafetyBackup, safetyBackupsDir } from '@/domain/backup/create';
import type { BackupEnv } from '@/domain/backup/types';
import type { DB } from '@/db/adapter';

const mockRoot = { dir: '' };
jest.mock('expo-sharing', () => ({}));
jest.mock('expo-document-picker', () => ({}));
jest.mock('expo-file-system', () => ({ File: class {}, Paths: {} }));
jest.mock('@/db/expoAdapter', () => ({ openExpoDb: () => null }));
jest.mock('@/files/expoFs', () => {
  const n = jest.requireActual('@/files/nodeFs');
  return { expoFs: n.nodeFs, expoHasher: n.nodeHasher, appDataRoot: () => mockRoot.dir };
});
jest.mock('@/services/openTempDb', () => ({ openNodeDbCompat: (p: string) => jest.requireActual('@/db/nodeAdapter').openNodeDb(p) }));
jest.mock('@/services/cipher', () => ({ deviceCipher: undefined }));
jest.mock('@/services/backupPassword', () => ({ backupPasswordForSealing: async () => null }));
jest.mock('@/services/appLockService', () => ({ whilePrompting: (f: () => unknown) => f() }));
// eslint-disable-next-line import/first
import { prepareRestoreFromSafety } from '@/services/backupService';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** بيئة نسخٍ على المجلد root · والقاعدة الحية تُغلق وتُفتح على مسارها كما في التطبيق */
function live(root: string, dbPath: string, db0: DB) {
  const h = { db: db0 };
  const env = (): BackupEnv => ({
    db: h.db, dbPath, fs: nodeFs, hasher: nodeHasher,
    attachmentsDir: path.join(root, 'attachments'), tmpDir: path.join(root, 'tmp'), appVersion: '1.0.0-test',
    openDb: (p) => openNodeDb(p),
    closeLive: () => h.db.close(),
    reopenLive: () => { h.db = openNodeDb(dbPath); return h.db; },
  });
  /** القاعدة كما يمرّرها التطبيق (AppDB): مسارها وإعادة فتحها */
  const app = () => Object.assign(h.db, { databasePath: dbPath, reopen: () => { h.db = openNodeDb(dbPath); } }) as never;
  return { h, env, app };
}

const props = (plan: { incoming: Record<string, number> }) => plan.incoming.properties ?? 0;

describe('«استعادة» نسخة الأمان بعد البند ١٦', () => {
  test('مسحٌ ثم مسحٌ ثم «استعادة»: تُستعاد النسخة التي فيها البيانات لا نسخة القاعدة الفارغة', async () => {
    const root = tempDir('aqari-auditB-');
    mockRoot.dir = root;
    try {
      const f = fileDb(root, 'live.db');
      addProperty(f.db, { name: 'عقار نسخة الأمان المصطنع' });
      const L = live(root, f.path, f.db);
      const withData = await wipeAllData(L.env());   // نسخة الأمان الأولى: فيها العقار
      await sleep(20);
      await wipeAllData(L.env());                    // مسحٌ ثانٍ على قاعدةٍ فارغة: نسختها فارغة ولا تحذف الأولى (البند ١٦)
      const names = nodeFs.list(safetyBackupsDir(L.env())).filter((n) => n.endsWith('.aqbk')).sort();
      expect(names).toContain(path.basename(withData)); // البند ١٦ يُبقيها على القرص
      const ready = await prepareRestoreFromSafety(L.app());
      expect(ready).not.toBeNull();
      // eslint-disable-next-line no-console
      console.log('safety files:', names, '→ incoming properties:', props(ready!.plan));
      expect(props(ready!.plan)).toBe(1);
      L.h.db.close();
    } finally {
      rmrf(root);
    }
  });

  test('بعد مسحٍ ثم استعادة ملفٍ على القاعدة الفارغة: «استعادة» تأخذ أحدث نسخة (pre-restore) لا الأقدم (pre-wipe)', async () => {
    const root = tempDir('aqari-auditB-');
    mockRoot.dir = root;
    try {
      const f = fileDb(root, 'live.db');
      addProperty(f.db, { name: 'عقار قبل المسح المصطنع' });
      const L = live(root, f.path, f.db);
      await wipeAllData(L.env());                                 // pre-wipe-T1: فيها عقار واحد
      await sleep(20);
      // استعادة ملفٍ على القاعدة الفارغة تبدأ بنسخة أمان (restore.ts:353) · فارغةٌ فلا تحذف ما قبلها
      const newest = await makeSafetyBackup(L.env(), 'pre-restore'); // pre-restore-T2: الأحدث، بلا عقار
      const names = nodeFs.list(safetyBackupsDir(L.env())).filter((n) => n.endsWith('.aqbk')).sort();
      const ready = await prepareRestoreFromSafety(L.app());
      // eslint-disable-next-line no-console
      console.log('safety files:', names, 'newest:', path.basename(newest), '→ incoming properties:', props(ready!.plan));
      // بعد الإصلاح (القاعدة ٩٩): القائمة بالوقت فالأحدث (pre-restore) أولاً ولو غلب اسمُ pre-wipe حروفاً، والزرّ بلا اختيارٍ يأخذ أحدث
      // نسخةٍ فيها بيانات لا الفارغة · والنسختان تُعرضان للاختيار في الواجهة لأنهما اثنتان
      const { deviceBackups } = jest.requireActual('@/domain/backup/deviceBackups');
      expect(deviceBackups(L.env()).map((b: { kind: string; empty?: boolean }) => b.kind + (b.empty ? ':empty' : ''))).toEqual(['pre-restore:empty', 'pre-wipe']);
      expect(props(ready!.plan)).toBe(1);
      L.h.db.close();
    } finally {
      rmrf(root);
    }
  });

  test('عمليات القاعدة الفارغة تتراكم بلا سقف: عشر عمليات = عشرة ملفات تبقى', async () => {
    const root = tempDir('aqari-auditB-');
    try {
      const f = fileDb(root, 'live.db');
      const L = live(root, f.path, f.db);
      for (let i = 0; i < 10; i++) { await makeSafetyBackup(L.env(), i % 2 ? 'pre-wipe' : 'pre-restore'); await sleep(5); }
      const names = nodeFs.list(safetyBackupsDir(L.env())).filter((n) => n.endsWith('.aqbk'));
      // eslint-disable-next-line no-console
      console.log('empty-db safety files kept:', names.length);
      expect(names.length).toBeLessThanOrEqual(2);
      L.h.db.close();
    } finally {
      rmrf(root);
    }
  });
});

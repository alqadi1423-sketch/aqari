/**
 * المراجعة الشاملة 2026-11-13 · C-7 · منخفض · create.ts (ensureFreeSpace) · restore.ts · backupService.ts · UpgradeGate.tsx
 *
 * السيناريو (بيانات مصطنعة):
 *  - جوالٌ جديد (بياناته أقل من ميغا) يستعيد نسخةً كبيرة: الفحص يقيس الموجود × ٣ فيمرّ، ثم يمتلئ القرص في منتصف الاستعادة برسالة
 *    «خطأ داخلي» بدل الرقمين.
 *  - التصدير بالمشاركة و«احفظ في مجلد» بلا فحص مساحة أصلاً.
 *  - بوابة الترقية لا تتيح حذف القديم من نسخ الترقية حين لا تكفي المساحة.
 *
 * قرار المالك س١٢ (تطبيقٌ للقاعدة ٩٩، «موافق على التوصيات» 2026-11-13): الحدّ في الاستعادة الأكبر من (الحالي × ٣) و(الملف الوارد × ٣)،
 * والفحص قبل التصدير · وفي البوابة «احذف أقدم نسخة ترقية» حين يكون السبب المساحة وفيها نسخة ترقية تُحذف.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { saf } from './helpers/safMock';

const mockPick = { uri: '' as string, size: 0 };
jest.mock('expo-file-system/legacy', () => jest.requireActual('./helpers/safMock').legacyMock);
jest.mock('expo-file-system', () => jest.requireActual('./helpers/safMock').expoFsMock);
jest.mock('expo-sharing', () => ({ isAvailableAsync: async () => false }));
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: async () => (mockPick.uri
    ? { canceled: false, assets: [{ uri: mockPick.uri, size: mockPick.size }] } : { canceled: true, assets: [] }),
}));
jest.mock('@/db/expoAdapter', () => ({ openExpoDb: () => null }));
jest.mock('@/files/expoFs', () => {
  const n = jest.requireActual('@/files/nodeFs');
  return { expoFs: n.nodeFs, expoHasher: n.nodeHasher, appDataRoot: () => jest.requireActual('./helpers/safMock').saf.docRoot };
});
jest.mock('@/services/openTempDb', () => ({ openNodeDbCompat: (p: string) => jest.requireActual('@/db/nodeAdapter').openNodeDb(p) }));
jest.mock('@/services/cipher', () => ({ deviceCipher: jest.requireActual('@/files/nodeCipher').nodeCipher }));
jest.mock('@/services/backupPassword', () => ({ backupSecretForSealing: async () => 'سر النسخ المصطنع' }));
jest.mock('@/services/appLockService', () => ({ whilePrompting: (f: () => unknown) => f() }));

/* eslint-disable import/first */
import { openNodeDb } from '@/db/nodeAdapter';
import { migrate } from '@/db/migrations';
import { seed } from '@/db/seed';
import { nodeFs } from '@/files/nodeFs';
import { putAttachment } from '@/files/store';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import type { DB } from '@/db/adapter';
import { NotEnoughSpaceError } from '@/domain/backup/types';
import { createBackup, dataFootprintBytes, safetyBackupsDir } from '@/domain/backup/create';
import { prepareRestore } from '@/domain/backup/restore';
import { makePreUpgradeBackup, preUpgradeBackups, deleteOldestPreUpgradeBackup, UpgradeBackupError } from '@/domain/backup/upgrade';
import { createAndSaveToFolder, createAndShareBackup, pickAndPrepareRestore } from '@/services/backupService';
import { pickBackupFolder } from '@/services/backupFolder';
/* eslint-enable import/first */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
afterEach(() => { jest.restoreAllMocks(); mockPick.uri = ''; });

/** المساحة المتاحة كما يبلّغها الجهاز */
const usable = (n: number) => jest.spyOn(nodeFs, 'usableSpace').mockResolvedValue(n);

function appDb() {
  const root = tempDir('aqari-r14c7-').replace(/\\/g, '/');
  dirs.push(root);
  saf.reset();
  saf.docRoot = root + '/doc';
  fs.mkdirSync(saf.docRoot, { recursive: true });
  const dbPath = saf.docRoot + '/aqari.db';
  let conn: DB = openNodeDb(dbPath);
  migrate(conn);
  seed(conn);
  const db = new Proxy({} as DB, {
    get: (_t, k) => {
      if (k === 'databasePath') return dbPath;
      if (k === 'reopen') return () => { conn = openNodeDb(dbPath); };
      const v = (conn as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(conn) : v;
    },
  });
  return { db, root, folderDir: root + '/sdcard/Documents/Aqari' };
}

/** نسخةٌ كبيرة من جهازٍ آخر: مكتبة بمرفقٍ لا يُضغط (بايتات عشوائية) */
async function bigArchive(): Promise<{ archive: string; size: number }> {
  const d = tempDir('aqari-r14c7-src-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  const bytes = new Uint8Array(6 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i += 65536) require('node:crypto').randomFillSync(bytes, i, Math.min(65536, bytes.length - i));
  await putAttachment(env.filesEnv, bytes, { entityType: 'library', kind: 'other', originalName: 'مرفق مصطنع.pdf' });
  const archive = path.join(d, 'big.aqbk');
  await createBackup(env, archive);
  env.closeLive();
  return { archive, size: fs.statSync(archive).size };
}

test('C-7 · الاستعادة على جوالٍ جديد تقيس الملف الوارد: لا تبدأ ونسختها أكبر مما يسعه القرص، والرسالة بالرقمين', async () => {
  const { archive, size } = await bigArchive();
  const d = tempDir('aqari-r14c7-new-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  const here = dataFootprintBytes(env);
  expect(size).toBeGreaterThan(here * 3);
  // المتاح يسع البيانات الحالية × ٣ ولا يسع الملف الوارد × ٣
  usable(size * 2);
  const err = await prepareRestore(env, archive).catch((e: Error) => e);
  expect(err).toBeInstanceOf(NotEnoughSpaceError);
  expect((err as Error).message).toMatch(/المساحة المتاحة .* ولا تكفي · العملية تحتاج /);
  // لم يُكتب شيء في التجهيز
  expect(fs.existsSync(env.tmpDir) ? fs.readdirSync(env.tmpDir).filter((n) => n.startsWith('restore-staging')) : []).toEqual([]);
  env.closeLive();
});

test('C-7 · الاستعادة من المنتقي تفحص حجم الملف المختار قبل نسخه، وتحذف نسخة المنتقي', async () => {
  const { archive, size } = await bigArchive();
  const { db } = appDb();
  const picked = path.join(saf.docRoot, 'picker-cache.aqbk');
  fs.copyFileSync(archive, picked);
  mockPick.uri = picked;
  mockPick.size = size;
  usable(size * 2);
  const err = await pickAndPrepareRestore(db as never).catch((e: Error) => e);
  expect(err).toBeInstanceOf(NotEnoughSpaceError);
  // لم يُنسخ الملف إلى مجلد التطبيق المؤقت، ونسخة المنتقي لا تبقى تشغل القرص
  expect(fs.existsSync(saf.docRoot + '/tmp/restore-input.aqbk')).toBe(false);
  expect(fs.existsSync(picked)).toBe(false);
  db.close();
});

test('C-7 · التصدير بالمشاركة و«احفظ في مجلد» يفحصان المساحة قبل أن يبدآ', async () => {
  const { db, folderDir } = appDb();
  saf.pickDir = folderDir;
  await pickBackupFolder();
  usable(1024);
  await expect(createAndShareBackup(db as never)).rejects.toBeInstanceOf(NotEnoughSpaceError);
  await expect(createAndSaveToFolder(db as never)).rejects.toBeInstanceOf(NotEnoughSpaceError);
  expect(fs.existsSync(folderDir) ? fs.readdirSync(folderDir) : []).toEqual([]);
  expect(fs.existsSync(saf.docRoot + '/tmp') ? fs.readdirSync(saf.docRoot + '/tmp').filter((n) => n.endsWith('.aqbk')) : []).toEqual([]);
  db.close();
});

test('C-7 · بوابة الترقية: سبب المساحة يُعرف، وأقدم نسخة ترقية تُحذف وحدها', async () => {
  const d = tempDir('aqari-r14c7-gate-');
  dirs.push(d);
  const env = makeBackupEnv(d);
  // ثلاث نسخ ترقية سابقة
  for (const day of ['2026-01-01', '2026-02-01', '2026-03-01']) await makePreUpgradeBackup(env, undefined, new Date(day + 'T00:00:00Z'));
  const before = preUpgradeBackups(env);
  expect(before).toHaveLength(3);
  usable(10);
  const err = await makePreUpgradeBackup(env).catch((e: Error) => e);
  expect(err).toBeInstanceOf(UpgradeBackupError);
  expect((err as UpgradeBackupError).space).toBe(true);
  jest.restoreAllMocks();
  const gone = deleteOldestPreUpgradeBackup(env);
  expect(gone).toBe(before[2]);
  expect(preUpgradeBackups(env)).toEqual(before.slice(0, 2));
  expect(fs.existsSync(path.join(safetyBackupsDir(env), before[2]))).toBe(false);
  // وفشلٌ لغير المساحة لا يُعرض فيه الحذف
  expect(new UpgradeBackupError('سبب آخر').space).toBe(false);
  env.closeLive();
  // والزرّ في البوابة لا يظهر إلا بسبب المساحة ووجود نسخة ترقية تُحذف
  const gate = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ui', 'UpgradeGate.tsx'), 'utf8');
  expect(gate).toMatch(/spaceFix\s*&&\s*oldest\s*\?/);
  expect(gate).toMatch(/deleteOldestPreUpgradeBackup\(/);
});

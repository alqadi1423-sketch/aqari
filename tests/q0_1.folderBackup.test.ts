/**
 * ق٠-١ · النسخ بلا Drive: «احفظ في مجلد» يختاره المستخدم مرة (إطار تخزين أندرويد) · الملف المحفوظ نسخة .aqbk مشفّرة صالحة تُستعاد
 * من «استعادة من نسخة» بلا قوقل · وضياع الإذن يُقال بالعربية ويُطلب اختيار المجلد من جديد.
 * (docs/التقارير/مراجعة-شاملة-2026-11-13/F-الاستقلال-عن-قوقل.md · ٥.٣ أ و٨ ق٠-١) · بيانات مصطنعة ومجلد مؤقت.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { saf } from './helpers/safMock';

const mockPick = { uri: '' as string };
jest.mock('expo-file-system/legacy', () => jest.requireActual('./helpers/safMock').legacyMock);
jest.mock('expo-file-system', () => jest.requireActual('./helpers/safMock').expoFsMock);
jest.mock('expo-sharing', () => ({ isAvailableAsync: async () => false }));
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: async () => (mockPick.uri ? { canceled: false, assets: [{ uri: mockPick.uri }] } : { canceled: true, assets: [] }),
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
import { getSetting } from '@/repos/settings';
import { addProperty } from './helpers/fixtures';
import { tempDir, rmrf } from './helpers/testDb';
import type { DB } from '@/db/adapter';
import { createAndSaveToFolder, pickAndPrepareRestore, commitPreparedRestore } from '@/services/backupService';
import { backupFolder, pickBackupFolder, FolderAccessError, FolderMissingError } from '@/services/backupFolder';
import { t } from '@/i18n';
/* eslint-enable import/first */

const SECRET = 'سر النسخ المصطنع';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

/** قاعدة التطبيق كما يمرّرها (AppDB): مسارها، وإغلاقها وإعادة فتحها على المسار نفسه */
function appDb() {
  const root = tempDir('aqari-q01-').replace(/\\/g, '/');
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

const names = (db: DB) => db.all<{ name: string }>(`SELECT name FROM properties WHERE deleted_at IS NULL ORDER BY name`).map((r) => r.name);

describe('«احفظ في مجلد»', () => {
  test('يُختار المجلد مرة ويُحفظ · ثم تُحفظ فيه نسخة .aqbk مشفّرة تُستعاد من الملف بلا قوقل', async () => {
    const { db, folderDir } = appDb();
    addProperty(db, { name: 'عقار قبل النسخة المصطنع' });

    // لا مجلد بعد: لا حفظ، ورسالة بالعربية تطلب اختياره
    expect(backupFolder()).toBeNull();
    await expect(createAndSaveToFolder(db as never)).rejects.toBeInstanceOf(FolderMissingError);

    saf.pickDir = folderDir;
    const uri = await pickBackupFolder();
    expect(uri).toContain('content://');
    expect(backupFolder()).toBe(uri); // يُتذكَّر بعد الإغلاق: في ملفٍ بمجلد التطبيق لا في الذاكرة

    const m = await createAndSaveToFolder(db as never);
    expect(m.savedName).toMatch(/\.aqbk$/);
    const files = fs.readdirSync(folderDir);
    expect(files).toEqual([m.savedName]);
    const bytes = fs.readFileSync(path.join(folderDir, files[0]));
    expect(bytes.length).toBeGreaterThan(100);
    // مشفّرة: لا يظهر فيها اسم العقار ولا ترويسة zip
    expect(bytes.includes(Buffer.from('عقار قبل النسخة المصطنع'))).toBe(false);
    expect(bytes.subarray(0, 2).toString('latin1')).not.toBe('PK');
    // تُحسب نسخةً خارج التطبيق (قرار القاعدة ٩٩ في التقرير)
    expect(getSetting(db, 'lastExportAt')).toBeTruthy();
    expect(getSetting(db, 'lastBackupAt')).toBeTruthy();
    // لا يبقى منها شيء في مجلد التطبيق المؤقت
    expect(fs.readdirSync(saf.docRoot + '/tmp').filter((n) => n.endsWith('.aqbk'))).toEqual([]);

    // تغيّرت البيانات بعد النسخة ثم استُعيد الملف من المجلد بالمسار القائم (منتقي الملفات)
    addProperty(db, { name: 'عقار بعد النسخة المصطنع' });
    expect(names(db)).toHaveLength(2);
    const picked = path.join(saf.docRoot, 'picker-cache.aqbk');
    fs.copyFileSync(path.join(folderDir, files[0]), picked); // المنتقي ينسخ الملف المختار إلى ذاكرته المؤقتة
    mockPick.uri = picked;
    const ready = await pickAndPrepareRestore(db as never, undefined, { password: async () => SECRET });
    expect(ready).not.toBeNull();
    expect(ready!.plan.incoming.properties).toBe(1);
    await commitPreparedRestore(ready!.env, ready!.plan, ready!.archiveTmp);
    expect(names(db)).toEqual(['عقار قبل النسخة المصطنع']);
    // والملف في المجلد باقٍ كما هو
    expect(fs.readdirSync(folderDir)).toEqual([m.savedName]);
    db.close();
  });

  test('نسختان في يوم واحد: الثانية لا تكتب فوق الأولى', async () => {
    const { db, folderDir } = appDb();
    saf.pickDir = folderDir;
    await pickBackupFolder();
    const a = await createAndSaveToFolder(db as never);
    const b = await createAndSaveToFolder(db as never);
    expect(a.savedName).not.toBe(b.savedName);
    expect(fs.readdirSync(folderDir).sort()).toEqual([a.savedName, b.savedName].sort());
    db.close();
  });

  test('ضاع الإذن: رسالة عربية تطلب اختيار المجلد من جديد · لا يُبنى شيء ولا يُكتب · ثم الاختيار من جديد يعيد الحفظ', async () => {
    const { db, folderDir } = appDb();
    saf.pickDir = folderDir;
    await pickBackupFolder();
    saf.revoked = true;
    saf.calls = [];
    const before = getSetting(db, 'lastExportAt');
    const err = await createAndSaveToFolder(db as never).catch((e: Error) => e);
    expect(err).toBeInstanceOf(FolderAccessError);
    expect((err as Error).message).toBe(t('folder.lost'));
    expect((err as Error).message).toMatch(/اختر المجلد من جديد/);
    // فُحص الإذن قبل بناء النسخة: لا إنشاء ملف ولا كتابة
    expect(saf.calls.filter((c) => c.startsWith('create') || c.startsWith('write'))).toEqual([]);
    expect(fs.readdirSync(folderDir)).toEqual([]);
    expect(getSetting(db, 'lastExportAt')).toBe(before);
    // ويبقى المجلد المحفوظ كما هو حتى يختار غيره
    expect(backupFolder()).toContain('content://');

    // يختار المجلد من جديد (يمنح الإذن) فيعود الحفظ
    await pickBackupFolder();
    const m = await createAndSaveToFolder(db as never);
    expect(fs.readdirSync(folderDir)).toEqual([m.savedName]);
    db.close();
  });

  test('إلغاء نافذة اختيار المجلد لا يمسح المجلد المختار من قبل', async () => {
    const { db, folderDir } = appDb();
    saf.pickDir = folderDir;
    const first = await pickBackupFolder();
    saf.pickDir = null;
    expect(await pickBackupFolder()).toBeNull();
    expect(backupFolder()).toBe(first);
    db.close();
  });

  test('كتابةٌ ناقصة في المجلد (مزوّد قطع الملف) تُكشف بالمطابقة: يُحذف الملف ولا تُعتمد النسخة', async () => {
    const { db, folderDir } = appDb();
    saf.pickDir = folderDir;
    await pickBackupFolder();
    saf.corrupt = true;
    const before = getSetting(db, 'lastExportAt');
    const err = await createAndSaveToFolder(db as never).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/لا تطابق الأصل/);
    expect(fs.readdirSync(folderDir)).toEqual([]);
    expect(getSetting(db, 'lastExportAt')).toBe(before);
    db.close();
  });
});

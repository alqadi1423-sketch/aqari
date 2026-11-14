/**
 * ق٠-١ · «نسخك على Google Drive» (F-الاستقلال-عن-قوقل.md · ٧.٤): تُنزَّل النسخ واحدةً واحدة بالمسار القائم (downloadBackupFromDrive،
 * بمطابقة البصمة) إلى المجلد الذي اختاره المستخدم · والتالفة تُذكر ولا تُحفظ · ثم «احذف نسخ عقاري من Drive» بزرّه: deleteAllAppDataFiles
 * (ومعها المجلد الظاهر) ثم سحب الإذن (GoogleSignin.revokeAccess) · والحذف بعد إخراج الكل، أو بتأكيدٍ زائد يسمّي عدد ما لم يُخرج.
 * Drive مصطنع في الذاكرة، وإطار تخزين أندرويد مصطنع فوق مجلد مؤقت · بيانات مصطنعة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { saf } from './helpers/safMock';

jest.mock('expo-file-system/legacy', () => jest.requireActual('./helpers/safMock').legacyMock);
jest.mock('expo-file-system', () => jest.requireActual('./helpers/safMock').expoFsMock);
jest.mock('@/services/appLockService', () => ({ whilePrompting: (f: () => unknown) => f() }));

/* eslint-disable import/first */
import { uploadBackupToDrive, uploadVisibleCopy, type DriveIO, type DriveBackup } from '@/cloud/drive';
import { exportDriveBackups, deleteDriveBackups, driveExitView, emptyExitState, type DriveExitDeps, type DriveExitState } from '@/cloud/driveExit';
import { pickBackupFolder, writeToBackupFolder, FolderAccessError } from '@/services/backupFolder';
import { nodeHasher } from '@/files/nodeFs';
import { tempDir, rmrf } from './helpers/testDb';
import { t } from '@/i18n';
/* eslint-enable import/first */

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

/** Drive مصطنع: المجلد المخفي والمجلد الظاهر، والتنزيل يكتب ما على Drive فعلاً، والبصمة المسجّلة قد لا تطابقه (ملف تالف) */
function fakeDrive() {
  const files = new Map<string, { id: string; name: string; parents: string[]; folder?: boolean; app?: string; bytes: Buffer; sha: string; created: string }>();
  let pending: { name: string; parents: string[] } | null = null;
  let n = 0;
  const calls: string[] = [];
  const res = (status: number, body: unknown, location?: string) => ({
    ok: status < 300, status, text: async () => (body === null ? '' : JSON.stringify(body)), headers: { get: () => location ?? null },
  });
  const io: DriveIO = {
    fetch: (async (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      if (url.includes('uploadType=resumable')) { pending = JSON.parse(init.body!); return res(200, {}, 'https://upload/session'); }
      if (method === 'DELETE') {
        calls.push('delete');
        const id = decodeURIComponent(url.split('/files/')[1]);
        return files.delete(id) ? res(204, null) : res(404, {});
      }
      if (method === 'POST' && url.includes('/files?fields=id')) {
        const b = JSON.parse(init.body!);
        const id = 'FOLDER-' + (++n);
        files.set(id, { id, name: b.name, parents: ['root'], folder: true, app: b.appProperties?.app, bytes: Buffer.alloc(0), sha: '', created: '' });
        return res(200, { id });
      }
      if (method === 'GET' && url.includes('/files?')) {
        const q = new URL(url).searchParams;
        if (q.get('spaces') === 'appDataFolder') {
          calls.push('list');
          const list = [...files.values()].filter((f) => f.parents.includes('appDataFolder')).sort((a, b) => (a.created < b.created ? 1 : -1));
          return res(200, { files: list.map((f) => ({ id: f.id, name: f.name, size: String(f.bytes.length), createdTime: f.created, sha256Checksum: f.sha, appProperties: { app: 'aqari', encrypted: '1' } })) });
        }
        const qq = q.get('q') ?? '';
        const inParent = /'([^']+)' in parents/.exec(qq)?.[1];
        if (inParent) {
          const kids = [...files.values()].filter((f) => !f.folder && f.parents.includes(inParent));
          return res(200, { files: kids.map((f) => ({ id: f.id, name: f.name })) });
        }
        const list = [...files.values()].filter((f) => f.folder && qq.includes(`value='${f.app}'`));
        return res(200, { files: list.map((f) => ({ id: f.id, name: f.name })) });
      }
      return res(404, {});
    }) as unknown as typeof fetch,
    async putFile(_url, p) {
      const bytes = fs.readFileSync(p);
      const id = 'F' + (++n);
      files.set(id, { id, name: pending!.name, parents: pending!.parents, bytes, sha: sha(bytes), created: '2026-11-0' + n + 'T09:00:00Z' });
      return { status: 200, body: JSON.stringify({ id, name: pending!.name, size: String(bytes.length), sha256Checksum: sha(bytes) }) };
    },
    async downloadFile(url, p) {
      calls.push('download');
      const id = decodeURIComponent(url.split('/files/')[1].split('?')[0]);
      const f = files.get(id);
      if (!f) return { status: 404 };
      fs.writeFileSync(p, f.bytes);
      return { status: 200 };
    },
    sha256OfFile: async (p) => sha(new Uint8Array(fs.readFileSync(p))),
    sizeOf: (p) => fs.statSync(p).size,
  };
  return { io, files, calls };
}

/** ما كان يفعله backupToDrive: نسخة في المجلد المخفي ونسختها في الظاهر · و«تالفة» بصمتها على Drive لا تطابق محتواها */
async function seedDrive(d: ReturnType<typeof fakeDrive>, root: string, count: number, corruptIndex = -1) {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = path.join(root, 'src-' + i + '.aqbk');
    fs.writeFileSync(p, Buffer.from('نسخة مشفّرة مصطنعة رقم ' + i + ' '.repeat(i * 7)));
    const name = 'عقاري · نسخة · 2026-11-0' + (i + 1) + '.aqbk';
    const b = await uploadBackupToDrive(d.io, 'T', p, name, { encrypted: true });
    await uploadVisibleCopy(d.io, 'T', p, name, { encrypted: true });
    if (i === corruptIndex) { const f = d.files.get(b.id)!; f.bytes = Buffer.concat([f.bytes, Buffer.from('تلف')]); }
    out.push(b.id);
  }
  return out;
}

function setup(count: number, corruptIndex = -1) {
  const root = tempDir('aqari-q01-drive-').replace(/\\/g, '/');
  dirs.push(root);
  saf.reset();
  saf.docRoot = root + '/doc';
  fs.mkdirSync(saf.docRoot + '/tmp', { recursive: true });
  const folderDir = root + '/sdcard/Aqari';
  const d = fakeDrive();
  let state: DriveExitState = emptyExitState();
  const order: string[] = [];
  const deps: DriveExitDeps = {
    io: d.io,
    token: async () => 'T',
    tmpPath: (b: DriveBackup) => saf.docRoot + '/tmp/drive-exit-' + b.id + '.aqbk',
    removeTmp: (p: string) => { try { fs.rmSync(p); } catch { /* لا شيء */ } },
    save: (p: string, b: DriveBackup) => writeToBackupFolder(p, b.name, { size: fs.statSync(p).size, sha256: b.sha256, hasher: nodeHasher }).then((r) => r.name),
    load: () => state,
    store: (s: DriveExitState) => { state = s; },
    revoke: async () => { order.push('revoke:' + d.files.size); },
  };
  return { root, folderDir, d, deps, order, state: () => state, seed: () => seedDrive(d, root, count, corruptIndex) };
}

describe('إخراج نسخ Drive إلى المجلد', () => {
  test('ثلاث نسخ إحداها تالفة: تُنزَّل الاثنتان وتطابقان · والتالفة تُذكر باسمها ولا يُحفظ منها شيء', async () => {
    const s = setup(3, 1);
    const ids = await s.seed();
    saf.pickDir = s.folderDir;
    await pickBackupFolder();

    // قبل الإخراج: العدد يظهر، وزرّ الحذف لا يظهر (لا يعمل قبل إخراجٍ ناجح)
    const list0 = await (await import('@/cloud/drive')).listDriveBackups(s.d.io, 'T');
    expect(driveExitView(list0, s.state(), { folder: true })).toEqual({ count: 3, exported: 0, canExport: true, canDelete: false, unexported: 3 });

    const r = await exportDriveBackups(s.deps);
    expect(r.saved).toHaveLength(2);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].name).toBe('عقاري · نسخة · 2026-11-02.aqbk');
    expect(r.failed[0].why).toMatch(/بصمة/);
    // في المجلد النسختان السليمتان بأسمائهما ومحتواهما كما على Drive، ولا أثر للتالفة
    const inFolder = fs.readdirSync(s.folderDir).sort();
    expect(inFolder).toEqual(['عقاري · نسخة · 2026-11-01.aqbk', 'عقاري · نسخة · 2026-11-03.aqbk']);
    for (const name of inFolder) {
      const onDrive = [...s.d.files.values()].find((f) => f.name === name && f.parents.includes('appDataFolder'))!;
      expect(sha(fs.readFileSync(path.join(s.folderDir, name)))).toBe(onDrive.sha);
    }
    expect(Object.keys(s.state().exported).sort()).toEqual([ids[0], ids[2]].sort());
    // ولا يبقى شيء في مجلد التطبيق المؤقت
    expect(fs.readdirSync(saf.docRoot + '/tmp')).toEqual([]);

    // بعد محاولةٍ فشل فيها بعضها: الحذف ممكن بتأكيدٍ زائد يسمّي العدد
    const list1 = await (await import('@/cloud/drive')).listDriveBackups(s.d.io, 'T');
    expect(driveExitView(list1, s.state(), { folder: true, triedExport: true })).toEqual({ count: 3, exported: 2, canExport: true, canDelete: true, unexported: 1 });

    // إعادة الإخراج لا تنزّل ما خرج من قبل
    s.d.calls.length = 0;
    const again = await exportDriveBackups(s.deps);
    expect(again.saved).toHaveLength(0);
    expect(again.already).toBe(2);
    expect(s.d.calls.filter((c) => c === 'download')).toHaveLength(1); // التالفة وحدها تُحاوَل
    expect(fs.readdirSync(s.folderDir)).toHaveLength(2);
  });

  test('الحذف قبل إخراج الكل يُرفض ولا يُحذف شيء ولا يُسحب الإذن · وبالتأكيد الزائد بالعدد الصحيح يُحذف الكل ثم يُسحب الإذن', async () => {
    const s = setup(3, 1);
    await s.seed();
    saf.pickDir = s.folderDir;
    await pickBackupFolder();
    await exportDriveBackups(s.deps);
    const before = s.d.files.size;

    const e1 = await deleteDriveBackups(s.deps).catch((e: Error) => e);
    expect((e1 as Error).message).toBe(t('driveExit.notExported', { count: 1 }));
    // تأكيدٌ بعددٍ آخر غير الذي يُحذف لا يكفي
    const e2 = await deleteDriveBackups(s.deps, { unexportedConfirmed: 2 }).catch((e: Error) => e);
    expect((e2 as Error).message).toBe(t('driveExit.notExported', { count: 1 }));
    expect(s.d.files.size).toBe(before);
    expect(s.order).toEqual([]);
    expect(s.state().retiredAt).toBeUndefined();

    const r = await deleteDriveBackups(s.deps, { unexportedConfirmed: 1 });
    expect(r.deleted).toBe(6); // ثلاث مخفية وثلاث في المجلد الظاهر
    // لا يبقى ملف نسخة على Drive (المجلد الظاهر نفسه يبقى: قد يضع فيه المستخدم غيرها)
    expect([...s.d.files.values()].filter((f) => !f.folder)).toEqual([]);
    // سحب الإذن بعد الحذف لا قبله، ومرةً واحدة
    expect(s.order).toEqual(['revoke:1']);
    expect(s.state().retiredAt).toBeTruthy();
    // والنسخ في المجلد باقية
    expect(fs.readdirSync(s.folderDir)).toHaveLength(2);
    // وبعد السحب تختفي الشاشة
    expect(driveExitView([], s.state(), { folder: true }).canDelete).toBe(false);
  });

  test('كلها خرجت وطابقت: الحذف بلا تأكيدٍ زائد ثم سحب الإذن', async () => {
    const s = setup(2);
    await s.seed();
    saf.pickDir = s.folderDir;
    await pickBackupFolder();
    const r = await exportDriveBackups(s.deps);
    expect(r.saved).toHaveLength(2);
    expect(r.failed).toEqual([]);
    const list = await (await import('@/cloud/drive')).listDriveBackups(s.d.io, 'T');
    expect(driveExitView(list, s.state(), { folder: true })).toEqual({ count: 2, exported: 2, canExport: false, canDelete: true, unexported: 0 });
    const del = await deleteDriveBackups(s.deps);
    expect(del.deleted).toBe(4);
    expect(s.order).toEqual(['revoke:1']);
  });

  test('نسخةٌ جديدة ظهرت على Drive بعد الإخراج (من جهاز آخر) لا تُحذف بلا تأكيدٍ يسمّيها', async () => {
    const s = setup(1);
    await s.seed();
    saf.pickDir = s.folderDir;
    await pickBackupFolder();
    await exportDriveBackups(s.deps);
    const p = path.join(s.root, 'late.aqbk');
    fs.writeFileSync(p, Buffer.from('نسخة متأخرة مصطنعة'));
    await uploadBackupToDrive(s.d.io, 'T', p, 'عقاري · نسخة · 2026-11-09.aqbk', { encrypted: true });
    const e = await deleteDriveBackups(s.deps).catch((x: Error) => x);
    expect((e as Error).message).toBe(t('driveExit.notExported', { count: 1 }));
    expect(s.order).toEqual([]);
  });

  test('سحب الإذن تعذّر بعد الحذف: رسالة تقول إن النسخ حُذفت · والضغط ثانيةً يكمل السحب بلا شيءٍ يُحذف', async () => {
    const s = setup(1);
    await s.seed();
    saf.pickDir = s.folderDir;
    await pickBackupFolder();
    await exportDriveBackups(s.deps);
    let fail = true;
    s.deps.revoke = async () => { if (fail) throw new Error('network'); s.order.push('revoke'); };
    const e = await deleteDriveBackups(s.deps).catch((x: Error) => x);
    expect((e as Error).message).toBe(t('driveExit.revokeFailed'));
    expect([...s.d.files.values()].filter((f) => !f.folder)).toEqual([]);
    expect(s.state().retiredAt).toBeUndefined();
    const list = await (await import('@/cloud/drive')).listDriveBackups(s.d.io, 'T');
    expect(driveExitView(list, s.state(), { folder: true }).canDelete).toBe(true);
    fail = false;
    const r = await deleteDriveBackups(s.deps);
    expect(r.deleted).toBe(0);
    expect(s.order).toEqual(['revoke']);
    expect(s.state().retiredAt).toBeTruthy();
  });

  test('ضاع إذن المجلد أثناء الإخراج: يتوقف برسالة اختيار المجلد من جديد ولا يُسجَّل ما لم يُحفظ', async () => {
    const s = setup(2);
    await s.seed();
    saf.pickDir = s.folderDir;
    await pickBackupFolder();
    saf.revoked = true;
    const e = await exportDriveBackups(s.deps).catch((x: Error) => x);
    expect(e).toBeInstanceOf(FolderAccessError);
    expect((e as Error).message).toBe(t('folder.lost'));
    expect(s.state().exported).toEqual({});
    expect(fs.readdirSync(saf.docRoot + '/tmp')).toEqual([]);
  });

  test('بلا مجلدٍ مختار: لا يظهر زرّ التنزيل ولا الحذف · ولا شيء على Drive: الحذف وحده (لسحب الإذن)', () => {
    const st = emptyExitState();
    const fake = [{ id: 'a', name: 'x.aqbk', size: 1, createdTime: '', sha256: 'aa' }];
    expect(driveExitView(fake, st, { folder: false })).toEqual({ count: 1, exported: 0, canExport: false, canDelete: false, unexported: 1 });
    expect(driveExitView([], st, { folder: false })).toEqual({ count: 0, exported: 0, canExport: false, canDelete: true, unexported: 0 });
  });
});

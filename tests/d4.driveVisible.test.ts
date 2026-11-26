/**
 * التوجيه الرابع ٤ · ٣ (قرار المالك 2026-11-07 «نسخة في مجلد ظاهر على Drive»): مجلد «عقاري · نسخ احتياطية» في Drive المستخدم يُعرف
 * بعلامته في خصائص التطبيق، ويُنشأ مرةً ويُعاد استعماله، والنسخة الظاهرة الملف نفسه بمطابقة بصمته · والنطاقان: المجلد المخفي وما أنشأه
 * التطبيق وحده (drive.file) · بيانات مصطنعة.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { ensureVisibleFolder, uploadVisibleCopy, uploadBackupToDrive, DriveError, VISIBLE_FOLDER_NAME, type DriveIO } from '@/cloud/drive';
import { DRIVE_SCOPE, DRIVE_FILE_SCOPE } from '@/cloud/config';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function fakeDrive(o: { deny?: boolean } = {}) {
  const folders: Array<{ id: string; name: string; app: string }> = [];
  const uploads: Array<{ name: string; parents: string[] }> = [];
  const calls: string[] = [];
  let pending: { name: string; parents: string[] } | null = null;
  const res = (status: number, body: unknown, location?: string) => ({
    ok: status < 300, status, text: async () => JSON.stringify(body), headers: { get: () => location ?? null },
  });
  const io: DriveIO = {
    fetch: (async (url: string, init: { method?: string; body?: string } = {}) => {
      calls.push((init.method ?? 'GET') + ' ' + url);
      if (o.deny) return res(403, { error: { message: 'insufficientPermissions' } });
      if (url.includes('uploadType=resumable')) { pending = JSON.parse(init.body!); return res(200, {}, 'https://upload/session'); }
      if (url.includes('/files?q=') || url.includes('/files?spaces')) {
        const q = decodeURIComponent(url);
        const hit = q.includes("value='aqari-backups'") ? folders.filter((f) => f.app === 'aqari-backups') : [];
        return res(200, { files: hit.map((f) => ({ id: f.id, name: f.name })) });
      }
      if (url.includes('/files?fields=id') && init.method === 'POST') {
        const b = JSON.parse(init.body!);
        const id = 'FOLDER-' + (folders.length + 1);
        folders.push({ id, name: b.name, app: b.appProperties?.app });
        return res(200, { id });
      }
      return res(404, {});
    }) as unknown as typeof fetch,
    async putFile(_url, p) {
      const bytes = new Uint8Array(fs.readFileSync(p));
      uploads.push(pending!);
      return { status: 200, body: JSON.stringify({ id: 'F' + uploads.length, name: pending!.name, size: String(bytes.length), sha256Checksum: sha(bytes) }) };
    },
    async downloadFile() { return { status: 200 }; },
    sha256OfFile: async (p) => sha(new Uint8Array(fs.readFileSync(p))),
    sizeOf: (p) => fs.statSync(p).size,
  };
  return { io, folders, uploads, calls };
}

const file = () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drv-')), 'b.aqbk');
  fs.writeFileSync(p, Buffer.from('نسخة مشفّرة مصطنعة'));
  return p;
};

describe('مجلد النسخ الظاهر على Drive', () => {
  test('يُنشأ مرةً باسمه وعلامته، ويُعاد استعماله بعدها', async () => {
    const d = fakeDrive();
    const a = await ensureVisibleFolder(d.io, 'T');
    const b = await ensureVisibleFolder(d.io, 'T');
    expect(a).toBe(b);
    expect(d.folders).toEqual([{ id: a, name: VISIBLE_FOLDER_NAME, app: 'aqari-backups' }]);
  });

  test('النسخة الظاهرة في المجلد الظاهر، والمخفية في appDataFolder، بالملف نفسه', async () => {
    const d = fakeDrive();
    const p = file();
    await uploadBackupToDrive(d.io, 'T', p, 'n.aqbk', { encrypted: true });
    await uploadVisibleCopy(d.io, 'T', p, 'n.aqbk', { encrypted: true });
    expect(d.uploads.map((u) => u.parents)).toEqual([['appDataFolder'], [d.folders[0].id]]);
  });

  test('رفض النطاق (403) يحمل رمزه فيُطلب النطاق ثم يُعاد', async () => {
    const d = fakeDrive({ deny: true });
    const e = await ensureVisibleFolder(d.io, 'T').catch((x) => x);
    expect(e).toBeInstanceOf(DriveError);
    expect((e as DriveError).status).toBe(403);
    const svc = fs.readFileSync(path.join(__dirname, '..', 'src/services/cloud.ts'), 'utf8');
    expect(svc).toMatch(/e\.status !== 403\) throw e;\s*await whilePrompting\(\(\) => GoogleSignin\.addScopes\(\{ scopes: \[DRIVE_FILE_SCOPE\] \}\)\)/);
  });

  test('النطاقان: المجلد المخفي، وما أنشأه التطبيق وحده', () => {
    expect(DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive.appdata');
    expect(DRIVE_FILE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
    const svc = fs.readFileSync(path.join(__dirname, '..', 'src/services/cloud.ts'), 'utf8');
    expect(svc).toMatch(/scopes: \[DRIVE_SCOPE, DRIVE_FILE_SCOPE\]/);
  });
});

/**
 * أُصلح في الجولة نفسها (D٥): الحذف يشمل نسخ المجلد الظاهر، والمجلد الوهمي يسرد ملفات مجلدٍ بعينه.
 * المدقق الخارجي D · الجولة الثانية · «حذف حسابي» بعد «نسخة في مجلد ظاهر على Drive».
 *
 * ورقة «حذف حسابي» (app/settings.tsx) تَعِد: «يُحذف نهائياً ولا يُستعاد: حسابك…، ونسخ التطبيق على Google Drive…»، وdeleteMyAccount
 * (src/services/cloud.ts) يحذف بـ deleteAllAppDataFiles وحدها، وهي تسرد appDataFolder وحده (listDriveBackups: spaces=appDataFolder) ·
 * فالنسخة الثانية التي يرفعها التطبيق نفسه منذ feb6ceb في مجلد «عقاري · نسخ احتياطية» (drive.file) تبقى بعد «الحذف النهائي».
 * Drive وهمي في الذاكرة · بيانات مصطنعة.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { uploadBackupToDrive, uploadVisibleCopy, deleteAllAppDataFiles, type DriveIO } from '@/cloud/drive';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Drive وهمي: ملفاتٌ بآبائها، والسرد بحسب spaces، والحذف */
function fakeDrive() {
  const files = new Map<string, { id: string; name: string; parents: string[]; folder?: boolean; app?: string; size: number; sha: string }>();
  let pending: { name: string; parents: string[] } | null = null;
  let n = 0;
  const res = (status: number, body: unknown, location?: string) => ({
    ok: status < 300, status, text: async () => (body === null ? '' : JSON.stringify(body)), headers: { get: () => location ?? null },
  });
  const io: DriveIO = {
    fetch: (async (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      if (url.includes('uploadType=resumable')) { pending = JSON.parse(init.body!); return res(200, {}, 'https://upload/session'); }
      if (method === 'DELETE') {
        const id = decodeURIComponent(url.split('/files/')[1]);
        return files.delete(id) ? res(204, null) : res(404, {});
      }
      if (method === 'POST' && url.includes('/files?fields=id')) {
        const b = JSON.parse(init.body!);
        const id = 'FOLDER-' + (++n);
        files.set(id, { id, name: b.name, parents: ['root'], folder: true, app: b.appProperties?.app, size: 0, sha: '' });
        return res(200, { id });
      }
      if (method === 'GET' && url.includes('/files?')) {
        const q = new URL(url).searchParams;
        if (q.get('spaces') === 'appDataFolder') {
          const list = [...files.values()].filter((f) => f.parents.includes('appDataFolder'));
          return res(200, { files: list.map((f) => ({ id: f.id, name: f.name, size: String(f.size), createdTime: '2026-11-07T00:00:00Z', sha256Checksum: f.sha })) });
        }
        const qq = q.get('q') ?? '';
        // ملفات مجلدٍ بعينه (بعد الإصلاح: حذف نسخ المجلد الظاهر)
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
      const bytes = new Uint8Array(fs.readFileSync(p));
      const id = 'F' + (++n);
      files.set(id, { id, name: pending!.name, parents: pending!.parents, size: bytes.length, sha: sha(bytes) });
      return { status: 200, body: JSON.stringify({ id, name: pending!.name, size: String(bytes.length), sha256Checksum: sha(bytes) }) };
    },
    async downloadFile() { return { status: 200 }; },
    sha256OfFile: async (p) => sha(new Uint8Array(fs.readFileSync(p))),
    sizeOf: (p) => fs.statSync(p).size,
  };
  return { io, files };
}

test('«حذف حسابي» يحذف نسخ التطبيق على Drive كما تَعِد الورقة · ومنها النسخة في المجلد الظاهر', async () => {
  const d = fakeDrive();
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auditD-drv-')), 'b.aqbk');
  fs.writeFileSync(p, Buffer.from('نسخة مشفّرة مصطنعة'));
  // ما يفعله backupToDrive منذ feb6ceb: المخفية ثم الظاهرة
  await uploadBackupToDrive(d.io, 'T', p, 'عقاري · نسخة · 2026-11-07.aqbk', { encrypted: true });
  await uploadVisibleCopy(d.io, 'T', p, 'عقاري · نسخة · 2026-11-07.aqbk', { encrypted: true });
  const backupsBefore = [...d.files.values()].filter((f) => !f.folder).length;
  expect(backupsBefore).toBe(2);

  // ما يفعله deleteMyAccount على Drive (services/cloud.ts: «جاري حذف نسخك على Google Drive»)
  const deleted = await deleteAllAppDataFiles(d.io, 'T');
  const left = [...d.files.values()].filter((f) => !f.folder);
  // eslint-disable-next-line no-console
  console.log('حُذف:', deleted, '· بقي بعد «حذف حسابي»:', left.map((f) => f.name + ' في ' + f.parents.join(',')));

  // والورقة تقول للمستخدم إن «نسخ التطبيق على Google Drive» تُحذف نهائياً
  const ui = fs.readFileSync(path.join(__dirname, '..', 'app/settings.tsx'), 'utf8');
  expect(ui).toContain('ونسخ التطبيق على Google Drive');
  const svc = fs.readFileSync(path.join(__dirname, '..', 'src/services/cloud.ts'), 'utf8');
  const del = svc.slice(svc.indexOf('export async function deleteMyAccount'), svc.indexOf('export async function cloudSignOut'));
  expect(del).toMatch(/deleteAllAppDataFiles\(driveIO/);

  expect(left).toEqual([]);
});

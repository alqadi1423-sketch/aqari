/**
 * المدقق الخارجي F · الجولة الثالثة · المجلد الظاهر على Drive (D٤ وD٥) كما هو في 1f21568.
 * قرار المالك 2026-11-07 «نسخة في مجلد ظاهر على Drive» · وورقة «حذف حسابي» تَعِد بحذف «نسخ التطبيق على Google Drive» نهائياً.
 * Drive وهمي في الذاكرة يسرد كما يسرد Drive: files.list بلا pageSize يعيد مئة ومعها nextPageToken (وثائق Drive v3: pageSize الافتراضي 100).
 * بيانات مصطنعة.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { uploadBackupToDrive, uploadVisibleCopy, deleteAllAppDataFiles, type DriveIO } from '@/cloud/drive';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
type FileRec = { id: string; name: string; parents: string[]; folder?: boolean; app?: string; size: number; sha: string };

function fakeDrive() {
  const files = new Map<string, FileRec>();
  let pending: { name: string; parents: string[]; appProperties?: Record<string, string> } | null = null;
  let n = 0;
  const res = (status: number, body: unknown, location?: string) => ({
    ok: status < 300, status, text: async () => (body === null ? '' : JSON.stringify(body)), headers: { get: () => location ?? null },
  });
  /** صفحةٌ كما في Drive: pageSize الافتراضي 100، وnextPageToken لما بعدها */
  const page = (list: FileRec[], q: URLSearchParams, map: (f: FileRec) => object) => {
    const size = Number(q.get('pageSize') ?? 100);
    const from = Number(q.get('pageToken') ?? 0);
    const slice = list.slice(from, from + size);
    return res(200, { files: slice.map(map), ...(from + size < list.length ? { nextPageToken: String(from + size) } : {}) });
  };
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
          return page(list, q, (f) => ({ id: f.id, name: f.name, size: String(f.size), createdTime: '2026-11-07T00:00:00Z', sha256Checksum: f.sha }));
        }
        const qq = q.get('q') ?? '';
        const inParent = /'([^']+)' in parents/.exec(qq)?.[1];
        if (inParent) return page([...files.values()].filter((f) => !f.folder && f.parents.includes(inParent) && f.app === 'aqari'), q, (f) => ({ id: f.id, name: f.name }));
        return page([...files.values()].filter((f) => f.folder && qq.includes(`value='${f.app}'`)), q, (f) => ({ id: f.id, name: f.name }));
      }
      return res(404, {});
    }) as unknown as typeof fetch,
    async putFile(_url, p) {
      const bytes = new Uint8Array(fs.readFileSync(p));
      const id = 'F' + (++n);
      files.set(id, { id, name: pending!.name, parents: pending!.parents, app: pending!.appProperties?.app, size: bytes.length, sha: sha(bytes) });
      return { status: 200, body: JSON.stringify({ id, name: pending!.name, size: String(bytes.length), sha256Checksum: sha(bytes) }) };
    },
    async downloadFile() { return { status: 200 }; },
    sha256OfFile: async (p) => sha(new Uint8Array(fs.readFileSync(p))),
    sizeOf: (p) => fs.statSync(p).size,
  };
  return { io, files };
}

test('F8 · «حذف حسابي» يُبقي نسخ المجلد الظاهر بعد المئة: deleteVisibleCopies يقرأ صفحةً واحدة بلا pageToken', async () => {
  const d = fakeDrive();
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auditF-drv-')), 'b.aqbk');
  fs.writeFileSync(p, Buffer.from('نسخة مشفّرة مصطنعة'));
  // ١٣٠ نسخةً يدوية على مدى أشهر (backupToDrive: المخفية ثم الظاهرة · ولا تنظيف للظاهر)
  for (let i = 0; i < 130; i++) {
    const name = `عقاري · نسخة · ${i}.aqbk`;
    await uploadBackupToDrive(d.io, 'T', p, name, { encrypted: true });
    await uploadVisibleCopy(d.io, 'T', p, name, { encrypted: true });
  }
  expect([...d.files.values()].filter((f) => !f.folder).length).toBe(260);
  await deleteAllAppDataFiles(d.io, 'T');
  const left = [...d.files.values()].filter((f) => !f.folder);
  // eslint-disable-next-line no-console
  console.log('F8 · بقي بعد «حذف حسابي»:', left.length, 'نسخة · في المخفي:', left.filter((f) => f.parents.includes('appDataFolder')).length,
    '· في الظاهر:', left.filter((f) => !f.parents.includes('appDataFolder')).length);
  expect(left.length).toBe(0);
});

test('F9 (سابقٌ لـ 1f21568 في الموضع نفسه) · «رُفعت النسخة … وفيها ملاحظات» لا يظهر أبداً: uploadBackupToDrive لا يعيد notes', async () => {
  const d = fakeDrive();
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auditF-drv-')), 'b.aqbk');
  fs.writeFileSync(p, Buffer.from('نسخة مشفّرة مصطنعة'));
  // backupToDrive (services/cloud.ts) يرفع بـ { encrypted: true, notes: !!manifest.notes?.length } ويعيد ما يعيده الرفع (أو {...b, visibleFailed})
  const b = await uploadBackupToDrive(d.io, 'T', p, 'عقاري · نسخة · ملاحظات.aqbk', { encrypted: true, notes: true });
  // وsettings.tsx (doDriveBackup) يقرأ b.notes ليعرض الملاحظات، ثم b.visibleFailed
  const ui = fs.readFileSync(path.join(__dirname, '..', 'app/settings.tsx'), 'utf8');
  expect(ui).toMatch(/const b = await backupToDrive\(db, setProgress, signal\);\s*bump\(\);\s*if \(b\.notes\) notesDialog\(/);
  // eslint-disable-next-line no-console
  console.log('F9 · ما يعيده الرفع:', Object.keys(b));
  expect(b.notes).toBe(true);
});

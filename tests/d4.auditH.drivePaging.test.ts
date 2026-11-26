/**
 * المدقق الخارجي H · الجولة الرابعة · قراءة قوائم Drive كما هي في 97d0beb (src/cloud/drive.ts).
 * قرار المالك 2026-11-07 «نسخة في مجلد ظاهر على Drive» و«النسخ القديمة تبقى تُستعاد» · و«حذف حسابي» يَعِد بحذف نسخ التطبيق على Drive.
 *
 * عقد files.list في Drive v3 (مرجع الواجهة، معامل pageSize): «Partial or empty result pages are possible even before the end of the
 * files list has been reached» · والصفحة التالية بـ nextPageToken وحده، ولا تُعرف نهاية القائمة إلا بغيابه.
 * والكود يطلب fields: 'files(id)' بلا nextPageToken، ويقف عند أول صفحةٍ فارغة (drive.ts:193)، وقائمة الاستعادة صفحةٌ واحدة من خمسين
 * بلا pageToken (drive.ts:66-72).
 * Drive مقلَّد في الذاكرة بسلوكه الموثَّق · بيانات مصطنعة.
 */
import { deleteAllAppDataFiles, listDriveBackups, type DriveIO } from '@/cloud/drive';

type F = { id: string; parent: string; createdTime: string; app?: string; folderTag?: string };

/** Drive مقلَّد: يحترم pageSize وpageToken، ويعيد nextPageToken ما بقي شيء · وemptyFirst: أول صفحةٍ للمجلد الظاهر فارغة (موثَّق) */
function fakeDrive(files: F[], opts: { emptyFirst?: boolean } = {}) {
  let emptied = false;
  const calls: string[] = [];
  const res = (status: number, body: unknown) => ({
    status, ok: status >= 200 && status < 300, headers: { get: () => null },
    text: async () => (body == null ? '' : JSON.stringify(body)),
  }) as unknown as Response;
  const page = (list: F[], q: URLSearchParams, fields: (f: F) => Record<string, unknown>) => {
    const size = Number(q.get('pageSize') ?? 100);
    const start = Number(q.get('pageToken') ?? 0);
    const slice = list.slice(start, start + size);
    const next = start + size < list.length ? String(start + size) : undefined;
    return { files: slice.map(fields), ...(next ? { nextPageToken: next } : {}) };
  };
  const io: DriveIO = {
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push((init?.method ?? 'GET') + ' ' + url);
      const u = new URL(url);
      if (init?.method === 'DELETE') {
        const id = u.pathname.split('/').pop()!;
        const i = files.findIndex((f) => f.id === id);
        if (i < 0) return res(404, null);
        files.splice(i, 1);
        return res(204, null);
      }
      const q = u.searchParams;
      const query = q.get('q') ?? '';
      if (q.get('spaces') === 'appDataFolder') {
        const list = files.filter((f) => f.parent === 'appDataFolder').sort((a, b) => b.createdTime.localeCompare(a.createdTime));
        return res(200, page(list, q, (f) => ({ id: f.id, name: f.id, size: '10', createdTime: f.createdTime, appProperties: { app: 'aqari', sha256: 'x' } })));
      }
      if (query.includes('mimeType=')) {
        return res(200, { files: files.filter((f) => f.folderTag === 'aqari-backups').map((f) => ({ id: f.id })) });
      }
      const m = /'([^']+)' in parents/.exec(query);
      if (m) {
        const list = files.filter((f) => f.parent === m[1] && f.app === 'aqari');
        // الصفحة الأولى فارغة ومعها رمز التالية (موثَّق) · مرةً واحدة
        if (opts.emptyFirst && !emptied && !q.get('pageToken')) { emptied = true; return res(200, { files: [], nextPageToken: '0' }); }
        return res(200, page(list, q, (f) => ({ id: f.id })));
      }
      return res(400, { error: 'unexpected ' + url });
    }) as unknown as typeof fetch,
    putFile: async () => ({ status: 500, body: '' }),
    downloadFile: async () => ({ status: 500 }),
    sha256OfFile: async () => '',
    sizeOf: () => 0,
  };
  return { io, files, calls };
}

const day = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString();

test('H5 · «حذف حسابي»: صفحةٌ فارغةٌ أولى من Drive (موثَّقة مع nextPageToken) توقف حذف المجلد الظاهر فتبقى النسخ', async () => {
  const files: F[] = [{ id: 'FOLDER', parent: 'root', createdTime: day(0), folderTag: 'aqari-backups' }];
  for (let i = 0; i < 3; i++) files.push({ id: 'V' + i, parent: 'FOLDER', createdTime: day(i), app: 'aqari' });
  const d = fakeDrive(files, { emptyFirst: true });
  const n = await deleteAllAppDataFiles(d.io, 'tok');
  const left = d.files.filter((f) => f.parent === 'FOLDER').map((f) => f.id);
  const listCall = d.calls.find((c) => c.includes('in+parents') || c.includes('in%20parents')) ?? '';
  // eslint-disable-next-line no-console
  console.log('H5 · حُذف:', n, '· بقي في المجلد الظاهر:', left, '· وحقول الطلب:', new URL(listCall.split(' ')[1]).searchParams.get('fields'));
  expect(left).toEqual([]);
});

test('H6 · قائمة الاستعادة من Drive خمسون نسخةً بلا صفحة تالية: النسخة الحادية والخمسون وما قبلها (في المجلد المخفي) لا تُستعاد من التطبيق', async () => {
  // ستون نسخةً مخفية (appDataFolder لا يراه المستخدم في Drive) · أقدمها من قبل التشفير الإجباري
  const files: F[] = [];
  for (let i = 0; i < 60; i++) files.push({ id: 'H' + i, parent: 'appDataFolder', createdTime: day(i), app: 'aqari' });
  const d = fakeDrive(files);
  const list = await listDriveBackups(d.io, 'tok');
  const oldest = 'H0';
  // eslint-disable-next-line no-console
  console.log('H6 · في قائمة الاستعادة:', list.length, 'من 60 · أقدم ما فيها:', list[list.length - 1]?.createdTime, '· وفيها الأقدم (H0):', list.some((b) => b.id === oldest));
  expect(list.some((b) => b.id === oldest)).toBe(true);
});

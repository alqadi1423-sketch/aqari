/**
 * النسخ على Google Drive · نطاق drive.appdata وحده: مجلد مخفي يخصّ التطبيق، لا يرى غيره
 * من ملفات المستخدم ولا يراه غيره.
 *
 *  - الرفع: ملف .aqbk نفسه بعد اجتيازه كل تحققات الإنشاء · رفعٌ مستأنَف يبثّ الملف من القرص،
 *    ثم تُقارن بصمة SHA-256 التي حسبها Drive ببصمة الملف المحلي، وعدم التطابق يحذف المرفوع ويرفض.
 *  - الاستعادة: تنزيل إلى القرص ثم مطابقة البصمة ثم مسار الاستعادة المحلي نفسه بكل ضماناته.
 * منطق خالص · النقل الفعلي يُحقن (expo-file-system على الجهاز، ونسخة وهمية في الاختبارات).
 */
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveIO {
  fetch: typeof fetch;
  /** PUT يبثّ الملف من القرص · يعيد الحالة ونصّ الرد */
  putFile(url: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }>;
  /** GET إلى ملف على القرص */
  downloadFile(url: string, path: string, headers: Record<string, string>): Promise<{ status: number }>;
  sha256OfFile(path: string): Promise<string>;
  sizeOf(path: string): number;
}

export interface DriveBackup {
  id: string;
  name: string;
  size: number;
  createdTime: string;
  sha256: string;
}

export class DriveError extends Error {
  constructor(detail: string) {
    super('Google Drive: ' + detail);
    this.name = 'DriveError';
  }
}

function auth(token: string, extra: Record<string, string> = {}) {
  return { Authorization: 'Bearer ' + token, ...extra };
}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new DriveError(`رُفض الوصول أثناء ${what} · سجّل الدخول من جديد`);
  if (!res.ok) throw new DriveError(`تعذّر ${what} (${res.status})`);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function listDriveBackups(io: DriveIO, token: string): Promise<DriveBackup[]> {
  const q = new URLSearchParams({
    spaces: 'appDataFolder',
    orderBy: 'createdTime desc',
    pageSize: '50',
    fields: 'files(id,name,size,createdTime,sha256Checksum,appProperties)',
  });
  const res = await io.fetch(`${API}/files?${q.toString()}`, { headers: auth(token) });
  const j = await json<{ files?: Array<{ id: string; name: string; size?: string; createdTime: string; sha256Checksum?: string; appProperties?: Record<string, string> }> }>(res, 'قراءة النسخ');
  return (j.files ?? []).map((f) => ({
    id: f.id, name: f.name, size: Number(f.size ?? 0), createdTime: f.createdTime,
    sha256: (f.sha256Checksum ?? f.appProperties?.sha256 ?? '').toLowerCase(),
  }));
}

async function remoteSha(io: DriveIO, token: string, id: string): Promise<{ sha: string; size: number }> {
  // Drive يحسب البصمة بعد اكتمال الرفع · قد تتأخر لحظة
  for (let i = 0; i < 5; i++) {
    const res = await io.fetch(`${API}/files/${id}?fields=id,size,sha256Checksum`, { headers: auth(token) });
    const j = await json<{ size?: string; sha256Checksum?: string }>(res, 'قراءة بصمة النسخة المرفوعة');
    if (j.sha256Checksum) return { sha: j.sha256Checksum.toLowerCase(), size: Number(j.size ?? 0) };
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return { sha: '', size: 0 };
}

/**
 * رفع نسخة · البصمة المحلية تُحسب من الملف على القرص، وبصمة Drive تُقرأ بعد الرفع ·
 * أي اختلاف يحذف المرفوع ويرفض برسالة تسمّي الملف.
 */
export async function uploadBackupToDrive(io: DriveIO, token: string, path: string, name: string): Promise<DriveBackup> {
  const local = (await io.sha256OfFile(path)).toLowerCase();
  const size = io.sizeOf(path);
  const init = await io.fetch(`${UPLOAD}/files?uploadType=resumable&fields=id,name,size,createdTime,sha256Checksum`, {
    method: 'POST',
    headers: auth(token, {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': String(size),
    }),
    body: JSON.stringify({ name, parents: ['appDataFolder'], appProperties: { app: 'aqari', sha256: local } }),
  });
  if (init.status === 401 || init.status === 403) throw new DriveError('رُفض الوصول عند بدء الرفع · سجّل الدخول من جديد');
  const session = init.headers.get('Location') ?? init.headers.get('location');
  if (!init.ok || !session) throw new DriveError(`تعذّر بدء رفع «${name}» (${init.status})`);
  const put = await io.putFile(session, path, { 'Content-Type': 'application/octet-stream' });
  if (put.status < 200 || put.status >= 300) throw new DriveError(`انقطع رفع «${name}» (${put.status})`);
  const f = JSON.parse(put.body || '{}') as { id: string; name: string; size?: string; createdTime?: string; sha256Checksum?: string };
  let sha = (f.sha256Checksum ?? '').toLowerCase();
  let remoteSize = Number(f.size ?? 0);
  if (!sha) ({ sha, size: remoteSize } = await remoteSha(io, token, f.id));
  if (sha !== local || remoteSize !== size) {
    try { await io.fetch(`${API}/files/${f.id}`, { method: 'DELETE', headers: auth(token) }); } catch { /* يبقى بلا قيمة */ }
    throw new DriveError(`بصمة «${name}» على Drive لا تطابق الملف المحلي · حُذف المرفوع ولم تُعتمد النسخة`);
  }
  return { id: f.id, name: f.name ?? name, size, createdTime: f.createdTime ?? new Date().toISOString(), sha256: sha };
}

/** تنزيل نسخة إلى مسار محلي ومطابقة بصمتها · المطابقة شرط قبل أن يبدأ مسار الاستعادة */
export async function downloadBackupFromDrive(io: DriveIO, token: string, b: DriveBackup, path: string): Promise<void> {
  const res = await io.downloadFile(`${API}/files/${b.id}?alt=media`, path, auth(token));
  if (res.status === 401 || res.status === 403) throw new DriveError('رُفض الوصول عند التنزيل · سجّل الدخول من جديد');
  if (res.status < 200 || res.status >= 300) throw new DriveError(`تعذّر تنزيل «${b.name}» (${res.status})`);
  const local = (await io.sha256OfFile(path)).toLowerCase();
  if (!b.sha256 || local !== b.sha256) {
    throw new DriveError(`بصمة «${b.name}» بعد التنزيل لا تطابق بصمتها على Drive · رُفضت الاستعادة`);
  }
}

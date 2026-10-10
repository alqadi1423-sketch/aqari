/**
 * ملفات المنشأة في Firebase Storage (النموذج المختلط · قرار المالك ٢٠٢٦-١٠-٠٧) · عبر واجهة REST نفسها التي
 * يستعملها محاكي Storage، والنقل الفعلي يُحقن (expo-file-system على الجهاز، وfetch في الاختبارات).
 *
 *  - المسار: orgs/{org}/files/{بصمة}.{امتداد} · ملفٌ واحد للبصمة الواحدة مهما تكرر ربطه.
 *  - البيانات الوصفية: g رموز رؤية الملف («قسم|عقار» مفصولة بفواصل) تقرؤها قواعد التخزين مع مستند العضوية،
 *    وop قسم العملية التي ترفعه، وmd5 الذي حسبه الجهاز فترفض القاعدة رفعاً يخالف ما حسبه الخادم، وsha256 للمطابقة بعد التنزيل.
 *  - الرفع بالبروتوكول القابل للاستئناف (بدءٌ ثم رفعٌ وختم)، والتنزيل إلى ملف ثم مطابقة البصمة في cloudFiles.ts.
 */
import { throwIfCancelled, type CancelSignal } from '../domain/progress';

export interface StorageIO {
  fetch: typeof fetch;
  /** إرسال الملف من القرص (طلب واحد) · onBytes بالمرسَل والكلي، والإلغاء يرمي CancelledError */
  sendFile(url: string, path: string, method: 'POST' | 'PUT', headers: Record<string, string>,
    onBytes?: (done: number, total: number) => void, signal?: CancelSignal): Promise<{ status: number; body: string }>;
  /** GET إلى ملف على القرص */
  downloadFile(url: string, path: string, headers: Record<string, string>,
    onBytes?: (done: number, total: number) => void, signal?: CancelSignal): Promise<{ status: number }>;
  /** MD5 بترميز base64 كما يعيده Storage في md5Hash */
  md5OfFile(path: string): Promise<string>;
  sizeOf(path: string): number;
}

export interface StorageTarget {
  /** https://firebasestorage.googleapis.com أو عنوان المحاكي http://127.0.0.1:9199 */
  base: string;
  bucket: string;
  org: string;
  idToken: () => Promise<string>;
}

export class StorageError extends Error {
  constructor(public status: number, detail: string) {
    super(detail);
    this.name = 'StorageError';
  }
}

export interface RemoteFile {
  name: string;
  size: number;
  md5: string;
  /** رموز الرؤية المكتوبة على الملف */
  g: string[];
}

export const filesPrefix = (org: string) => `orgs/${org}/files/`;
export const objectName = (org: string, sha256: string, ext: string) => `${filesPrefix(org)}${sha256}.${ext}`;
const objUrl = (t: StorageTarget, name: string) => `${t.base}/v0/b/${t.bucket}/o/${encodeURIComponent(name)}`;
const auth = async (t: StorageTarget, extra: Record<string, string> = {}) =>
  ({ Authorization: 'Firebase ' + (await t.idToken()), ...extra });

function failure(status: number, what: string): StorageError {
  if (status === 401 || status === 403) return new StorageError(status, `رُفض الوصول إلى الملف أثناء ${what} · ليس من صلاحيتك أو انتهت الجلسة`);
  if (status === 404) return new StorageError(status, `الملف غير موجود في الخادم أثناء ${what}`);
  return new StorageError(status, `تعذّر ${what} (${status})`);
}

const splitG = (g: unknown): string[] => (typeof g === 'string' && g ? g.split(',') : []);

/** بيانات الملف في الخادم · null إن لم يوجد */
export async function statObject(io: StorageIO, t: StorageTarget, name: string): Promise<RemoteFile | null> {
  const res = await io.fetch(objUrl(t, name), { headers: await auth(t) });
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw failure(res.status, 'قراءة بيانات الملف');
  const j = JSON.parse(text || '{}') as { name: string; size?: string | number; md5Hash?: string; metadata?: Record<string, string> };
  return { name: j.name, size: Number(j.size ?? 0), md5: j.md5Hash ?? '', g: splitG(j.metadata?.g) };
}

export interface UploadMeta {
  /** رموز الرؤية كلها لمرفقات هذه البصمة */
  g: string[];
  /** قسم العملية · المالك بلا قسم */
  op: string | null;
  sha256: string;
  md5: string;
  contentType: string;
}

/**
 * رفع ملف · بدءُ جلسةٍ قابلة للاستئناف ثم رفعه وختمه، ثم مطابقة md5 الذي حسبه الخادم بما حسبه الجهاز ·
 * يعيد بيانات الملف كما سجّلها الخادم.
 */
export async function uploadObject(
  io: StorageIO, t: StorageTarget, name: string, path: string, meta: UploadMeta,
  opts: { onBytes?: (done: number, total: number) => void; signal?: CancelSignal } = {},
): Promise<RemoteFile> {
  throwIfCancelled(opts.signal);
  const size = io.sizeOf(path);
  const metadata: Record<string, string> = { g: meta.g.join(','), sha256: meta.sha256, md5: meta.md5 };
  if (meta.op) metadata.op = meta.op;
  const start = await io.fetch(`${t.base}/v0/b/${t.bucket}/o?name=${encodeURIComponent(name)}&uploadType=resumable`, {
    method: 'POST',
    headers: await auth(t, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': meta.contentType,
    }),
    body: JSON.stringify({ name, contentType: meta.contentType, metadata }),
  });
  if (!start.ok) throw failure(start.status, 'بدء رفع الملف');
  const session = start.headers.get('X-Goog-Upload-URL') ?? start.headers.get('x-goog-upload-url');
  if (!session) throw new StorageError(start.status, 'الخادم لم يعطِ جلسة رفع');
  const put = await io.sendFile(session, path, 'POST', await auth(t, {
    'X-Goog-Upload-Protocol': 'resumable',
    'X-Goog-Upload-Command': 'upload, finalize',
    'X-Goog-Upload-Offset': '0',
    'Content-Type': meta.contentType,
  }), opts.onBytes, opts.signal);
  throwIfCancelled(opts.signal);
  if (put.status < 200 || put.status >= 300) throw failure(put.status, 'رفع الملف');
  const j = JSON.parse(put.body || '{}') as { name?: string; size?: string | number; md5Hash?: string; metadata?: Record<string, string> };
  const got: RemoteFile = { name: j.name ?? name, size: Number(j.size ?? 0), md5: j.md5Hash ?? '', g: splitG(j.metadata?.g) };
  if (got.md5 !== meta.md5 || got.size !== size) {
    throw new StorageError(0, 'بصمة الملف في الخادم لا تطابق الملف على الجهاز · لم يُعتمد رفعه ويُعاد لاحقاً');
  }
  return got;
}

/** يضمّ رموز رؤيةٍ جديدة إلى ملفٍ قائم (بصمةٌ رُبطت بجهةٍ أخرى) · القواعد لا تجيز إلا الزيادة */
/** أقصى ما يُضاف من رموز في تعديلٍ واحد · القواعد تفحص كل رمزٍ مضاف بموضعه (storage.rules: addedOk) */
export const MAX_TOKENS_PER_PATCH = 6;

export async function addTokens(io: StorageIO, t: StorageTarget, name: string, current: RemoteFile, g: string[]): Promise<void> {
  const missing = [...new Set(g)].filter((x) => !current.g.includes(x)).sort();
  let have = [...current.g];
  for (let i = 0; i < missing.length; i += MAX_TOKENS_PER_PATCH) {
    have = [...new Set([...have, ...missing.slice(i, i + MAX_TOKENS_PER_PATCH)])].sort();
    const res = await io.fetch(objUrl(t, name), {
      method: 'PATCH',
      headers: await auth(t, { 'Content-Type': 'application/json; charset=utf-8' }),
      body: JSON.stringify({ metadata: { g: have.join(',') } }),
    });
    if (!res.ok) throw failure(res.status, 'تحديث رؤية الملف');
  }
}

/** تنزيل ملف إلى مسار · المطابقة بالبصمة على من ينادي */
export async function downloadObject(
  io: StorageIO, t: StorageTarget, name: string, dest: string,
  opts: { onBytes?: (done: number, total: number) => void; signal?: CancelSignal } = {},
): Promise<void> {
  throwIfCancelled(opts.signal);
  const res = await io.downloadFile(objUrl(t, name) + '?alt=media', dest, await auth(t), opts.onBytes, opts.signal);
  throwIfCancelled(opts.signal);
  if (res.status < 200 || res.status >= 300) throw failure(res.status, 'تنزيل الملف');
}

/** أسماء الملفات تحت بادئة · صفحات حتى آخرها */
export async function listObjects(io: StorageIO, t: StorageTarget, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let page = '';
  for (;;) {
    const q = `prefix=${encodeURIComponent(prefix)}${page ? '&pageToken=' + encodeURIComponent(page) : ''}`;
    const res = await io.fetch(`${t.base}/v0/b/${t.bucket}/o?${q}`, { headers: await auth(t) });
    const text = await res.text();
    if (!res.ok) throw failure(res.status, 'قراءة قائمة الملفات');
    const j = JSON.parse(text || '{}') as { items?: Array<{ name: string }>; nextPageToken?: string };
    out.push(...(j.items ?? []).map((x) => x.name));
    if (!j.nextPageToken) return out;
    page = j.nextPageToken;
  }
}

export async function deleteObject(io: StorageIO, t: StorageTarget, name: string): Promise<void> {
  const res = await io.fetch(objUrl(t, name), { method: 'DELETE', headers: await auth(t) });
  if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw failure(res.status, 'حذف الملف');
}

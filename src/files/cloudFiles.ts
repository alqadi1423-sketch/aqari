/**
 * مزامنة الملفات بالنموذج المختلط (قرار المالك ٢٠٢٦-١٠-٠٧):
 *  - البيانات على الجهاز وتُزامَن، والملف أصله في الخادم (Firebase Storage) ولا يُنزَّل إلا حين يُفتح.
 *  - أول دخول على جهاز جديد يسحب البيانات وحدها: صفوف المرفقات تصل، وملفاتها تبقى في الخادم.
 *  - الملف المنزَّل يبقى في ذاكرة مؤقتة على الجهاز ليُفتح بلا اتصال، ولها حدّ يُحذف عنده الأقدم استعمالاً،
 *    وزرٌّ في الإعدادات يفرّغها · وما لم يُرفع لا يُحذف من الجهاز أبداً.
 *  - الملف الجديد يُرفع في الخلفية (طابور مستقل عن طابور البيانات) ويبقى على الجهاز حتى يُرفع وتطابق بصمته.
 *  - التنزيل يُطابَق بـ SHA-256 على اسمه، فما خالفه يُحذف ولا يُعرض.
 * حال كل ملف على هذا الجهاز في file_cache (الهجرة ٢٧): صفٌّ لكل ملفٍ موجودٍ هنا، وuploaded=1 لما في الخادم.
 */
import type { DB } from '../db/adapter';
import type { FS, Hasher } from './fsAdapter';
import { blobPath } from './store';
import type { Access } from '../domain/access/access';
import { level } from '../domain/access/access';
import { readSectionsOf } from '../domain/access/readSections';
import { rowPids, tokensFor } from '../sync/acl';
import type { RowData } from '../sync/types';
import { CancelledError, isCancelled, throwIfCancelled, type CancelSignal, type ProgressFn } from '../domain/progress';
import {
  addTokens, downloadObject, objectName, statObject, uploadObject, type StorageIO, type StorageTarget,
} from '../cloud/storage';

export interface CloudFilesEnv {
  db: DB;
  fs: FS;
  hasher: Hasher;
  attachmentsDir: string;
}

/** الاتصال بالخادم · غائبٌ على جهاز بلا مزامنة أو قبل تفعيل التخزين، فيبقى كل شيء محلياً كما كان */
export interface FilesRemote {
  io: StorageIO;
  target: StorageTarget;
  access: Access;
}

export class FileUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'FileUnavailableError';
  }
}

const nowIso = () => new Date().toISOString();
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
const contentTypeOf = (ext: string) => MIME[ext] ?? 'application/octet-stream';

/* ═══════════ حال الملف على الجهاز ═══════════ */

export type FileState = 'local' | 'uploading' | 'remote';

/** موجودٌ هنا ورُفع · موجودٌ هنا ولم يُرفع بعد · في الخادم وحده */
export function fileState(env: CloudFilesEnv, sha256: string, ext: string): FileState {
  const row = env.db.get<{ uploaded: number }>(`SELECT uploaded FROM file_cache WHERE sha256 = ?`, [sha256]);
  const here = env.fs.exists(blobPath(env, sha256, ext));
  if (!here) return 'remote';
  return row && Number(row.uploaded) === 1 ? 'local' : 'uploading';
}

/** الملفات المنتظرة الرفع (موجودة هنا ولم تطابق في الخادم بعد) */
export function pendingUploads(db: DB): Array<{ sha256: string; ext: string; bytes: number; attempts: number }> {
  return db.all(`SELECT sha256, ext, bytes, attempts FROM file_cache WHERE uploaded = 0 ORDER BY last_used`);
}

/**
 * رموز رؤية الملف ومن يرفعه · اتحاد رموز كل مرفقٍ يشير إلى بصمته (الملف الواحد قد يرتبط بأكثر من جهة) ·
 * والعضو يرفع بقسمٍ له فيه «إدخال» من أقسام قرّائه.
 */
export function fileVisibility(db: DB, sha256: string, access: Access): { g: string[]; op: string | null; groups: Array<{ att: string; g: string[] }> } {
  const rows = db.all<RowData>(`SELECT * FROM attachments WHERE sha256 = ? ORDER BY id`, [sha256]);
  const g = new Set<string>();
  const groups: Array<{ att: string; g: string[] }> = [];
  let op: string | null = null;
  for (const r of rows) {
    const readers = readSectionsOf('attachments', r as Record<string, unknown>);
    // رموز صفّ المرفق كما يرفعها الجهاز في Firestore (annotate) · العضو يضمّها إلى الملف بربط هذا الصف (storage.rules: linkedOk)
    const own = tokensFor(readers, rowPids(db, 'attachments', r));
    groups.push({ att: String(r.id), g: own });
    for (const tkn of own) g.add(tkn);
    if (!access.owner && !op) op = readers.find((s) => level(access, s) >= 2) ?? null;
  }
  return { g: [...g].sort(), op: access.owner ? null : op, groups };
}

/* ═══════════ الرفع في الخلفية ═══════════ */

export interface PumpResult { uploaded: number; failed: number; lost: number }

/**
 * يرفع ما ينتظر الرفع · ملفٌ في الخادم ببصمته نفسها لا يُرفع ثانيةً (تُضمّ رموز رؤيته إن نقصت) ·
 * وكل ملف يُتحقق بعد رفعه بـ md5 الذي حسبه الخادم · والفشل يُسجَّل على الملف ويُعاد في الدورة التالية،
 * والملف يبقى على الجهاز.
 */
export async function pumpUploads(
  env: CloudFilesEnv, remote: FilesRemote,
  opts: { onProgress?: ProgressFn; signal?: CancelSignal; max?: number } = {},
): Promise<PumpResult> {
  const out: PumpResult = { uploaded: 0, failed: 0, lost: 0 };
  const queue = pendingUploads(env.db).slice(0, opts.max ?? Infinity);
  const total = queue.reduce((n, q) => n + Number(q.bytes), 0);
  let done = 0;
  for (const f of queue) {
    throwIfCancelled(opts.signal);
    const path = blobPath(env, f.sha256, f.ext);
    if (!env.fs.exists(path)) {
      // سجلٌّ بلا ملف (حُذف من القرص خارج التطبيق) · لا شيء يُرفع منه
      env.db.run(`DELETE FROM file_cache WHERE sha256 = ?`, [f.sha256]);
      out.lost++;
      continue;
    }
    const name = objectName(remote.target.org, f.sha256, f.ext);
    try {
      const vis = fileVisibility(env.db, f.sha256, remote.access);
      const md5 = await remote.io.md5OfFile(path);
      const there = await statObject(remote.io, remote.target, name);
      // العضو يرفع برموز أول صفّ مرفقٍ للملف ويضمّ رموز كل صفٍّ بربطه (المتحقق المستقل: كانت الرموز كلها تُضمّ معاً فترفض القواعد
      // رمز قسمٍ لا يكتب فيه، ويُعاد الملف كل دورة) · والمالك برموزه كلها كما كان
      const member = !remote.access.owner;
      const first = member ? vis.groups[0] ?? null : null;
      let cur = there && there.md5 === md5 ? there : null;
      if (!cur) {
        cur = await uploadObject(remote.io, remote.target, name, path,
          { g: first ? first.g : vis.g, op: vis.op, sha256: f.sha256, md5, contentType: contentTypeOf(f.ext), ...(first ? { att: first.att } : {}) },
          {
            signal: opts.signal,
            onBytes: (d) => opts.onProgress?.('جاري رفع الملفات', { done: done + d, total, unit: 'bytes' }),
          });
      }
      if (member) {
        for (const grp of vis.groups) {
          if (!grp.g.some((x) => !cur!.g.includes(x))) continue;
          await addTokens(remote.io, remote.target, name, cur, grp.g, grp.att);
          cur = { ...cur, g: [...new Set([...cur.g, ...grp.g])].sort() };
        }
      } else if (vis.g.some((x) => !cur!.g.includes(x))) {
        await addTokens(remote.io, remote.target, name, cur, vis.g);
      }
      env.db.run(`UPDATE file_cache SET uploaded = 1, attempts = 0, last_error = NULL WHERE sha256 = ?`, [f.sha256]);
      out.uploaded++;
    } catch (e) {
      if (isCancelled(e)) throw e;
      env.db.run(`UPDATE file_cache SET attempts = attempts + 1, last_error = ? WHERE sha256 = ?`,
        [(e instanceof Error ? e.message : String(e)).slice(0, 300), f.sha256]);
      out.failed++;
    }
    done += Number(f.bytes);
    opts.onProgress?.('جاري رفع الملفات', { done, total, unit: 'bytes' });
  }
  return out;
}

/* ═══════════ التنزيل عند الفتح ═══════════ */

/**
 * مسار الملف على الجهاز · يُنزَّل من الخادم إن لم يكن هنا ثم يُطابَق ببصمته ·
 * وبلا اتصال (أو قبل تفعيل التخزين) يُرمى بسببٍ يُعرض للمستخدم.
 */
export async function ensureLocal(
  env: CloudFilesEnv, remote: FilesRemote | null, sha256: string, ext: string,
  opts: { onProgress?: ProgressFn; signal?: CancelSignal; online?: boolean; cacheLimit?: number } = {},
): Promise<string> {
  const path = blobPath(env, sha256, ext);
  if (env.fs.exists(path)) {
    env.db.run(`UPDATE file_cache SET last_used = ? WHERE sha256 = ?`, [nowIso(), sha256]);
    return path;
  }
  if (!remote) throw new FileUnavailableError('الملف ليس على هذا الجهاز · ويُنزَّل من الخادم حين يُفعَّل تخزين الملفات');
  if (opts.online === false) throw new FileUnavailableError('الملف لم يُنزَّل على هذا الجهاز بعد · يُفتح حين يعود الاتصال');
  const size = Number(env.db.get<{ n: number }>(`SELECT size_bytes AS n FROM blobs WHERE sha256 = ?`, [sha256])?.n ?? 0);
  env.fs.mkdirp(env.attachmentsDir);
  const part = path + '.part';
  try {
    await downloadObject(remote.io, remote.target, objectName(remote.target.org, sha256, ext), part, {
      signal: opts.signal,
      onBytes: (d, t) => opts.onProgress?.('جاري تنزيل الملف', { done: d, total: t > 0 ? t : size, unit: 'bytes' }),
    });
    opts.onProgress?.('جاري مطابقة بصمة الملف');
    const bytes = env.fs.read(part);
    const actual = await env.hasher(bytes);
    if (actual !== sha256) throw new FileUnavailableError('الملف المنزَّل لا يطابق بصمته · لم يُعرض ويُعاد تنزيله عند الفتح التالي');
    env.fs.rename(part, path);
  } catch (e) {
    try { if (env.fs.exists(part)) env.fs.remove(part); } catch { /* يكنسه الإقلاع */ }
    if (isCancelled(e)) throw new CancelledError();
    throw e;
  }
  env.db.run(
    `INSERT INTO file_cache (sha256, ext, bytes, uploaded, last_used) VALUES (?,?,?,1,?)
     ON CONFLICT(sha256) DO UPDATE SET uploaded = 1, last_used = excluded.last_used`,
    [sha256, ext, size, nowIso()]);
  if (opts.cacheLimit) evictCache(env, opts.cacheLimit, sha256);
  return path;
}

/* ═══════════ الذاكرة المؤقتة ═══════════ */

/** الحدّ الافتراضي للذاكرة المؤقتة · ٥٠٠ م.ب */
export const DEFAULT_CACHE_LIMIT = 500 * 1024 * 1024;

export interface CacheUsage {
  /** ما رُفع ويُحذف عند الحاجة */
  cachedBytes: number;
  cachedCount: number;
  /** ما ينتظر الرفع ولا يُحذف */
  pendingBytes: number;
  pendingCount: number;
}

export function cacheUsage(db: DB): CacheUsage {
  const q = (u: number) => db.get<{ b: number; n: number }>(
    `SELECT COALESCE(SUM(bytes), 0) AS b, COUNT(*) AS n FROM file_cache WHERE uploaded = ?`, [u])!;
  const c = q(1); const p = q(0);
  return { cachedBytes: Number(c.b), cachedCount: Number(c.n), pendingBytes: Number(p.b), pendingCount: Number(p.n) };
}

/**
 * يحذف من الجهاز الأقدم استعمالاً مما رُفع حتى لا يتجاوز الحدّ · ما لم يُرفع لا يُمسّ أبداً ·
 * keep: ملفٌ فُتح للتو لا يُحذف في الدورة نفسها · يعيد عدد ما حُذف.
 */
export function evictCache(env: CloudFilesEnv, limitBytes: number, keep?: string): number {
  const rows = env.db.all<{ sha256: string; ext: string; bytes: number }>(
    `SELECT sha256, ext, bytes FROM file_cache WHERE uploaded = 1 ORDER BY last_used`);
  let total = rows.reduce((n, r) => n + Number(r.bytes), 0);
  let removed = 0;
  for (const r of rows) {
    if (total <= limitBytes) break;
    if (r.sha256 === keep) continue;
    dropLocal(env, r.sha256, r.ext);
    total -= Number(r.bytes);
    removed++;
  }
  return removed;
}

/** «تفريغ الذاكرة المؤقتة» · يحذف من الجهاز كل ما رُفع، ويبقى ما ينتظر الرفع · يعيد عدد ما حُذف */
export function clearCache(env: CloudFilesEnv): number {
  const rows = env.db.all<{ sha256: string; ext: string }>(`SELECT sha256, ext FROM file_cache WHERE uploaded = 1`);
  for (const r of rows) dropLocal(env, r.sha256, r.ext);
  return rows.length;
}

function dropLocal(env: CloudFilesEnv, sha256: string, ext: string): void {
  const p = blobPath(env, sha256, ext);
  try { if (env.fs.exists(p)) env.fs.remove(p); } catch { /* التالي */ }
  env.db.run(`DELETE FROM file_cache WHERE sha256 = ? AND uploaded = 1`, [sha256]);
}

/**
 * مطابقة file_cache بما على القرص فعلاً · بعد الاستعادة: كل ملفٍ موجود هنا يُعامَل «لم يُرفع» حتى يطابقه
 * الخادم (الطابور يجد الموجود منها فلا يرفعه ثانيةً)، وصفٌّ بلا ملف يُحذف · فلا يُفرَّغ ملفٌ ظُنّ أنه رُفع.
 */
export function reconcileCache(env: CloudFilesEnv): { present: number; missing: number } {
  const blobs = env.db.all<{ sha256: string; ext: string; size_bytes: number }>(`SELECT sha256, ext, size_bytes FROM blobs`);
  let present = 0; let missing = 0;
  env.db.transaction(() => {
    env.db.run(`DELETE FROM file_cache`);
    for (const b of blobs) {
      if (env.fs.exists(blobPath(env, b.sha256, b.ext))) {
        env.db.run(`INSERT INTO file_cache (sha256, ext, bytes, uploaded, last_used) VALUES (?,?,?,0,?)`,
          [b.sha256, b.ext, Number(b.size_bytes), nowIso()]);
        present++;
      } else missing++;
    }
  });
  return { present, missing };
}

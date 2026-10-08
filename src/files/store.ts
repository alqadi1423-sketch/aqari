/**
 * مخزن الملفات المعنون بالمحتوى.
 * الملفات على القرص في attachments/<sha256>.<ext> · القاعدة تحفظ البصمة والحجم والمسار المشتق فقط.
 * نفس الملف مرفوعاً مرتين = صف واحد في blobs · منع التكرار خاصية بنيوية.
 * كل رفع يمر عبر putAttachment فيُسجَّل تلقائياً بتصنيفه (وهذا ما تعتمد عليه المكتبة).
 */
import type { DB } from '../db/adapter';
import type { FS, Hasher } from './fsAdapter';
import { joinPath } from './fsAdapter';
import { uid } from '../domain/ids';

export interface FilesEnv {
  db: DB;
  fs: FS;
  hasher: Hasher;
  /** مجلد attachments المطلق */
  attachmentsDir: string;
  /**
   * مصغّرة خفيفة للصورة (data URI بضعة كيلوبايت) تُزامَن مع صفّ المرفق، فيظهر بها الملف على جهازٍ لم يُنزّله ·
   * null لغير الصور أو حين يتعذّر التوليد · وبيئة بلا مولِّد (الاختبارات والأدوات) لا مصغّرة لها
   */
  thumbnailer?: (path: string, ext: string, mime: string) => Promise<string | null>;
}

export interface AttachmentMeta {
  entityType: string;
  entityId?: string;
  kind: string;
  originalName?: string;
  mime?: string;
  note?: string;
}

export interface AttachmentRow {
  id: string;
  sha256: string;
  entity_type: string;
  entity_id: string;
  kind: string;
  original_name: string;
  mime: string;
  note: string;
  display_name: string;
  cat_override: string | null;
  created_at: string;
  ext: string;
  size_bytes: number;
  /** المصغّرة الخفيفة المزامَنة (الهجرة ٢٧) · null لغير الصور */
  thumb?: string | null;
}

/** شكل البصمة والامتداد المقبولان · منهما يُبنى اسم الملف على القرص ويدخل صفحات العرض */
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const EXT_RE = /^[a-z0-9]{1,5}$/;
export const isSafeBlobName = (sha: unknown, ext: unknown): boolean =>
  typeof sha === 'string' && typeof ext === 'string' && SHA256_RE.test(sha) && EXT_RE.test(ext);

export function extOf(name: string | undefined, mime?: string): string {
  const fromName = name && name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (fromName && EXT_RE.test(fromName)) return fromName;
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'application/pdf': 'pdf',
  };
  return (mime && mimeMap[mime]) || 'bin';
}

export function blobPath(env: Pick<FilesEnv, 'attachmentsDir'>, sha256: string, ext: string): string {
  // اسمٌ غير آمن (وصل بالمزامنة قبل فحصه، المراجعة #21) لا يخرج بالمسار عن مجلد المرفقات: يُحوَّل اسماً لا ملف له
  if (!isSafeBlobName(sha256, ext)) {
    return joinPath(env.attachmentsDir, 'unsafe-' + String(sha256).replace(/[^0-9a-f]/g, '_') + '.' + String(ext).replace(/[^a-z0-9]/g, '_'));
  }
  return joinPath(env.attachmentsDir, `${sha256}.${ext}`);
}

/** المسار الفعلي لمرفق */
export function attachmentPath(env: FilesEnv, att: Pick<AttachmentRow, 'sha256' | 'ext'>): string {
  return blobPath(env, att.sha256, att.ext);
}

/** الرفع · المسار الواحد لكل ملف يدخل النظام */
export async function putAttachment(
  env: FilesEnv,
  bytes: Uint8Array,
  meta: AttachmentMeta
): Promise<AttachmentRow> {
  const sha = await env.hasher(bytes);
  const ext = extOf(meta.originalName, meta.mime);
  const now = new Date().toISOString();
  const existing = env.db.get<{ sha256: string; ext: string }>(
    `SELECT sha256, ext FROM blobs WHERE sha256 = ?`, [sha]
  );
  const finalExt = existing ? existing.ext : ext;
  const path = blobPath(env, sha, finalExt);
  // بصمةٌ معروفة وملفها ليس هنا (في الخادم وحده) يُكتب ملفها من البايتات التي بين أيدينا
  if (!existing || !env.fs.exists(path)) {
    env.fs.mkdirp(env.attachmentsDir);
    env.fs.write(path, bytes);
    // التحقق قبل التسجيل بإعادة القراءة الفعلية · لا نسجّل مرفقاً لملف لم يُنسخ سليماً
    let writtenLen = -1;
    try { writtenLen = env.fs.read(path).byteLength; } catch { writtenLen = -1; }
    if (writtenLen !== bytes.byteLength) {
      throw new Error(`فشل نسخ الملف إلى مخزن التطبيق (كُتب ${writtenLen} من ${bytes.byteLength} بايت) · لم يُسجَّل المرفق`);
    }
  }
  const id = uid();
  // مصغّرة البصمة نفسها إن سبقت لها · وإلا تُولَّد مرة (الفشل لا يمنع المرفق)
  let thumb: string | null = env.db.get<{ t: string }>(
    `SELECT thumb AS t FROM attachments WHERE sha256 = ? AND thumb IS NOT NULL LIMIT 1`, [sha])?.t ?? null;
  if (!thumb && env.thumbnailer) {
    try { thumb = await env.thumbnailer(path, finalExt, meta.mime ?? ''); } catch { thumb = null; }
  }
  env.db.transaction(() => {
    if (!existing) {
      env.db.run(`INSERT INTO blobs (sha256, ext, size_bytes, created_at) VALUES (?,?,?,?)`, [
        sha, finalExt, bytes.byteLength, now,
      ]);
    }
    // الملف هنا ولم يُرفع · فلا يُحذف من الجهاز حتى يُرفع وتطابق بصمته (cloudFiles.ts)
    env.db.run(
      `INSERT INTO file_cache (sha256, ext, bytes, uploaded, last_used) VALUES (?,?,?,0,?)
       ON CONFLICT(sha256) DO UPDATE SET last_used = excluded.last_used`, [sha, finalExt, bytes.byteLength, now]);
    env.db.run(
      `INSERT INTO attachments (id, sha256, entity_type, entity_id, kind, original_name, mime, note, display_name, created_at, thumb)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, sha, meta.entityType, meta.entityId ?? '', meta.kind, meta.originalName ?? '',
       meta.mime ?? '', meta.note ?? '', meta.originalName ?? '', now, thumb]
    );
  });
  return getAttachment(env.db, id)!;
}

/** امتداد احتياطي من اسم الملف أو نوعه · لمرفق مستورد بلا صف بصمة في blobs */
function fallbackExt(name?: string | null, mime?: string | null): string {
  const fromName = name && name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (fromName && fromName.length <= 5) return fromName;
  if (mime === 'application/pdf') return 'pdf';
  if (mime?.startsWith('image/')) return mime.slice(6) === 'jpeg' ? 'jpg' : mime.slice(6);
  return 'bin';
}

/** انضمام أيسر مع blobs: المرفق المستورد بلا صف بصمة يبقى ظاهراً لا يختفي */
function withBlobFallback(r: AttachmentRow & { ext: string | null; size_bytes: number | null }): AttachmentRow {
  return {
    ...r,
    ext: r.ext ?? fallbackExt(r.original_name, r.mime),
    size_bytes: Number(r.size_bytes ?? 0),
  };
}

export function getAttachment(db: DB, id: string): AttachmentRow | undefined {
  const row = db.get<AttachmentRow & { ext: string | null; size_bytes: number | null }>(
    `SELECT a.*, b.ext, b.size_bytes FROM attachments a LEFT JOIN blobs b ON b.sha256 = a.sha256
     WHERE a.id = ?`,
    [id]
  );
  return row ? withBlobFallback(row) : undefined;
}

export function attachmentsFor(db: DB, entityType: string, entityId: string, kind?: string): AttachmentRow[] {
  const conds = [`a.entity_type = ?`, `a.entity_id = ?`, `a.deleted_at IS NULL`];
  const params: string[] = [entityType, entityId];
  if (kind) { conds.push(`a.kind = ?`); params.push(kind); }
  return db.all<AttachmentRow & { ext: string | null; size_bytes: number | null }>(
    `SELECT a.*, b.ext, b.size_bytes FROM attachments a LEFT JOIN blobs b ON b.sha256 = a.sha256
     WHERE ${conds.join(' AND ')} ORDER BY a.created_at DESC`,
    params
  ).map(withBlobFallback);
}

export function readAttachment(env: FilesEnv, id: string): Uint8Array | null {
  const att = getAttachment(env.db, id);
  if (!att) return null;
  const p = attachmentPath(env, att);
  if (!env.fs.exists(p)) return null;
  return env.fs.read(p);
}

/** حذف ناعم */
export function softDeleteAttachment(db: DB, id: string): void {
  db.transaction(() => {
    db.run(`UPDATE attachments SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
  });
}

/**
 * نزع الربط لا الحذف: يُفكّ الملف عن سجله (عقد/وحدة/مورد…) ويبقى في المكتبة
 * «غير مرتبط» · للحذف الفعلي طريقه المنفصل عبر سلة المحذوفات.
 */
export function unlinkAttachment(db: DB, id: string): void {
  db.transaction(() => {
    db.run(`UPDATE attachments SET entity_type = 'library', entity_id = '' WHERE id = ?`, [id]);
  });
}

/**
 * كنس الملفات: لا يُحذف ملف من القرص إلا بعد انقضاء مهلة السلة
 * وبعد التأكد أن لا صف حيّ يشير لبصمته.
 */
export function gcBlobs(env: FilesEnv, retentionDays: number, now: Date = new Date()): number {
  // صفوفٌ بأسماء غير آمنة وصلت قبل فحصها (المراجعة #21): تُزال صفوفها وحدها، ولا ملف لها في المرفقات
  const unsafe = env.db.all<{ sha256: string; ext: string }>(`SELECT sha256, ext FROM blobs`).filter((b) => !isSafeBlobName(b.sha256, b.ext));
  const unsafeAtt = env.db.all<{ sha256: string }>(`SELECT DISTINCT sha256 FROM attachments`).filter((a) => !isSafeBlobName(a.sha256, 'bin'));
  for (const sha of new Set([...unsafe.map((b) => b.sha256), ...unsafeAtt.map((a) => a.sha256)])) {
    env.db.transaction(() => {
      env.db.run(`DELETE FROM attachments WHERE sha256 = ?`, [sha]);
      env.db.run(`DELETE FROM blobs WHERE sha256 = ?`, [sha]);
      env.db.run(`DELETE FROM file_cache WHERE sha256 = ?`, [sha]);
    });
  }
  const cutoff = new Date(now.getTime() - retentionDays * 86400000).toISOString();
  const orphans = env.db.all<{ sha256: string; ext: string }>(
    `SELECT b.sha256, b.ext FROM blobs b
     WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.sha256 = b.sha256 AND a.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.sha256 = b.sha256 AND a.deleted_at > ?)`,
    [cutoff]
  );
  let removed = 0;
  for (const o of orphans) {
    // اسمٌ يخرج بالمسار عن مجلد المرفقات لا يُحذف ملفه (المراجعة #21) · والصفّ وحده يُزال
    const p = isSafeBlobName(o.sha256, o.ext) ? blobPath(env, o.sha256, o.ext) : null;
    env.db.transaction(() => {
      env.db.run(`DELETE FROM attachments WHERE sha256 = ?`, [o.sha256]);
      env.db.run(`DELETE FROM blobs WHERE sha256 = ?`, [o.sha256]);
      env.db.run(`DELETE FROM file_cache WHERE sha256 = ?`, [o.sha256]);
    });
    if (p && env.fs.exists(p)) env.fs.remove(p);
    removed++;
  }
  return removed;
}

/** كل البصمات الحية (يلزم للنسخ الاحتياطي) */
export function liveBlobs(db: DB): Array<{ sha256: string; ext: string; size_bytes: number }> {
  return db.all(
    `SELECT DISTINCT b.sha256, b.ext, b.size_bytes FROM blobs b
     JOIN attachments a ON a.sha256 = b.sha256
     WHERE a.deleted_at IS NULL ORDER BY b.sha256`
  );
}

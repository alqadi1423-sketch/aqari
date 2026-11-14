/**
 * خروج العضو من المنشأة بإزالته أو مغادرته (المراجعة الشاملة 2026-11-13 · B-4 · قرارا المالك س٩ وس١٠ في 2026-11-13، تطبيقاً لقرار
 * 2026-11-07 (٢ أ) «لا نسخة للعضو المُزال إلا بما لم يُرفع من عمله»): لا تبقى على جواله نسخةٌ كاملة من بيانات المنشأة، ولا «أبقِ بياناتي».
 *  ١) ما لم يُرفع من عمله وحده (طابور الرفع، وما رفضته السحابة مما كتبه هذا الجهاز، ومرفقاته التي لم تُرفع ملفاتها) يُحفظ في ملفٍ واحد
 *     يرسله إلى صاحب المنشأة · ولا ملف إن لم يبقَ له شيء.
 *  ٢) تُحذف نسخ هذا الجهاز التي صُنعت وهو عضو (نسخ الأمان وما قبل الترقية فيها بيانات المنشأة كما رآها) قبل التفريغ، وتُعرف بما فيها
 *     لا بساعة الجهاز، وما قبل انضمامه يبقى له.
 *  ٣) يُفرَّغ الجهاز بلا نسخة أمان (wipe.ts).
 * والملف بصيغة JSON مقروءة لا مختومة بسرّ نسخ العضو: يُرسل إلى صاحب المنشأة وهو لا يملك ذلك السرّ، وليس فيه إلا عمل العضو نفسه.
 * والملف في مجلدٍ فرعي من مجلد نسخ الحساب، فيُركن معه (accountSlots.ts)، ولا تعدّه شاشة المساحة نسخة أمان ولا يعرضه زرّ «استعادة».
 */
import type { DB } from '../db/adapter';
import type { BackupEnv } from './backup/types';
import type { RemoteDoc } from '../sync/types';
import { joinPath } from '../files/fsAdapter';
import { blobPath } from '../files/store';
import { safetyBackupsDir } from './backup/create';
import { deviceBackups } from './backup/deviceBackups';
import { unzipYielding } from './backup/zipStream';
import { membershipOf } from './backup/restore';
import { buildDoc, getSyncState, setSyncState, isUploadReject } from '../sync/engine';
import { t } from '../i18n';

/**
 * وقت انضمام العضو (sync_state) · نسخ الجهاز تُعرف بما فيها (عضوية المنشأة داخلها)، وهذا الوقت لما لا تُقرأ عضويته منها وحده: ما بعده
 * يُحذف عند خروجه، وما قبله يبقى له (ساعة الجهاز قد تتقدّم ثم تُصحَّح · المراجعة الشاملة 2026-11-13 · R11-B4-2)
 */
export const MEMBER_SINCE_KEY = 'member_since';
/** نسخٌ من نسخ الجهاز تعذّر حذفها عند خروج العضو (sync_state): منشأتها ووقت انضمامه، فيُعاد حذفها حتى يتمّ (R11-B4-2) */
export const EXIT_DROP_KEY = 'exit_drop_backups';
/** إشعار الخروج على الجهاز بعد تفريغه (sync_state): يُعرض حتى يقرأه، ومعه اسم ملف ما لم يُرفع */
export const EXIT_NOTICE_KEY = 'exit_notice';
export const UNSYNCED_FORMAT = 'aqari-unsynced-work';
const UNSYNCED_DIR = 'unsynced';
const UNSYNCED_NAME = /^unsynced-work-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

export type ExitWhy = 'removed' | 'left';

export interface UnsyncedReject {
  /** سبب الرفض كما حُفظ على الجهاز */
  reason: string;
  at: string;
  doc: RemoteDoc;
}

/**
 * مرفقٌ لم يُرفع ملفه (file_cache.uploaded = 0): تخزين الملفات مطفأ أو بقي في طابوره، فنسخته الوحيدة على هذا الجهاز (المراجعة الشاملة
 * 2026-11-13 · R11-B4-1) · صفّ بصمته (blobs) وصفوف مرفقاته الحية (attachments) كما هي، وبايتاته بترميز base64
 */
export interface UnsyncedFile {
  sha256: string;
  ext: string;
  size_bytes: number;
  created_at: string;
  attachments: Array<Record<string, unknown>>;
  base64: string;
}

/** محتوى الملف الصغير · مستندات المزامنة نفسها، فيقرؤها صاحب المنشأة أو يُضيفها */
export interface UnsyncedWork {
  format: typeof UNSYNCED_FORMAT;
  version: 1;
  created_at: string;
  reason: ExitWhy;
  org: string;
  org_name: string | null;
  member: { uid: string; email: string | null; name: string };
  device_id: string;
  /** ما في طابور الرفع ولم يبلغ السحابة */
  docs: RemoteDoc[];
  /** ما كتبه هذا الجهاز ورفضته السحابة */
  rejected: UnsyncedReject[];
  /** مرفقاته التي لم تُرفع ملفاتها (R11-B4-1) */
  files: UnsyncedFile[];
}

export interface UnsyncedInfo {
  reason: ExitWhy;
  org: string;
  orgName: string | null;
  uid: string;
  email: string | null;
  name: string;
  deviceId: string;
}

export interface UnsyncedSaved {
  /** اسم الملف في مجلد ما لم يُرفع */
  name: string;
  /** عدد ما فيه من تغييرات */
  count: number;
}

type DirEnv = Pick<BackupEnv, 'fs' | 'tmpDir'>;
type WorkEnv = Pick<BackupEnv, 'fs' | 'tmpDir' | 'attachmentsDir'>;
type ProbeEnv = Pick<BackupEnv, 'fs' | 'tmpDir' | 'openDb'>;

/** ما لم يُرفع من عمل هذا الجهاز: طابور الرفع بمحتواه الحالي، وما رفضته السحابة مما كتبه هو (لا ما رُفض تطبيقه من الوارد) */
export function collectUnsyncedWork(db: DB, deviceId: string): { docs: RemoteDoc[]; rejected: UnsyncedReject[] } {
  const docs = db.all<{ tbl: string; pk: string; op: 'upsert' | 'delete'; changed_at: string }>(
    `SELECT tbl, pk, op, changed_at FROM sync_outbox ORDER BY changed_at, tbl, pk`)
    .map((r) => buildDoc(db, r.tbl, r.pk, r.op, r.changed_at, deviceId));
  const rejected: UnsyncedReject[] = [];
  for (const r of db.all<{ tbl: string; pk: string; reason: string; payload: string; at: string }>(
    `SELECT tbl, pk, reason, payload, at FROM sync_rejects ORDER BY id`)) {
    if (!isUploadReject(r.reason)) continue;
    let doc: Partial<RemoteDoc> | null = null;
    try { doc = JSON.parse(r.payload) as Partial<RemoteDoc>; } catch { doc = null; }
    // المرفوض رفضاً دائماً محفوظٌ بلا محتواه (engine.ts) · فيُبنى من الصف نفسه
    const full = doc && 'd' in doc ? (doc as RemoteDoc) : buildDoc(db, r.tbl, r.pk, doc?.del ? 'delete' : 'upsert', r.at, deviceId);
    rejected.push({ reason: r.reason, at: r.at, doc: full });
  }
  return { docs, rejected };
}

/** مرفقٌ لم يُرفع: ما يُكتب منه في الملف، ومسار ملفه وحجمه على القرص */
export interface PendingFile {
  meta: Omit<UnsyncedFile, 'base64'>;
  path: string;
  size: number;
}

/**
 * مرفقات هذا الجهاز التي لم تُرفع ملفاتها (R11-B4-1): كل ما في file_cache بـ uploaded = 0 وله مرفقٌ حيّ وملفه هنا · فلا يُتلفها التفريغ
 * بلا أثر (قرار المالك س٩: «ولا يضيع عمله») · وما رُفع (uploaded = 1) في الخادم فلا يُحفظ، وما حُذف مرفقه إلى السلة لا يُحفظ
 */
export function collectUnsyncedFiles(env: WorkEnv, db: DB): PendingFile[] {
  const out: PendingFile[] = [];
  const rows = db.all<{ sha256: string; ext: string; created_at: string | null }>(
    `SELECT f.sha256, COALESCE(b.ext, f.ext) AS ext, b.created_at FROM file_cache f LEFT JOIN blobs b ON b.sha256 = f.sha256
     WHERE f.uploaded = 0 ORDER BY COALESCE(b.created_at, f.last_used), f.sha256`);
  for (const f of rows) {
    const attachments = db.all<Record<string, unknown>>(
      `SELECT * FROM attachments WHERE sha256 = ? AND deleted_at IS NULL ORDER BY created_at, id`, [f.sha256]);
    if (!attachments.length) continue;
    const path = blobPath(env, f.sha256, f.ext);
    if (!env.fs.exists(path)) continue;
    const size = env.fs.size(path);
    out.push({ meta: { sha256: f.sha256, ext: f.ext, size_bytes: size, created_at: f.created_at ?? '', attachments }, path, size });
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_CODES = new Uint8Array(64).map((_, i) => B64.charCodeAt(i));
const PAD = 61; // «=»
const base64Length = (n: number): number => 4 * Math.ceil(n / 3);

/** base64 القياسي يُكتب بايتاتٍ في موضعه من المخزن مباشرةً · بلا نصٍّ وسيط بحجم الملف (ذاكرة الجوال) · يعيد الموضع بعده */
function base64Into(out: Uint8Array, at: number, bytes: Uint8Array): number {
  let o = at;
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = B64_CODES[(v >> 18) & 63]; out[o++] = B64_CODES[(v >> 12) & 63];
    out[o++] = B64_CODES[(v >> 6) & 63]; out[o++] = B64_CODES[v & 63];
  }
  if (i < n) {
    const two = i + 1 < n;
    const v = (bytes[i] << 16) | ((two ? bytes[i + 1] : 0) << 8);
    out[o++] = B64_CODES[(v >> 18) & 63]; out[o++] = B64_CODES[(v >> 12) & 63];
    out[o++] = two ? B64_CODES[(v >> 6) & 63] : PAD; out[o++] = PAD;
  }
  return o;
}

/** المسار بلا «مجلد/..» (مجلد النسخ بجوار المؤقت: tmp/../backups) · فيُكتب الملف ويُشارَك بمساره الصريح */
function collapse(p: string): string {
  let out = p;
  for (let prev = ''; prev !== out;) { prev = out; out = out.replace(/\/(?!\.\.?\/)[^/]+\/\.\.(?=\/|$)/, ''); }
  return out;
}

export const unsyncedDir = (env: DirEnv): string => collapse(joinPath(safetyBackupsDir(env as BackupEnv), UNSYNCED_DIR));

/** مسار ملفٍ من ملفات ما لم يُرفع باسمه · واسمٌ ليس بشكلها يُرفض (لا يُقرأ ملفٌ خارج مجلدها باسمٍ مصنوع) */
export function unsyncedPath(env: DirEnv, name: string): string {
  if (!UNSYNCED_NAME.test(String(name ?? ''))) throw new Error(t('org.exit.fileGone'));
  return joinPath(unsyncedDir(env), name);
}

/**
 * يحفظ ما لم يُرفع من عمل العضو في ملفٍ واحد قبل تفريغ جهازه · null إن لم يبقَ له شيء · وتعذّر الكتابة أو قراءة مرفقٍ يرمي، فلا يقع
 * التفريغ بعده ولا يضيع عمله · والمرفقات بايتاتها فيه بترميز base64 (R11-B4-1): الملف JSON مقروءٌ كما هو، يُبنى في مخزنٍ واحد بحجمه
 * المحسوب سلفاً ويُقرأ كل مرفقٍ في دوره، فلا يُحمل نصٌّ وسيطٌ بحجم المرفقات كلها
 */
export function saveUnsyncedWork(env: WorkEnv, db: DB, info: UnsyncedInfo): UnsyncedSaved | null {
  const { docs, rejected } = collectUnsyncedWork(db, info.deviceId);
  const files = collectUnsyncedFiles(env, db);
  const count = docs.length + rejected.length + files.length;
  if (!count) return null;
  const at = new Date().toISOString();
  const name = 'unsynced-work-' + at.replace(/[:.]/g, '-') + '.json';
  const work: UnsyncedWork = {
    format: UNSYNCED_FORMAT, version: 1, created_at: at, reason: info.reason, org: info.org, org_name: info.orgName,
    member: { uid: info.uid, email: info.email, name: info.name }, device_id: info.deviceId, docs, rejected, files: [],
  };
  // «files» آخر مفاتيحه: يُفتح مكانه ويُكتب فيه كل مرفقٍ بصفوفه ثم بايتاته
  const head = JSON.stringify(work, null, 1);
  const EMPTY_TAIL = '[]\n}';
  if (!head.endsWith(EMPTY_TAIL)) throw new Error(t('org.exit.saveFailed'));
  const enc = new TextEncoder();
  const text = (s: string) => ({ text: enc.encode(s) });
  const parts: Array<{ text: Uint8Array } | { file: PendingFile }> = [text(head.slice(0, -EMPTY_TAIL.length) + '[')];
  files.forEach((f, i) => {
    const meta = JSON.stringify(f.meta);
    parts.push(text((i ? ',' : '') + '\n  ' + meta.slice(0, -1) + ',"base64":"'), { file: f }, text('"}'));
  });
  parts.push(text((files.length ? '\n ' : '') + ']\n}'));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + ('text' in p ? p.text.byteLength : base64Length(p.file.size)), 0));
  let o = 0;
  for (const p of parts) {
    if ('text' in p) { bytes.set(p.text, o); o += p.text.byteLength; continue; }
    const raw = env.fs.read(p.file.path);
    // تغيّر الملف بين حسابه وقراءته · فلا يُكتب ملفٌ مبتور ولا يُفرَّغ الجهاز (يُعاد في الدورة التالية)
    if (raw.byteLength !== p.file.size) throw new Error(t('org.exit.saveFailed'));
    o = base64Into(bytes, o, raw);
  }
  if (o !== bytes.byteLength) throw new Error(t('org.exit.saveFailed'));
  const dir = unsyncedDir(env);
  env.fs.mkdirp(dir);
  const path = joinPath(dir, name);
  env.fs.write(path, bytes);
  if (!env.fs.exists(path) || env.fs.size(path) !== bytes.byteLength) throw new Error(t('org.exit.saveFailed'));
  return { name, count };
}

/** سطرٌ في سجل العمليات مع سبب التفريغ: ما حُفظ مما لم يُرفع · والتفريغ نفسه بلا نسخة أمان */
export function unsyncedAuditNote(saved: UnsyncedSaved | null): string {
  return saved ? ' · ما لم يُرفع من عمله: ' + saved.count + ' في ' + saved.name : ''; // i18n-exempt: سطر سجل العمليات المخزَّن
}

/**
 * عضوية نسخةٍ من نسخ الجهاز بما فيها (sync_state في قاعدتها · R11-B4-2): { org } لنسخةٍ صُنعت والجهاز عضو (org = null لعضويةٍ مكتوبة لا
 * تُقرأ)، وnull لنسخةٍ بلا عضوية (بيانات صاحب الجهاز نفسه)، و'unknown' لما لا يُفكّ أو لا تُفتح قاعدته · تُفكّ القاعدة وحدها من الأرشيف
 * (المرفقات لا تُفكّ) وتُفتح من المؤقت ثم تُحذف
 */
export async function backupMembership(env: ProbeEnv, path: string): Promise<{ org: string | null } | null | 'unknown'> {
  let bytes: Uint8Array | undefined;
  try { bytes = (await unzipYielding(env.fs.read(path), undefined, undefined, (n) => n === 'data.db'))['data.db']; } catch { return 'unknown'; }
  if (!bytes) return 'unknown';
  const probe = joinPath(env.tmpDir, `exit-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  let open: DB | null = null;
  try {
    env.fs.mkdirp(env.tmpDir);
    env.fs.write(probe, bytes);
    bytes = undefined;
    open = env.openDb(probe);
    const m = membershipOf(open);
    return m === null ? null : { org: m === 'unreadable' ? null : m.org };
  } catch {
    return 'unknown';
  } finally {
    try { open?.close(); } catch { /* مغلقة */ }
    for (const sfx of ['', '-wal', '-shm', '-journal']) { try { if (env.fs.exists(probe + sfx)) env.fs.remove(probe + sfx); } catch { /* التالي */ } }
  }
}

export interface DropResult {
  /** ما حُذف */
  gone: string[];
  /** ما تعذّر حذفه · يُعاد في الدورة التالية (EXIT_DROP_KEY) */
  failed: string[];
}

/**
 * نسخ هذا الجهاز (نسخ الأمان وما قبل الترقية) التي صُنعت وهو عضوٌ في المنشأة تُحذف عند خروجه منها: فيها بيانات المنشأة كما رآها ·
 * وتُعرف بما فيها لا بساعة الجهاز (المراجعة الشاملة 2026-11-13 · R11-B4-2: ساعةٌ تقدّمت عند الانضمام ثم صُحّحت كانت تُبقي نسخةً كاملة):
 * عضوية هذه المنشأة (أو عضويةٌ لا تُقرأ) ← تُحذف · بلا عضوية (بياناته هو) ← تبقى · عضوية منشأةٍ أخرى ← ليست لهذا الخروج · وما لا تُقرأ
 * عضويته يُحكم فيه بوقت الانضمام: ما بعده يُحذف وما قبله يبقى، وبلا وقت انضمام يُحذف · org = null: كل نسخةٍ فيها عضوية
 */
export async function dropMemberBackups(env: ProbeEnv, org: string | null, since: string | null): Promise<DropResult> {
  const from = since ? Date.parse(since) : NaN;
  // مجلد النسخ يُبلغ عبر المؤقت (tmp/../backups) · فيُضمن وجوده كي لا تُعدّ النسخ غائبةً فتبقى
  try { env.fs.mkdirp(env.tmpDir); } catch { /* يُجرَّب كما هو */ }
  const dir = safetyBackupsDir(env as BackupEnv);
  const out: DropResult = { gone: [], failed: [] };
  for (const b of deviceBackups(env as BackupEnv)) {
    const path = joinPath(dir, b.name);
    const m = await backupMembership(env, path);
    const drop = m === 'unknown'
      ? !(Number.isFinite(from) && Date.parse(b.at) < from)
      : m !== null && (org === null || m.org === null || m.org === org);
    if (!drop) continue;
    try { env.fs.remove(path); out.gone.push(b.name); } catch { out.failed.push(b.name); }
  }
  return out;
}

/** ما تعذّر حذفه عند الخروج يُسجَّل في القاعدة الحية بعد التفريغ، فيُعاد حذفه (retryDropMemberBackups) · R11-B4-2 */
export function noteDropPending(db: DB, org: string | null, since: string | null): void {
  setSyncState(db, EXIT_DROP_KEY, JSON.stringify({ org, since }));
}

/** إعادة حذف ما تعذّر عند الخروج حتى يتمّ (كل دورة وكل إقلاع) · ولا شيء بلا تسجيل · يعيد ما حُذف */
export async function retryDropMemberBackups(env: ProbeEnv, db: DB): Promise<string[]> {
  const raw = getSyncState(db, EXIT_DROP_KEY);
  if (!raw) return [];
  let p: { org?: unknown; since?: unknown } = {};
  try { p = JSON.parse(raw) as typeof p; } catch { /* تسجيلٌ لا يُقرأ: كل نسخةٍ فيها عضوية، وما لا يُقرأ */ }
  const r = await dropMemberBackups(env, typeof p.org === 'string' ? p.org : null, typeof p.since === 'string' ? p.since : null);
  if (!r.failed.length) setSyncState(db, EXIT_DROP_KEY, null);
  return r.gone;
}

export interface ExitNotice {
  why: ExitWhy;
  /** عدد ما حُفظ مما لم يُرفع · ٠ بلا ملف */
  count: number;
  /** اسم ملف ما لم يُرفع · null بلا ملف */
  file: string | null;
  at: string;
}

export function readExitNotice(db: DB): ExitNotice | null {
  let raw: string | null;
  try { raw = getSyncState(db, EXIT_NOTICE_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const n = JSON.parse(raw) as Partial<ExitNotice>;
    if (n.why !== 'removed' && n.why !== 'left') return null;
    return { why: n.why, count: Math.max(0, Number(n.count) || 0), file: typeof n.file === 'string' && n.file ? n.file : null, at: String(n.at ?? '') };
  } catch { return null; }
}

export function writeExitNotice(db: DB, n: ExitNotice): void {
  setSyncState(db, EXIT_NOTICE_KEY, JSON.stringify(n));
}

/** قرأ الإشعار (بأمره): يُمحى، ويُحذف ملف ما لم يُرفع من الجهاز (أرسله أو تركه بأمره) */
export function clearExitNotice(env: DirEnv, db: DB): void {
  const n = readExitNotice(db);
  if (n?.file) {
    try { const p = unsyncedPath(env, n.file); if (env.fs.exists(p)) env.fs.remove(p); } catch { /* حُذف أو اسمٌ غير صالح */ }
  }
  setSyncState(db, EXIT_NOTICE_KEY, null);
}

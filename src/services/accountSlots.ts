/**
 * نسخة كل حساب على الجهاز (توجيه المالك ٢٠٢٦-١٠-٠٤): البيانات ملك الحساب لا الجهاز.
 * القاعدة النشطة (aqari.db ومرفقاتها) لحسابٍ واحد · وعند الخروج أو دخول حساب آخر تُركن نسخة الحساب
 * كما هي في accounts/{uid}/ مقفلةً لا يفتحها غيره، وطابورها معها فلا يضيع تغيير لم يُرفع.
 * وعند الدخول تعود نسخة الحساب إن كانت مركونة، وإلا فنسخة جديدة تُسحب من سحابته.
 * لا مسح هنا أبداً: النقل وحده.
 */
import type { DB } from '../db/adapter';
import type { FS } from '../files/fsAdapter';
import { joinPath } from '../files/fsAdapter';
import { getSyncState } from '../sync/engine';
import { hasUserData } from '../domain/backup/upgrade';

/** ما يخص الحساب في جذر بيانات التطبيق · القاعدة نفسها تُنقل بملفاتها الثلاثة */
const ITEMS = ['attachments', 'thumbs', 'backups', 'widget.json'];
const DB_SUFFIXES = ['', '-wal', '-shm'];
/** مكان البيانات التي لا حساب لها (جهاز قديم قبل الدخول الإلزامي) حين يختار الداخل ألا يربطها */
export const UNBOUND = '_unbound';

export interface SlotEnv {
  fs: FS;
  /** جذر بيانات التطبيق (فيه attachments وغيرها) */
  root: string;
  /** المسار الكامل لملف القاعدة النشطة */
  dbFile: string;
  /** القاعدة الحالية · تُغلق قبل النقل وتُفتح بعده على الملف نفسه */
  db(): DB;
  close(): void;
  reopen(): void;
  /** تجهيز قاعدة جديدة فارغة بعد فتحها (الهجرات والزرع وهوية الجهاز) */
  prepareFresh(db: DB): void;
}

const safe = (uid: string) => uid.replace(/[^A-Za-z0-9_-]/g, '_');
export const slotDir = (env: Pick<SlotEnv, 'root'>, uid: string) => joinPath(env.root, 'accounts', safe(uid));

/** حساب النسخة النشطة · null لنسخة لا حساب لها */
export function activeAccount(db: DB): string | null {
  return getSyncState(db, 'uid');
}

export function hasParked(env: SlotEnv, uid: string): boolean {
  return env.fs.exists(joinPath(slotDir(env, uid), 'aqari.db'));
}

function checkpoint(db: DB): void {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* لا WAL */ }
}

/** تُركن النسخة النشطة باسم حسابها، وتُفتح مكانها قاعدة جديدة فارغة */
export function parkActive(env: SlotEnv, uid: string): void {
  const dir = slotDir(env, uid);
  if (env.fs.exists(joinPath(dir, 'aqari.db'))) {
    throw new Error('للحساب نسخة مركونة على الجهاز بالفعل · لا تُكتب فوقها');
  }
  checkpoint(env.db());
  env.close();
  env.fs.mkdirp(dir);
  for (const s of DB_SUFFIXES) {
    if (env.fs.exists(env.dbFile + s)) env.fs.rename(env.dbFile + s, joinPath(dir, 'aqari.db' + s));
  }
  for (const it of ITEMS) {
    const p = joinPath(env.root, it);
    if (env.fs.exists(p)) env.fs.rename(p, joinPath(dir, it));
  }
  env.reopen();
  env.prepareFresh(env.db());
}

/**
 * تعود نسخة الحساب المركونة إلى مكان النشطة · والنشطة يجب أن تكون فارغة بلا حساب (ركنت قبلها)،
 * فإن كان فيها حسابٌ أو بيانات رُفض النقل ولا يُكتب فوقها.
 */
export function restoreParked(env: SlotEnv, uid: string): boolean {
  if (!hasParked(env, uid)) return false;
  const db = env.db();
  if (activeAccount(db) || hasUserData(db)) throw new Error('النسخة النشطة ليست فارغة · تُركن أولاً');
  env.close();
  for (const s of DB_SUFFIXES) if (env.fs.exists(env.dbFile + s)) env.fs.remove(env.dbFile + s);
  for (const it of ITEMS) {
    const p = joinPath(env.root, it);
    if (env.fs.exists(p)) env.fs.remove(p);
  }
  const dir = slotDir(env, uid);
  for (const s of DB_SUFFIXES) {
    const from = joinPath(dir, 'aqari.db' + s);
    if (env.fs.exists(from)) env.fs.rename(from, env.dbFile + s);
  }
  for (const it of ITEMS) {
    const from = joinPath(dir, it);
    if (env.fs.exists(from)) env.fs.rename(from, joinPath(env.root, it));
  }
  try { env.fs.remove(dir); } catch { /* مجلد فارغ */ }
  env.reopen();
  return true;
}

/**
 * ما يلزم عند دخول حساب · 'ready' النشطة له، 'switched' رُكنت نسخة غيره وفُتحت نسخته أو جديدة،
 * 'unbound' على الجهاز بيانات بلا حساب تنتظر قرار الداخل (تُربط به أو تُركن).
 */
export function switchTo(env: SlotEnv, uid: string): 'ready' | 'switched' | 'unbound' {
  const db = env.db();
  const owner = activeAccount(db);
  if (owner === uid) return 'ready';
  if (owner) {
    parkActive(env, owner);
  } else if (hasUserData(db)) {
    return 'unbound';
  }
  restoreParked(env, uid);
  return 'switched';
}

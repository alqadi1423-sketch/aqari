/**
 * عمليات المساحة · إحصاء المستهلَك بأقسامه، كنس المؤقتات،
 * وتحرير القرص فعلاً بعد التفريغ (كنس الملفات اليتيمة + VACUUM لاستعادة مساحة القاعدة).
 */
import { File, Directory, Paths } from 'expo-file-system';
import type { DB } from '../db/adapter';
import { appFilesEnv } from './filesEnv';
import { gcBlobs } from '../files/store';
import { appDataRoot } from '../files/expoFs';
import { joinPath } from '../files/fsAdapter';

const dirSize = (d: Directory): number => {
  if (!d.exists) return 0;
  let total = 0;
  for (const e of d.list()) {
    if (e instanceof Directory) total += dirSize(e);
    else total += (e as File).size ?? 0;
  }
  return total;
};

export interface StorageBreakdown {
  originalsBytes: number;
  originalsCount: number;
  thumbsBytes: number;
  dbBytes: number;
  cacheBytes: number;
  trashBytes: number;
  trashCount: number;
  /** نسخة الأمان المحفوظة قبل آخر استيراد أو مسح · كانت خفيّة لا تُعدّ */
  safetyBytes: number;
  safetyCount: number;
}

export function thumbsDir(): string {
  return joinPath(appDataRoot(), 'thumbs');
}

export function attachmentsDirPath(): string {
  return joinPath(appDataRoot(), 'attachments');
}

export function safetyDirPath(): string {
  return joinPath(appDataRoot(), 'backups');
}

export function storageBreakdown(db: DB): StorageBreakdown {
  const live = db.get<{ n: number; s: number }>(
    `SELECT COUNT(DISTINCT b.sha256) AS n, COALESCE(SUM(sz.size_bytes),0) AS s
     FROM (SELECT DISTINCT sha256 FROM attachments WHERE deleted_at IS NULL) x
     JOIN blobs b ON b.sha256 = x.sha256
     JOIN blobs sz ON sz.sha256 = b.sha256`
  )!;
  // بصمات كل مراجعها في السلة (محذوفة ناعماً ولم تُستعد)
  const trash = db.get<{ n: number; s: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(b.size_bytes),0) AS s FROM blobs b
     WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.sha256 = b.sha256 AND a.deleted_at IS NULL)
       AND EXISTS (SELECT 1 FROM attachments a WHERE a.sha256 = b.sha256)`
  )!;
  // القاعدة بملفّيها الملحقين · سجلّ الكتابة المسبقة وحده يبلغ ميغاتٍ بعد عملية ثقيلة،
  // وإغفاله كان يجعل شاشة المساحة تقلّ عمّا على القرص فعلاً بلا سبب ظاهر للمستخدم
  let dbBytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const f = new File(joinPath(appDataRoot(), 'SQLite/aqari.db' + suffix));
      if (f.exists) dbBytes += f.size ?? 0;
    } catch { /* التالي */ }
  }
  let cacheBytes = 0;
  try { cacheBytes = dirSize(new Directory(Paths.cache.uri)); } catch { cacheBytes = 0; }
  let thumbsBytes = 0;
  try { thumbsBytes = dirSize(new Directory(thumbsDir())); } catch { thumbsBytes = 0; }
  // نسخ الأمان تُقرأ من القرص لا من القاعدة · فلا صف لها في جدول
  let safetyBytes = 0;
  let safetyCount = 0;
  try {
    const dir = new Directory(safetyDirPath());
    if (dir.exists) {
      for (const e of dir.list()) {
        if (e instanceof Directory) continue;
        safetyBytes += (e as File).size ?? 0;
        safetyCount += 1;
      }
    }
  } catch { safetyBytes = 0; safetyCount = 0; }
  return {
    originalsBytes: Number(live.s), originalsCount: Number(live.n),
    thumbsBytes, dbBytes, cacheBytes,
    trashBytes: Number(trash.s), trashCount: Number(trash.n),
    safetyBytes, safetyCount,
  };
}

/** كنس المؤقتات · كل ما في cache مؤقت بحكم التعريف ويعاد توليده عند الحاجة */
export function sweepCache(): number {
  let freed = 0;
  try {
    const root = new Directory(Paths.cache.uri);
    if (!root.exists) return 0;
    for (const e of root.list()) {
      try {
        if (e instanceof Directory) { freed += dirSize(e); e.delete(); }
        else { freed += (e as File).size ?? 0; (e as File).delete(); }
      } catch { /* ملف مقفل مؤقتاً · يُكنس في الإقلاع التالي */ }
    }
  } catch { /* لا يعطّل شيئاً */ }
  return freed;
}

/**
 * تحرير القرص بعد تفريغ السلة: كنس فوري للملفات اليتيمة (بلا مهلة)
 * ثم VACUUM · لأن SQLite لا يعيد المساحة عند الحذف بدونه.
 */
export async function reclaimStorage(db: DB): Promise<void> {
  gcBlobs(appFilesEnv(db), 0);
  // المرفقات اليتيمة: ملفٌ في attachments لا صفَّ لبصمته في blobs.
  // و`gcBlobs` يبدأ استعلامه من blobs فلا يراه أصلاً، فيبقى على القرص أبداً
  // لا يُحذف ولا يُعدّ. وهذه مخلّفات استعادةٍ فشلت بعد نقل المرفقات، لا ميزة جديدة.
  try {
    const dir = new Directory(attachmentsDirPath());
    if (dir.exists) {
      const known = new Set(
        db.all<{ sha256: string }>(`SELECT sha256 FROM blobs`).map((r) => r.sha256)
      );
      let i = 0;
      for (const e of dir.list()) {
        if (e instanceof Directory) continue;
        const sha = e.name.split('.')[0];
        if (!known.has(sha)) { try { (e as File).delete(); } catch { /* التالي */ } }
        if (++i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    }
  } catch { /* لا يعطّل التفريغ */ }
  // المصغّرات اليتيمة: مصغّرة بلا بصمة حية تُحذف · مع تنفّس بين الحذف
  try {
    const dir = new Directory(thumbsDir());
    if (dir.exists) {
      const alive = new Set(
        db.all<{ sha256: string }>(
          `SELECT DISTINCT b.sha256 FROM blobs b
           JOIN attachments a ON a.sha256 = b.sha256 AND a.deleted_at IS NULL`
        ).map((r) => r.sha256)
      );
      let i = 0;
      for (const e of dir.list()) {
        const name = e.name.split('.')[0];
        if (!alive.has(name)) { try { e.delete(); } catch { /* التالي */ } }
        if (++i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    }
  } catch { /* لا يعطّل التفريغ */ }
  // VACUUM على خيط القاعدة الأصلي حيث يتوفر · فلا يتجمد التطبيق أثناء إعادة البناء
  try {
    if (db.execAsync) await db.execAsync('VACUUM');
    else db.run('VACUUM');
  } catch { /* قاعدة مشغولة · يُعاد في الإقلاع التالي */ }
}

/** إنشاء مجلدات التطبيق كلها عند الإقلاع لا عند الحاجة · وكنس مخلّفات tmp */
export function ensureAppDirs(): void {
  for (const d of ['attachments', 'thumbs', 'tmp']) {
    try {
      const dir = new Directory('file://' + joinPath(appDataRoot().replace(/^file:\/\//, ''), d));
      if (!dir.exists) dir.create({ intermediates: true });
    } catch { /* لا يعطّل الإقلاع · العملية نفسها تعيد المحاولة */ }
  }
  // tmp مؤقت بحكم التعريف: أي مخلّف من نسخة سابقة يُكنس
  try {
    const tmp = new Directory('file://' + joinPath(appDataRoot().replace(/^file:\/\//, ''), 'tmp'));
    if (tmp.exists) for (const e of tmp.list()) { try { e.delete(); } catch { /* التالي */ } }
  } catch { /* لا يعطّل الإقلاع */ }
}

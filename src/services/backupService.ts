/**
 * خدمة النسخ الاحتياطي داخل التطبيق · بناء البيئة، الإنشاء والمشاركة، والاستعادة من ملف.
 */
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import type { AppDB } from '../db/expoAdapter';
import { openExpoDb } from '../db/expoAdapter';
import { expoFs, expoHasher, appDataRoot } from '../files/expoFs';
import { joinPath } from '../files/fsAdapter';
import { createBackup, ensureFreeSpace } from '../domain/backup/create';
import { prepareRestore, commitRestore, abortRestore, type RestorePlan, type PrepareOptions } from '../domain/backup/restore';
import type { BackupEnv, BackupManifest } from '../domain/backup/types';
import { setSetting } from '../repos/settings';
import { toLocalISODate } from '../domain/dates';
import { openNodeDbCompat } from './openTempDb';
import { deviceCipher } from './cipher';
import { getBackupPassword } from './backupPassword';
import { sealBackupFile } from '../domain/backup/seal';

export function appBackupEnv(db: AppDB): BackupEnv {
  const root = appDataRoot();
  return {
    db,
    dbPath: db.databasePath,
    fs: expoFs,
    hasher: expoHasher,
    attachmentsDir: joinPath(root, 'attachments'),
    tmpDir: joinPath(root, 'tmp'),
    appVersion: '1.0.0',
    openDb: (path) => openTempSqlite(path),
    closeLive: () => { try { db.close(); } catch { /* مغلقة */ } },
    reopenLive: () => { db.reopen(); return db; },
    cipher: deviceCipher,
  };
}

/** فتح قاعدة على مسار مطلق عبر expo-sqlite */
function openTempSqlite(path: string) {
  return openNodeDbCompat(path);
}

/** إنشاء نسخة ومشاركتها خارج الجهاز · تحدّث lastBackupAt و lastExportAt */
export async function createAndShareBackup(
  db: AppDB,
  onProgress?: (msg: string) => void
): Promise<BackupManifest> {
  const env = appBackupEnv(db);
  const name = `عقاري · نسخة · ${toLocalISODate(new Date())}.aqbk`;
  const outPath = joinPath(env.tmpDir, name);
  const manifest = await createBackup(env, outPath, onProgress);
  // بكلمة مرور النسخ إن وُضعت · ولا يُسلَّم المشفّر قبل أن يُفكّ ويطابق
  const pw = await getBackupPassword();
  if (pw) await sealBackupFile(env, outPath, pw, onProgress);
  setSetting(db, 'lastBackupAt', new Date().toISOString());
  onProgress?.('جاري فتح نافذة المشاركة');
  // فشل المشاركة بعد نجاح النسخة لا يُحسب فشلاً للنسخة نفسها
  try {
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(new File(outPath).uri, { dialogTitle: 'تصدير النسخة الاحتياطية' });
      setSetting(db, 'lastExportAt', new Date().toISOString());
    }
  } catch { /* أُنشئت النسخة وسلِمت · المشاركة وحدها أُلغيت */ }
  return manifest;
}

/**
 * المرحلة التفاعلية الأولى: اختيار الملف وتجهيز الاستعادة (تشغيل تجريبي كامل).
 * لا يمسّ البيانات الحية · يعيد الخطة والملخص أو null عند الإلغاء.
 */
export async function pickAndPrepareRestore(
  db: AppDB,
  onProgress?: (msg: string) => void,
  opts?: PrepareOptions
): Promise<{ env: BackupEnv; plan: RestorePlan; archiveTmp: string } | null> {
  const env = appBackupEnv(db);
  // القرص يسع العملية · **قبل فتح المنتقي** لا بعده:
  // المنتقي نفسه ينسخ الملف المختار إلى الذاكرة المؤقتة قبل أن يعود إلينا، وهي
  // نسخةٌ بحجم الأرشيف كاملاً · فإن ضاق القرص فشل هو قبل أن يصل الدور إلى فحصنا،
  // وخرج العطل بلغةٍ أعجمية من طبقة النظام لا برسالتنا.
  await ensureFreeSpace(env);
  const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
  if (res.canceled || !res.assets?.length) return null;
  onProgress?.('جاري قراءة الملف المختار');
  env.fs.mkdirp(env.tmpDir);
  const archiveTmp = joinPath(env.tmpDir, 'restore-input.aqbk');
  // قراءة لا تحتجز خيط الواجهة · الملف يُقرأ على الخيط الأصلي
  const pickedUri = res.assets[0].uri;
  let bytes: Uint8Array | null = new Uint8Array(await new File(pickedUri).arrayBuffer());
  env.fs.write(archiveTmp, bytes);
  bytes = null; // تحرير قبل الفك · الذاكرة لا تحمل الأرشيف مرتين
  // نسخة المنتقي في الذاكرة المؤقتة صارت زائدة بعد نقلها إلى tmp · وهي بحجم
  // الأرشيف كاملاً ولا يعدّها شيء ولا يكنسها شيء، فتُحذف فور الاستغناء عنها
  try { env.fs.remove(pickedUri); } catch { /* المنتقي قد يكون سلّم مرجعاً لا نسخة */ }
  const plan = await prepareRestore(env, archiveTmp, onProgress, opts);
  return { env, plan, archiveTmp };
}

/** المرحلة الثانية بعد موافقة المستخدم على الملخص */
export async function commitPreparedRestore(
  env: BackupEnv,
  plan: RestorePlan,
  archiveTmp: string,
  onProgress?: (msg: string) => void
) {
  try {
    return await commitRestore(env, plan, onProgress);
  } finally {
    try { env.fs.remove(archiveTmp); } catch { /* يكنسه الإقلاع */ }
  }
}

/** إلغاء بعد الملخص */
export function abortPreparedRestore(env: BackupEnv, plan: RestorePlan, archiveTmp: string): void {
  abortRestore(env, plan.stagingDir);
  try { env.fs.remove(archiveTmp); } catch { /* يكنسه الإقلاع */ }
}

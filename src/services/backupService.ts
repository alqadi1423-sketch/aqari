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
import { createBackup, ensureFreeSpace, safetyBackupsDir } from '../domain/backup/create';
import { deviceBackupPath, deviceBackups, type DeviceBackup } from '../domain/backup/deviceBackups';
import { prepareRestore, commitRestore, abortRestore, type RestorePlan, type PrepareOptions } from '../domain/backup/restore';
import type { BackupEnv, BackupManifest } from '../domain/backup/types';
import { setSetting } from '../repos/settings';
import { toLocalISODate } from '../domain/dates';
import { openNodeDbCompat } from './openTempDb';
import { deviceCipher } from './cipher';
import { backupSecretForSealing } from './backupPassword';
import { getSyncState } from '../sync/engine';
import { sealBackupFile } from '../domain/backup/seal';
import type { CancelSignal, ProgressFn } from '../domain/progress';
// منتقي الملفات والكاميرا والمشاركة والطباعة نوافذ يفتحها التطبيق: العودة القصيرة منها لا تُقفله (#51)
import { whilePrompting } from './appLockService';
import { APP_VERSION_LABEL } from '../version';
import { t } from '../i18n';

export function appBackupEnv(db: AppDB): BackupEnv {
  const root = appDataRoot();
  let open = true;
  return {
    db,
    dbPath: db.databasePath,
    fs: expoFs,
    hasher: expoHasher,
    attachmentsDir: joinPath(root, 'attachments'),
    tmpDir: joinPath(root, 'tmp'),
    appVersion: APP_VERSION_LABEL,
    openDb: (path) => openTempSqlite(path),
    // الإغلاق الذي يفشل يُرمى فتتوقف الاستعادة قبل أن تمسّ الملفات (المراجعة الشاملة · البند ٢٠) · ومسار التراجع يبتلعه بنفسه ·
    // وما أغلقته هذه البيئة من قبل لا يُغلق مرتين
    closeLive: () => { if (!open) return; db.close(); open = false; },
    reopenLive: () => { db.reopen(); open = true; return db; },
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
  onProgress?: ProgressFn,
  signal?: CancelSignal,
): Promise<BackupManifest> {
  const env = appBackupEnv(db);
  const name = `عقاري · نسخة · ${toLocalISODate(new Date())}.aqbk`;
  const outPath = joinPath(env.tmpDir, name);
  const manifest = await createBackup(env, outPath, onProgress, { signal });
  // مشفّرة دائماً بمفتاح الاسترداد (التوجيه الرابع ٤ · ٣) · ولا يُسلَّم المشفّر قبل أن يُفكّ ويطابق · وبلا مفتاحٍ أو تعذّرت قراءته: لا تصدير
  const secret = await backupSecretForSealing(getSyncState(db, 'uid'));
  await sealBackupFile(env, outPath, secret, onProgress);
  setSetting(db, 'lastBackupAt', new Date().toISOString());
  onProgress?.('جاري فتح نافذة المشاركة');
  // فشل المشاركة بعد نجاح النسخة لا يُحسب فشلاً للنسخة نفسها
  try {
    if (await Sharing.isAvailableAsync()) {
      await whilePrompting(() => Sharing.shareAsync(new File(outPath).uri, { dialogTitle: 'تصدير النسخة الاحتياطية' }));
      setSetting(db, 'lastExportAt', new Date().toISOString());
    }
  } catch { /* أُنشئت النسخة وسلِمت · المشاركة وحدها أُلغيت */ }
  return manifest;
}

/**
 * المرحلة التفاعلية الأولى: اختيار الملف وتجهيز الاستعادة (تشغيل تجريبي كامل).
 * لا يمسّ البيانات الحية · يعيد الخطة والملخص أو null عند الإلغاء.
 */
/**
 * نسخة من نسخ هذا الجهاز (قبل آخر مسح أو استعادة، أو قبل ترقية) · تُستعاد من «البيانات والمساحة» بالمسار المعتاد نفسه.
 * تُنسخ أولاً إلى المؤقت لأن الاستعادة تصنع نسخة أمان جديدة تحذف ما قبلها.
 */
export async function prepareRestoreFromSafety(
  db: AppDB,
  onProgress?: ProgressFn,
  opts?: PrepareOptions,
  name?: string,
): Promise<{ env: BackupEnv; plan: RestorePlan; archiveTmp: string } | null> {
  const env = appBackupEnv(db);
  // نسخة الأمان ونسخ ما قبل الترقية (القرارات المعلّقة البند ١٧) · المختارة باسمها من القائمة، وبلا اسمٍ الأحدث
  const src = deviceBackupPath(env, name);
  if (!src) return null;
  await ensureFreeSpace(env);
  env.fs.mkdirp(env.tmpDir);
  const archiveTmp = joinPath(env.tmpDir, 'restore-input.aqbk');
  env.fs.write(archiveTmp, env.fs.read(src));
  const plan = await prepareRestore(env, archiveTmp, onProgress, opts);
  return { env, plan, archiveTmp };
}

export async function pickAndPrepareRestore(
  db: AppDB,
  onProgress?: ProgressFn,
  opts?: PrepareOptions
): Promise<{ env: BackupEnv; plan: RestorePlan; archiveTmp: string } | null> {
  const env = appBackupEnv(db);
  // القرص يسع العملية · **قبل فتح المنتقي** لا بعده:
  // المنتقي نفسه ينسخ الملف المختار إلى الذاكرة المؤقتة قبل أن يعود إلينا، وهي
  // نسخةٌ بحجم الأرشيف كاملاً · فإن ضاق القرص فشل هو قبل أن يصل الدور إلى فحصنا،
  // وخرج العطل بلغةٍ أعجمية من طبقة النظام لا برسالتنا.
  await ensureFreeSpace(env);
  const res = await whilePrompting(() => DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }));
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

/**
 * ملفُّ ما لم يُرفع من عمل العضو بعد خروجه من المنشأة يُرسل إلى صاحبها من نافذة المشاركة (المراجعة الشاملة 2026-11-13 · B-4 ·
 * قرار المالك س٩: «يُفرَّغ جواله عند أول اتصال بعد حفظ ذلك التعديل وحده في ملفٍ صغير يُرسل لك»)
 */
export async function shareUnsyncedFile(path: string, title: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error(t('org.exit.shareUnavailable'));
  await whilePrompting(() => Sharing.shareAsync(new File(path).uri, { dialogTitle: title, mimeType: 'application/json' }));
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

/** نسخ هذا الجهاز لزر «استعادة» في «البيانات والمساحة» · الأحدث أولاً (القرارات المعلّقة البند ١٧) */
export function listDeviceBackups(db: AppDB): Array<DeviceBackup & { size: number }> {
  const env = appBackupEnv(db);
  const dir = safetyBackupsDir(env);
  return deviceBackups(env).map((b) => {
    let size = 0;
    try { size = env.fs.size(joinPath(dir, b.name)); } catch { size = 0; }
    return { ...b, size };
  });
}

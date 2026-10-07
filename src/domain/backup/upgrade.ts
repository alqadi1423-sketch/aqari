/**
 * نسخة كاملة قبل كل ترقية لقاعدةٍ فيها بيانات · فإن فشلت فلا ترقية.
 *
 * الترقية تعيد بناء جداول وتضيف محفّزات على بيانات المستخدم كلها، والهجرة في معاملة واحدة
 * فلا تترك حالة وسطى · لكن خطأً في منطق الهجرة نفسها لا تحميه المعاملة، فتُحفظ البيانات
 * كما هي قبلها في نسخة تُستعاد من شاشة النسخ الاحتياطي (والاستعادة ترقّي النسخ الأقدم بنفسها).
 * والنسخة بالتحقق الكامل نفسه الذي في createBackup: إعادة فتح الأرشيف، وبصمة القاعدة وكل
 * مرفق، وintegrity_check، ومطابقة الأعداد · ويُحتفظ بآخر ثلاث ويُحذف ما قبلها.
 */
import { isCancelled, type CancelSignal, type ProgressFn } from '../progress';
import { joinPath } from '../../files/fsAdapter';
import { currentSchemaVersion, migrate } from '../../db/migrations';
import { SCHEMA_VERSION } from '../../db/schema';
import { createBackup, ensureFreeSpace, safetyBackupsDir, PRE_UPGRADE_PREFIX } from './create';
import type { BackupEnv, BackupManifest } from './types';

/** عدد نسخ ما قبل الترقية المحفوظة · الأحدث فالأقدم */
export const PRE_UPGRADE_KEEP = 3;

/** جداول تكتبها البذرة والإعداد لا المستخدم · وجود صفوفها وحدها لا يعني بيانات */
const SYSTEM_TABLES = new Set([
  'meta', 'settings', 'accounts', 'company', 'message_scripts', 'form_templates',
  'audit_log', 'scheduled_notifications',
]);

/** في القاعدة بيانات أدخلها المستخدم؟ · أي صف في جدول غير جداول النظام والمزامنة */
export function hasUserData(db: BackupEnv['db']): boolean {
  const tables = db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).map((t) => t.name);
  for (const t of tables) {
    if (SYSTEM_TABLES.has(t) || t.startsWith('sync_')) continue;
    // مركز «عام» تزرعه الهجرة ٢٨ على كل قاعدة · وما أضافه المستخدم بياناته
    if (t === 'cost_centers') {
      if (db.get(`SELECT 1 FROM cost_centers WHERE is_default = 0 LIMIT 1`)) return true;
      continue;
    }
    if (db.get(`SELECT 1 FROM "${t}" LIMIT 1`)) return true;
  }
  return false;
}

export interface UpgradeState {
  from: number;
  to: number;
  /** ترقية مطلوبة على قاعدة فيها بيانات · فتُسبق بنسخة */
  needsBackup: boolean;
}

/** حالة الترقية · قاعدة جديدة (الإصدار صفر) لا بيانات فيها فلا نسخة لها */
export function upgradeState(db: BackupEnv['db']): UpgradeState {
  const from = currentSchemaVersion(db);
  return { from, to: SCHEMA_VERSION, needsBackup: from > 0 && from < SCHEMA_VERSION && hasUserData(db) };
}

/** فشل نسخة ما قبل الترقية · رسالته عربية تُعرض كما هي ولا ترقية بعدها */
export class UpgradeBackupError extends Error {
  constructor(public reason: string) {
    super('لم تُرقَّ بياناتك لأن حفظ نسخة كاملة منها قبل الترقية لم يكتمل · ' + reason
      + ' · بياناتك كما هي لم يتغيّر فيها شيء، فأعد المحاولة بعد معالجة السبب.');
    this.name = 'UpgradeBackupError';
  }
}

const ARABIC = /[؀-ۿ]/;

/** نسخ ما قبل الترقية في المجلد · الأحدث أولاً (الاسم يحمل التاريخ بصيغة ترتّب نفسها) */
export function preUpgradeBackups(env: BackupEnv): string[] {
  const dir = safetyBackupsDir(env);
  let names: string[] = [];
  try { names = env.fs.list(dir); } catch { return []; }
  return names.filter((n) => n.startsWith(PRE_UPGRADE_PREFIX + '-') && n.endsWith('.aqbk')).sort().reverse();
}

/**
 * النسخة نفسها · تعيد مسارها وبيانها، أو ترمي UpgradeBackupError بسبب عربي.
 * لا تحذف شيئاً قبل أن تكتمل الجديدة وتُتحقَّق.
 */
export async function makePreUpgradeBackup(
  env: BackupEnv,
  onProgress?: ProgressFn,
  now: Date = new Date(),
  signal?: CancelSignal,
): Promise<{ path: string; manifest: BackupManifest }> {
  const from = currentSchemaVersion(env.db);
  const dir = safetyBackupsDir(env);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const outPath = joinPath(dir, `${PRE_UPGRADE_PREFIX}-${stamp}-v${from}.aqbk`);
  let manifest: BackupManifest;
  try {
    await ensureFreeSpace(env);
    env.fs.mkdirp(dir);
    manifest = await createBackup(env, outPath, onProgress, { preUpgrade: true, signal });
  } catch (e) {
    if (isCancelled(e)) throw e;
    const m = e instanceof Error ? e.message : '';
    throw new UpgradeBackupError(ARABIC.test(m) ? m : 'تعذّر إنشاء النسخة أو التحقق منها');
  }
  // السقف بعد نجاح الجديدة · فلا تمرّ لحظة بلا نسخة
  for (const old of preUpgradeBackups(env).slice(PRE_UPGRADE_KEEP)) {
    try { env.fs.remove(joinPath(dir, old)); } catch { /* التالي · لا يعطّل */ }
  }
  return { path: outPath, manifest };
}

/**
 * الترقية المحروسة: نسخة كاملة أولاً إن كانت في القاعدة بيانات، ثم الهجرة.
 * فشل النسخة يرمي قبل أن تُمسّ البنية.
 */
export async function guardedUpgrade(
  env: BackupEnv,
  onProgress?: (msg: string) => void
): Promise<{ from: number; backupPath: string | null }> {
  const st = upgradeState(env.db);
  let backupPath: string | null = null;
  if (st.needsBackup) backupPath = (await makePreUpgradeBackup(env, onProgress)).path;
  onProgress?.('جاري ترقية البيانات');
  migrate(env.db);
  return { from: st.from, backupPath };
}

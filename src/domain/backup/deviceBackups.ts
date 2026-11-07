/**
 * نسخ هذا الجهاز التلقائية (القرارات المعلّقة البند ١٧ · قرار المالك 2026-11-07 «نغلقها» بالخيار أ): نوعان كما بُنيا · نسخة الأمان قبل
 * الاستعادة أو المسح (تبقى الأخيرة)، ونسخ ما قبل الترقية (آخر ثلاث) · وزر «استعادة» القائم في «البيانات والمساحة» يعرضها كلها بتاريخ
 * كلٍّ منها ونوعها، بلا شاشة جديدة. والقائمة من أسماء الملفات وحدها (الاسم يحمل نوعه ووقته)، فلا يُفتح أرشيفٌ لعرضها.
 */
import { joinPath } from '../../files/fsAdapter';
import { safetyBackupsDir, PRE_UPGRADE_PREFIX } from './create';
import type { BackupEnv } from './types';
import { t } from '../../i18n';

export type DeviceBackupKind = 'pre-restore' | 'pre-wipe' | 'pre-upgrade';

export interface DeviceBackup {
  name: string;
  kind: DeviceBackupKind;
  /** وقت صنعها (ISO بتوقيت UTC كما في اسمها) */
  at: string;
  /** إصدار بنية القاعدة قبل الترقية · لنسخ ما قبل الترقية وحدها */
  fromSchema?: number;
}

// الاسم كما تكتبه create.ts وupgrade.ts: «النوع-التاريخT-الساعة-الدقيقة-الثانية-الأجزاءZ[-vالإصدار].aqbk»
const NAME = new RegExp(
  '^(pre-restore|pre-wipe|' + PRE_UPGRADE_PREFIX + ')-(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})-(\\d{3})Z(?:-v(\\d+))?\\.aqbk$',
);

/** نوع النسخة ووقتها من اسمها · واسمٌ لا يطابق الشكل (ملفٌ غريب أو مسارٌ ملتفّ) لا يُعدّ نسخة */
export function parseDeviceBackupName(name: string): DeviceBackup | null {
  const m = NAME.exec(String(name ?? ''));
  if (!m) return null;
  const at = `${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z`;
  if (Number.isNaN(Date.parse(at))) return null;
  const kind = m[1] as DeviceBackupKind;
  return { name, kind, at, ...(kind === 'pre-upgrade' && m[7] ? { fromSchema: Number(m[7]) } : {}) };
}

/** النسخ على هذا الجهاز · الأحدث أولاً بوقتها لا بترتيب أسمائها (فـ«pre-wipe» لا تسبق «pre-restore» أحدث منها لحروفها) */
export function deviceBackups(env: BackupEnv): DeviceBackup[] {
  const dir = safetyBackupsDir(env);
  let names: string[] = [];
  try { names = env.fs.exists(dir) ? env.fs.list(dir) : []; } catch { return []; }
  return names
    .map(parseDeviceBackupName)
    .filter((b): b is DeviceBackup => b !== null)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.name < b.name ? 1 : -1));
}

/**
 * مسار النسخة المختارة · بلا اسمٍ: الأحدث · واسمٌ ليس في القائمة يُرفض (لا يُقرأ ملفٌ خارج مجلد النسخ باسمٍ مصنوع)،
 * وإن لم تكن نسخةٌ فـnull
 */
export function deviceBackupPath(env: BackupEnv, name?: string): string | null {
  const list = deviceBackups(env);
  if (!list.length) return null;
  const hit = name === undefined ? list[0] : list.find((b) => b.name === name);
  if (!hit) throw new Error(t('backup.device.gone'));
  return joinPath(safetyBackupsDir(env), hit.name);
}

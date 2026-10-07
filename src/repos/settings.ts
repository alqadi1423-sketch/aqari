import type { DB } from '../db/adapter';
import { DEFAULT_SETTINGS } from '../db/seed';

export interface AppSettings {
  remindersOn: boolean;
  remindPayment: 1 | 3 | 7 | 14;
  remindContract: 15 | 30 | 60 | 90;
  remindDoc: 15 | 30 | 60;
  backupWeekly: boolean;
  trashRetention: 30 | 60 | 90;
  lastExportAt: string | null;
  lastBackupAt: string | null;
  displayScale: number;
  fontScale: number;
  /** نزع بيانات EXIF من صور JPEG عند الرفع · حذف تعريفي بلا إعادة ترميز · مطفأ افتراضياً */
  stripExif: boolean;
  /** حدّ الذاكرة المؤقتة للملفات المنزَّلة من الخادم بالميغابايت (النموذج المختلط) */
  fileCacheMb: 250 | 500 | 1000 | 2000;
}

export function getSetting<K extends keyof AppSettings>(db: DB, key: K): AppSettings[K] {
  const row = db.get<{ value_json: string }>(`SELECT value_json FROM settings WHERE key = ?`, [key]);
  if (!row) return DEFAULT_SETTINGS[key] as AppSettings[K];
  return JSON.parse(row.value_json) as AppSettings[K];
}

export function getAllSettings(db: DB): AppSettings {
  const out = { ...(DEFAULT_SETTINGS as unknown as AppSettings) };
  for (const row of db.all<{ key: string; value_json: string }>(`SELECT key, value_json FROM settings`)) {
    (out as Record<string, unknown>)[row.key] = JSON.parse(row.value_json);
  }
  return out;
}

export function setSetting<K extends keyof AppSettings>(db: DB, key: K, value: AppSettings[K]): void {
  db.transaction(() => {
    db.run(
      `INSERT INTO settings (key, value_json) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      [key, JSON.stringify(value)]
    );
  });
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key]);
  return row ? row.value : null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.transaction(() => {
    db.run(
      `INSERT INTO meta (key, value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  });
}

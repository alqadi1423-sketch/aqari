/**
 * حالة التطبيق الخفيفة: نسخة القاعدة (للتحديث بعد كل كتابة) + مقياسا العرض والخط.
 * المقياسان متصلان (٧٠ إلى ١٥٠٪ بخطوة ١٪): قيمة حية أثناء السحب تعمّ الشاشة فوراً،
 * وتُحفظ في القاعدة عند ترك الشريط فتبقى بعد الإغلاق وإعادة التشغيل.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { appDb, type AppDB } from '../db/expoAdapter';
import { getAllSettings, setSetting, type AppSettings } from '../repos/settings';
import { backfillHandovers } from '../domain/handover/service';
import { refreshContractStatuses } from '../domain/contracts/rules';
import { sweepCache, ensureAppDirs } from '../services/storageOps';
import { backfillTenantLinks } from '../domain/tenants';
import { purgeExpiredTrash } from '../domain/trash';
import { gcBlobs } from '../files/store';
import { appFilesEnv } from '../services/filesEnv';
import { writeWidgetSnapshot, scheduleWidgetSnapshot } from '../services/widgetService';
import { perfAttachStorage } from '../perf/perf';
import { getSetting } from '../repos/settings';
import { today } from '../domain/dates';
import { naturalKey } from '../domain/sortKey';

/** هجرة البيانات القائمة: حساب مفتاح الترتيب لكل وحدة بلا مفتاح */
function backfillSortKeys(db: AppDB): void {
  const rows = db.all<{ id: string; unit_no: string }>(
    `SELECT id, unit_no FROM units WHERE unit_no_key IS NULL`
  );
  if (!rows.length) return;
  db.transaction(() => {
    for (const r of rows) db.run(`UPDATE units SET unit_no_key = ? WHERE id = ?`, [naturalKey(r.unit_no), r.id]);
  });
}

const clampPct = (v: number) => Math.min(150, Math.max(70, Math.round(v)));

interface AppState {
  db: AppDB;
  /** يرتفع بعد كل كتابة · الشاشات تعتمد عليه لإعادة الاستعلام */
  version: number;
  bump(): void;
  settings: AppSettings;
  updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void;
  /** مقياس الخط ٧٠ إلى ١٥٠٪ (معامل ضرب مستقل عن مقياس العرض) */
  fontScale: number;
  /** مقياس عرض الواجهة ٧٠ إلى ١٥٠٪ · يكبّر كل شيء معاً */
  uiScale: number;
  /** النسبتان المعروضتان بجانب الشريطين (تتغيّران أثناء السحب) */
  fontPct: number;
  uiPct: number;
  /** أثناء السحب: تطبيق فوري دون كتابة في القاعدة */
  previewScale(key: 'displayScale' | 'fontScale', pct: number): void;
  /** عند ترك الشريط: حفظ دائم */
  commitScale(key: 'displayScale' | 'fontScale', pct: number): void;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  // فتح القاعدة وهجرتها فقط قبل أول رسم · كل صيانة أخرى مؤجلة بعده
  const db = useMemo(() => {
    const d = appDb();
    // عينات قياس الأداء تُحفظ في meta فتنجو من إعادة تشغيل التطبيق
    perfAttachStorage({
      save: (json) => d.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('perf_log', ?)`, [json]),
      load: () => d.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'perf_log'`)?.value ?? null,
    });
    return d;
  }, []);
  const [version, setVersion] = useState(0);
  const [settings, setSettings] = useState<AppSettings>(() => getAllSettings(db));
  // القيم الحية أثناء سحب الشريطين · null = استعمل المحفوظ
  const [liveUi, setLiveUi] = useState<number | null>(null);
  const [liveFont, setLiveFont] = useState<number | null>(null);

  const bump = useCallback(() => {
    setVersion((v) => v + 1);
    setSettings(getAllSettings(db));
    // لقطة الودجت مجدولة بعد سكون · لا تركب كل bump فتُثقله
    scheduleWidgetSnapshot(db);
  }, [db]);

  // صيانة الإقلاع كانت متزامنة قبل أول رسم فكانت تجمّد أول الشاشات ثواني ·
  // الآن على دفعتين مؤجلتين: الإعمار السريع ثم الكنس البطيء
  useEffect(() => {
    const t1 = setTimeout(() => {
      try {
        refreshContractStatuses(db, today());
        backfillHandovers(db);
        backfillSortKeys(db);
        backfillTenantLinks(db);
        writeWidgetSnapshot(db);
        bump();
      } catch { /* لا يعطّل الإقلاع */ }
    }, 700);
    const t2 = setTimeout(() => {
      try {
        ensureAppDirs();
        sweepCache();
        purgeExpiredTrash(db).catch(() => {});
        gcBlobs(appFilesEnv(db), getSetting(db, 'trashRetention'));
      } catch { /* لا يعطّل الإقلاع */ }
    }, 3000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [db, bump]);
  const updateSetting = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setSetting(db, key, value);
      bump();
    },
    [db, bump]
  );
  const previewScale = useCallback((key: 'displayScale' | 'fontScale', pct: number) => {
    const v = clampPct(pct);
    if (key === 'displayScale') setLiveUi(v);
    else setLiveFont(v);
  }, []);
  const commitScale = useCallback((key: 'displayScale' | 'fontScale', pct: number) => {
    const v = clampPct(pct);
    setSetting(db, key, v);
    if (key === 'displayScale') setLiveUi(null);
    else setLiveFont(null);
    bump();
  }, [db, bump]);

  const uiPct = clampPct(liveUi ?? settings.displayScale ?? 100);
  const fontPct = clampPct(liveFont ?? settings.fontScale ?? 100);

  const value = useMemo<AppState>(
    () => ({
      db, version, bump, settings, updateSetting,
      uiScale: uiPct / 100, fontScale: fontPct / 100, uiPct, fontPct,
      previewScale, commitScale,
    }),
    [db, version, bump, settings, updateSetting, uiPct, fontPct, previewScale, commitScale]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppStateProvider مفقود');
  return v;
}

/** حجم خط متدرج بمقياس الإعدادات */
export function useFs() {
  const { fontScale } = useApp();
  return useCallback((px: number) => Math.round(px * fontScale * 10) / 10, [fontScale]);
}

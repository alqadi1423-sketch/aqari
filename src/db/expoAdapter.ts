/**
 * محوّل expo-sqlite · يُستخدم داخل التطبيق فقط.
 */
import * as SQLite from 'expo-sqlite';
import { applyOpenPragmas, makeTransactionRunner, type DB, type SqlParams } from './adapter';
import { migrate } from './migrations';
import { seed, ensureDeviceId } from './seed';
import { upgradeState } from '../domain/backup/upgrade';
import { perfSqlTick } from '../perf/perf';

const tNow = (): number =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

/** توقيت كل استعلام لشاشة قياس الأداء · كلفته استدعاءا ساعة لا غير */
function timed<T>(sql: string, fn: () => T): T {
  const t0 = tNow();
  const out = fn();
  perfSqlTick(sql, tNow() - t0);
  return out;
}

export const DB_NAME = 'aqari.db';

export interface AppDB extends DB {
  /** المسار الفعلي لملف القاعدة (يلزم للنسخ الاحتياطي) */
  databasePath: string;
  /** إغلاق وإعادة فتح (يلزم للتبديل الذرّي أثناء الاستعادة) */
  reopen(): void;
}

/** حدّ العبارات المحضَّرة المحفوظة · الأقدم استعمالاً يُنهى أولاً */
const STATEMENT_CACHE_MAX = 96;

export function openExpoDb(name: string = DB_NAME): AppDB {
  let raw = SQLite.openDatabaseSync(name);
  const base = { exec: (sql: string) => raw.execSync(sql) };
  const transaction = makeTransactionRunner(base);

  // العبارات المحضَّرة تُحفظ (أعطال ٢٠٢٦-١٠-٠٥: تحضير نصّ الخصم الطويل في كل نداء كان أكثر كلفة المزامنة) ·
  // والمكتبة تعيد ضبط العبارة وتمسح قيمها قبل كل تشغيل، وتُعاد هنا بعده فلا تبقى قراءة معلّقة
  const cache = new Map<string, SQLite.SQLiteStatement>();
  const stmt = (sql: string): SQLite.SQLiteStatement => {
    let s = cache.get(sql);
    if (s) { cache.delete(sql); cache.set(sql, s); return s; }
    s = raw.prepareSync(sql);
    cache.set(sql, s);
    if (cache.size > STATEMENT_CACHE_MAX) {
      const [k, old] = cache.entries().next().value as [string, SQLite.SQLiteStatement];
      cache.delete(k);
      try { old.finalizeSync(); } catch { /* أُنهيت */ }
    }
    return s;
  };
  const dropCache = () => {
    for (const s of cache.values()) { try { s.finalizeSync(); } catch { /* أُنهيت */ } }
    cache.clear();
  };
  const execute = <T, R>(sql: string, params: SqlParams, read: (r: SQLite.SQLiteExecuteSyncResult<T>) => R): R => {
    const r = stmt(sql).executeSync<T>(params as SQLite.SQLiteBindParams);
    try { return read(r); } finally { try { r.resetSync(); } catch { /* لا شيء معلّق */ } }
  };

  const db: AppDB = {
    exec: (sql) => timed(sql, () => raw.execSync(sql)),
    run(sql: string, params: SqlParams = []) {
      timed(sql, () => execute(sql, params, () => undefined));
    },
    get<T>(sql: string, params: SqlParams = []): T | undefined {
      const row = timed(sql, () => execute<T, T | null>(sql, params, (r) => r.getFirstSync()));
      return row === null ? undefined : (row as T);
    },
    all<T>(sql: string, params: SqlParams = []): T[] {
      return timed(sql, () => execute<T, T[]>(sql, params, (r) => r.getAllSync()));
    },
    transaction,
    // على خيط القاعدة الأصلي · للعبارات الثقيلة كـ VACUUM INTO فلا يُحتجز خيط الواجهة
    execAsync: (sql) => raw.execAsync(sql),
    close: () => { dropCache(); raw.closeSync(); },
    databasePath: raw.databasePath,
    reopen() {
      dropCache();
      try { raw.closeSync(); } catch { /* مغلقة بالفعل */ }
      raw = SQLite.openDatabaseSync(name);
      db.databasePath = raw.databasePath;
      applyOpenPragmas(db);
    },
  };
  applyOpenPragmas(db);
  return db;
}

let _appDb: AppDB | null = null;
let _raw: AppDB | null = null;
let _upgradeCleared = false;

/** القاعدة تنتظر نسخة ما قبل الترقية · لا يُهاجرها طلبٌ يسبق بوابة الترقية */
export class UpgradePendingError extends Error {
  constructor() { super('upgrade-pending'); this.name = 'UpgradePendingError'; }
}

/** القاعدة مفتوحة بلا هجرة · لبوابة الترقية وحدها: تقرأ الإصدار وتنسخ قبل أن تُمسّ البنية */
export function rawAppDb(): AppDB {
  if (_appDb) return _appDb;
  if (!_raw) _raw = openExpoDb();
  return _raw;
}

/** تأذن بوابة الترقية بالهجرة · بعد نسخة ناجحة أو حين لا بيانات تُنسخ */
export function clearUpgrade(): void {
  _upgradeCleared = true;
}

/**
 * قاعدة التطبيق الوحيدة · تُفتح وتُهاجَر وتُزرع عند أول طلب.
 * قاعدةٌ أقدم من التطبيق فيها بيانات لا تُهاجَر هنا قبل أن تأذن البوابة (src/ui/UpgradeGate.tsx)
 * بعد نسخة كاملة · فيرمي الطلب المبكر بدل أن يرقّيها بلا نسخة.
 */
export function appDb(): AppDB {
  if (!_appDb) {
    const d = rawAppDb();
    if (!_upgradeCleared && upgradeState(d).needsBackup) throw new UpgradePendingError();
    migrate(d);
    seed(d);
    ensureDeviceId(d);
    _appDb = d;
    _raw = null;
  }
  return _appDb;
}

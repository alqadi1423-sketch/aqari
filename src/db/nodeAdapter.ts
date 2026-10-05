/**
 * محوّل node:sqlite (مدمج في Node ≥ 22.5) · للاختبارات وأدوات سطر الأوامر.
 * لا يُستورد من كود التطبيق (react-native يستخدم expoAdapter).
 */
import { DatabaseSync } from 'node:sqlite';
import { applyOpenPragmas, makeTransactionRunner, type DB, type SqlParams } from './adapter';

export function openNodeDb(path: string): DB {
  const raw = new DatabaseSync(path);
  const base = {
    exec: (sql: string) => raw.exec(sql),
  };
  const transaction = makeTransactionRunner(base);
  // العبارات المحضَّرة تُحفظ كما في expoAdapter
  const cache = new Map<string, ReturnType<typeof raw.prepare>>();
  const prep = (sql: string) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); if (cache.size > 96) cache.delete(cache.keys().next().value as string); }
    return s;
  };
  const db: DB = {
    exec: base.exec,
    run(sql: string, params: SqlParams = []) {
      prep(sql).run(...(params as never[]));
    },
    get<T>(sql: string, params: SqlParams = []): T | undefined {
      const row = prep(sql).get(...(params as never[]));
      return row === undefined ? undefined : ({ ...(row as object) } as T);
    },
    all<T>(sql: string, params: SqlParams = []): T[] {
      return prep(sql)
        .all(...(params as never[]))
        .map((r: unknown) => ({ ...(r as object) })) as T[];
    },
    transaction,
    close: () => raw.close(),
  };
  applyOpenPragmas(db);
  return db;
}

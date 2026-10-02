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
  const db: DB = {
    exec: base.exec,
    run(sql: string, params: SqlParams = []) {
      raw.prepare(sql).run(...(params as never[]));
    },
    get<T>(sql: string, params: SqlParams = []): T | undefined {
      const row = raw.prepare(sql).get(...(params as never[]));
      return row === undefined ? undefined : ({ ...(row as object) } as T);
    },
    all<T>(sql: string, params: SqlParams = []): T[] {
      return raw
        .prepare(sql)
        .all(...(params as never[]))
        .map((r: unknown) => ({ ...(r as object) })) as T[];
    },
    transaction,
    close: () => raw.close(),
  };
  applyOpenPragmas(db);
  return db;
}

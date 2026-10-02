/**
 * فتح قاعدة SQLite على مسار مطلق (للتحقق من النسخ المستخرجة داخل التطبيق).
 */
import * as SQLite from 'expo-sqlite';
import { applyOpenPragmas, makeTransactionRunner, type DB, type SqlParams } from '../db/adapter';

export function openNodeDbCompat(absolutePath: string): DB {
  // المسار المطلق يُمرَّر اسماً + مجلداً · تمريره اسماً واحداً كان يفتح قاعدة فارغة
  // جديدة في مجلد SQLite الافتراضي فيمرّ الفحص صامتاً على غير القاعدة المقصودة
  const clean = absolutePath.replace(/^file:\/\//, '');
  const slash = clean.lastIndexOf('/');
  const dir = slash > 0 ? clean.slice(0, slash) : clean;
  const name = slash > 0 ? clean.slice(slash + 1) : clean;
  const raw = SQLite.openDatabaseSync(name, undefined, 'file://' + dir);
  const base = { exec: (sql: string) => raw.execSync(sql) };
  const transaction = makeTransactionRunner(base);
  const db: DB = {
    exec: base.exec,
    run: (sql: string, params: SqlParams = []) => { raw.runSync(sql, params as SQLite.SQLiteBindParams); },
    get: <T,>(sql: string, params: SqlParams = []) => {
      const row = raw.getFirstSync<T>(sql, params as SQLite.SQLiteBindParams);
      return row === null ? undefined : (row as T);
    },
    all: <T,>(sql: string, params: SqlParams = []) => raw.getAllSync<T>(sql, params as SQLite.SQLiteBindParams),
    transaction,
    close: () => raw.closeSync(),
  };
  applyOpenPragmas(db);
  return db;
}

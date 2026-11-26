/**
 * فتح قاعدة SQLite على مسار مطلق (للتحقق من النسخ المستخرجة داخل التطبيق).
 */
import * as SQLite from 'expo-sqlite';
import { applyOpenPragmas, driverCall, makeTransactionRunner, type DB, type SqlParams } from '../db/adapter';

export function openNodeDbCompat(absolutePath: string): DB {
  // المسار المطلق يُمرَّر اسماً + مجلداً · تمريره اسماً واحداً كان يفتح قاعدة فارغة
  // جديدة في مجلد SQLite الافتراضي فيمرّ الفحص صامتاً على غير القاعدة المقصودة
  const clean = absolutePath.replace(/^file:\/\//, '');
  const slash = clean.lastIndexOf('/');
  const dir = slash > 0 ? clean.slice(0, slash) : clean;
  const name = slash > 0 ? clean.slice(slash + 1) : clean;
  const raw = SQLite.openDatabaseSync(name, undefined, 'file://' + dir);
  // عطل القاعدة يوسمه المحوّل بما رماه المشغّل (driverCall · مراجعة إصلاح R12-SYN-1)
  const base = { exec: (sql: string) => driverCall(() => raw.execSync(sql)), inTransaction: () => raw.isInTransactionSync() };
  const transaction = makeTransactionRunner(base);
  const db: DB = {
    exec: base.exec,
    run: (sql: string, params: SqlParams = []) => { driverCall(() => raw.runSync(sql, params as SQLite.SQLiteBindParams)); },
    get: <T,>(sql: string, params: SqlParams = []) => {
      const row = driverCall(() => raw.getFirstSync<T>(sql, params as SQLite.SQLiteBindParams));
      return row === null ? undefined : (row as T);
    },
    all: <T,>(sql: string, params: SqlParams = []) => driverCall(() => raw.getAllSync<T>(sql, params as SQLite.SQLiteBindParams)),
    transaction,
    inTransaction: base.inTransaction,
    close: () => raw.closeSync(),
  };
  applyOpenPragmas(db);
  return db;
}

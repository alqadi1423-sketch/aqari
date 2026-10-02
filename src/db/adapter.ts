/**
 * واجهة قاعدة البيانات المجردة · تنفيذان:
 *  - expoAdapter (expo-sqlite) في التطبيق
 *  - nodeAdapter (better-sqlite3) في الاختبارات
 * كلاهما متزامن، وكل كتابة تمر عبر transaction() التي تفتح BEGIN IMMEDIATE.
 */
export type SqlValue = string | number | null | Uint8Array;
export type SqlParams = SqlValue[];

export interface DB {
  /** تنفيذ عدة عبارات دفعة واحدة (DDL / PRAGMA) */
  exec(sql: string): void;
  run(sql: string, params?: SqlParams): void;
  get<T = Record<string, SqlValue>>(sql: string, params?: SqlParams): T | undefined;
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlParams): T[];
  /** كل كتابة داخل BEGIN IMMEDIATE · التداخل عبر SAVEPOINT */
  transaction<T>(fn: () => T): T;
  /**
   * تنفيذ على خيط القاعدة الأصلي حيث يتوفر (الجهاز) · للعبارات الثقيلة كـ VACUUM INTO
   * كي لا يُحتجز خيط الواجهة ثوانيَ فيقتل النظام التطبيق.
   */
  execAsync?(sql: string): Promise<void>;
  close(): void;
}

/** إدارة المعاملات المتداخلة المشتركة بين المحوّلين */
export function makeTransactionRunner(db: Pick<DB, 'exec'>): <T>(fn: () => T) => T {
  let depth = 0;
  return function transaction<T>(fn: () => T): T {
    if (depth > 0) {
      const name = `sp_${depth}`;
      db.exec(`SAVEPOINT ${name}`);
      depth++;
      try {
        const out = fn();
        depth--;
        db.exec(`RELEASE ${name}`);
        return out;
      } catch (e) {
        depth--;
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw e;
      }
    }
    db.exec('BEGIN IMMEDIATE');
    depth++;
    try {
      const out = fn();
      depth--;
      db.exec('COMMIT');
      return out;
    } catch (e) {
      depth--;
      db.exec('ROLLBACK');
      throw e;
    }
  };
}

/** إعدادات الفتح الملزمة */
export function applyOpenPragmas(db: Pick<DB, 'exec'>): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = FULL');
}

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

/**
 * إدارة المعاملات المتداخلة المشتركة بين المحوّلين.
 * العدّاد يُضبط مرةً واحدة في كل خروج: كان ينقص مرتين إن فشل COMMIT أو RELEASE فيصير سالباً،
 * فتفشل كل معاملةٍ متداخلة بعده حتى إعادة التشغيل (دراسة الويب §٤.٣).
 * وإن ألغت SQLite المعاملة بنفسها (امتلاء القرص، خطأ إدخال وإخراج) فشل ROLLBACK بعدها
 * بـ«no transaction is active»؛ يُبتلع ذلك وحده ويُرمى الخطأ الأصلي.
 */
export function makeTransactionRunner(db: Pick<DB, 'exec'>): <T>(fn: () => T) => T {
  let depth = 0;
  const quietly = (sql: string) => { try { db.exec(sql); } catch { /* المعاملة أُلغيت أصلاً · الخطأ الأصلي يُرمى بعده */ } };
  return function transaction<T>(fn: () => T): T {
    if (depth > 0) {
      const name = `sp_${depth}`;
      db.exec(`SAVEPOINT ${name}`);
      depth++;
      let out: T;
      try {
        out = fn();
      } catch (e) {
        depth--;
        quietly(`ROLLBACK TO ${name}`);
        quietly(`RELEASE ${name}`);
        throw e;
      }
      depth--;
      // إن فشل RELEASE صعد خطؤه إلى المستوى الأعلى فيُلغي ما فوقه، والعدّاد صحيحٌ هنا
      db.exec(`RELEASE ${name}`);
      return out;
    }
    db.exec('BEGIN IMMEDIATE');
    depth = 1;
    let out: T;
    try {
      out = fn();
      db.exec('COMMIT');
    } catch (e) {
      depth = 0;
      quietly('ROLLBACK');
      throw e;
    }
    depth = 0;
    return out;
  };
}

/** إعدادات الفتح الملزمة */
export function applyOpenPragmas(db: Pick<DB, 'exec'>): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = FULL');
}

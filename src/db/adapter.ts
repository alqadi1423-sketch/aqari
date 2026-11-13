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
  /**
   * هل المعاملة قائمة في القاعدة نفسها (لا في عدّاد المحوّل) · يكشف معاملةً ألغتها SQLite بنفسها فيمتنع ما يُكتب بعدها خارج أي معاملة
   * (المراجعة الشاملة 2026-11-13 · R12-SYN-1) · اختياري: محوّلٌ بلا كاشف لا يُسأل
   */
  inTransaction?(): boolean;
  close(): void;
}

/**
 * المعاملة الخارجية أُلغيت كلها من تحت المستدعي (ألغتها SQLite بنفسها عند امتلاء القرص أو خطأ الإدخال والإخراج) · رسالته رسالة الخطأ
 * الأصلي، وهو غير خطأ العمل: من يمسك خطأ معاملةٍ داخلية ليمضي (كالمزامنة ترفض مستنداً وتكمل الصفحة) يعيد رميه، فما يكتبه بعده يقع
 * خارج أي معاملة فيُحفظ وحده ويضيع ما قبله (المراجعة الشاملة 2026-11-13 · R12-SYN-1)
 */
/** نصّ الخطأ ولو من عالمٍ آخر (خطأ node:sqlite في بيئة jest ليس instanceof Error فيها) */
const messageOf = (e: unknown): string => {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : String(e);
};

export class TransactionAbortedError extends Error {
  constructor(readonly original: unknown) {
    super(messageOf(original));
    this.name = 'TransactionAbortedError';
  }
}

/**
 * أخطاء القاعدة نفسها لا المستند: امتلاء القرص وخطأ الإدخال والإخراج والانشغال ونفاد الذاكرة والتلف · قد تلغي SQLite المعاملة كلها
 * معها، ولا يُرفض بها مستندٌ ولا يُحكم بها على صفّ (المراجعة الشاملة 2026-11-13 · R12-SYN-1).
 * ويُعرف العطل بما رماه المشغّل نفسه لا بنصّ أي رسالة: رسالة رفضٍ يبنيها التطبيق قد تحمل نصاً كتبه عضو (رقم قيدٍ «database is locked»
 * في «حركة البنك لقيدٍ مرفوض») فكانت تُعدّ عطلاً فتوقف مزامنة المالك في كل دورة (مراجعة الإصلاح · R12-SYN-1) · فالمحوّلات وحدها توسم
 * خطأ المشغّل حين يرميه (driverCall)، بالرمز في node:sqlite (errcode) وفي expo-sqlite («Error code N:» في نصّه)، وبنصّ SQLite إن غاب الرمز
 */
const DB_FAULT_CODES = new Set([5, 6, 7, 10, 11, 13, 26]); // BUSY LOCKED NOMEM IOERR CORRUPT FULL NOTADB
const DB_FAULT_TEXT = /database or disk is full|disk I\/O error|database is locked|database table is locked|out of memory|database disk image is malformed|file is not a database|SQLITE_(FULL|IOERR|BUSY|LOCKED|NOMEM|CORRUPT|NOTADB)/i;
const DB_FAULT = Symbol.for('aqari.dbFault');

/** رمز SQLite في خطأ المشغّل: errcode في node:sqlite، و«Error code N:» في نصّ expo-sqlite (iOS وAndroid) */
function driverCode(e: unknown): number | null {
  const c = (e as { errcode?: unknown } | null)?.errcode;
  if (typeof c === 'number') return c;
  const m = /Error code (\d+):/.exec(messageOf(e));
  return m ? Number(m[1]) : null;
}

/** يوسم خطأً رماه المشغّل إن كان عطلاً في القاعدة · لا يُنادى إلا على ما رماه المشغّل نفسه (driverCall)، فنصّه نصّ SQLite لا نصّ مستند */
export function markDriverFault(e: unknown): unknown {
  if (e === null || typeof e !== 'object') return e;
  const code = driverCode(e);
  const fault = code !== null ? DB_FAULT_CODES.has(code & 0xff) : DB_FAULT_TEXT.test(messageOf(e));
  if (fault) { try { Object.defineProperty(e, DB_FAULT, { value: true }); } catch { /* مجمَّد: errcode يكفي في node */ } }
  return e;
}

/** نداءٌ إلى المشغّل يوسم خطأه إن كان عطلاً في القاعدة · حدّ المحوّل الوحيد الذي يُقرأ عنده نصّ SQLite */
export function driverCall<T>(fn: () => T): T {
  try { return fn(); } catch (e) { markDriverFault(e); throw e; }
}

export function isDbFault(e: unknown): boolean {
  if (e instanceof TransactionAbortedError) return true;
  if (e === null || typeof e !== 'object') return false;
  if ((e as { [DB_FAULT]?: unknown })[DB_FAULT] === true) return true;
  // errcode لا يضعه إلا node:sqlite
  const code = (e as { errcode?: unknown }).errcode;
  return typeof code === 'number' && DB_FAULT_CODES.has(code & 0xff);
}

/**
 * إدارة المعاملات المتداخلة المشتركة بين المحوّلين.
 * العدّاد يُضبط مرةً واحدة في كل خروج: كان ينقص مرتين إن فشل COMMIT أو RELEASE فيصير سالباً،
 * فتفشل كل معاملةٍ متداخلة بعده حتى إعادة التشغيل (دراسة الويب §٤.٣).
 * وإن ألغت SQLite المعاملة بنفسها (امتلاء القرص، خطأ إدخال وإخراج) فشل ROLLBACK بعدها
 * بـ«no transaction is active»؛ يُبتلع ذلك وحده ويُرمى الخطأ الأصلي.
 * وفي المعاملة المتداخلة يُرمى TransactionAbortedError بالخطأ الأصلي، وتفشل به كل معاملةٍ متداخلة بعده حتى تنتهي الخارجية، فلا
 * يُفتح بعد الإلغاء SAVEPOINT خارج أي معاملة (يبدأ معاملةً جديدة تُحفظ وحدها) ولا تُحفظ الخارجية ناقصة · inTransaction (إن وُجد)
 * يكشف الإلغاء ولو ابتلعه مستدعٍ، وبدونه يُكشف بفشل ROLLBACK TO (R12-SYN-1)
 */
export function makeTransactionRunner(db: Pick<DB, 'exec'> & { inTransaction?: () => boolean }): <T>(fn: () => T) => T {
  let depth = 0;
  /** الخطأ الذي ألغت معه SQLite المعاملة الخارجية الجارية · null ما دامت قائمة */
  let aborted: unknown = null;
  const quietly = (sql: string) => { try { db.exec(sql); } catch { /* المعاملة أُلغيت أصلاً · الخطأ الأصلي يُرمى بعده */ } };
  const gone = () => aborted !== null || (db.inTransaction ? !db.inTransaction() : false);
  const abortWith = (e: unknown): TransactionAbortedError => {
    if (aborted === null) aborted = e instanceof TransactionAbortedError ? e.original : e;
    return e instanceof TransactionAbortedError ? e : new TransactionAbortedError(aborted);
  };
  return function transaction<T>(fn: () => T): T {
    if (depth > 0) {
      if (gone()) throw abortWith(new Error('no transaction is active'));
      const name = `sp_${depth}`;
      db.exec(`SAVEPOINT ${name}`);
      depth++;
      let out: T;
      try {
        out = fn();
      } catch (e) {
        depth--;
        // فشل ROLLBACK TO: نقطة الحفظ ذهبت مع المعاملة كلها
        let lost = gone();
        if (!lost) { try { db.exec(`ROLLBACK TO ${name}`); } catch { lost = true; } }
        if (lost || gone()) throw abortWith(e);
        quietly(`RELEASE ${name}`);
        throw e;
      }
      depth--;
      if (gone()) throw abortWith(new Error('no transaction is active'));
      // إن فشل RELEASE صعد خطؤه إلى المستوى الأعلى فيُلغي ما فوقه، والعدّاد صحيحٌ هنا
      db.exec(`RELEASE ${name}`);
      return out;
    }
    db.exec('BEGIN IMMEDIATE');
    depth = 1;
    aborted = null;
    let out: T;
    try {
      out = fn();
      // مستدعٍ ابتلع الإلغاء: لا يُحفظ شيء ويظهر الخطأ الأصلي لا «cannot commit» · وبالكاشف ولو لم تمرّ به معاملةٌ متداخلة
      if (gone()) throw new TransactionAbortedError(aborted ?? new Error('no transaction is active'));
      db.exec('COMMIT');
    } catch (e) {
      depth = 0;
      aborted = null;
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

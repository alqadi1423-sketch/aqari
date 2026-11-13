/**
 * محوّل node:sqlite (مدمج في Node ≥ 22.5) · للاختبارات وأدوات سطر الأوامر.
 * لا يُستورد من كود التطبيق (react-native يستخدم expoAdapter).
 */
import { DatabaseSync } from 'node:sqlite';
import { applyOpenPragmas, driverCall, makeTransactionRunner, type DB, type SqlParams } from './adapter';

export function openNodeDb(path: string): DB {
  const raw = new DatabaseSync(path);
  // كل نداءٍ إلى المشغّل عبر driverCall: يوسم عطل القاعدة بما رماه المشغّل لا بنصّ رسالة (مراجعة إصلاح R12-SYN-1)
  const base = {
    exec: (sql: string) => driverCall(() => raw.exec(sql)),
    // يكشف إلغاء SQLite للمعاملة بنفسها (R12-SYN-1)
    inTransaction: () => raw.isTransaction,
  };
  const transaction = makeTransactionRunner(base);
  // العبارات المحضَّرة تُحفظ كما في expoAdapter
  const cache = new Map<string, ReturnType<typeof raw.prepare>>();
  const prep = (sql: string) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); if (cache.size > 96) cache.delete(cache.keys().next().value as string); }
    return s;
  };
  // وبعد تغيير المخطط تُرمى المحفوظة: node:sqlite في Node 22 يُبقي أعمدة «SELECT *» كما كانت قبل ALTER TABLE، فنجح على هذا الجهاز
  // اختبارٌ يسقط في جيت هب (Node 24) · upgrade16 على 52f19cb
  const db: DB = {
    exec: (sql: string) => { base.exec(sql); if (/\b(ALTER|CREATE|DROP)\b/i.test(sql)) cache.clear(); },
    run(sql: string, params: SqlParams = []) {
      driverCall(() => prep(sql).run(...(params as never[])));
    },
    get<T>(sql: string, params: SqlParams = []): T | undefined {
      const row = driverCall(() => prep(sql).get(...(params as never[])));
      return row === undefined ? undefined : ({ ...(row as object) } as T);
    },
    all<T>(sql: string, params: SqlParams = []): T[] {
      return driverCall(() => prep(sql).all(...(params as never[])))
        .map((r: unknown) => ({ ...(r as object) })) as T[];
    },
    transaction,
    inTransaction: base.inTransaction,
    close: () => raw.close(),
  };
  applyOpenPragmas(db);
  return db;
}

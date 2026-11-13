/**
 * عيبٌ وجدته دراسة نسخة الويب (2026-11-13 · §٤.٣) يمسّ الجوال اليوم:
 * عدّاد المعاملات في makeTransactionRunner ينقص مرتين إن فشل COMMIT أو RELEASE،
 * فيصير سالباً، وتفشل بعده كل معاملةٍ متداخلة («cannot start a transaction within a transaction»)
 * حتى يُعاد تشغيل التطبيق.
 * والاختبار على SQLite حقيقية (node:sqlite كما في nodeAdapter) مع مغلّفٍ يُفشل أمراً واحداً مرةً واحدة.
 */
import { DatabaseSync } from 'node:sqlite';
import { makeTransactionRunner } from '@/db/adapter';

type FailMode = 'throw' | 'autoRollback';

function harness() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE t (v INTEGER NOT NULL)');
  let failOn: { sql: string; mode: FailMode } | null = null;
  const exec = (sql: string) => {
    if (failOn && sql === failOn.sql) {
      const { mode } = failOn;
      failOn = null;
      // autoRollback: كما تفعل SQLite عند امتلاء القرص أو خطأ الإدخال والإخراج، تُلغي المعاملة بنفسها ثم يفشل الأمر
      if (mode === 'autoRollback') raw.exec('ROLLBACK');
      throw new Error(`فشلٌ مصطنع في ${sql}`);
    }
    raw.exec(sql);
  };
  const transaction = makeTransactionRunner({ exec });
  const insert = (v: number) => raw.prepare('INSERT INTO t (v) VALUES (?)').run(v);
  const values = () => (raw.prepare('SELECT v FROM t ORDER BY v').all() as { v: number }[]).map((r) => r.v);
  const nestedWrite = (v: number) => transaction(() => { insert(v); transaction(() => insert(v + 1)); });
  return { raw, transaction, insert, values, nestedWrite, failNext: (sql: string, mode: FailMode = 'throw') => { failOn = { sql, mode }; } };
}

describe('المعاملات بعد فشل الحفظ (adapter.ts)', () => {
  test('فشل COMMIT مرةً لا يكسر المعاملات المتداخلة بعده', () => {
    const h = harness();
    h.failNext('COMMIT');
    expect(() => h.transaction(() => h.insert(1))).toThrow('فشلٌ مصطنع في COMMIT');
    expect(h.raw.isTransaction).toBe(false);
    expect(h.values()).toEqual([]);
    h.nestedWrite(10);
    expect(h.values()).toEqual([10, 11]);
    expect(h.raw.isTransaction).toBe(false);
  });

  test('إن ألغت SQLite المعاملة بنفسها عند فشل COMMIT: يظهر الخطأ الأصلي لا خطأ ROLLBACK، وتعمل المعاملات بعده', () => {
    const h = harness();
    h.failNext('COMMIT', 'autoRollback');
    expect(() => h.transaction(() => h.insert(1))).toThrow('فشلٌ مصطنع في COMMIT');
    expect(h.raw.isTransaction).toBe(false);
    h.nestedWrite(20);
    expect(h.values()).toEqual([20, 21]);
  });

  test('إن ألغت SQLite المعاملة بنفسها أثناء العمل: يظهر الخطأ الأصلي لا خطأ ROLLBACK', () => {
    const h = harness();
    expect(() => h.transaction(() => { h.insert(1); h.raw.exec('ROLLBACK'); throw new Error('خطأ العمل الأصلي'); }))
      .toThrow('خطأ العمل الأصلي');
    expect(h.raw.isTransaction).toBe(false);
    h.nestedWrite(30);
    expect(h.values()).toEqual([30, 31]);
  });

  test('فشل RELEASE لنقطة حفظٍ داخلية يُلغي المعاملة كلها ولا يكسر ما بعدها', () => {
    const h = harness();
    h.failNext('RELEASE sp_1');
    expect(() => h.nestedWrite(1)).toThrow('فشلٌ مصطنع في RELEASE sp_1');
    expect(h.raw.isTransaction).toBe(false);
    expect(h.values()).toEqual([]);
    h.nestedWrite(40);
    expect(h.values()).toEqual([40, 41]);
  });

  test('خطأ داخلي يُمسك في الخارج: يُلغى الداخل وحده ويُحفظ الخارج (السلوك القائم)', () => {
    const h = harness();
    h.transaction(() => {
      h.insert(1);
      try { h.transaction(() => { h.insert(2); throw new Error('داخلي'); }); } catch { /* يمسكه المستدعي */ }
      h.insert(3);
    });
    expect(h.values()).toEqual([1, 3]);
    h.nestedWrite(50);
    expect(h.values()).toEqual([1, 3, 50, 51]);
  });
});

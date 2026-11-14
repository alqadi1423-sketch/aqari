/**
 * المراجعة الشاملة 2026-11-13 · R12-SYN-1 · مدير المعاملات (adapter.ts) على SQLite حقيقية كما في webStudy.txAfterCommitFail.
 *
 * العيب: إذا ألغت SQLite المعاملة كلها داخل نقطة حفظ (قرصٌ ممتلئ) فشل «ROLLBACK TO» بصمت ورُمي الخطأ الأصلي كأنه خطأ هذا العمل وحده،
 *   فمن يمسكه ليمضي (المزامنة ترفض المستند وتكمل الصفحة) يفتح بعده «SAVEPOINT» خارج أي معاملة فيبدأ معاملةً جديدة تُحفظ وحدها،
 *   وتضيع المعاملة الخارجية بلا علم أحد.
 * الصحيح: يُرمى خطأٌ مميّز (TransactionAbortedError) برسالة الخطأ الأصلي، وتفشل به كل معاملةٍ متداخلة بعده حتى تنتهي الخارجية،
 *   فلا يُحفظ شيءٌ منها · وتعمل المعاملات بعدها كالمعتاد.
 *   TZ=Asia/Riyadh npx jest tests/review12.sync.nestedAbort.test.ts
 */
import { DatabaseSync } from 'node:sqlite';
import { isDbFault, makeTransactionRunner, markDriverFault } from '@/db/adapter';
import { openNodeDb } from '@/db/nodeAdapter';

function harness(probe: boolean) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE t (v INTEGER NOT NULL)');
  const exec = (sql: string) => { raw.exec(sql); };
  const transaction = makeTransactionRunner(probe ? { exec, inTransaction: () => raw.isTransaction } : { exec });
  const insert = (v: number) => raw.prepare('INSERT INTO t (v) VALUES (?)').run(v);
  const values = () => (raw.prepare('SELECT v FROM t ORDER BY v').all() as { v: number }[]).map((r) => r.v);
  /** قرصٌ ممتلئ: SQLite تلغي المعاملة كلها ثم يفشل الأمر */
  const diskFull = (): never => { raw.exec('ROLLBACK'); throw new Error('database or disk is full'); };
  return { raw, transaction, insert, values, diskFull };
}

const nameOf = (fn: () => unknown): string => {
  try { fn(); return ''; } catch (e) { return `${(e as Error).name}: ${(e as Error).message}`; }
};

describe.each([false, true])('إلغاء SQLite للمعاملة داخل نقطة حفظ (كاشف المعاملة: %s)', (probe) => {
  test('يُرمى خطأ الإلغاء المميّز، وتفشل المعاملات المتداخلة بعده، ولا يُحفظ شيء', () => {
    const h = harness(probe);
    const seen: string[] = [];
    const outer = nameOf(() => h.transaction(() => {
      h.transaction(() => h.insert(1));
      // المستدعي يمسك خطأ المستند ويمضي إلى التالي كما تفعل المزامنة
      seen.push(nameOf(() => h.transaction(() => { h.insert(2); h.diskFull(); })));
      seen.push(nameOf(() => h.transaction(() => h.insert(3))));
    }));
    expect({ seen, outer, values: h.values(), open: h.raw.isTransaction }).toEqual({
      seen: ['TransactionAbortedError: database or disk is full', 'TransactionAbortedError: database or disk is full'],
      outer: 'TransactionAbortedError: database or disk is full',
      // لا ١ (أُلغي مع المعاملة) ولا ٣ (لا يُفتح بعد الإلغاء SAVEPOINT خارج أي معاملة)
      values: [],
      open: false,
    });
    // وما بعدها يعمل كالمعتاد
    h.transaction(() => { h.insert(10); h.transaction(() => h.insert(11)); });
    expect(h.values()).toEqual([10, 11]);
  });
});

test('بكاشف المعاملة: إلغاءٌ في المعاملة الخارجية ابتلعه مستدعٍ تُرفض بعده كل معاملةٍ متداخلة', () => {
  const h = harness(true);
  const seen: string[] = [];
  const outer = nameOf(() => h.transaction(() => {
    h.insert(1);
    try { h.diskFull(); } catch { /* ابتلعه مستدعٍ */ }
    seen.push(nameOf(() => h.transaction(() => h.insert(2))));
  }));
  expect({ seen, outer: outer.split(':')[0], values: h.values() })
    .toEqual({ seen: ['TransactionAbortedError: no transaction is active'], outer: 'TransactionAbortedError', values: [] });
});

/**
 * مراجعة الإصلاح (review12.r.dbFaultTextSpoof): العطل يُعرف بما رماه المشغّل نفسه (يوسمه المحوّل عند الحدّ) وبرمز node:sqlite، لا بنصّ
 * أي رسالة · فرسالةٌ يبنيها التطبيق وفيها نصّ SQLite (رقم قيدٍ كتبه عضو «database is locked») ليست عطلاً ولو طابقت نصّه حرفاً
 */
test('أعطال القاعدة تُعرف بما رماه المشغّل وبرمزه، لا بنصّ رسالةٍ بناها التطبيق', () => {
  const texts = ['database or disk is full', 'disk I/O error', 'database is locked', 'Error code 13: database or disk is full'];
  // رسائل التطبيق بنصّ SQLite: ليست عطلاً
  expect(texts.map((m) => isDbFault(new Error(m)))).toEqual([false, false, false, false]);
  expect(isDbFault(new Error('حركة البنك لقيدٍ مرفوض (database is locked) · لا تُطبَّق بلا قيدها'))).toBe(false);
  // وما رماه المشغّل بالنصّ نفسه عطلٌ (expo-sqlite يحمل «Error code N:»، وغيره بنصّ SQLite)
  expect(texts.map((m) => isDbFault(markDriverFault(new Error(m))))).toEqual([true, true, true, true]);
  // expo-sqlite: الرمز في النصّ يحكم، فقيدٌ فريدٌ مكرَّر (١٩) ليس عطلاً ولو ذكر نصّه «locked»
  expect(isDbFault(markDriverFault(new Error("Calling the 'runSync' function has failed\n→ Caused by: Error code 19: UNIQUE constraint failed: t.locked")))).toBe(false);
  expect(isDbFault(Object.assign(new Error('x'), { errcode: 13 }))).toBe(true);
  // SQLITE_IOERR_WRITE = 778 = 10 | (3 << 8) · رمزه الأساسي ١٠
  expect(isDbFault(Object.assign(new Error('x'), { errcode: 778 }))).toBe(true);
  expect([
    'FOREIGN KEY constraint failed', 'UNIQUE constraint failed: properties.id', 'الوارد مرفوض · مسدَّد سالب',
  ].map((m) => isDbFault(markDriverFault(new Error(m))))).toEqual([false, false, false]);
  expect(isDbFault(Object.assign(new Error('x'), { errcode: 19 }))).toBe(false); // SQLITE_CONSTRAINT
});

test('قرصٌ ممتلئ حقيقي عبر محوّل node: خطأ المشغّل عطلٌ، والمعاملة أُلغيت، ولا يُحفظ شيء', () => {
  const db = openNodeDb(':memory:');
  db.exec('CREATE TABLE t (v TEXT NOT NULL)');
  // حدّ الصفحات عند حجمها الآن: أول صفحةٍ جديدة تفشل بـSQLITE_FULL (١٣)
  db.exec('PRAGMA max_page_count = ' + db.get<{ page_count: number }>('PRAGMA page_count')!.page_count);
  let caught: unknown = null;
  const outer = nameOf(() => db.transaction(() => {
    db.run('INSERT INTO t (v) VALUES (?)', ['a']);
    try {
      db.transaction(() => { for (let i = 0; i < 100; i++) db.run('INSERT INTO t (v) VALUES (?)', ['x'.repeat(5000)]); });
    } catch (e) { caught = e; }
  }));
  expect({
    caught: nameOf(() => { throw caught; }),
    fault: isDbFault(caught),
    outer,
    rows: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM t')!.n,
    open: db.inTransaction!(),
  }).toEqual({
    caught: 'TransactionAbortedError: database or disk is full',
    fault: true,
    outer: 'TransactionAbortedError: database or disk is full',
    rows: 0,
    open: false,
  });
  db.close();
});

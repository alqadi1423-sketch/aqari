/**
 * جدول تحقق المالك لدفعة «الفترات تُشتقّ من البيانات»:
 * سنة وحدها إن كانت وحدها، ربعان زرّان لا أربعة، ٢٠٢٨ تظهر بأول مستند،
 * حذف مستندات ربع يُخفيه، عدد المستندات بجانب كل ربع، الافتراضي الحالي أو الأحدث.
 */
import { memDb as openDb } from './helpers/testDb';
import { dataYears, dataQuarters, defaultPeriod, quarterRange } from '@/domain/periods';
import type { DB } from '@/db/adapter';

const addPurchase = (db: DB, id: string, date: string) =>
  db.run(
    `INSERT INTO purchases (id, no, supplier_name, date, subtotal_halalas, tax_halalas, total_halalas, created_at)
     VALUES (?, ?, 'مورد', ?, 10000, 1500, 11500, datetime('now'))`, [id, 'PC-' + id, date]);

const addEntry = (db: DB, id: string, date: string, status = 'مرحّل') =>
  db.run(
    `INSERT INTO journal_entries (id, no, date, status, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
    [id, 'JE-' + id, date, status]);

describe('الفترات من البيانات لا من الكود', () => {
  test('بيانات في ٢٠٢٦ فقط: القائمة ٢٠٢٦ وحدها', () => {
    const db = openDb();
    addPurchase(db, 'a', '2026-05-10');
    addPurchase(db, 'b', '2026-08-01');
    expect(dataYears(db).map((y) => y.year)).toEqual([2026]);
    db.close();
  });

  test('ربعان فيهما بيانات: زرّان لا أربعة · وبجانب كل ربع عدد مستنداته', () => {
    const db = openDb();
    addPurchase(db, 'a', '2025-07-10'); // الربع الثالث
    addPurchase(db, 'b', '2025-08-15'); // الربع الثالث
    addPurchase(db, 'c', '2025-11-01'); // الربع الرابع
    const qs = dataQuarters(db, 2025);
    expect(qs).toEqual([{ q: 3, count: 2 }, { q: 4, count: 1 }]);
    db.close();
  });

  test('أول مستند بتاريخ ٢٠٢٨ يُظهر سنته تلقائياً بلا تعديل كود', () => {
    const db = openDb();
    addPurchase(db, 'a', '2026-03-01');
    expect(dataYears(db).map((y) => y.year)).toEqual([2026]);
    addPurchase(db, 'z', '2028-01-15');
    expect(dataYears(db).map((y) => y.year)).toEqual([2028, 2026]);
    db.close();
  });

  test('حذف كل مستندات ربع يُخفي الربع من القائمة', () => {
    const db = openDb();
    addPurchase(db, 'a', '2026-02-10'); // الأول
    addPurchase(db, 'b', '2026-07-05'); // الثالث
    expect(dataQuarters(db, 2026).map((x) => x.q)).toEqual([1, 3]);
    db.run(`UPDATE purchases SET deleted_at = datetime('now') WHERE id = 'a'`);
    expect(dataQuarters(db, 2026).map((x) => x.q)).toEqual([3]);
    db.close();
  });

  test('المصادر الثلاثة تُحتسب: مشتريات وفواتير وقيود مرحّلة · وغير المرحّل لا يُحتسب', () => {
    const db = openDb();
    addPurchase(db, 'a', '2026-01-10');
    db.run(
      `INSERT INTO invoices (id, no, customer_name, issue, due, status, subtotal_halalas, tax_halalas, total_halalas, created_at)
       VALUES ('i1', 'INV-1', 'عميل', '2025-05-01', '2025-06-01', 'مستحقة', 1000, 0, 1000, datetime('now'))`);
    addEntry(db, 'e1', '2024-12-31');
    addEntry(db, 'e2', '2023-06-01', 'قيد الإنشاء'); // غير مرحّل: لا يُظهر سنته
    expect(dataYears(db).map((y) => y.year)).toEqual([2026, 2025, 2024]);
    db.close();
  });

  test('لا بيانات إطلاقاً: لا سنوات ولا افتراضي · فالشاشة تعرض رسالة لا قائمة فارغة', () => {
    const db = openDb();
    expect(dataYears(db)).toEqual([]);
    expect(defaultPeriod(db, '2026-08-20')).toBeNull();
    db.close();
  });

  test('الافتراضي: السنة والربع الحاليان إن كان فيهما بيانات', () => {
    const db = openDb();
    addPurchase(db, 'a', '2026-07-10'); // الربع الثالث ٢٠٢٦
    addPurchase(db, 'b', '2025-02-01');
    expect(defaultPeriod(db, '2026-08-20')).toEqual({ year: 2026, q: 3 });
    db.close();
  });

  test('الافتراضي حين لا بيانات في الفترة الحالية: أحدث سنة فيها بيانات وآخر ربع فيها', () => {
    const db = openDb();
    addPurchase(db, 'a', '2025-07-10');
    addPurchase(db, 'b', '2025-11-20');
    expect(defaultPeriod(db, '2026-08-20')).toEqual({ year: 2025, q: 4 });
    // والسنة الحالية فيها بيانات لكن الربع الحالي (الثالث) فارغ: آخر ربع فيه بيانات منها
    addPurchase(db, 'c', '2026-01-05');
    expect(defaultPeriod(db, '2026-08-20')).toEqual({ year: 2026, q: 1 });
    db.close();
  });

  test('حدا الربع صحيحان حتى في سنة كبيسة', () => {
    expect(quarterRange(2025, 3)).toEqual({ from: '2025-07-01', to: '2025-09-30' });
    expect(quarterRange(2024, 1)).toEqual({ from: '2024-01-01', to: '2024-03-31' });
    expect(quarterRange(2026, 4)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
  });
});

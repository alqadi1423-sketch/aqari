/**
 * مراجعة التثبيت #60 · قرار المالك 2026-10-07: «الأرصدة الافتتاحية: يُحفظ ويظهر الفرق» · الأرصدة الافتتاحية تُحفظ ولو لم
 * تتوازن، ويظهر فرقها (وأرصدة البنوك الافتتاحية أصولٌ فيه حتى تُسجَّل في الدفتر) · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { openingDifference, saveAccount } from '@/domain/accounting/chart';

test('فرق الأرصدة الافتتاحية: الأصول والمصروفات مقابل الخصوم وحقوق الملكية والإيرادات · ومعها افتتاحيات البنوك', () => {
  const db = memDb();
  db.run(`UPDATE accounts SET opening_halalas = 0`);
  expect(openingDifference(db)).toBe(0);
  saveAccount(db, { code: '1100', name: 'النقدية', type: 'أصل', openingHalalas: 100000 }, '1100');
  saveAccount(db, { code: '3100', name: 'رأس المال', type: 'حقوق ملكية', openingHalalas: 60000 }, '3100');
  expect(openingDifference(db)).toBe(40000);
  db.run(`INSERT INTO banks (id, name, opening_halalas, created_at) VALUES ('B1', 'بنك مصطنع', 20000, '2026-01-01')`);
  expect(openingDifference(db)).toBe(60000);
  saveAccount(db, { code: '3100', name: 'رأس المال', type: 'حقوق ملكية', openingHalalas: 120000 }, '3100');
  expect(openingDifference(db)).toBe(0);
  db.close();
});

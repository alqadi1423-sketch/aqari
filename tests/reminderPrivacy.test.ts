/**
 * التنبيه يظهر على شاشة القفل (القرار ٧) · لا اسم مستأجر في نصّه، والوحدة وعقارها يدلّان · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { computeSchedule } from '@/domain/reminders';

test('تذكيرات الدفعات وانتهاء العقود بلا اسم المستأجر · بالوحدة والعقار', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'برج التجربة' }), { unit_no: '14', rent: 100000 });
  confirmContract(db, contractInput(u, { tenant: 'مستأجر مخترع الاسم', valueHalalas: 1200000, depositHalalas: 0,
    start: '2030-01-01', end: '2030-12-31' }));
  const s = computeSchedule(db, '2029-12-01');
  expect(s.filter((x) => x.kind === 'payment').length).toBeGreaterThan(0);
  expect(s.some((x) => x.kind === 'contract')).toBe(true);
  for (const x of s) {
    expect(x.title + x.body).not.toContain('مستأجر مخترع الاسم');
    if (x.kind !== 'document') expect(x.body).toContain('وحدة 14 · برج التجربة');
  }
  db.close();
});

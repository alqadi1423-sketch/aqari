/**
 * المراجعة الشاملة 2026-11-13 · E-3: الودجت تعرض أرقام آخر فتحٍ للتطبيق بلا تاريخ · اللقطة تحمل الآن جدول الأيام القادمة (`ahead`): لكل يومٍ
 * تتغيّر فيه أرقامها خلال ستين يوماً (قسطٌ يصير متأخراً، أو شهرٌ جديد) أرقامُه منسَّقة، و`validUntil` آخر يومٍ تصحّ له · فلا تحصيل يقع والتطبيق
 * مغلق، وما يصل بالمزامنة يعيد الكتابة · بيانات مصطنعة، والمبالغ بالهللات.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { buildWidgetSnapshot } from '@/services/widgetSnapshot';
import { fmt } from '@/domain/money';

const T = '2026-11-28';

function setup() {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار مصطنع' });
  // ٥٠٠,٠٠٠ هللة شهرياً لكلٍّ: الأولى من أول نوفمبر (قسط نوفمبر متأخر)، والثانية من أول ديسمبر
  confirmContract(db, contractInput(addUnit(db, p, { unit_no: '12' }), { start: '2026-11-01', end: '2027-10-31', valueHalalas: 6_000_000, depositHalalas: 0 }));
  confirmContract(db, contractInput(addUnit(db, p, { unit_no: '14' }), { idNumber: '1000000019', start: '2026-12-01', end: '2027-11-30', valueHalalas: 6_000_000, depositHalalas: 0 }));
  return db;
}

type Ahead = { day: string; lateCount: number; lateSum: string; dueThisMonth: string; paidThisMonth: string; monthPct: number };

test('E-3 لقطة 28 نوفمبر تحمل أول ديسمبر (مستحق الشهر 1,000,000 هللة) وثانيه (ثلاثة أقساط متأخرة بـ1,500,000)', () => {
  const db = setup();
  const s = buildWidgetSnapshot(db, T) as ReturnType<typeof buildWidgetSnapshot> & { ahead?: Ahead[]; validUntil?: string };
  expect(s.lateCount).toBe(1);
  expect(s.validUntil).toBe('2027-01-27');
  const ahead = s.ahead ?? [];
  const dec1 = ahead.find((a) => a.day === '2026-12-01');
  expect(s.dueThisMonth).toBe(fmt(500_000));
  expect(dec1).toMatchObject({ lateCount: 1, lateSum: fmt(500_000), dueThisMonth: fmt(1_000_000), paidThisMonth: fmt(0), monthPct: 0 });
  const dec2 = ahead.find((a) => a.day === '2026-12-02');
  expect(dec2).toMatchObject({ lateCount: 3, lateSum: fmt(1_500_000), dueThisMonth: fmt(1_000_000) });
  // الأيام بلا تغيير لا تُكتب، والجدول مرتّب
  expect(ahead.find((a) => a.day === '2026-12-03')).toBeUndefined();
  expect([...ahead].map((a) => a.day).sort()).toEqual(ahead.map((a) => a.day));
  db.close();
});

test('E-3 القفل مفعّل: الجدول بأعداده وحدها بلا مبالغ', () => {
  const db = setup();
  const s = buildWidgetSnapshot(db, T, undefined, { locked: true }) as unknown as { ahead: Ahead[] };
  const dec2 = s.ahead.find((a) => a.day === '2026-12-02')!;
  expect(dec2.lateCount).toBe(3);
  expect([dec2.lateSum, dec2.dueThisMonth, dec2.paidThisMonth, dec2.monthPct]).toEqual(['', '', '', 0]);
  db.close();
});

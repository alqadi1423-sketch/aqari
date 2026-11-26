/**
 * المراجعة الشاملة 2026-11-13 · D-14 · منخفض · «لا يوجد» وأصفار في مراجعة العقد وتفاصيل الإلغاء.
 * السيناريو: نموذج عقدٍ ناقص (بلا تواريخ ولا قيمة) ← «مراجعة قبل الإنشاء» ← كان يُعرض «البداية: لا يوجد» و«المدة: 0 شهراً»
 * و«قيمة العقد: 0.00» · وعقدٌ ملغى بلا تاريخ إنهاء يُعرض «تاريخ الإنهاء: لا يوجد».
 * الصحيح (قرار المالك 2026-09-09): الغائب يُسقط صفّه بعنوانه، والصفر المكتوب يُعرض.
 */
import fs from 'fs';
import path from 'path';
import { contractReviewFigures } from '../src/ui/contractReview';

test('D-14 النموذج الناقص: لا تاريخ ولا مدة ولا قيمة ولا دفعات', () => {
  const f = contractReviewFigures({ start: '', end: '', value: '', deposit: '' }, 1);
  expect(f).toEqual({ start: '', end: '', months: null, count: null, each: null, value: null, deposit: null });
});

test('D-14 الصفر المكتوب قيمة تُعرض، والمكتمل يُحسب', () => {
  const f = contractReviewFigures({ start: '2026-01-01', end: '2026-12-31', value: '12000', deposit: '0' }, 1);
  expect(f.start).toBe('01/01/2026');
  expect(f.end).toBe('31/12/2026');
  expect(f.months).toBe(12);
  expect(f.count).toBe(12);
  expect(f.value).toBe(1_200_000);
  expect(f.each).toBe(100_000);
  expect(f.deposit).toBe(0);
});

test('D-14 الشاشة تبني صفوف المراجعة من الأرقام الغائبة، وتاريخ الإنهاء الغائب لا يُعرض', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', '(tabs)', 'contracts.tsx'), 'utf8');
  const review = src.slice(src.indexOf('function ReviewSheet('), src.indexOf('return (', src.indexOf('function ReviewSheet(')));
  expect(review).toMatch(/contractReviewFigures\(/);
  expect(review).not.toMatch(/dfmt\(form\.(start|end)\)/);
  expect(review).not.toMatch(/'المدة', months \+/);
  // كل سطرٍ يعرض تاريخ الإنهاء مشروطٌ بوجوده
  const lines = src.split('\n').filter((l) => l.includes('تاريخ الإنهاء: {dfmt(c.cancel_date)}'));
  expect(lines.length).toBeGreaterThan(0);
  lines.forEach((l) => expect(l).toMatch(/c\.cancel_date \?/));
});

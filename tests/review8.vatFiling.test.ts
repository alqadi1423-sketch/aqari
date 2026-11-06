/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ٨: لا يُقدَّم إقرار ربعٍ قبل انتهائه · وإن وقع اليوم في ربعٍ مقدَّم (قُدِّم قبل الإصلاح أو
 * وصل بالمزامنة) فقيد التصحيح بأول يومٍ في الربع المفتوح التالي لا في الفترة المجمَّدة · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { fileVatReturn, correctionDate, isFiledDate, canFileVatReturn } from '@/domain/vatFilings';

const at = (iso: string) => {
  jest.useFakeTimers({ now: new Date(iso), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
};
afterEach(() => jest.useRealTimers());

test('٨ تقديم إقرار الربع قبل انتهائه مرفوض · وبعد آخر يومٍ فيه يُقبل', () => {
  const db = memDb();
  at('2026-03-31T12:00:00');
  expect(canFileVatReturn(2026, 1)).toBe(false);
  expect(() => fileVatReturn(db, 2026, 1)).toThrow();
  expect(isFiledDate(db, '2026-02-01')).toBe(false);
  at('2026-04-01T09:00:00');
  expect(canFileVatReturn(2026, 1)).toBe(true);
  fileVatReturn(db, 2026, 1);
  expect(isFiledDate(db, '2026-02-01')).toBe(true);
  db.close();
});

test('٨ ولا بتاريخ تقديمٍ قبل انتهاء الربع', () => {
  const db = memDb();
  at('2026-05-01T09:00:00');
  expect(() => fileVatReturn(db, 2026, 1, '2026-03-30')).toThrow();
  db.close();
});

test('٨ اليوم في ربعٍ مقدَّم: قيد التصحيح بأول يومٍ في الربع المفتوح التالي', () => {
  const db = memDb();
  at('2026-03-20T12:00:00');
  // إقرار الربعين الأول والثاني مقدَّمان (قبل الإصلاح أو من جهازٍ ساعته متقدمة)
  for (const q of ['2026-Q1', '2026-Q2']) {
    db.run(`INSERT INTO vat_filings (id, period_from, period_to, filed_at, snapshot, created_at) VALUES (?,?,?,?,?,?)`,
      [q, '2026-01-01', '2026-06-30', '2026-03-19', '{}', '2026-03-19T00:00:00.000Z']);
  }
  expect(correctionDate(db, '2026-01-10')).toBe('2026-07-01');
  expect(isFiledDate(db, correctionDate(db, '2026-02-01'))).toBe(false);
  db.close();
});

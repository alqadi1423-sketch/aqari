/**
 * المراجعة الشاملة 2026-11-13 · E-16 · منخفض · صيغ جوال سعودية تُرفض.
 * السيناريو: رقمٌ مكتوبٌ بلوحة فارسية أو أردية «۰۵۰۱۲۳۴۵۶۷» ← تُحذف أرقامه لأنها ليست \d فيصير null ويُرفض العقد
 * «ليس رقم جوال سعودي صحيح» · ومثله «0966501234567».
 * الصحيح: الأرقام تُحوَّل كما في toHalalas (العربية والفارسية)، وتُقبل البادئة 0966.
 */
import { normalizePhone } from '@/domain/phone';
import { toLatinDigits } from '@/domain/money';

test('E-16 الأرقام الفارسية والأردية', () => {
  expect(normalizePhone('۰۵۰۱۲۳۴۵۶۷')).toBe('0501234567');
  expect(normalizePhone('+۹۶۶ ۵۰ ۱۲۳ ۴۵۶۷')).toBe('0501234567');
});

test('E-16 البادئة 0966', () => {
  expect(normalizePhone('0966501234567')).toBe('0501234567');
  expect(normalizePhone('0966 50 123 4567')).toBe('0501234567');
});

test('E-16 الصيغ القائمة كما هي', () => {
  for (const s of ['0501234567', '501234567', '+966501234567', '00966501234567', '٠٥٠١٢٣٤٥٦٧', '050-123-4567']) {
    expect(normalizePhone(s)).toBe('0501234567');
  }
  expect(normalizePhone('0401234567')).toBeNull();
  expect(normalizePhone('')).toBeNull();
});

test('E-16 محوّل الأرقام الواحد', () => {
  expect(toLatinDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789 0123456789');
});

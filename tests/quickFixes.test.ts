/**
 * مراجعة التثبيت #45 و#47 و#62 · بيانات مصطنعة
 */
import { toHalalas } from '@/domain/money';
import { legalUrls, LEGAL_PAGES_PUBLISHED } from '@/domain/legal';
import { buildContractDoc } from '@/domain/printDocs';

test('#٦٢ المبلغ من نص المستخدم: الأرقام العربية الهندية والفاصلة العربية · وتقريب المنزلة الثالثة بلا خطأ عشري', () => {
  expect(toHalalas('١٠٠')).toBe(10000);
  expect(toHalalas('١٠٫٥')).toBe(1050);
  expect(toHalalas('10.075')).toBe(1008);
  expect(toHalalas('1,234.56')).toBe(123456);
  expect(toHalalas('۲۵')).toBe(2500);
  expect(toHalalas('0.005')).toBe(1);
  expect(toHalalas('-3.335')).toBe(-334);
  expect(toHalalas('abc')).toBe(0);
  expect(toHalalas(12.5)).toBe(1250);
});

test('#٤٥ رابطا الشروط والخصوصية لا يظهران قبل نشر الصفحتين', () => {
  expect(LEGAL_PAGES_PUBLISHED).toBe(false);
  expect(legalUrls('demo-project')).toBeNull();
});

test('#٤٧ اسم «طرف آخر» حامل التأمين يُهرَّب في العقد المطبوع', () => {
  const html = buildContractDoc({ name: 'منشأة مصطنعة' } as never, {
    contractNo: 'C-1', tenantName: 'مستأجر مصطنع', idNumber: '1000000000', phone: '0500000000', unitLabel: 'A-1', propertyName: 'عقار مصطنع',
    start: '2026-01-01', end: '2026-12-31', valueHalalas: 100000, depositHalalas: 10000,
    depositHolderLabel: 'طرف آخر · <img src=x onerror=alert(1)>', cycle: 'شهرية', status: 'سارٍ', installments: [],
  }, '2026-01-01');
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('&lt;img');
});

/**
 * E-5 · متوسط · src/domain/pdf/parseEjar.ts:148 (ينتهي الجدول بأول سطرٍ فيه ثلاثة حروف بعد صفوفه)
 *
 * السيناريو (نصٌّ مخترع على هيئة ملف إيجار، لا بيانات حقيقية): عقدٌ شهري من ١٢ دفعة، جدول دفعاته يمتد على صفحتين.
 *   بين آخر صفّ في الصفحة الأولى وأول صفّ في الثانية: تذييل الصفحة «Page 1 of 2»، وترويسة الصفحة التالية، وصفّ عناوين الجدول مكرراً.
 *   الواقع: يُقرأ ٨ صفوف فقط (صفوف الصفحة الأولى)، والجدول المبتور يجتاز فحص التصاعد والمدة فيُعرض «جدول الدفعات 8 قسطاً من الملف».
 *   ثم يرفض التوثيق: «مجموع جدول إيجار 8,000.00 يخالف إجمالي العقد 12,000.00 · صحّح قيمة الإيجار…» ولا سبيل في النموذج لإسقاط الجدول المقروء،
 *   فإما أن يبقى العقد مسودة، أو يُنقص المستخدم قيمة الإيجار لتطابق الجدول المبتور (رقمٌ خاطئ).
 *
 * لماذا يهم: العقود الشهرية لسنتين أو ثلاث (٢٤ إلى ٣٦ دفعة) لا يتسع جدولها لصفحةٍ واحدة، وقراءة ملف إيجار هي الطريق الأساس لإنشاء العقد.
 *   (يحتاج تأكيداً على ملفٍ حقيقيٍّ طويل: هل يرسم إيجار ترويسةً أو تذييلاً نصياً بين صفحات الجدول؟)
 *
 * السلوك الصحيح: أسطر إطار الصفحة (رقم الصفحة، الترويسة المتكررة، صفّ العناوين المكرر) لا تُنهي الجدول؛ يُكمَل بعدها ما دامت الصفوف
 *   متصاعدة وضمن مدة العقد، وينتهي عند عنوان القسم التالي أو آخر النص · فتُقرأ الصفوف الاثنا عشر كلها.
 *
 *   TZ=Asia/Riyadh npx jest tests/review9.E.ejarPages
 */
import { parseEjarSchedule } from '@/domain/pdf/parseEjar';

const HEAD = [
  'Ejar Contract',
  'Contract No. 20260099999 / 1-2026',
  'Tenancy Start Date 2026-01-01',
  'Tenancy End Date 2026-12-31',
  'Rent Payments Schedule جدول سداد الدفعات',
  'No. Due Date (Hijri) Due Date (Gregorian) Payment Deadline (Gregorian) Amount',
].join('\n');

const row = (i: number) => {
  const m = String(i).padStart(2, '0');
  return `${i} 1447-0${(i % 9) + 1}-12 2026-${m}-01 2026-${m}-10 1,000.00`;
};

describe('E-5 · [متوسط] جدول دفعات إيجار يمتد على صفحتين يُقرأ نصفه', () => {
  test('ضابط: الجدول نفسه في صفحةٍ واحدة يُقرأ ١٢ صفاً', () => {
    const one = HEAD + '\n' + Array.from({ length: 12 }, (_, k) => row(k + 1)).join('\n') + '\nObligations of the Parties\n';
    expect(parseEjarSchedule(one)?.length).toBe(12);
  });

  test.failing('بين الصفحتين تذييلٌ وترويسة وصفّ عناوين مكرر: تُقرأ الصفوف الاثنا عشر كلها', () => {
    const two = HEAD + '\n'
      + Array.from({ length: 8 }, (_, k) => row(k + 1)).join('\n')
      + '\nPage 1 of 2\nUnified Lease Contract 20260099999/1-2026\n'
      + 'No. Due Date (Hijri) Due Date (Gregorian) Payment Deadline (Gregorian) Amount\n'
      + Array.from({ length: 4 }, (_, k) => row(k + 9)).join('\n')
      + '\nPage 2 of 2\nObligations of the Parties\n';
    const s = parseEjarSchedule(two);
    // (الواقع: 8)
    expect(s?.length).toBe(12);
    expect(s?.reduce((x, r) => x + r.amountHalalas, 0)).toBe(1_200_000);
  });
});

/**
 * المراجعة الشاملة 2026-11-13 · E-19 · منخفض · ملفات أوفيس: محارف التحكم، وصف الإجمالي بلا قيمة محسوبة.
 * السيناريو أ: ملاحظةٌ منسوخة من وورد فيها فاصل سطرٍ U+000B ← إكسل يقول إن الملف تالف ويصلحه بحذف محتوى، ووورد يرفض فتحه.
 * السيناريو ب: خلايا =SUM بلا قيمة محسوبة <v> ← العارضات التي لا تحسب (معاينات الجوال) تعرض الإجمالي فارغاً.
 * الصحيح: نزع المحارف غير المسموحة في XML 1.0 (U+0000 إلى U+0008 وU+000B وU+000C وU+000E إلى U+001F)، والمجموع المحسوب
 * <v> مع الصيغة الحيّة. بيانات مصطنعة.
 */
import { unzipSync, strFromU8 } from 'fflate';
import { buildXlsx, buildDocx, type ReportBlock } from '@/domain/officeBuild';

const BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

const block = (note: string): ReportBlock => ({
  heading: 'وحدة مصطنعة', meta: [['ملاحظة', note]],
  sections: [{
    title: 'الحركات', header: ['البيان', 'المبلغ', 'العدد'],
    rows: [[note, { money: 12_345 }, 2], ['سطر ثانٍ', { money: 55 }, 3]],
  }],
  totals: [],
});

const files = (u8: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(u8)).map(([k, v]) => [k, strFromU8(v)]));

test('E-19 لا محرف تحكمٍ غير مسموح في XML إكسل ووورد', () => {
  const note = 'سطر\u000Bثانٍ\u0001\u0008\u000C\u001Fآخر\tو\nسطر';
  const x = files(buildXlsx([{ name: 'ورقة', blocks: [block(note)] }]));
  for (const [k, v] of Object.entries(x)) expect([k, BAD.test(v)]).toEqual([k, false]);
  const d = files(buildDocx('تقرير مصطنع', 'الفترة', [block(note)], 'تذييل'));
  for (const [k, v] of Object.entries(d)) expect([k, BAD.test(v)]).toEqual([k, false]);
  // النص نفسه يبقى بلا المحارف المنزوعة
  expect(Object.values(x).join('')).toContain('سطرثانٍآخر');
});

test('E-19 صف الإجمالي: الصيغة الحيّة ومعها قيمتها المحسوبة', () => {
  const sheet = Object.entries(files(buildXlsx([{ name: 'ورقة', blocks: [block('عادي')] }])))
    .find(([k]) => /worksheets\/sheet1\.xml$/.test(k))![1];
  const sums = [...sheet.matchAll(/<f>SUM\([^)]*\)<\/f>(<v>[^<]*<\/v>)?/g)];
  expect(sums.length).toBe(2);
  expect(sums[0][1]).toBe('<v>124.00</v>');
  expect(sums[1][1]).toBe('<v>5</v>');
});

/**
 * المدقق J2 · الجولة الثامنة عشرة · على ae6765f · إصلاح H2-7 يقدّم صيغة التاريخ المصحَّحة (أو المحفوظة مع الربط) «إن قُرئت بها التواريخ كلها»،
 * و«التواريخ كلها» كل خليةٍ فيها رقمٌ في عمود التاريخ بعد صفّ العناوين، ومنها التذييل؛ فتذييلٌ واحد كـ«Printed on: 07/12/2026» يُبطل التصحيح ·
 * بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditJ2.dateOrderFooter.test.ts
 *
 * J2-3 · متوسط · src/domain/bankStatement/read.ts:180 (dateCells: كل خلية عمود التاريخ فيها رقم «/\d/»، صفّ حركةٍ كانت أو تذييلاً أو ملخصاً)
 * وread.ts:195 («score(opts.mapping.dateOrder) === dateCells.length» شرط تقديم صيغة الربط، وإلا التخمين بالعدد ثم التتابع ثم الأقصر مدىً): كشف
 * H2-7 نفسه (CSV حسابٍ للإيجار بالصيغة السعودية DD/MM/YYYY بلا صفّ فترة، وإيداعات 1 أكتوبر و1 نوفمبر و1 ديسمبر) وفي آخره سطر التذييل
 * «Printed on: 07/12/2026» في العمود الأول كما تطبعه برامج التصدير · التخمين «mdy» (10 و11 و12 يناير) فيختار المستخدم «يوم/شهر» في «أعمدة
 * الكشف»، فتُعاد القراءة بـ«dmy»: خلية التذييل لا تُقرأ تاريخاً بأي صيغة، فلا تساوي قراءةُ «dmy» عدد الخلايا (3 من 4) ويغلب التخمين ثانيةً:
 * يناير و«mdy» · وكذلك «Total: 3 transactions» وما شابهه · (وبلا التذييل يعمل التصحيح: الضابط، وهو اختبار H2-7.)
 * لماذا يهم: قرار المالك أ.٣ («تُعرض الأعمدة بأدوارها المخمَّنة وصيغة التاريخ … فيؤكدها المستخدم أو يصححها»)، وH2-7 جعل التصحيح يعمل؛ وسطر
 * التذييل أو المجموع في عمود التاريخ شائعٌ في ملفات التصدير · فيُحفظ الكشف بتواريخ يناير والربط «mdy» رغم تصحيح المستخدم: لا يدخل تقارير
 * أكتوبر إلى ديسمبر، وتُقترح لإيداعاته أقساط يناير، وكل كشفٍ بعده بالربط المحفوظ كذلك.
 * السلوك الصحيح: صيغة الربط المصحَّحة أو المحفوظة تُقدَّم ما دامت تقرأ كل ما تقرؤه الأخرى (الخلية التي لا تُقرأ تاريخاً بأي صيغة ليست تاريخاً
 * سقطت به): 2026-10-01 و2026-11-01 و2026-12-01 والربط «dmy».
 */
import { readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';

const GRID = [
  ['Opening Balance', '0.00'],
  ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
  ['01/10/2026', 'RENT TRANSFER (synthetic)', '', '2,500.00', '2,500.00'],
  ['01/11/2026', 'RENT TRANSFER (synthetic)', '', '2,500.00', '5,000.00'],
  ['01/12/2026', 'RENT TRANSFER (synthetic)', '', '2,500.00', '7,500.00'],
  ['Closing Balance', '7,500.00'],
];
const view = (r: StatementResult) => (r.ok ? { dates: r.lines.map((l) => l.date), order: r.mapping.dateOrder } : r.error + ':' + r.detail);
/** كما يبنيه confirmMapping في app/bankStatement.tsx: الربط المخمَّن بصيغة «dmy» التي اختارها المستخدم */
const corrected = (grid: string[][]) => {
  const guess = readStatementGrid(grid);
  if (!guess.ok) throw new Error('لم يُقرأ: ' + guess.error); // i18n-exempt: رسالة اختبار
  return readStatementGrid(grid, { mapping: { ...guess.mapping, dateOrder: 'dmy' } });
};
const want = { dates: ['2026-10-01', '2026-11-01', '2026-12-01'], order: 'dmy' };

describe('J2-3 · [متوسط] سطر تذييلٍ في عمود التاريخ يُبطل صيغة التاريخ المصحَّحة فيعود التخمين «mdy» (read.ts:180 و195)', () => {
  test('الضابط: بلا تذييل يعمل التصحيح (H2-7)', () => {
    expect(view(corrected(GRID))).toEqual(want);
  });

  test('بتذييل «Printed on: 07/12/2026»: التصحيح «dmy» يُقرأ به', () => {
    // (الواقع: { dates: ['2026-01-10', '2026-01-11', '2026-01-12'], order: 'mdy' })
    expect(view(corrected([...GRID, ['Printed on: 07/12/2026']]))).toEqual(want);
  });

  test('وبسطر مجموعٍ «Total: 3 transactions» كذلك', () => {
    // (الواقع: { dates: ['2026-01-10', '2026-01-11', '2026-01-12'], order: 'mdy' })
    expect(view(corrected([...GRID, ['Total: 3 transactions', '', '', '7,500.00', '']]))).toEqual(want);
  });
});

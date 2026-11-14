/**
 * المدقق D2 · الجولة الخامسة عشرة · على f5036b1 · تذييل صفحة PDF «ختم الطباعة … رقم الصفحة» يُقرأ صفَّ حركةٍ إن وقع رقم الصفحة تحت عمود
 * مبلغ، فيُرفض الكشف كله «صيغة» · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditD2.pdfFooter.test.ts
 *
 * D2-4 · متوسط · src/domain/bankStatement/read.ts:218 (moved: خلية مبلغٍ غير فارغة لا تُقرأ صفراً تعدّ «مبلغ حركة»، وparseStatementAmount('Page 1 of 2')
 * = null فـnull !== 0) ثم read.ts:239-240 (خلية مبلغٍ لا تُقرأ ترفض الكشف) مع src/domain/bankStatement/pdfTable.ts:134-139 (قطع ما تحت
 * العناوين تُوزَّع على أقرب عمود): كشف PDF إنجليزي من صفحتين، في تذييل كل صفحةٍ ختم الطباعة يساراً «07/11/2026 10:30» ورقم الصفحة في الوسط
 * «Page 1 of 2» فيقع تحت عمود «Debit» · الصف مؤرَّخٌ بختم الطباعة وفي خانة المدين نصٌّ لا يُقرأ مبلغاً، فـ«format: amount» ولا يُقرأ شيء ·
 * إصلاح V13 جعل الصف المؤرَّخ «بلا أي مبلغ» ليس حركة، واختباره يضع رقم الصفحة تحت عمود الرصيد (الذي لا يدخل في moved) فلم يُكشف هذا.
 * لماذا يهم: التذييل بختم الطباعة ورقم الصفحة في الوسط شكلٌ شائع، ويتكرر في كل صفحة؛ كشفٌ صحيح متسلسلٌ بافتتاحيه وختاميه لا يُقرأ، ولا
 * تُعرض للمستخدم «أعمدة الكشف» ليصحّح شيئاً.
 * السلوك الصحيح: صفٌّ ليس في خانات مبلغه مبلغٌ مقروء ولا رصيد ليس حركة (كما قرّر V13): ثلاث حركاتٍ (+1,000 و+500 و−200) وافتتاحي صفر
 * وختامي 1,300 · ويبقى رفض U5 لخلية مبلغٍ تالفةٍ في صفّ حركةٍ حقيقي.
 */
import { readStatementGrid } from '@/domain/bankStatement/read';
import { gridFromPdfItems } from '@/domain/bankStatement/pdfTable';

const at = (str: string, x: number, y: number) => ({ str, x, y, size: 9 });
const head = [at('Date', 40, 700), at('Description', 120, 700), at('Debit', 300, 700), at('Credit', 380, 700), at('Balance', 460, 700)];
const page1 = [
  at('Statement Period: 01/10/2026 - 31/10/2026', 40, 760),
  at('Opening Balance', 40, 740), at('0.00', 200, 740),
  ...head,
  at('01/10/2026', 40, 680), at('SALARY (synthetic)', 120, 680), at('1,000.00', 380, 680), at('1,000.00', 460, 680),
  at('02/10/2026', 40, 665), at('TRANSFER IN (synthetic)', 120, 665), at('500.00', 380, 665), at('1,500.00', 460, 665),
  at('07/11/2026 10:30', 40, 40), at('Page 1 of 2', 280, 40),
];
const page2 = [
  ...head,
  at('05/10/2026', 40, 680), at('POS PURCHASE (synthetic)', 120, 680), at('200.00', 300, 680), at('1,300.00', 460, 680),
  at('Closing Balance', 40, 600), at('1,300.00', 460, 600),
  at('07/11/2026 10:30', 40, 40), at('Page 2 of 2', 280, 40),
];

describe('D2-4 · [متوسط] رقم الصفحة في وسط التذييل يقع تحت عمود المدين فيُرفض كشف PDF صحيح «format» (read.ts:218 و239-240)', () => {
  test('الجدول كما يبنيه pdfTable: صفّ التذييل مؤرَّخٌ وفي خانة «Debit» نصّ رقم الصفحة', () => {
    const grid = gridFromPdfItems([page1, page2]);
    expect(grid.filter((r) => r[0].startsWith('07/11/2026'))).toEqual([
      ['07/11/2026 10:30', '', 'Page 1 of 2', '', ''], ['07/11/2026 10:30', '', 'Page 2 of 2', '', '']]);
  });

  test('الضابط: الصفحتان بلا التذييل تُقرآن صحيحتين', () => {
    const noFooter = (p: typeof page1) => p.filter((i) => i.y > 40);
    const r = readStatementGrid(gridFromPdfItems([noFooter(page1), noFooter(page2)]));
    expect(r.ok && [r.lines.map((l) => l.amount), r.opening, r.closing]).toEqual([[100000, 50000, -20000], 0, 130000]);
  });

  test('الكشف من صفحتين بتذييله يُقرأ: ثلاث حركاتٍ في أكتوبر، والافتتاحي صفر والختامي 1,300', () => {
    const r = readStatementGrid(gridFromPdfItems([page1, page2]));
    // (الواقع: { ok: false, error: 'format', detail: 'amount' })
    expect(r.ok ? { lines: r.lines.map((l) => [l.date, l.amount]), opening: r.opening, closing: r.closing } : { error: r.error, detail: r.detail }).toEqual({
      lines: [['2026-10-01', 100000], ['2026-10-02', 50000], ['2026-10-05', -20000]], opening: 0, closing: 130000,
    });
  });
});

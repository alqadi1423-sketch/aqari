/**
 * المدقق J2 · الجولة الثامنة عشرة · على ae6765f · إصلاح H2-9 يُلحق السطر المكمِّل الذي فيه كلمة ملخص «إن لم تُقرأ بعدها قيمة»، والقيمة عنده أي
 * رقمٍ في الخلية (amountAfter ← AMOUNT_IN_TEXT) ولو كان رقم مرجعٍ أو بطاقةٍ ملتصقاً بحروفه؛ فيصير ختامياً أو افتتاحياً للكشف ويُرفض كشفٌ صحيح ·
 * بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditJ2.continuationRef.test.ts
 *
 * J2-5 · متوسط · src/domain/bankStatement/read.ts:271-279 (summaryRow: كلمة ملخصٍ و«amountAfter(r, i) != null» فلا يُلحق، ثم noteSummary) مع
 * read.ts:90 وread.ts:451 (AMOUNT_IN_TEXT «[-(]?\d[\d,.٫٬ﺭ]*» يلتقط «2026001» من «TD2026001» و«4417» من «card 4417»، وparseStatementAmount يقرأ
 * العدد الصحيح بلا كسرين مبلغاً) وread.ts:227 (summary[k] = v: الأخير يغلب) وread.ts:324 (الافتتاحي في آخر الكشف):
 *  أ) كشفٌ ملخصه في رأسه (افتتاحي 5,000 وختامي 56,300) وحركة «DEPOSIT MATURITY CREDIT» بيانها المكمِّل «TERM DEPOSIT CLOSING TD2026001»: يصير
 *     الختامي 2,026,001.00 فيُرفض الكشف «balance: closing».
 *  ب) كشفٌ بلا افتتاحيٍّ مطبوع (يُشتق من أول رصيد) آخر حركاته «ATM CASH» وبيانها المكمِّل «Opening of new card 4417 fee» (مثال H2-9 برقم
 *     البطاقة): يصير افتتاحيه 4,417.00 فيُرفض «balance: opening» ويُعرض حفظه «غير متحقَّق» بافتتاحي 4,417 وختامي 5,317 (والصحيح 5,000 و5,900).
 *  (والسطر نفسه بلا الرقم يُلحق ويُقرأ الكشف: الضابط، وهو H2-9 · وكان الخلل نفسه على 3f2c136.)
 * لماذا يهم: رقم الوديعة أو البطاقة أو المرجع في سطر البيان الثاني هو الغالب، وكلمات «Closing» و«Opening» فيه طبيعية (إقفال وديعة، إصدار
 * بطاقة) · فكشفٌ صحيح متسلسل يُرفض، والحفظ «غير متحقَّق» المعروض (ب) يُدخل تقرير الشهر افتتاحياً وختامياً لا وجود لهما وفجوة، ويُسقط من البيان
 * ما يعرّف الحركة.
 * السلوك الصحيح (H2-9: «ملخصاً تُقرأ قيمته: كلمة افتتاحيٍّ أو ختاميٍّ أو مجموعٍ بعدها مبلغ»): رقم المرجع أو البطاقة (عددٌ بلا كسرين، أو أرقامٌ
 * ملتصقةٌ بحروف) ليس مبلغ ملخص؛ فالسطر بيانٌ مكمِّل يُلحق بحركته: (أ) ختامي 56,300 كما في الرأس، و(ب) افتتاحي 5,000 مشتقّ وختامي 5,900.
 */
import { readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';

const H = ['Date', 'Description', 'Debit', 'Credit', 'Balance'];
const view = (r: StatementResult) => (r.ok ? { descr: r.lines.map((l) => l.descr), opening: r.opening, closing: r.closing } : r.error + ':' + r.detail);

const maturity = (more: string) => readStatementGrid([
  ['Opening Balance', '5,000.00'], ['Closing Balance', '56,300.00'],
  H,
  ['01/10/2026', 'SALARY (synthetic)', '', '1,000.00', '6,000.00'],
  ['15/10/2026', 'DEPOSIT MATURITY CREDIT', '', '50,000.00', '56,000.00'],
  ['', 'TERM DEPOSIT CLOSING' + more, '', '', ''],
  ['20/10/2026', 'TRANSFER IN (synthetic)', '', '300.00', '56,300.00'],
]);
const card = (more: string) => readStatementGrid([
  H,
  ['01/10/2026', 'SALARY (synthetic)', '', '1,000.00', '6,000.00'],
  ['02/10/2026', 'ATM CASH', '100.00', '', '5,900.00'],
  ['', 'Opening of new card' + more + ' fee', '', '', ''],
]);

describe('J2-5 · [متوسط] رقم مرجعٍ أو بطاقة في سطر البيان المكمِّل مع «Closing/Opening» يصير ختامي الكشف أو افتتاحيه فيُرفض (read.ts:271-279 و451)', () => {
  test('الضابط: السطر نفسه بلا رقم يُلحق ويُقرأ الكشفان (H2-9)', () => {
    expect([view(maturity('')), view(card(''))]).toEqual([
      { descr: ['SALARY (synthetic)', 'DEPOSIT MATURITY CREDIT TERM DEPOSIT CLOSING', 'TRANSFER IN (synthetic)'], opening: 500000, closing: 5630000 },
      { descr: ['SALARY (synthetic)', 'ATM CASH Opening of new card fee'], opening: 500000, closing: 590000 },
    ]);
  });

  test('أ) «TERM DEPOSIT CLOSING TD2026001»: يُلحق، والختامي 56,300 كما في الرأس', () => {
    // (الواقع: 'balance:closing' والختامي المقروء 2,026,001.00)
    expect(view(maturity(' TD2026001'))).toEqual(
      { descr: ['SALARY (synthetic)', 'DEPOSIT MATURITY CREDIT TERM DEPOSIT CLOSING TD2026001', 'TRANSFER IN (synthetic)'], opening: 500000, closing: 5630000 });
  });

  test('ب) «Opening of new card 4417 fee» تحت آخر حركة: يُلحق، والافتتاحي 5,000 لا 4,417', () => {
    // (الواقع: 'balance:opening' بجزءٍ يُعرض حفظه «غير متحقَّق» بافتتاحي 441700 وختامي 531700)
    expect(view(card(' 4417'))).toEqual({ descr: ['SALARY (synthetic)', 'ATM CASH Opening of new card 4417 fee'], opening: 500000, closing: 590000 });
  });
});

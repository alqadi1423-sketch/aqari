/**
 * المدقق H2 · الجولة السابعة عشرة · على 3f2c136 · إصلاح F2-6 («التاريخ ليس مبلغ ملخص») يمحو من خلية كلمة الملخص التاريخ الرقمي وحده
 * («15/03/2015» و«15-03-2015»)؛ والتاريخ باسم الشهر («15-Mar-2015» و«15 Mar 2015» و«Mar 15, 2015»)، وهو شكلٌ يقرؤه القارئ نفسه في السطور
 * (normalize.ts:91-96)، تبقى أرقامه فيُؤخذ آخرها مبلغاً · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditH2.summaryMonthDate.test.ts
 *
 * H2-5 · متوسط · src/domain/bankStatement/read.ts:434-435 (amountAfter: «r[i].replace(FULL_DATE, ' ')» وFULL_DATE رقميٌّ وحده (read.ts:83)، ثم
 * آخر ما يطابق AMOUNT_IN_TEXT (read.ts:90) في الخلية: «-2015» من «15-Mar-2015» و«2015» من «15 Mar 2015») مع read.ts:222 (كل افتتاحيٍّ بموضعه)
 * وread.ts:312 (أول افتتاحيٍّ قبل الحركات) وread.ts:224 (الختامي آخر ما يُطبع) ثم read.ts:355 و363 (الرفض «balance»):
 *  أ) رأسٌ فيه «Account Opening Date: 15-Mar-2015» ثم «Opening Balance | 5,000.00»: الافتتاحي −2,015.00 (و2,015.00 بـ«15 Mar 2015» و«Mar 15,
 *     2015») فـ«balance: opening»، ويُعرض حفظه «غير متحقَّق» بافتتاحي −2,015.00.
 *  ب) «Opening Balance 5,000.00 as of 01-Oct-2026» في خليةٍ واحدة (قطعة PDF واحدة): الافتتاحي −2,026.00.
 *  ج) «Statement Closing Date: 31-Oct-2026» بعد ملخص الرأس: الختامي −2,026.00 فـ«balance: closing».
 * لماذا يهم: الكشوف الإنجليزية تطبع التاريخ باسم الشهر كثيراً («01-OCT-2026»)، وF2-6 أثبت الضرر نفسه بالتاريخ الرقمي: كشفٌ صحيح متسلسل يُرفض،
 * ويُعرض حفظه بافتتاحيٍّ وختاميٍّ لا وجود لهما فيدخلان تقرير الشهر.
 * السلوك الصحيح (F2-6): التاريخ بأي شكلٍ يقرؤه القارئ ليس مبلغ ملخص: يُقرأ الكشف بافتتاحي 5,000.00 وختامي 5,490.00 مفحوصاً بلا تنبيه.
 */
import { readStatementGrid, unverifiedResult, type StatementResult } from '@/domain/bankStatement/read';

const BODY = [
  ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
  ['01/10/2026', 'TRANSFER IN (synthetic)', '', '500.00', '5,500.00'],
  ['03/10/2026', 'SERVICE FEE (synthetic)', '10.00', '', '5,490.00'],
];
const openedOn = (d: string) => [['Account Number: 1234567890 (synthetic)', `Account Opening Date: ${d}`], ['Opening Balance', '5,000.00'], ...BODY, ['Closing Balance', '5,490.00']];
const view = (r: StatementResult) => (r.ok ? { amounts: r.lines.map((l) => l.amount), opening: r.opening, closing: r.closing, closingChecked: r.checks.closing, warnings: r.warnings }
  : r.error + ':' + r.detail);
const want = { amounts: [50000, -1000], opening: 500000, closing: 549000, closingChecked: true, warnings: [] };

describe('H2-5 · [متوسط] التاريخ باسم الشهر في خلية كلمة الملخص يُقرأ مبلغها: «Account Opening Date: 15-Mar-2015» افتتاحيٌّ −2,015.00 (read.ts:434)', () => {
  test('الضابط (F2-6): «Account Opening Date: 15/03/2015» الرقمي يُقرأ الكشف معه', () => {
    expect(view(readStatementGrid(openedOn('15/03/2015')))).toEqual(want);
  });

  test('(أ) «15-Mar-2015» و«15 Mar 2015» و«Mar 15, 2015» في خلية «Account Opening Date»: الافتتاحي 5,000.00، ولا يُعرض حفظٌ بافتتاحيٍّ مصنوع', () => {
    const forms = ['15-Mar-2015', '15 Mar 2015', 'Mar 15, 2015'];
    const reads = forms.map((d) => readStatementGrid(openedOn(d)));
    const offers = reads.map((r) => (!r.ok && r.error === 'balance' ? unverifiedResult(r.partial)?.opening ?? null : null));
    // (الواقع: ثلاثتها 'balance:opening'، ويُعرض حفظها «غير متحقَّق» بافتتاحي −201500 و201500 و201500)
    expect({ reads: reads.map(view), offers }).toEqual({ reads: [want, want, want], offers: [null, null, null] });
  });

  test('(ب) «Opening Balance 5,000.00 as of 01-Oct-2026» في خليةٍ واحدة', () => {
    // (الواقع: 'balance:opening' بافتتاحي −202600)
    expect(view(readStatementGrid([['Opening Balance 5,000.00 as of 01-Oct-2026'], ...BODY, ['Closing Balance', '5,490.00']]))).toEqual(want);
  });

  test('(ج) «Statement Closing Date: 31-Oct-2026» بعد ملخص الرأس لا يغلب الختامي المطبوع', () => {
    // (الواقع: 'balance:closing')
    expect(view(readStatementGrid([['Opening Balance', '5,000.00', 'Closing Balance', '5,490.00'], ['Statement Closing Date: 31-Oct-2026'], ...BODY]))).toEqual(want);
  });
});

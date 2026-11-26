/**
 * المدقق F2 · الجولة السادسة عشرة · على 50556c3 · كلمة ملخصٍ في خليةٍ معها تاريخ («Account Opening Date: 15/03/2015» و«Statement Closing Date:
 * 31/10/2026» و«الرصيد الافتتاحي 5,000.00 بتاريخ 01/10/2026») تأخذ أرقام التاريخ مبلغاً: الافتتاحي 2,015.00 أو الختامي 2,026.00 · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditF2.summaryDate.test.ts
 *
 * F2-6 · متوسط · src/domain/bankStatement/read.ts:412-413 (amountAfter: «المبلغ في الخلية نفسها» آخر ما يطابق AMOUNT_IN_TEXT (read.ts:87) فيها،
 * والتاريخ «15/03/2015» يطابقه «15» و«03» و«2015» فيؤخذ 2015 · ولا يُستثنى التاريخ كما يُستثنى في رقم الحساب «noDates» · X4) مع قاموس
 * الملخص (dictionary.json: «opening» و«closing» كلمتان وحدهما) وread.ts:216 («الافتتاحي أول ما يُطبع»، فيغلب تاريخُ فتح الحساب الافتتاحيَّ
 * المطبوع بعده) وread.ts:218 («الختامي آخره») ثم read.ts:312 و344 (يُرفض «balance» ويُعرض حفظه «غير متحقَّق» بالافتتاحي الخاطئ):
 *  أ) رأسٌ فيه «Account Opening Date: 15/03/2015» ثم «Opening Balance | 5,000.00»: الافتتاحي 2,015.00 فـ«balance: opening»، ويُعرض حفظه «غير
 *     متحقَّق» بافتتاحي 2,015.00 وختامي 2,505.00 (والمطبوع 5,490.00) · وبـ«15-03-2015» يصير −2,015.00.
 *  ب) «الرصيد الافتتاحي 5,000.00 بتاريخ 01/10/2026» في خليةٍ واحدة (سطر PDF واحد): الافتتاحي 2,026.00.
 *  ج) «Statement Closing Date: 31/10/2026» بعد ملخص الرأس: الختامي 2,026.00 فـ«balance: closing».
 * لماذا يهم: تاريخ فتح الحساب وتاريخ الختامي وتاريخ الرصيد شائعةٌ في رأس الكشف (X4 ذكر «Account Opening Date»)، وقطعة PDF الواحدة تحمل الكلمة
 * وقيمتها؛ فكشفٌ صحيح متسلسل يُرفض، ويُعرض على المستخدم حفظه بافتتاحيٍّ وختاميٍّ لا وجود لهما فيدخلان تقرير الشهر.
 * السلوك الصحيح: التاريخ ليس مبلغ ملخص: «تاريخ فتح الحساب» لا يصنع افتتاحياً، و«بتاريخ …» بعد القيمة لا يغلبها، فيُقرأ الكشف بافتتاحي
 * 5,000.00 وختامي 5,490.00 مفحوصاً (checks.closing = true) بلا تنبيه.
 */
import { readStatementGrid, unverifiedResult, type StatementResult } from '@/domain/bankStatement/read';

const BODY = [
  ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
  ['01/10/2026', 'TRANSFER IN (synthetic)', '', '500.00', '5,500.00'],
  ['03/10/2026', 'SERVICE FEE (synthetic)', '10.00', '', '5,490.00'],
];
const AR_BODY = [
  ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
  ['01/10/2026', 'حوالة واردة مصطنعة', '', '500.00', '5,500.00'],
  ['03/10/2026', 'رسوم مصطنعة', '10.00', '', '5,490.00'],
];
const openedOn = (d: string) => [['Account Number: 1234567890 (synthetic)', `Account Opening Date: ${d}`], ['Opening Balance', '5,000.00'], ...BODY, ['Closing Balance', '5,490.00']];
const view = (r: StatementResult) => (r.ok ? { amounts: r.lines.map((l) => l.amount), opening: r.opening, closing: r.closing, closingChecked: r.checks.closing, warnings: r.warnings }
  : r.error + ':' + r.detail);
const want = { amounts: [50000, -1000], opening: 500000, closing: 549000, closingChecked: true, warnings: [] };

describe('F2-6 · [متوسط] تاريخٌ في خلية كلمة الملخص يُقرأ مبلغها: «Account Opening Date: 15/03/2015» افتتاحيٌّ 2,015.00 (read.ts:412-413 و216)', () => {
  test('الضابط: «Account Opening Date» وتاريخه في خليتين، والملخص بلا تاريخ، يُقرأ الكشف', () => {
    expect(view(readStatementGrid([['Account Opening Date', '15/03/2015'], ['Opening Balance', '5,000.00'], ...BODY, ['Closing Balance', '5,490.00']]))).toEqual(want);
  });

  test('(أ) «Account Opening Date: 15/03/2015» في خليته: الافتتاحي 5,000.00 المطبوع، ولا يُعرض حفظٌ بافتتاحيٍّ مصنوع', () => {
    const r = readStatementGrid(openedOn('15/03/2015'));
    const offer = !r.ok && r.error === 'balance' ? unverifiedResult(r.partial) : null;
    // (الواقع: 'balance:opening'، ويُعرض حفظه «غير متحقَّق» بافتتاحي 201500 وختامي 250500)
    expect({ read: view(r), offer: offer && [offer.opening, offer.closing] }).toEqual({ read: want, offer: null });
    // (الواقع: 'balance:opening' بافتتاحي −201500)
    expect(view(readStatementGrid(openedOn('15-03-2015')))).toEqual(want);
  });

  test('(ب) «الرصيد الافتتاحي 5,000.00 بتاريخ 01/10/2026» في خليةٍ واحدة', () => {
    // (الواقع: 'balance:opening' بافتتاحي 202600)
    expect(view(readStatementGrid([['الرصيد الافتتاحي 5,000.00 بتاريخ 01/10/2026'], ...AR_BODY, ['الرصيد الختامي', '5,490.00']]))).toEqual(want);
  });

  test('(ج) «Statement Closing Date: 31/10/2026» بعد ملخص الرأس لا يغلب الختامي المطبوع', () => {
    // (الواقع: 'balance:closing')
    expect(view(readStatementGrid([['Opening Balance', '5,000.00', 'Closing Balance', '5,490.00'], ['Statement Closing Date: 31/10/2026'], ...BODY]))).toEqual(want);
  });
});

/**
 * المدقق P2 · الجولة الحادية والعشرون · على ec1b970 · الملخص بصفّين (كلماته في صفٍّ وقيمها تحتها) يُقرأ في رأس الكشف وحده (U3)؛ فإن جاء بعد
 * الحركات، وهو شكل الجزيرة كما في الدراسة («ملخص الأرصدة جدول في الصفحة الأخيرة: Previous Balance / Total Withdrawal (Dr) / Total Deposit (Cr)
 * / New Balance»)، سقط كله بصمت: لا افتتاحي ولا ختامي ولا مجاميع · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditP2.summaryTable.test.ts
 *
 * P2-1 · متوسط · src/domain/bankStatement/read.ts:236-249 (الملخص بصفّين يُفحص في grid.slice(0, h) وحده) مع read.ts:273-286 (في الجسم: صفّ
 * الكلمات بلا قيمٍ بعدها فلا يُسجَّل شيء، وصفّ القيم بلا كلمات فلا يُسجَّل شيء): كشف الجزيرة الأقدم أولاً (افتتاحي 5,000، راتب 1,000، حوالة
 * 500، شراء 200، ختامي 6,300) وملخصه جدولٌ بعد الحركات: صفّ «Previous Balance | Total Withdrawal (Dr) | Total Deposit (Cr) | New Balance» ثم
 * صفّ «5,000.00 | 200.00 | 1,500.00 | 6,300.00»:
 *  أ) بعمود الرصيد وأول سطرٍ مقروءٌ 7,000 مكان 1,000 (مثال J2-4 ب وU1): يُقبل «متحقَّقاً» بافتتاحيٍّ مشتقٍّ −1,000 وتنبيه «openingDerived» وحده،
 *     والافتتاحي المطبوع 5,000 والمجاميع 1,500/200 أمامه كلها ترفضه.
 *  ب) والملخص نفسه بختامي «New Balance 9,300» يخالف الحركات: يُقبل «متحقَّقاً» كذلك (الختامي لا يُقرأ).
 *  ج) بلا عمود رصيد: «needBalances» فيُطلب من المستخدم كتابة ما هو مطبوعٌ أمامه.
 *  د) وPDF الصفحة نفسها (الجدول بمواضعه) كـ(أ).
 *  (والملخص نفسه صفاً واحداً «Previous Balance 5,000.00» يرفض (أ) «balance» ويقرأ (ج): الضابط، J2-4.)
 * لماذا يهم: «ما قبل أول رصيدٍ مطبوع يشهد له الافتتاحي» (DESIGN §١٣.٢٢ · U1) والمجاميع والختامي شهود الكشف كله · والقارئ «عام لا مبني على بنك
 * أو شكل»، والجدول شكل الملخص الذي سمّته الدراسة للجزيرة · فيُحفظ «متحقَّقاً» إيداعٌ بـ7,000 لم يقع (يُقترح له تحصيل) وافتتاحي شهرٍ سالب، أو
 * يُطلب من المستخدم ما طُبع.
 * السلوك الصحيح (U3 في جسم الكشف كرأسه): صفٌّ فيه كلمتا ملخصٍ فأكثر بلا قيم ويليه صفّ قيمٍ بلا كلمات ملخصٌ بصفّين، فيُقرأ «Previous Balance»
 * افتتاحياً و«New Balance» ختامياً والمجاميع مجاميع: (أ) و(ب) و(د) تُرفض «balance»، و(ج) تُقرأ بافتتاحي 5,000 وختامي 6,300 · (ولا يخالف
 * قراراً ولا اختباراً: صفّ القيم بلا تاريخ ولا كلمات لم يكن يُقرأ شيئاً.)
 */
import { readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';
import { gridFromPdfItems } from '@/domain/bankStatement/pdfTable';

const view = (r: StatementResult) => (r.ok
  ? { ok: true, amounts: r.lines.map((l) => l.amount), opening: r.opening, closing: r.closing, warnings: r.warnings }
  : { ok: false, error: r.error });
const want = { ok: true, amounts: [100000, 50000, -20000], opening: 500000, closing: 630000, warnings: [] };

const H = ['Date', 'Description', 'Value Date', 'Withdrawal (Dr)', 'Deposit (Cr)', 'Balance'];
const rows = (first: string) => [
  ['01/10/26', 'SALARY (synthetic)', '01/10/26', '', first, '6,000.00'],
  ['02/10/26', 'TRANSFER IN (synthetic)', '02/10/26', '', '500.00', '6,500.00'],
  ['05/10/26', 'POS PURCHASE (synthetic)', '05/10/26', '200.00', '', '6,300.00'],
];
const LABELS = ['Previous Balance', 'Total Withdrawal (Dr)', 'Total Deposit (Cr)', 'New Balance'];
const values = (last = '6,300.00') => ['5,000.00', '200.00', '1,500.00', last];
/** بعمود الرصيد أو بدونه */
const table = (first: string, balance = true, last?: string) => [
  ...[H, ...rows(first)].map((r) => (balance ? r : r.slice(0, 5))),
  LABELS, values(last),
];

const at = (str: string, x: number, y: number) => ({ str, x, y, size: 9 });
const pdf = [[
  at('Date', 40, 700), at('Description', 100, 700), at('Value Date', 220, 700), at('Withdrawal (Dr)', 300, 700), at('Deposit (Cr)', 390, 700), at('Balance', 470, 700),
  at('01/10/26', 40, 680), at('SALARY (synthetic)', 100, 680), at('01/10/26', 220, 680), at('7,000.00', 390, 680), at('6,000.00', 470, 680),
  at('02/10/26', 40, 665), at('TRANSFER IN (synthetic)', 100, 665), at('02/10/26', 220, 665), at('500.00', 390, 665), at('6,500.00', 470, 665),
  at('05/10/26', 40, 650), at('POS PURCHASE (synthetic)', 100, 650), at('05/10/26', 220, 650), at('200.00', 300, 650), at('6,300.00', 470, 650),
  at('Previous Balance', 100, 600), at('Total Withdrawal (Dr)', 230, 600), at('Total Deposit (Cr)', 360, 600), at('New Balance', 470, 600),
  at('5,000.00', 100, 585), at('200.00', 300, 585), at('1,500.00', 390, 585), at('6,300.00', 470, 585),
]];

describe('P2-1 · [متوسط] ملخص الجزيرة جدولاً بعد الحركات (كلماتٌ ثم قيم) يسقط كله فلا يشهد الافتتاحي ولا الختامي ولا المجاميع (read.ts:236-249 و273-286)', () => {
  test('الضابط (J2-4): الملخص صفاً واحداً «Previous Balance 5,000.00» يرفض أول سطرٍ مقروءٍ 7,000', () => {
    const r = readStatementGrid([H, ...rows('7,000.00'), ['', 'Previous Balance', '', '', '', '5,000.00'], ['', 'New Balance', '', '', '', '6,300.00']]);
    expect(view(r)).toEqual({ ok: false, error: 'balance' });
  });

  test('الضابط: الكشف الصحيح بالجدول يُقرأ سطوره (والتسلسل يشهد لما بعد أول رصيد)', () => {
    const r = readStatementGrid(table('1,000.00'));
    expect(r.ok && r.lines.map((l) => l.amount)).toEqual(want.amounts);
  });

  test('أ) أول سطرٍ مقروءٌ 7,000 مكان 1,000: يرفضه «Previous Balance 5,000» والمجاميع في الجدول', () => {
    // (الواقع: { ok: true, amounts: [700000, 50000, -20000], opening: −100000, closing: 630000, warnings: ['openingDerived'] })
    expect(view(readStatementGrid(table('7,000.00')))).toEqual({ ok: false, error: 'balance' });
  });

  test('ب) «New Balance 9,300» يخالف الحركات: يُرفض', () => {
    // (الواقع: { ok: true, … opening 500000, closing 630000, warnings: ['openingDerived'] })
    expect(view(readStatementGrid(table('1,000.00', true, '9,300.00')))).toEqual({ ok: false, error: 'balance' });
  });

  test('ج) بلا عمود رصيد: يُقرأ بافتتاحي الجدول 5,000 وختاميه 6,300', () => {
    // (الواقع: { ok: false, error: 'needBalances' })
    expect(view(readStatementGrid(table('1,000.00', false)))).toEqual(want);
  });

  test('د) PDF الصفحة نفسها والجدول بمواضعه: يُرفض كـ(أ)', () => {
    // (الواقع: ok بافتتاحيٍّ مشتقٍّ −100000 وتنبيه 'openingDerived')
    expect(view(readStatementGrid(gridFromPdfItems(pdf)))).toEqual({ ok: false, error: 'balance' });
  });
});

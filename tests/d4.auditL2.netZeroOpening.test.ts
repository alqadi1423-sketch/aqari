/**
 * المدقق L2 · الجولة التاسعة عشرة · على 5c203a6 · إصلاح J2-4 جعل «الافتتاحي/الرصيد السابق» في ملخص آخر الكشف رصيداً منقولاً إن ساوى رصيد آخر
 * حركةٍ قبله؛ فكشفٌ صافي حركته صفر (إيجارٌ يدخل ثم يُحوَّل للمالك) يُترك افتتاحيه المطبوع ويُشتق من أول سطر · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditL2.netZeroOpening.test.ts
 *
 * L2-1 · متوسط · src/domain/bankStatement/read.ts:328-330 («carriedOver: o.at > 0 && raws[o.at - 1]?.balance === o.v» يُسقط الافتتاحي في الطرف
 * الآخر بالمساواة وحدها) ثم read.ts:384-387 (بلا افتتاحيٍّ مطبوع يُشتق من أول رصيدٍ ويُقبل بتنبيه «openingDerived»): كشف الجزيرة الذي في
 * J2-4 (الملخص بعد الحركات «Previous Balance» و«New Balance»، بعمود رصيد) لحساب عمارةٍ يدخله الإيجار ثم يُحوَّل للمالك: افتتاحي 5,000،
 * إيجار 4,000 يوم 1 (9,000)، وتحويلٌ للمالك 4,000 يوم 3 (5,000)، فالختامي 5,000 يساوي الافتتاحي ·
 *  أ) سطر الإيجار ساقطٌ من القراءة (فاصل صفحةٍ أو صفٌّ لم يُقرأ · مثال U2): يُقبل «متحقَّقاً» بسطرٍ واحد وافتتاحيٍّ مشتقٍّ 9,000 وتنبيه
 *     «openingDerived» وحده، والافتتاحي المطبوع 5,000 يرفضه كما يرفضه حين يختلف الختامي (J2-4 ب).
 *  ب) وكذلك بكلمة «Opening Balance» في الموضع نفسه (ضابط J2-4)، وهي لا تكون رصيداً منقولاً بين صفحتين.
 *  ج) والكشف الصحيح نفسه يُقرأ بافتتاحيٍّ «مشتق» وتنبيهه والافتتاحي مطبوعٌ أمامه.
 *  (والملخص نفسه بختامي يخالف الافتتاحي يُرفض «balance» · الضابط.)
 * لماذا يهم: «ما قبل أول رصيدٍ مطبوع يشهد له الافتتاحي» (DESIGN §١٣.٢٢ · U1)، والافتتاحي المطبوع هو الشاهد الوحيد لأول سطر · وصافي الشهر صفراً
 * شائعٌ في حساب العقار (يدخل الإيجار ويُحوَّل للمالك كاملاً) · فيُحفظ «متحقَّقاً» كشفٌ سقط منه إيداعٌ حقيقي، فلا يُقترح له تحصيل ولا يظهر في
 * التقرير، وافتتاحي الشهر في التقرير 9,000 بدل 5,000.
 * السلوك الصحيح: المساواة برصيد آخر حركةٍ وحدها لا تجعل الملخص رصيداً منقولاً (الذي في H2-6 بعد صفّ عناوينٍ مكرَّر في صفحةٍ جديدة):
 * أ) و(ب) تُرفضان «balance» كـJ2-4 ب، و(ج) تُقرأ بافتتاحي 5,000 بلا «openingDerived» · (ولا يخالف H2-6: هناك صفّ العناوين يتكرر قبل
 * «رصيد سابق» فهو رأس صفحة.)
 */
import { readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';

const rent = ['01/10/26', 'RENT TRANSFER (synthetic)', '01/10/26', '', '4,000.00', '9,000.00'];
const owner = ['03/10/26', 'TRANSFER TO OWNER (synthetic)', '03/10/26', '4,000.00', '', '5,000.00'];
/** شكل الجزيرة (الملخص بعد الحركات) كما في tests/d4.auditJ2.previousBalance.test.ts */
const jazira = (word: string, rows: string[][], last = '5,000.00') => [
  ['Date', 'Description', 'Value Date', 'Withdrawal (Dr)', 'Deposit (Cr)', 'Balance'],
  ...rows,
  ['', word, '', '', '', '5,000.00'],
  ['', 'New Balance', '', '', '', last],
];
const view = (r: StatementResult) => (r.ok
  ? { ok: true, amounts: r.lines.map((l) => l.amount), opening: r.opening, closing: r.closing, warnings: r.warnings }
  : { ok: false, error: r.error });

describe('L2-1 · [متوسط] افتتاحي الملخص في آخر الكشف يُترك إن ساوى الختامي فيُقبل كشفٌ سقط أول سطوره (read.ts:328-330)', () => {
  test('الضابط: السطر ساقطٌ والختامي يخالف الافتتاحي: يُرفض «balance» (J2-4 ب)', () => {
    const r = readStatementGrid(jazira('Previous Balance', [['03/10/26', 'TRANSFER TO OWNER (synthetic)', '03/10/26', '1,000.00', '', '8,000.00']], '8,000.00'));
    expect(view(r)).toEqual({ ok: false, error: 'balance' });
  });

  test('أ) صافي الشهر صفر وسطر الإيجار ساقط: «Previous Balance 5,000» يرفض الكشف لا يُقبل بافتتاحيٍّ مشتقٍّ 9,000', () => {
    // (الواقع: { ok: true, amounts: [-400000], opening: 900000, closing: 500000, warnings: ['openingDerived'] })
    expect(view(readStatementGrid(jazira('Previous Balance', [owner])))).toEqual({ ok: false, error: 'balance' });
  });

  test('ب) وكذلك بكلمة «Opening Balance» في ملخص آخر الكشف', () => {
    // (الواقع: { ok: true, amounts: [-400000], opening: 900000, closing: 500000, warnings: ['openingDerived'] })
    expect(view(readStatementGrid(jazira('Opening Balance', [owner])))).toEqual({ ok: false, error: 'balance' });
  });

  test('ج) الكشف الصحيح يُقرأ بافتتاحيه المطبوع 5,000 لا مشتقاً', () => {
    // (الواقع: warnings ['openingDerived'])
    expect(view(readStatementGrid(jazira('Previous Balance', [rent, owner])))).toEqual(
      { ok: true, amounts: [400000, -400000], opening: 500000, closing: 500000, warnings: [] });
  });
});

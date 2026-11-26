/**
 * المدقق H2 · الجولة السابعة عشرة · على 3f2c136 · إصلاح F2-9 جعل «الرصيد المنقول» في وسط الحركات رصيداً بين صفحتين، وأبقى ما بعد الحركات كلها
 * افتتاحياً؛ فكشفٌ تنتهي حركاته عند آخر صفحةٍ قبل الأخيرة، والأخيرة «Balance Brought Forward» ثم الختامي وحدهما، يصير افتتاحيه الرصيدَ المنقول
 * (ختاميَّه) · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditH2.trailingForward.test.ts
 *
 * H2-6 · متوسط · src/domain/bankStatement/read.ts:310-312 (atEnd: «o.at === raws.length» افتتاحيٌّ في الكشف الأقدم أولاً إن لم يُطبع افتتاحيٌّ قبل
 * الحركات) مع dictionary.json («balance brought forward» و«brought forward» و«رصيد سابق» من كلمات الافتتاحي) ثم read.ts:355 (الرفض
 * «balance: opening» بجزءٍ يُحفظ «غير متحقَّق»): كشف PDF من صفحتين، الأولى بلا سطر افتتاحي (يُشتق من أول رصيد) فيها حركاتٌ ثلاث وأسفلها
 * «Balance Carried Forward 6,300.00»، والثانية «Balance Brought Forward 6,300.00» ثم «Closing Balance 6,300.00» · فيصير 6,300 افتتاحيَّ الكشف،
 * ويسقط التسلسل عند أول سطر، ويُعرض حفظه «غير متحقَّق» بافتتاحي 6,300 وختامي 7,600 (والصحيح 5,000 و6,300) · والكشف نفسه بلا سطر «المنقول»
 * يُقرأ متحقَّقاً.
 * لماذا يهم: صفحةٌ أخيرة تبدأ بالرصيد المنقول ثم الملخص شكلٌ معتاد حين تنتهي الحركات عند حدّ الصفحة · وهو F2-9 نفسه في موضعٍ آخر: كشفٌ صحيح
 * يُرفض، والحفظ المعروض يُدخل تقرير الشهر افتتاحياً وختامياً لا وجود لهما وفجوةً كاذبة.
 * السلوك الصحيح (F2-9: «المنقول بعد حركةٍ رصيدٌ بين صفحتين لا افتتاحيٌّ للكشف»): في الكشف الأقدم أولاً «المنقول» بعد آخر حركةٍ ليس افتتاحياً:
 * يُقرأ الكشف بثلاث حركاتٍ وافتتاحي 5,000 (مشتقاً بتنبيهه) وختامي 6,300 كما يُقرأ بلا ذلك السطر · (ولا يمسّ هذا الأحدث أولاً، فافتتاحيه بعد
 * حركاته في الطباعة، ولا ملخص «Opening Balance» أسفل الكشف.)
 */
import { readStatementGrid, unverifiedResult, type StatementResult } from '@/domain/bankStatement/read';
import { gridFromPdfItems } from '@/domain/bankStatement/pdfTable';

const at = (str: string, x: number, y: number) => ({ str, x, y, size: 9 });
const head = [at('Date', 40, 700), at('Description', 120, 700), at('Debit', 300, 700), at('Credit', 380, 700), at('Balance', 460, 700)];
const pages = (broughtForward: string | null) => [[
  at('Statement Period: 01/10/2026 - 31/10/2026', 40, 760),
  ...head,
  at('01/10/2026', 40, 680), at('SALARY (synthetic)', 120, 680), at('1,000.00', 380, 680), at('6,000.00', 460, 680),
  at('02/10/2026', 40, 665), at('TRANSFER IN (synthetic)', 120, 665), at('500.00', 380, 665), at('6,500.00', 460, 665),
  at('05/10/2026', 40, 650), at('POS PURCHASE (synthetic)', 120, 650), at('200.00', 300, 650), at('6,300.00', 460, 650),
  at('Balance Carried Forward', 120, 620), at('6,300.00', 460, 620),
], [
  ...head,
  ...(broughtForward ? [at(broughtForward, 120, 690), at('6,300.00', 460, 690)] : []),
  at('Closing Balance', 120, 600), at('6,300.00', 460, 600),
]];
const view = (r: StatementResult) => (r.ok ? { amounts: r.lines.map((l) => l.amount), opening: r.opening, closing: r.closing } : r.error + ':' + r.detail);
const want = { amounts: [100000, 50000, -20000], opening: 500000, closing: 630000 };

describe('H2-6 · [متوسط] «Balance Brought Forward» في صفحةٍ أخيرة بلا حركات يصير افتتاحيَّ الكشف فيُرفض كشفٌ صحيح (read.ts:310-312)', () => {
  test('الضابط: الصفحة الأخيرة بلا سطر «المنقول» تُقرأ (الافتتاحي مشتقٌّ من أول رصيد)', () => {
    const r = readStatementGrid(gridFromPdfItems(pages(null)));
    expect([view(r), r.ok && r.warnings]).toEqual([want, ['openingDerived']]);
  });

  test('بسطر «Balance Brought Forward» أعلى الصفحة الأخيرة: يُقرأ كما بدونه، ولا يُعرض حفظٌ بافتتاحي 6,300', () => {
    const r = readStatementGrid(gridFromPdfItems(pages('Balance Brought Forward')));
    const offer = !r.ok && r.error === 'balance' ? unverifiedResult(r.partial) : null;
    // (الواقع: 'balance:opening'، ويُعرض حفظه «غير متحقَّق» بافتتاحي 630000 وختامي 760000)
    expect({ read: view(r), offer: offer && [offer.opening, offer.closing] }).toEqual({ read: want, offer: null });
  });

  test('وكذلك «رصيد سابق» في كشفٍ عربي من Excel', () => {
    const H = ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'];
    const r = readStatementGrid([
      H,
      ['01/10/2026', 'حوالة واردة مصطنعة', '', '1,000.00', '6,000.00'],
      ['02/10/2026', 'حوالة واردة مصطنعة ثانية', '', '500.00', '6,500.00'],
      ['05/10/2026', 'شراء مصطنع', '200.00', '', '6,300.00'],
      H,
      ['', 'رصيد سابق', '', '', '6,300.00'],
      ['', 'الرصيد الختامي', '', '', '6,300.00'],
    ]);
    // (الواقع: 'balance:opening')
    expect(view(r)).toEqual(want);
  });
});

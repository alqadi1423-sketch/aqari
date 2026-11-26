/**
 * المدقق F2 · الجولة السادسة عشرة · على 50556c3 · «الرصيد المنقول» (Balance Brought Forward · «رصيد سابق») أعلى الصفحة الثانية يصير افتتاحيَّ
 * الكشف كله إن لم تطبع الصفحة الأولى افتتاحياً، فيُرفض كشفٌ صحيح ويُعرض حفظه بافتتاحيٍّ وختاميٍّ خاطئين · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditF2.broughtForward.test.ts
 *
 * F2-9 · متوسط · src/domain/bankStatement/read.ts:216 و247 («الافتتاحي أولُ ما يُطبع (كل صفحةٍ قد تكرره)»: أول «opening» يُؤخذ أينما وقع، ولو بعد
 * حركات) مع dictionary.json («brought forward» و«balance brought forward» و«رصيد سابق» و«الرصيد السابق» من كلمات الافتتاحي) ثم read.ts:299
 * و312 (الافتتاحي المطبوع المناقض لا يُستبدل إلا بمجاميع مطبوعة): كشف PDF من صفحتين، الأولى بلا سطر افتتاحي (يُشتق من أول رصيدٍ كما في
 * read.ts:350) وأسفلها «Balance Carried Forward 6,500.00»، والثانية تبدأ «Balance Brought Forward 6,500.00» · فيصير 6,500 افتتاحيَّ الكشف،
 * ويسقط التسلسل عند أول سطر «balance: opening»، ويُعرض حفظه «غير متحقَّق» بافتتاحي 6,500 وختامي 7,800 (والصحيح 5,000 و6,300) · والكشف
 * نفسه بلا سطر «المنقول» يُقرأ متحقَّقاً.
 * لماذا يهم: إصلاح D2-5 جعل «المرحَّل» ختامياً «إن لم تأتِ بعده حركة» وإلا فهو رصيدٌ بين صفحتين؛ و«المنقول» نظيره في رأس الصفحة التالية يبقى
 * افتتاحياً أينما وقع · فكشفٌ صحيح متعدد الصفحات يُرفض، والحفظ المعروض يُدخل تقرير الشهر افتتاحياً وختامياً لا وجود لهما (وفجوةً كاذبة).
 * السلوك الصحيح: «المنقول» بعد حركةٍ رصيدٌ بين صفحتين لا افتتاحيٌّ للكشف (نظير قاعدة D2-5 للمرحَّل): يُقرأ الكشف بثلاث حركاتٍ وافتتاحي 5,000
 * (مشتقاً، بتنبيهه) وختامي 6,300 كما يُقرأ بلا ذلك السطر · (تنبيه المدقق: في الكشف «الأحدث أولاً» يقع الافتتاحي آخر الجدول، فـ«بعد حركة» يُقاس
 * بترتيب الزمن بعد القلب (read.ts:296) لا بترتيب الصفوف، وإلا خالف الإصلاحُ ذلك الشكل · ولا يمسّ هذا صورة الصفحة الثانية وحدها (Z1-2 وD2-1):
 * «المنقول» فيها قبل كل حركة فهو افتتاحيها.)
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
  at('Balance Carried Forward', 120, 640), at('6,500.00', 460, 640),
], [
  ...head,
  ...(broughtForward ? [at(broughtForward, 120, 690), at('6,500.00', 460, 690)] : []),
  at('05/10/2026', 40, 680), at('POS PURCHASE (synthetic)', 120, 680), at('200.00', 300, 680), at('6,300.00', 460, 680),
  at('Closing Balance', 120, 600), at('6,300.00', 460, 600),
]];
const view = (r: StatementResult) => (r.ok ? { amounts: r.lines.map((l) => l.amount), opening: r.opening, closing: r.closing } : r.error + ':' + r.detail);
const want = { amounts: [100000, 50000, -20000], opening: 500000, closing: 630000 };

describe('F2-9 · [متوسط] «Balance Brought Forward» أعلى الصفحة الثانية يصير افتتاحيَّ الكشف فيُرفض كشفٌ صحيح (read.ts:216 و247 و299)', () => {
  test('الضابط: الصفحتان بلا سطر «المنقول» تُقرآن (الافتتاحي مشتقٌّ من أول رصيد)', () => {
    const r = readStatementGrid(gridFromPdfItems(pages(null)));
    expect([view(r), r.ok && r.warnings]).toEqual([want, ['openingDerived']]);
  });

  test('بسطر «Balance Brought Forward» أعلى الثانية: يُقرأ الكشف كما بدونه، ولا يُعرض حفظٌ بافتتاحي 6,500', () => {
    const r = readStatementGrid(gridFromPdfItems(pages('Balance Brought Forward')));
    const offer = !r.ok && r.error === 'balance' ? unverifiedResult(r.partial) : null;
    // (الواقع: 'balance:opening'، ويُعرض حفظه «غير متحقَّق» بافتتاحي 650000 وختامي 780000)
    expect({ read: view(r), offer: offer && [offer.opening, offer.closing] }).toEqual({ read: want, offer: null });
  });

  test('وكذلك «رصيد سابق» في كشفٍ عربي من Excel', () => {
    const H = ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'];
    const r = readStatementGrid([
      H,
      ['01/10/2026', 'حوالة واردة مصطنعة', '', '1,000.00', '6,000.00'],
      ['02/10/2026', 'حوالة واردة مصطنعة ثانية', '', '500.00', '6,500.00'],
      H,
      ['', 'رصيد سابق', '', '', '6,500.00'],
      ['05/10/2026', 'شراء مصطنع', '200.00', '', '6,300.00'],
      ['', 'الرصيد الختامي', '', '', '6,300.00'],
    ]);
    // (الواقع: 'balance:opening')
    expect(view(r)).toEqual(want);
  });
});

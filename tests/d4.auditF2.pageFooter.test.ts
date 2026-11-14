/**
 * المدقق F2 · الجولة السادسة عشرة · على 50556c3 · إصلاح D2-4 يمحو رقم الصفحة بنصّه «Page 1 of 2» وحده؛ وأشكاله الأخرى في التذييل («Page 1/2»
 * و«صفحة 1 / 2» و«1 / 2» والرقم وحده) تقع تحت عمود المدين في صفٍّ مؤرَّخٍ بختم الطباعة فيُرفض الكشف، أو تصير حركاتٍ وهمية · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditF2.pageFooter.test.ts
 *
 * F2-4 · متوسط · src/domain/bankStatement/read.ts:85 (PAGE_MARK = «page|pg|صفحه|الصفحه» ثم رقم ثم «of|من» ورقمٌ اختياريان، بعد foldText الذي يجعل
 * «/» مسافة: «page 1 2» لا يطابق، و«1 2» بلا كلمةٍ لا يطابق) وread.ts:93 (المحو) ثم read.ts:241 (moved: خلية مبلغٍ غير فارغة لا تُقرأ صفراً) وread.ts:266
 * (خلية مبلغٍ لا تُقرأ ترفض الكشف): كشف PDF D2-4 نفسه، صفحتان، تذييل كلٍّ منهما ختم الطباعة «07/11/2026 10:30» يساراً ورقم الصفحة في
 * الوسط تحت «Debit»:
 *  أ) «Page 1/2» و«صفحة 1 / 2» و«1 / 2»: «format: amount» فلا يُقرأ شيء (والشاشة تعرض «أعمدة الكشف» ولا عمود خاطئ فيها يُصحَّح).
 *  ب) الرقم وحده «1» و«2»: يُقرأ مبلغاً (1.00 و2.00) فيصير التذييل حركتين مدينتين يوم 7 نوفمبر خارج فترة الكشف المطبوعة، ويسقط التسلسل
 *     «balance» ويُعرض حفظه «غير متحقَّق» بخمس حركاتٍ منها الوهميتان.
 * لماذا يهم: رقم الصفحة بهذه الأشكال أشيع من «Page 1 of 2»، والتذييل يتكرر في كل صفحة؛ فكشفٌ صحيح متسلسل لا يُقرأ، أو يُحفظ بتأكيدٍ واحد
 * بحركاتٍ لم تقع (تظهر «في الكشف وحده» في تقرير نوفمبر).
 * السلوك الصحيح (D2-4): التذييل ليس حركة: ثلاث حركاتٍ (+1,000 و+500 و−200) وافتتاحي صفر وختامي 1,300 كما مع «Page 1 of 2» · (تنبيه المدقق
 * على (ب): الرقم وحده مبلغٌ مقروء، فلا يكفيه معيار D2-4 «لا مبلغ مقروء»؛ والمعيار الممكن صفٌّ مؤرَّخٌ بختم وقتٍ خارج الفترة المطبوعة بلا
 * رصيد · ولا يخالف ذلك U10 الذي يأخذ مدى السطور إن لم تحوِها الفترة، إن اقتصر على صفٍّ بلا رصيدٍ في آخر الصفحة.)
 */
import { readStatementGrid, unverifiedResult, type StatementResult } from '@/domain/bankStatement/read';
import { gridFromPdfItems } from '@/domain/bankStatement/pdfTable';

const at = (str: string, x: number, y: number) => ({ str, x, y, size: 9 });
const head = [at('Date', 40, 700), at('Description', 120, 700), at('Debit', 300, 700), at('Credit', 380, 700), at('Balance', 460, 700)];
const pages = (p1: string, p2: string) => [[
  at('Statement Period: 01/10/2026 - 31/10/2026', 40, 760),
  at('Opening Balance', 40, 740), at('0.00', 200, 740),
  ...head,
  at('01/10/2026', 40, 680), at('SALARY (synthetic)', 120, 680), at('1,000.00', 380, 680), at('1,000.00', 460, 680),
  at('02/10/2026', 40, 665), at('TRANSFER IN (synthetic)', 120, 665), at('500.00', 380, 665), at('1,500.00', 460, 665),
  at('07/11/2026 10:30', 40, 40), at(p1, 300, 40),
], [
  ...head,
  at('05/10/2026', 40, 680), at('POS PURCHASE (synthetic)', 120, 680), at('200.00', 300, 680), at('1,300.00', 460, 680),
  at('Closing Balance', 40, 600), at('1,300.00', 460, 600),
  at('07/11/2026 10:30', 40, 40), at(p2, 300, 40),
]];
const view = (r: StatementResult) => (r.ok ? { lines: r.lines.map((l) => [l.date, l.amount]), opening: r.opening, closing: r.closing } : r.error + ':' + r.detail);
const want = { lines: [['2026-10-01', 100000], ['2026-10-02', 50000], ['2026-10-05', -20000]], opening: 0, closing: 130000 };

describe('F2-4 · [متوسط] رقم الصفحة بغير «Page n of m» تحت عمود المدين يرفض كشف PDF صحيحاً أو يصنع حركاتٍ وهمية (read.ts:85 و93 و241 و266)', () => {
  test('الضابط: «Page 1 of 2» يُمحى (D2-4) فيُقرأ الكشف', () => {
    expect(view(readStatementGrid(gridFromPdfItems(pages('Page 1 of 2', 'Page 2 of 2'))))).toEqual(want);
  });

  test('(أ) «Page 1/2» و«صفحة 1 / 2» و«1 / 2» تُقرأ كـ«Page 1 of 2»', () => {
    const forms: Array<[string, string]> = [['Page 1/2', 'Page 2/2'], ['صفحة 1 / 2', 'صفحة 2 / 2'], ['1 / 2', '2 / 2']];
    // (الواقع: ['format:amount', 'format:amount', 'format:amount'])
    expect(forms.map(([a, b]) => view(readStatementGrid(gridFromPdfItems(pages(a, b)))))).toEqual([want, want, want]);
  });

  test('(ب) الرقم وحده «1» و«2»: لا حركاتٍ يوم 7 نوفمبر، لا مقروءةً ولا معروضةً للحفظ «غير متحقَّق»', () => {
    const r = readStatementGrid(gridFromPdfItems(pages('1', '2')));
    const shown = (r.ok ? r.lines : r.error === 'balance' ? unverifiedResult(r.partial)?.lines ?? [] : []).filter((l) => l.date > '2026-10-31');
    // (الواقع: 'balance:chain' ومعروضٌ للحفظ [['2026-11-07', -100], ['2026-11-07', -200]])
    expect({ read: view(r), phantom: shown.map((l) => [l.date, l.amount]) }).toEqual({ read: want, phantom: [] });
  });
});

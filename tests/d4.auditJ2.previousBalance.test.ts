/**
 * المدقق J2 · الجولة السابعة عشرة نقلت «Previous Balance» و«الرصيد السابق» و«رصيد سابق» من كلمات الافتتاحي إلى «broughtForward» الذي لا يكون
 * افتتاحياً إلا في أول الكشف زمنياً؛ فملخص الكشف الذي يكتب الافتتاحي بهذه الكلمة في آخره (الجزيرة حسب الدراسة) أو في رأس كشفٍ أحدثه أولاً لا
 * يُقرأ افتتاحيه · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditJ2.previousBalance.test.ts
 *
 * J2-4 · متوسط · src/domain/bankStatement/dictionary.json («broughtForward»: «previous balance» و«الرصيد السابق» و«رصيد سابق») مع
 * src/domain/bankStatement/read.ts:322-324 (first: أول الكشف زمنياً لكل افتتاحي، و«other» لما ليس «bf» وحده): الدراسة (docs/التقارير/
 * دراسة-كشف-البنك-2026-11-07.md · الجزيرة) «ملخص الأرصدة جدول في الصفحة الأخيرة (Previous Balance / Total Withdrawal (Dr) / Total Deposit (Cr) /
 * New Balance)» · كشفٌ بهذا الشكل الأقدم أولاً، وملخصه بعد حركاته «Previous Balance 5,000.00» و«New Balance 6,300.00»:
 *  أ) بلا عمود رصيد: «needBalances: opening» فيُطلب من المستخدم كتابة افتتاحيٍّ مطبوعٍ أمامه (وعلى 3f2c136 يُقرأ بافتتاحي 5,000).
 *  ب) بعمود رصيد وأول سطرٍ «7,000.00» مكان «1,000.00» (خطأ طباعةٍ أو قراءة): يُقبل «متحقَّقاً» بافتتاحيٍّ مشتقٍّ −1,000 وتنبيه «openingDerived»
 *     وحده، والافتتاحي المطبوع 5,000 كان يرفضه («balance: opening» على 3f2c136) · وهذا مثال U1 نفسه («سطرٌ أول بـ80,000 بدل 8,000 كان يُقبل
 *     بافتتاحيٍّ مشتقٍّ سالب»).
 *  ج) صورة الصفحة نفسها (الكلمات الإنجليزية يقرؤها قارئ النص) بقراءةٍ صحيحة: «needBalances: unknown» (إشارة أول سطرٍ في الصورة من التسلسل
 *     وحده ولا افتتاحي) وكانت تُقرأ على 3f2c136.
 *  د) وكشفٌ عربيٌّ أحدثه أولاً وفي رأسه «الرصيد السابق» و«الرصيد الحالي» بلا عمود رصيد: «needBalances: opening» وكان يُقرأ.
 *  (والكشف نفسه بكلمة «Opening Balance» في الموضع نفسه يُقرأ: الضابط · فالكلمة وحدها تُسقطه.)
 * لماذا يهم: «الرصيد السابق» في ملخص الكشف هو افتتاحيه بلفظ البنك، وهو الشاهد الوحيد لأول سطرٍ قبل أول رصيدٍ مطبوع (DESIGN §١٣.٢٢: «ما قبل أول
 * رصيدٍ مطبوع يشهد له الافتتاحي») · فيُطلب من المستخدم ما طُبع، أو يُقبل سطرٌ مقروءٌ خطأً بلا شاهدٍ فيُحفظ «متحقَّقاً» بإيداعٍ لم يقع (ويُقترح له
 * تحصيل) وافتتاحيٍّ سالب في تقرير الشهر.
 * السلوك الصحيح: «Previous Balance/الرصيد السابق» في ملخص الكشف (آخره في الأقدم أولاً، أو رأسه في الأحدث أولاً) افتتاحيّه كـ«Opening Balance»:
 * (أ) و(ج) و(د) تُقرأ بافتتاحي 5,000 وختامي 6,300، و(ب) تُرفض «balance» · (ولا يخالف H2-6: «المنقول» هناك رصيدٌ بين صفحتين بعد صفّ عناوينٍ مكرَّر
 * وقيمته رصيد ما قبله 6,300 لا افتتاحيّ يتسلسل منه شيء.)
 */
import { readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';
import { readStatementPhoto, type OcrLine } from '@/domain/bankStatement/photo';

const view = (r: StatementResult) => (r.ok ? { amounts: r.lines.map((l) => l.amount), opening: r.opening, closing: r.closing } : r.error + ':' + r.detail);
const want = { amounts: [100000, 50000, -20000], opening: 500000, closing: 630000 };

/** شكل الجزيرة: الملخص بعد الحركات · word: كلمة الافتتاحي، و balance: بعمود الرصيد أو بدونه */
const jazira = (word: string, balance: boolean, first = '1,000.00') => {
  const cut = (r: string[]) => (balance ? r : r.slice(0, 5));
  return [
    cut(['Date', 'Description', 'Value Date', 'Withdrawal (Dr)', 'Deposit (Cr)', 'Balance']),
    cut(['01/10/26', 'SALARY (synthetic)', '01/10/26', '', first, '6,000.00']),
    cut(['02/10/26', 'TRANSFER IN (synthetic)', '02/10/26', '', '500.00', '6,500.00']),
    cut(['05/10/26', 'POS PURCHASE (synthetic)', '05/10/26', '200.00', '', '6,300.00']),
    balance ? ['', word, '', '', '', '5,000.00'] : ['', word, '', '', '5,000.00'],
    balance ? ['', 'New Balance', '', '', '', '6,300.00'] : ['', 'New Balance', '', '', '6,300.00'],
  ];
};

/** صورة الصفحة نفسها (قارئ النص لا يقرأ العربية فالكلمات الإنجليزية وحدها) */
const ln = (text: string, left: number, top: number): OcrLine => ({ text, left, top, width: text.length * 10, height: 20 });
const photo = (first: string): OcrLine[] => [
  ln('Date Description Value Date Withdrawal (Dr) Deposit (Cr) Balance', 40, 60),
  ln('01/10/26', 40, 100), ln('SALARY', 200, 100), ln(first, 720, 100), ln('6,000.00', 880, 100),
  ln('02/10/26', 40, 140), ln('TRANSFER IN', 200, 140), ln('500.00', 720, 140), ln('6,500.00', 880, 140),
  ln('05/10/26', 40, 180), ln('POS PURCHASE', 200, 180), ln('200.00', 560, 180), ln('6,300.00', 880, 180),
  ln('Previous Balance', 40, 240), ln('5,000.00', 880, 240),
  ln('New Balance', 40, 280), ln('6,300.00', 880, 280),
];

describe('J2-4 · [متوسط] «Previous Balance/الرصيد السابق» في ملخص الكشف لا يُقرأ افتتاحياً بعد الجولة ١٧ (dictionary.json · read.ts:322-324)', () => {
  test('الضابط: الملخص نفسه بكلمة «Opening Balance» يُقرأ بافتتاحي 5,000', () => {
    expect(view(readStatementGrid(jazira('Opening Balance', false)))).toEqual(want);
  });

  test('أ) شكل الجزيرة بلا عمود رصيد: «Previous Balance» آخر الكشف افتتاحيّه', () => {
    // (الواقع: 'needBalances:opening')
    expect(view(readStatementGrid(jazira('Previous Balance', false)))).toEqual(want);
  });

  test('ب) بعمود رصيد وأول سطرٍ مقروءٌ 7,000 مكان 1,000: يرفضه الافتتاحي المطبوع ولا يُقبل «متحقَّقاً» بافتتاحيٍّ مشتقٍّ −1,000', () => {
    const r = readStatementGrid(jazira('Previous Balance', true, '7,000.00'));
    // (الواقع: ok · opening −100000 · warnings ['openingDerived'] · checks.chain true)
    expect(r.ok ? { ok: true, opening: r.opening, warnings: r.warnings } : { ok: false, error: r.error }).toEqual({ ok: false, error: 'balance' });
  });

  test('ج) الصورة نفسها بقراءةٍ صحيحة تُقرأ بافتتاحي 5,000', () => {
    // (الواقع: 'needBalances:unknown')
    expect(view(readStatementPhoto(photo('1,000.00')))).toEqual(want);
  });

  test('د) كشفٌ عربيٌّ أحدثه أولاً و«الرصيد السابق» في رأسه، بلا عمود رصيد', () => {
    const r = readStatementGrid([
      ['الرصيد السابق', '5,000.00'],
      ['الرصيد الحالي', '6,300.00'],
      ['التاريخ', 'البيان', 'مدين', 'دائن'],
      ['05/10/2026', 'شراء مصطنع', '200.00', ''],
      ['02/10/2026', 'حوالة واردة مصطنعة', '', '500.00'],
      ['01/10/2026', 'راتب مصطنع', '', '1,000.00'],
    ]);
    // (الواقع: 'needBalances:opening')
    expect(view(r)).toEqual(want);
  });
});

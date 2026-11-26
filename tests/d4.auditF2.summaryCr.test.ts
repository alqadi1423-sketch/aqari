/**
 * المدقق F2 · الجولة السادسة عشرة · على 50556c3 · قيمة الملخص بلاحقةٍ مفصولة («Opening Balance | 1,000.00 CR» و«Closing Balance | 1,490.00 CR»)
 * لا تُقرأ: «1,000.00 CR» يُعدّ عنوان عمود «الدائن» فيتوقف عنده البحث عن القيمة · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditF2.summaryCr.test.ts
 *
 * F2-7 · منخفض · src/domain/bankStatement/read.ts:408 (amountAfter: «if (summaryOf(r[j]) || roleOf(r[j])) break» قبل قراءة المبلغ) مع
 * src/domain/bankStatement/columns.ts:18-29 (roleOf: «1,000.00 CR» مطبَّعةً «1 000 00 cr» فيها كلمة «cr» من كلمات دور «credit»، و«DR» من
 * «debit»): الافتتاحي والختامي المطبوعان بلاحقةٍ مفصولة (الشكل الذي يقرؤه D2-9 ضابطاً) لا يُقرآن أصلاً:
 *  أ) بعمودي مدين ودائن أو مبلغٍ موقَّع: يُشتق الافتتاحي من أول رصيد (تنبيه «openingDerived») ولا يُفحص الختامي المطبوع (checks.closing = null) ·
 *     وهذا ما يمرّ به ضابط D2-9 نفسه (tests/d4.auditD2.crdrSuffix.test.ts) دون أن يُرى، وسلوكه الصحيح فيه «يُقرأ الكشف بافتتاحيه … وختاميه».
 *  ب) بمبلغٍ واحد بلا إشارة ورصيدٍ لكل سطر (وهو جدول الصورة دائماً: photo.ts يترك العلامات ويحدّد الإشارة من التسلسل): «needBalances: unknown»،
 *     فيُطلب من المستخدم كتابة افتتاحيٍّ مطبوعٍ أمامه.
 * لماذا يهم: «CR/DR» بعد الرصيد شائعةٌ في الكشوف الإنجليزية (D2-9 وU13)، والافتتاحي والختامي المطبوعان شاهدا الفحص (قرار المالك أ.٤)؛ فيضعف
 * الفحص بصمت، أو يُسأل المستخدم ما في الكشف.
 * السلوك الصحيح: «1,000.00 CR» قيمة الملخص لا عنوان عمود: يُقرأ الكشف بافتتاحيه وختاميه المطبوعين مفحوصين، بلا «openingDerived».
 */
import { readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';

const view = (r: StatementResult) => (r.ok ? { amounts: r.lines.map((l) => l.amount), opening: r.opening, closing: r.closing, closingChecked: r.checks.closing, warnings: r.warnings }
  : r.error + ':' + r.detail);
const want = { amounts: [50000, -1000], opening: 100000, closing: 149000, closingChecked: true, warnings: [] };
const split = (sep: string) => [
  ['Opening Balance', `1,000.00${sep}CR`],
  ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
  ['01/10/2026', 'TRANSFER IN (synthetic)', '', '500.00', `1,500.00${sep}CR`],
  ['03/10/2026', 'SERVICE FEE (synthetic)', '10.00', '', `1,490.00${sep}CR`],
  ['Closing Balance', `1,490.00${sep}CR`],
];
const single = (sep: string) => [
  ['Opening Balance', `1,000.00${sep}CR`],
  ['Date', 'Description', 'Amount', 'Balance'],
  ['01/10/2026', 'TRANSFER IN (synthetic)', '500.00', `1,500.00${sep}CR`],
  ['03/10/2026', 'SERVICE FEE (synthetic)', '10.00', `1,490.00${sep}CR`],
  ['Closing Balance', `1,490.00${sep}CR`],
];

describe('F2-7 · [منخفض] الافتتاحي والختامي بلاحقةٍ مفصولة «1,000.00 CR» لا يُقرآن (read.ts:408 · columns.ts:18-29)', () => {
  test('الضابط: اللاحقة الملتصقة «1,000.00CR» تُقرأ افتتاحياً وختامياً مفحوصين', () => {
    expect([view(readStatementGrid(split(''))), view(readStatementGrid(single('')))]).toEqual([want, want]);
  });

  test('(أ) عمودا مدين ودائن: الافتتاحي والختامي المطبوعان «… CR» يُقرآن ويُفحصان', () => {
    // (الواقع: closingChecked: null وwarnings: ['openingDerived'])
    expect(view(readStatementGrid(split(' ')))).toEqual(want);
  });

  test('(ب) مبلغٌ واحد بلا إشارة ورصيدٌ لكل سطر: يُقرأ بالافتتاحي المطبوع', () => {
    // (الواقع: 'needBalances:unknown')
    expect(view(readStatementGrid(single(' ')))).toEqual(want);
  });
});

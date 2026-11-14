/**
 * المدقق R2 · الجولة الثانية والعشرون · على 260be7b · ملخص رأس الكشف بصفّين (U3) يُعرف بـ«كلمتا ملخصٍ فأكثر في صف، والصف التالي بلا كلمة
 * ملخص» ثم يُرجَع من الصف دون noteSummary ولو لم يُقرأ من الصف التالي شيء · فملخصٌ بصفٍّ واحد قيمه في خلايا كلماته يتبعه صفٌّ عادي (رقم
 * الحساب، اسم العميل) يسقط كله بصمت · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditR2.headInCellSummary.test.ts
 *
 * R2-3 · متوسط · src/domain/bankStatement/read.ts:236-247 («if (keys… >= 2 && next && !next.some(summaryOf)) { … return; }» قبل noteSummary(r)):
 * رأس الكشف «Opening Balance: 5,000.00 | Closing Balance: 5,500.00» ثم «Account No 1234567890» ثم العناوين، وأول سطرٍ مقروءٌ 7,000 مكان
 * 1,000 (مثال U1 وJ2-4 وP2-1) · يُقبل «متحقَّقاً» بافتتاحيٍّ مشتقٍّ −1,000 وتنبيه «openingDerived»، والافتتاحي 5,000 والختامي 5,500 مطبوعان
 * أمامه · وبلا صفّ رقم الحساب يُرفض «balance» (الضابط) · فالحكم يتبع وجود صفٍّ لا علاقة له بالملخص.
 * لماذا يهم: «ما قبل أول رصيدٍ مطبوع يشهد له الافتتاحي» (DESIGN §١٣.٢٢ · U1) · والملخص في أعلى الصفحة يليه رقم الحساب أو اسم العميل شكلٌ
 * شائع · فيُحفظ «متحقَّقاً» إيداعٌ بـ7,000 لم يقع (يُقترح له تحصيل) وافتتاحي شهرٍ سالب · والكشف السليم نفسه يُقرأ بلا شاهدٍ للختامي.
 * السلوك الصحيح: صفّ الكلمات لا يصير ملخصاً بصفّين إلا إن قُرئ من الصف التالي قيمةٌ تحت كلماته؛ وإلا يُقرأ ملخصاً بصفٍّ واحد من خلاياه ·
 * فالمقروء خطأً يُرفض «balance»، والسليم يُقرأ بلا «openingDerived» وبختامٍ مفحوص · (ولا يخالف U3: صفّ القيم هناك يُقرأ منه.)
 */
import { readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';

const view = (r: StatementResult) => (r.ok
  ? { ok: true, amounts: r.lines.map((l) => l.amount), opening: r.opening, closing: r.closing, warnings: r.warnings, closingChecked: r.checks.closing }
  : { ok: false, error: r.error });

const H = ['Date', 'Description', 'Debit', 'Credit', 'Balance'];
const SUMMARY = ['Opening Balance: 5,000.00', 'Closing Balance: 5,500.00'];
const grid = (first: string, account: boolean) => [
  SUMMARY,
  ...(account ? [['Account No 1234567890']] : []),
  H,
  ['01/10/2026', 'RENT DEPOSIT (synthetic)', '', first, '6,000.00'],
  ['03/10/2026', 'SERVICE FEES (synthetic)', '500.00', '', '5,500.00'],
];

describe('R2-3 · [متوسط] ملخص الرأس بصفٍّ واحد قيمه في خلاياه يسقط إن تبعه صفٌّ بلا كلمة ملخص (read.ts:236-247)', () => {
  test('الضابط: بلا صفّ رقم الحساب يُرفض أول سطرٍ مقروءٍ 7,000', () => {
    expect(view(readStatementGrid(grid('7,000.00', false)))).toEqual({ ok: false, error: 'balance' });
  });

  test('ومع صفّ رقم الحساب بعده: يُرفض كذلك', () => {
    // (الواقع: { ok: true, amounts: [700000, -50000], opening: −100000, closing: 550000, warnings: ['openingDerived'], closingChecked: null })
    expect(view(readStatementGrid(grid('7,000.00', true)))).toEqual({ ok: false, error: 'balance' });
  });

  test('والكشف السليم مع صفّ رقم الحساب: افتتاحيه وختاميه المطبوعان يشهدان', () => {
    // (الواقع: warnings ['openingDerived'] وclosingChecked null)
    expect(view(readStatementGrid(grid('1,000.00', true))))
      .toEqual({ ok: true, amounts: [100000, -50000], opening: 500000, closing: 550000, warnings: [], closingChecked: true });
  });
});

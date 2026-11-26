/**
 * المدقق F2 · الجولة السادسة عشرة · على 50556c3 · إصلاح D2-6 («عمود نوع العملية تحكمه الأرصدة المطبوعة إن ناقضته») لا يعمل إلا مع افتتاحيٍّ
 * مطبوع ورصيدٍ لكل سطر؛ وإلا تبقى إشارات النص الوصفي، ويُعرض حفظ الكشف «غير متحقَّق» بها: سداد البطاقة إيداعٌ · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditF2.typeNoOpening.test.ts
 *
 * F2-3 · متوسط · src/domain/bankStatement/read.ts:305-308 (إعادة الحل بالتسلسل وحده «sign: 0» لكل سطر، وبشرط «lines.every(balance != null)»)
 * مع read.ts:328-336 (الرفض «balance» يحمل جزءاً بإشارات النوع ما دامت كلها «معروفة») وapp/bankStatement.tsx:138-145 (يُعرض حفظه «غير متحقَّق»):
 *  أ) بلا افتتاحيٍّ مطبوع (والختامي مطبوع): «Deposit» ثم «Credit Card Payment» ثم «Debit Card Refund» وكل سطرٍ برصيده · الحل بإشارات النوع
 *     يسقط «chain» عند السطر الثاني، والحل بالتسلسل وحده لا يعرف إشارة السطر الأول بلا افتتاحي «unknown» فلا يُعتمد · فيبقى الرفض الأول
 *     بإشارات النوع: سداد البطاقة +1,000 والاسترداد −200، ويُعرض حفظه «غير متحقَّق» بختامي 8,300 والمطبوع 6,700.
 *  ب) بافتتاحيٍّ مطبوع وسطرٍ بلا رصيد (الإيداع والسداد في يومٍ واحد ورصيدٌ آخر اليوم كما في كشف الرياض): الشرط «رصيدٌ لكل سطر» يسقط فلا
 *     تُعاد القراءة بالتسلسل أصلاً، مع أن رصيد آخر اليوم يحدّد إشارة السداد بعد إيداعٍ معروف الإشارة.
 * لماذا يهم: الإيداع المحفوظ مفتوحاً تقترح له شاشة التحصيل قسطاً أو مطالبة (collect.ts)، فسداد البطاقة المحفوظ إيداعاً بتأكيدٍ واحد يصير
 * تحصيل إيجارٍ لم يُدفع · وD2-6 قرّر أن الوصفي لا يغلب الأرصدة، وما نقضه هنا الشكلُ لا القاعدة.
 * السلوك الصحيح: لا تُعرض ولا تُقبل إشارةٌ من عمود النوع تناقضها الأرصدة المطبوعة: في (أ) لا يُعرض سداد البطاقة إيداعاً (يُقرأ الكشف بإشارة
 * «Deposit» للسطر الأول والتسلسل لما بعده، أو يُطلب الافتتاحي)، وفي (ب) يُقرأ الكشف (+2,500 −1,000 +200) كما يُقرأ بلا عمود النوع حين تُعرف
 * إشارة الإيداع.
 */
import { readStatementGrid, unverifiedResult, type StatementResult } from '@/domain/bankStatement/read';

const view = (r: StatementResult) => (r.ok ? { amounts: r.lines.map((l) => l.amount), opening: r.opening, closing: r.closing } : r.error + ':' + r.detail);
/** ما تعرضه الشاشة للحفظ: القراءة الناجحة، أو الجزء «غير المتحقَّق» مع رفض «balance» */
const offered = (r: StatementResult) => (r.ok ? r.lines : r.error === 'balance' ? unverifiedResult(r.partial)?.lines ?? [] : [])
  .map((l) => [l.descr, l.amount]);

const NO_OPENING = [
  ['Date', 'Transaction Type', 'Description', 'Amount', 'Balance'],
  ['01/10/2026', 'Deposit', 'RENT OCT (synthetic)', '2,500.00', '7,500.00'],
  ['03/10/2026', 'Credit Card Payment', 'CARD 4000 (synthetic)', '1,000.00', '6,500.00'],
  ['05/10/2026', 'Debit Card Refund', 'MERCHANT (synthetic)', '200.00', '6,700.00'],
  ['Closing Balance', '6,700.00'],
];
const SAME_DAY = [
  ['Opening Balance', '5,000.00'],
  ['Date', 'Transaction Type', 'Description', 'Amount', 'Balance'],
  ['01/10/2026', 'Deposit', 'RENT OCT (synthetic)', '2,500.00', ''],
  ['01/10/2026', 'Credit Card Payment', 'CARD 4000 (synthetic)', '1,000.00', '6,500.00'],
  ['05/10/2026', 'Debit Card Refund', 'MERCHANT (synthetic)', '200.00', '6,700.00'],
  ['Closing Balance', '6,700.00'],
];

describe('F2-3 · [متوسط] عمود «Transaction Type» الوصفي يغلب الأرصدة بلا افتتاحيٍّ مطبوع أو مع سطرٍ بلا رصيد، ويُعرض حفظه بإشاراته (read.ts:305-308 و328-336)', () => {
  test('الضابط: مع افتتاحيٍّ مطبوع ورصيدٍ لكل سطر تحكم الأرصدة (D2-6)', () => {
    expect(view(readStatementGrid([['Opening Balance', '5,000.00'], ...NO_OPENING]))).toEqual({ amounts: [250000, -100000, 20000], opening: 500000, closing: 670000 });
  });

  test('(أ) بلا افتتاحيٍّ مطبوع: لا يُعرض سداد البطاقة إيداعاً ولا الاسترداد سحباً', () => {
    const shown = offered(readStatementGrid(NO_OPENING));
    // (الواقع: [['RENT OCT (synthetic)', 250000], ['CARD 4000 (synthetic)', 100000], ['MERCHANT (synthetic)', -20000]] معروضاً «غير متحقَّق»)
    expect(shown.filter(([d, a]) => (d === 'CARD 4000 (synthetic)' && Number(a) > 0) || (d === 'MERCHANT (synthetic)' && Number(a) < 0))).toEqual([]);
  });

  test('(ب) الإيداع والسداد في يومٍ واحد ورصيدٌ آخر اليوم: يُقرأ الكشف بإشارات أرصدته', () => {
    // (الواقع: 'balance:opening' وجزءٌ بإشارات النوع [250000, 100000, -20000] يُعرض حفظه «غير متحقَّق»)
    expect(view(readStatementGrid(SAME_DAY))).toEqual({ amounts: [250000, -100000, 20000], opening: 500000, closing: 670000 });
  });
});

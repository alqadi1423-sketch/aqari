/**
 * المدقق D2 · الجولة الخامسة عشرة · على f5036b1 · لاحقة «CR/DR» ملتصقةً بالمبلغ بلا مسافة («1,500.00CR») لا تُقرأ، فيُرفض الكشف كله
 * «صيغة» · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditD2.crdrSuffix.test.ts
 *
 * D2-9 · متوسط · src/domain/bankStatement/normalize.ts:22-25 (/\b[Dd][Rr]\.?$/ و/\b[Cc][Rr]\.?$/: لا حدّ كلمةٍ بين «0» و«C» فلا تُعرف اللاحقة
 * الملتصقة، فيبقى «1,500.00CR» ويسقط في /^\d+(\.\d{1,2})?$/ = null) ومثلها amountHasSign (normalize.ts:42) وmarkOf (read.ts:341-342) ·
 * ثم read.ts:239-240 (خلية مبلغٍ لا تُقرأ ترفض الكشف): كشفٌ بمبلغٍ واحد ورصيدٍ يطبعان الإشارة لاحقةً ملتصقة («500.00CR» و«10.00DR»
 * و«1,490.00CR») · المبلغ لا يُقرأ فـ«format: amount»، والرصيد والافتتاحي والختامي لا تُقرأ أصلاً (لو قُرئت المبالغ لصار الكشف بلا أرصدة).
 * لماذا يهم: DESIGN §١٣.٢٢ ورأس normalize.ts: «والإشارة بالسالب أو بالأقواس أو بـCR وDR» · واللاحقة الملتصقة شكلٌ شائع في الكشوف
 * الإنجليزية، وكشفٌ صحيح متسلسل لا يُقرأ ولا تصحيح له في الشاشة.
 * السلوك الصحيح: «500.00CR» = +50,000 هللة و«10.00DR» = −1,000 كالمفصولة بمسافة، فيُقرأ الكشف بافتتاحيه وأرصدته وختاميه.
 */
import { parseStatementAmount } from '@/domain/bankStatement/normalize';
import { readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';

const view = (r: StatementResult) => (r.ok ? { amounts: r.lines.map((l) => l.amount), balances: r.lines.map((l) => l.balance), opening: r.opening, closing: r.closing } : r.error + ':' + r.detail);
const grid = (sep: string) => [
  ['Opening Balance', `1,000.00${sep}CR`],
  ['Date', 'Description', 'Amount', 'Balance'],
  ['01/10/2026', 'TRANSFER IN (synthetic)', `500.00${sep}CR`, `1,500.00${sep}CR`],
  ['03/10/2026', 'SERVICE FEE (synthetic)', `10.00${sep}DR`, `1,490.00${sep}CR`],
  ['Closing Balance', `1,490.00${sep}CR`],
];
const want = { amounts: [50000, -1000], balances: [150000, 149000], opening: 100000, closing: 149000 };

describe('D2-9 · [متوسط] «CR/DR» ملتصقةً بالمبلغ لا تُقرأ فيُرفض الكشف «format» (normalize.ts:22-25 · read.ts:239-240)', () => {
  test('الضابط: «500.00 CR» بمسافةٍ تُقرأ، والكشف بها يُقرأ', () => {
    expect([parseStatementAmount('500.00 CR'), parseStatementAmount('10.00 DR'), view(readStatementGrid(grid(' ')))]).toEqual([50000, -1000, want]);
  });

  test('«500.00CR» و«10.00DR» و«1,234.50Cr» تُقرأ بإشاراتها', () => {
    // (الواقع: [null, null, null])
    expect(['500.00CR', '10.00DR', '1,234.50Cr'].map(parseStatementAmount)).toEqual([50000, -1000, 123450]);
  });

  test('والكشف باللاحقة الملتصقة يُقرأ كالمفصولة', () => {
    // (الواقع: 'format:amount')
    expect(view(readStatementGrid(grid('')))).toEqual(want);
  });
});

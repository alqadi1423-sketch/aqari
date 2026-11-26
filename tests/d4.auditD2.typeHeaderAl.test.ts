/**
 * المدقق D2 · الجولة الخامسة عشرة · على f5036b1 · عنوان عمود المؤشر «المدين/الدائن» (بأل التعريف) يأخذ دور «مدين»، فقيمه «مدين» و«دائن»
 * خلايا مبلغٍ لا تُقرأ ويُرفض الكشف · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditD2.typeHeaderAl.test.ts
 *
 * D2-13 · منخفض · src/domain/bankStatement/dictionary.json (دور «type»: «مدين او دائن» و«دائن مدين» و«مدين دائن» بلا أل، ودور «debit»:
 * «المدين») مع src/domain/bankStatement/columns.ts:131-136 (أول دورٍ تطابق كلمته) ثم read.ts:239-240: «المدين/الدائن» ← foldText «المدين
 * الدائن» لا يطابق كلمات «type» ويطابق «المدين» فيصير عمود مدين، وقيمه «دائن»/«مدين» لا تُقرأ مبلغاً فـ«format: amount» · وهو ما أصلحه X5
 * للإنجليزية («Debit/Credit») وU9 لأل التعريف في المدين والدائن منفردين، ولم يجتمعا.
 * لماذا يهم: كشفٌ صحيح بمبلغٍ ومؤشرٍ ورصيد لا يُقرأ، ولا يُعرض للمستخدم «أعمدة الكشف» (الخطأ ليس «columns»).
 * السلوك الصحيح: «المدين/الدائن» و«الدائن/المدين» عمود نوع كـ«مدين/دائن»، فيُقرأ الكشف بإشاراته.
 */
import { roleOf } from '@/domain/bankStatement/columns';
import { readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';

const view = (r: StatementResult) => (r.ok ? r.lines.map((l) => l.amount) : r.error + ':' + r.detail);
const grid = (indicator: string) => [
  ['الرصيد الافتتاحي', '1,000.00'],
  ['التاريخ', 'البيان', 'المبلغ', indicator, 'الرصيد'],
  ['01/10/2026', 'حوالة واردة مصطنعة', '500.00', 'دائن', '1,500.00'],
  ['03/10/2026', 'رسوم مصطنعة', '10.00', 'مدين', '1,490.00'],
];

describe('D2-13 · [منخفض] «المدين/الدائن» بأل التعريف عمود مدين لا عمود نوع فيُرفض الكشف (dictionary.json · columns.ts:131-136)', () => {
  test('الضابط: «مدين/دائن» عمود نوع والكشف يُقرأ', () => {
    expect([roleOf('مدين/دائن'), view(readStatementGrid(grid('مدين/دائن')))]).toEqual(['type', [50000, -1000]]);
  });

  test('«المدين/الدائن» و«الدائن/المدين» عمودا نوع، والكشف يُقرأ', () => {
    // (الواقع: ['debit', 'debit'] و'format:amount')
    expect([roleOf('المدين/الدائن'), roleOf('الدائن/المدين'), view(readStatementGrid(grid('المدين/الدائن')))]).toEqual(['type', 'type', [50000, -1000]]);
  });
});

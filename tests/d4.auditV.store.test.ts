/**
 * المدقق الخارجي V · الجولة الحادية عشرة · كشف البنك على الجهاز (src/domain/bankStatement/store.ts): الحفظ والحذف وتقرير المطابقة ·
 * كل اختبارٍ يسقط على الشيفرة الحالية ويصف السلوك الصحيح · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditV.store.test.ts
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementGrid, unverifiedResult } from '@/domain/bankStatement/read';
import { saveStatement, deleteStatement, reconciliation } from '@/domain/bankStatement/store';

const HEAD = ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'];
/** كشف أكتوبر برسومٍ مقروءة كما في الملف (58 صحيحة، و85 قراءةٌ خاطئة لها) */
const october = (fee: string) => readStatementGrid([['الفترة من 01/10/2026 إلى 31/10/2026'], ['الرصيد الافتتاحي', '0.00'], HEAD,
  ['2026/10/02', 'حوالة واردة مصطنعة', '', '1,000.00', '1,000.00'],
  ['2026/10/05', 'رسوم مصطنعة', fee, '', '942.00'],
  ['2026/10/09', 'سداد مصطنع', '100.00', '', '842.00']]);

describe('V١ · [عالٍ] حذف كشفٍ ينقل إلى الكشف الآخر كل سطوره الواقعة في فترته ولو لم تكن فيه، فيبقى السطر الخاطئ بعد حذف كشفه (store.ts:272)', () => {
  // إصلاح U١٧ ينقل بالتاريخ وحده: «سطرٌ يقع في فترة كشفٍ حيٍّ آخر … يُنقل إليه» · لكن الكشف الآخر لم يتخطَّ إلا ما بصمته عنده
  // (التاريخ والمبلغ) · فأشيع سببٍ لحذف كشف (حُفظ «غير متحقَّق» بسطرٍ مقروءٍ خطأً، ثم قُرئ الصحيح للفترة نفسها) يُبقي السطر الخاطئ
  // في الكشف الصحيح: الرسوم مرتين (85 و58)، وسطور الكشف لا تساوي ختاميه، وفرقٌ «غير مفسَّر» 85 في تقرير أكتوبر · وكذلك كشف حسابٍ
  // آخر حُفظ في البنك خطأً ثم حُذف: سطوره كلها تنتقل إلى كشف البنك الصحيح
  test('غير المتحقَّق (85) ثم الصحيح (58) للفترة نفسها، ثم حذف غير المتحقَّق: تبقى سطور الكشف الصحيح وحدها', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع للمدقق V', 0);
    const bad = october('85.00');
    const u = bad.ok ? null : unverifiedResult(bad.partial);
    if (!u) throw new Error('لا قراءة غير متحقَّقة');
    const U = saveStatement(db, bank, u, { name: 'oct-photo.jpg', hash: 'v1-u' });
    const good = october('58.00');
    if (!good.ok) throw new Error(good.error);
    // الصحيح يضيف سطر الرسوم 58 وحده (الحوالة والسداد عنده بالبصمة نفسها)
    expect(saveStatement(db, bank, good, { name: 'oct.pdf', hash: 'v1-c' })).toMatchObject({ added: 1, skipped: 2 });
    deleteStatement(db, U.statementId);
    const live = db.all<{ a: number }>(`SELECT amount_halalas AS a FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY date, amount_halalas`, [bank]).map((x) => Number(x.a));
    // الصحيح: ما يُنقل هو ما تخطّاه الكشف الآخر عند حفظه (بصمته فيه)، وسطر 85 الذي ليس فيه يُحذف مع كشفه
    expect(live).toEqual([100000, -5800, -10000]);
    expect(reconciliation(db, bank, '2026-10').unexplained).toBe(0);
  });
});

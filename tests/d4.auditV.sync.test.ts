/**
 * المدقق الخارجي V · الجولة الحادية عشرة · كشف البنك في المزامنة (جهازان على الحساب نفسه بـMemoryRemote · tests/helpers/rederive.ts):
 * حذف الكشف (deleteStatement) يفترض أن الجهاز يرى كل كشوف البنك وكل اعتماداته، والمزامنة لا تفحص ذلك · كل اختبارٍ يسقط على الشيفرة
 * الحالية ويصف السلوك الصحيح · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditV.sync.test.ts
 */
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { depositCashToBank, ownerCashIn } from '@/domain/cashOps';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, deleteStatement, matchSuggestions, approveMatch, reconciliation } from '@/domain/bankStatement/store';
import type { MemoryRemote } from './helpers/memoryRemote';
import type { DB } from '@/db/adapter';

const HEAD = ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'];
const stmt = (from: string, to: string, opening: string, rows: string[][]) => {
  const r = readStatementGrid([[`الفترة من ${from} إلى ${to}`], ['الرصيد الافتتاحي', opening], HEAD, ...rows]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error);
  return r;
};
/** ما كتبه الجهاز الثاني بكاتبه العضو (كما في d6.bankStatementCollect) ثم جولتا مزامنة */
async function settle(p: { owner: DB; dev: DB; r: MemoryRemote }) {
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  for (const d of [...p.r.docs.values()]) if (d.dev && d.dev !== 'owner' && d.u && d.u > '2026-11-07') p.r.inject({ ...d, by: MEMBER });
  await ownerPulls(p.owner, p.r);
  await sync(p.dev, p.r);
  await ownerPulls(p.owner, p.r);
  await sync(p.dev, p.r);
}

describe('V٤ · [عالٍ] حذف كشفٍ على جهازٍ لا يعرف كشفاً متداخلاً حُفظ على الجهاز الآخر يمحو سطوراً تخطّاها ذلك الكشف (store.ts:261 · U١٧ عبر جهازين)', () => {
  // العضو يحفظ B (15–31 أكتوبر) فيتخطّى سطر 16 أكتوبر لأنه في A · والمالك بلا اتصال يحذف A (لا يعرف B فلا ينقل إليه شيئاً) · بعد
  // المزامنة يبقى B بلا سطر 16 أكتوبر على الجهازين، وتقرير أكتوبر بفرقٍ «غير مفسَّر» −10 لا سطر له · ولا يُستعاد بقراءة B ثانيةً
  // (بصمة الملف قائمة)
  test('A (1–20) عند الجهازين، ثم العضو يحفظ B (15–31) والمالك يحذف A: سطرا B كلاهما حيّان على الجهازين', async () => {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع للمدقق V', 0);
    const A = saveStatement(p.owner, bank, stmt('01/10/2026', '20/10/2026', '0.00', [
      ['2026/10/02', 'إيداع مصطنع', '', '1,000.00', '1,000.00'],
      ['2026/10/16', 'رسوم مصطنعة', '10.00', '', '990.00'],
    ]), { name: 'a.pdf', hash: 'v4-a' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    expect(saveStatement(p.dev, bank, stmt('15/10/2026', '31/10/2026', '1,000.00', [
      ['2026/10/16', 'رسوم مصطنعة', '10.00', '', '990.00'],
      ['2026/10/25', 'حوالة مصطنعة', '', '50.00', '1,040.00'],
    ]), { name: 'b.pdf', hash: 'v4-b' })).toMatchObject({ added: 1, skipped: 1 });
    deleteStatement(p.owner, A.statementId);
    await settle(p);
    const live = (db: DB) => db.all<{ d: string }>(`SELECT date AS d FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY date`, [bank]).map((x) => x.d);
    // الصحيح: سطر 16 أكتوبر سطرٌ في B أيضاً فيبقى (يُنقل إلى B حين يصل، أو لا يُحذف ما يحتاجه كشفٌ حيّ)، والتقرير بلا فرقٍ مجهول
    expect([live(p.owner), live(p.dev)]).toEqual([['2026-10-16', '2026-10-25'], ['2026-10-16', '2026-10-25']]);
    expect(reconciliation(p.owner, bank, '2026-10').unexplained).toBe(0);
    p.close();
  });
});

describe('V٥ · [متوسط] اعتماد مطابقةٍ على جهازٍ لسطرٍ حذف المالكُ كشفَه على جهازٍ آخر يُحيي السطر وحده في كشفٍ محذوف (engine.ts statementLineCheck)', () => {
  // deleteStatement يرفض كشفاً فيه مطابَق، لكن الجهاز الثاني (بلا اتصال) يعتمد المطابقة بعد الحذف · صفّ السطر الأحدث يغلب فيعود
  // حيّاً «مطابَقاً» وكشفه محذوف: لا يظهر في قائمة الكشوف ولا يُحذف بعدها، ويبقى في التقرير بلا كشفٍ يغطيه · وstatementLineCheck
  // لا ينظر في حال الكشف
  test('المالك يحذف كشف أكتوبر، والعضو يعتمد مطابقة سطرٍ منه بعد ذلك: لا سطر حيّاً في كشفٍ محذوف على أي جهاز', async () => {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع للمدقق V', 0);
    ownerCashIn(p.owner, { amountHalalas: 500000, date: '2026-09-01' });
    depositCashToBank(p.owner, { bankId: bank, amountHalalas: 100000, date: '2026-10-02', notes: 'إيداع مصطنع' });
    const S = saveStatement(p.owner, bank, stmt('01/10/2026', '31/10/2026', '0.00', [
      ['2026/10/02', 'إيداع مصطنع', '', '1,000.00', '1,000.00'],
      ['2026/10/05', 'رسوم مصطنعة', '10.00', '', '990.00'],
    ]), { name: 'oct.pdf', hash: 'v5' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    deleteStatement(p.owner, S.statementId);
    await new Promise((res) => setTimeout(res, 5));
    for (const s of matchSuggestions(p.dev, bank)) approveMatch(p.dev, s.line.id, s.tx.id);
    await settle(p);
    const orphans = (db: DB) => Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bank_statement_lines l JOIN bank_statements s ON s.id = l.statement_id
       WHERE l.bank_id = ? AND l.deleted_at IS NULL AND s.deleted_at IS NOT NULL`, [bank])!.n);
    // الصحيح: إما يبقى السطر محذوفاً مع كشفه (وتُلغى المطابقة الواردة) وإما يعود الكشف حيّاً · لا سطر حيّ بلا كشفٍ حيّ
    expect([orphans(p.owner), orphans(p.dev)]).toEqual([0, 0]);
    p.close();
  });
});

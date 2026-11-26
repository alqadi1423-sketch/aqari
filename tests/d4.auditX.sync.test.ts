/**
 * المدقق الخارجي X · الجولة الثانية عشرة · كشف البنك في المزامنة (جهازان على الحساب نفسه بـMemoryRemote · tests/helpers/rederive.ts) ·
 * كل اختبارٍ يسقط على الشيفرة الحالية (7ef3f8e) ويصف السلوك الصحيح · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditX.sync.test.ts
 */
import { addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, deleteStatement, reconciliation } from '@/domain/bankStatement/store';
import { getMeta } from '@/repos/settings';
import type { MemoryRemote } from './helpers/memoryRemote';
import type { DB } from '@/db/adapter';

const HEAD = ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'];
const stmt = (from: string, to: string, opening: string, rows: string[][]) => {
  const r = readStatementGrid([[`الفترة من ${from} إلى ${to}`], ['الرصيد الافتتاحي', opening], HEAD, ...rows]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error);
  return r;
};
/** ما رفعه الجهاز الثاني بكاتبه العضو، ثم جولات مزامنةٍ حتى يستقر الجهازان */
async function settle(p: { owner: DB; dev: DB; r: MemoryRemote }) {
  const devId = getMeta(p.dev, 'device_id');
  const asMember = () => { for (const d of [...p.r.docs.values()]) if (d.dev === devId) p.r.inject({ ...d, by: MEMBER }); };
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  asMember();
  await ownerPulls(p.owner, p.r);
  await sync(p.dev, p.r);
  asMember();
  await ownerPulls(p.owner, p.r);
  await sync(p.dev, p.r);
}
const liveDates = (db: DB, bank: string) => db.all<{ d: string }>(
  `SELECT date AS d FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL ORDER BY date`, [bank]).map((x) => x.d);

describe('X1 · [عالٍ] إحياء السطر المحذوف في الكشف المتداخل لا ينظر هل للبصمة سطرٌ حيٌّ آخر، فيتكرر السطر على الجهازين (engine.ts:930-931 statementLineCheck وengine.ts:982-983 statementCascade)', () => {
  // إصلاح V٤: السطر المحذوف (أو الحيّ في كشفٍ محذوف) يُنقل إلى كشفٍ حيٍّ تخطّاه عند حفظه، بلا فحصٍ لسطرٍ حيٍّ بالبصمة نفسها · وstatementCascade
  // للكشف الحيّ يفحص ذلك، أما فرع الكشف المحذوف وstatementLineCheck فلا · فأشيع سببٍ لحذف كشف (حذفه ثم قراءته ثانيةً) على جهازٍ لم يصله
  // الكشف المتداخل بعد: الجهاز يحفظ سطر 16 أكتوبر من جديد (لا بصمة حيّة عنده)، ثم يُحيي جهاز المالك السطر القديم في الكشف المتداخل ويرفعه ·
  // فيصير سطر الرسوم مرتين على الجهازين، وفرقٌ «غير مفسَّر» −10 في تقرير أكتوبر · وقبل 7ef3f8e (بلا إحياء) كان الكشف بلا تكرار
  test('المالك يحفظ B (15–31) بلا اتصال، والعضو يحذف A (1–20) ويقرؤه ثانيةً: سطر 16 أكتوبر مرةً واحدة على الجهازين', async () => {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع للمدقق X', 0);
    const rowsA = [
      ['2026/10/02', 'إيداع مصطنع', '', '1,000.00', '1,000.00'],
      ['2026/10/16', 'رسوم مصطنعة', '10.00', '', '990.00'],
    ];
    const A = saveStatement(p.owner, bank, stmt('01/10/2026', '20/10/2026', '0.00', rowsA), { name: 'a.pdf', hash: 'x1-a' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    // المالك بلا اتصال يحفظ B فيتخطّى سطر 16 أكتوبر (بصمته في A)
    expect(saveStatement(p.owner, bank, stmt('15/10/2026', '31/10/2026', '1,000.00', [
      ['2026/10/16', 'رسوم مصطنعة', '10.00', '', '990.00'],
      ['2026/10/25', 'حوالة مصطنعة', '', '50.00', '1,040.00'],
    ]), { name: 'b.pdf', hash: 'x1-b' })).toMatchObject({ added: 1, skipped: 1 });
    // والعضو بلا اتصال يحذف A ويقرأ الملف نفسه ثانيةً (لا يعرف B)
    deleteStatement(p.dev, A.statementId);
    expect(saveStatement(p.dev, bank, stmt('01/10/2026', '20/10/2026', '0.00', rowsA), { name: 'a.pdf', hash: 'x1-a' })).toMatchObject({ added: 2 });
    await settle(p);
    // الواقع: ['2026-10-02', '2026-10-16', '2026-10-16', '2026-10-25'] على الجهازين، والفرق غير المفسَّر 1,000 هللة
    // الصحيح: سطرٌ واحدٌ لكل بصمة (لا يُحيا سطرٌ ولا يُنقل وللبصمة سطرٌ حيّ)، والتقرير بلا فرقٍ مجهول
    const want = ['2026-10-02', '2026-10-16', '2026-10-25'];
    expect([liveDates(p.owner, bank), liveDates(p.dev, bank)]).toEqual([want, want]);
    expect([reconciliation(p.owner, bank, '2026-10').unexplained, reconciliation(p.dev, bank, '2026-10').unexplained]).toEqual([0, 0]);
    p.close();
  });
});

describe('X2 · [متوسط] الكشف نفسه يُحفظ على جهازين قبل المزامنة فتتضاعف سطوره على كل جهاز بلا تنبيه (store.ts:24 و37 · لا فحص للبصمة في المزامنة)', () => {
  // «لا كشف ولا سطر مرتين» (DESIGN §١٣.٢٢) يفحصه saveStatement على الجهاز وحده: بصمة الملف وبصمات السطور الحيّة عنده · والمزامنة
  // (statementLineCheck وstatementCascade) لا تنظر في بصمة السطر الوارد · فموظفان يقرآن كشف أكتوبر نفسه على جهازيهما قبل أن يتزامنا (أو
  // أحدهما بلا اتصال) يجعلان الكشف كشفين وكل سطرٍ سطرين: «في الكشف وحده» مضاعف، وفرقٌ غير مفسَّر −990 في التقرير، والمطابقة «متعادلة»
  // لكل إيداع
  test('الملف نفسه على جهازي المالك والعضو بلا اتصال: بعد المزامنة سطرا الكشف مرةً واحدة، والتقرير بلا فرقٍ مجهول', async () => {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع للمدقق X', 0);
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    const oct = () => stmt('01/10/2026', '31/10/2026', '0.00', [
      ['2026/10/02', 'إيداع مصطنع', '', '1,000.00', '1,000.00'],
      ['2026/10/16', 'رسوم مصطنعة', '10.00', '', '990.00'],
    ]);
    saveStatement(p.owner, bank, oct(), { name: 'oct.pdf', hash: 'x2' });
    saveStatement(p.dev, bank, oct(), { name: 'oct.pdf', hash: 'x2' });
    await settle(p);
    // الواقع: أربعة سطور على الجهازين (كل سطرٍ مرتين)، والفرق غير المفسَّر −99,000 هللة
    // الصحيح: سطرٌ واحدٌ لكل بصمة على كل جهاز (الثاني يُتخطّى كما في الحفظ على جهازٍ واحد)، والتقرير بلا فرقٍ مجهول
    expect([liveDates(p.owner, bank), liveDates(p.dev, bank)]).toEqual([['2026-10-02', '2026-10-16'], ['2026-10-02', '2026-10-16']]);
    expect([reconciliation(p.owner, bank, '2026-10').unexplained, reconciliation(p.dev, bank, '2026-10').unexplained]).toEqual([0, 0]);
    p.close();
  });
});

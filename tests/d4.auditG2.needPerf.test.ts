/**
 * المدقق G2 · الجولة السابعة عشرة · على 3f2c136 · عدّ حركات القاعدة (statementsNeed · E2-1) يفكّ shared_keys للكشف كله بـ json_each لكل
 * سطرٍ وارد ولكل بصمةٍ في الكشف الوارد، فصار تطبيق الكشف على الأجهزة الأخرى تربيعياً في حجمه · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditG2.needPerf.test.ts
 *
 * G2-6 · متوسط · src/domain/bankStatement/dedupe.ts:83-92 (statementsNeed: «json_each(s.shared_keys) … k.value BETWEEN ? AND ?» يمرّ على
 * بصمات الكشف كلها، فلا فهرس يخدمه) مع src/sync/engine.ts:1048 (statementLineFix: لكل سطرٍ حيٍّ وارد) وengine.ts:1140-1143 و1162-1163
 * (statementCascade → dupOfLive: لكل بصمةٍ في shared_keys للكشف الحيّ الوارد):
 * كشفٌ بـ N سطراً يُطبَّق على جهازٍ آخر بنحو 2·N² قراءةً من json_each · على Node: ألف سطر نحو 0.44 ثانية، وثمانية آلاف نحو 12.2 ثانية
 * (27 ضعفاً لثمانية أضعاف الحجم)، وعلى 1185664 قبل الجولة السادسة عشرة 0.21 و1.8 ثانية (8.7 أضعاف · خطّي) · والحفظ نفسه خطّي (نحو 1.8
 * ثانية لثمانية آلاف على الجهاز القارئ)، فالكلفة كلها على كل جهازٍ يستقبل الكشف: جهاز المالك وأجهزة الأعضاء.
 * لماذا يهم: المزامنة على خيط الواجهة (Hermes وexpo-sqlite أبطأ من Node بأضعاف)، وكل صفحةٍ من ثلاثمئة مستندٍ معاملةٌ واحدة لا تفسح
 * للواجهة · كشف MT940 للمنشآت (DESIGN §١٣.٢٢) أو تصدير سنةٍ كاملة لمكتبٍ بمئات المستأجرين آلاف السطور، فيتجمّد كل جهازٍ دقيقةً أو أكثر،
 * وأول دخولٍ لجهازٍ جديد يطبّق الكشوف كلها.
 * السلوك الصحيح: عدد بصمات القاعدة في الكشف يُعرف بلا فكّ shared_keys كله لكل سطر (يُحسب مرةً للكشف، أو بفهرسٍ/جدولٍ للبصمات)، فيبقى
 * تطبيق الكشف خطّياً كما كان: ثمانية أضعاف السطور في أقل من ستة عشر ضعف الزمن (ونصف ثانيةٍ هامشاً للضجيج).
 */
import { pair, sync } from './helpers/rederive';
import { addBank } from './helpers/fixtures';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';

/** كشف شهرٍ بـ n حوالة واردة بأرصدتها (مبالغ مختلفة فلكلّ سطرٍ قاعدته) */
function month(n: number) {
  const rows: string[][] = [];
  let bal = 0;
  for (let i = 0; i < n; i++) {
    const a = 150000 + i;
    bal += a;
    rows.push([`2027/03/${String(1 + Math.floor((i * 28) / n)).padStart(2, '0')}`, 'حوالة واردة مصطنعة ' + i, '', (a / 100).toFixed(2), (bal / 100).toFixed(2)]);
  }
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'], ...rows]);
  if (!r.ok) throw new Error(r.error);
  return r;
}
/** زمن تطبيق كشفٍ بـ n سطراً على الجهاز الثاني (ملي ثانية) */
async function applyStatement(n: number): Promise<number> {
  const p = await pair();
  const bank = addBank(p.owner, 'بنك مصطنع G2-6', 0);
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  saveStatement(p.owner, bank, month(n), { name: 'mar-2027.csv', hash: 'g2-6-' + n });
  await sync(p.owner, p.r);
  const t0 = Date.now();
  await sync(p.dev, p.r);
  const ms = Date.now() - t0;
  // السطور كلها طُبّقت
  expect(Number(p.dev.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_statement_lines WHERE deleted_at IS NULL`)!.n)).toBe(n);
  p.close();
  return ms;
}

test('G2-6 · [متوسط] كشفٌ بثمانية آلاف سطر يُطبَّق على الجهاز الآخر في أقل من ستة عشر ضعف زمن كشفٍ بألف سطر', async () => {
  await applyStatement(300); // إحماء
  const small = await applyStatement(1000);
  const big = await applyStatement(8000);
  // (الواقع على Node: نحو 440 ملي ثانية لألف سطر و12,200 لثمانية آلاف)
  expect({ small, big, linear: big < 16 * small + 500 }).toEqual({ small, big, linear: true });
}, 600000);

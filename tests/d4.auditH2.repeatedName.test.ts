/**
 * المدقق H2 · الجولة السابعة عشرة · على 3f2c136 · «أقوى الأسماء الكاملة في البيان» (إصلاح F2-2) يعدّ كلمات اسم المستأجر بتكرارها لا بأعيانها:
 * من سُمّي باسم جدّه («محمد سعد محمد الحربي») يوافق «محمد» في البيان مرتين، فيصير له «اسمٌ كامل» بكلمةٍ واحدة · بياناتٌ مصطنعة كلها
 * (أسماءٌ وأرقامٌ مخترعة).
 *   TZ=Asia/Riyadh npx jest tests/d4.auditH2.repeatedName.test.ts
 *
 * H2-1 · عالٍ · src/domain/bankStatement/collect.ts:148 (hits = n.filter((w) => d.has(w)).length: كل ظهورٍ للكلمة في اسم المستأجر يُعدّ) مع
 * collect.ts:48-58 (nameTokens يُبقي الكلمة المكرّرة) وcollect.ts:151-161 (fullNames: «كاملٌ» من وافق كلمتين، والأقوى بأكثرها) وcollect.ts:163
 * (named: من في «الأقوى» وحده يأخذ درجة الاسم):
 *  أ) عمارةٌ بإيجارٍ واحد (2,500 شهرياً): المستأجر أ «محمد سعد محمد الحربي» قسطه يستحق 1 أكتوبر، والمستأجر ب «محمد سعد العتيبي» قسطه يستحق
 *     20 سبتمبر ولم يُسدَّد، وحوالةٌ يوم 2 أكتوبر بيانها «حوالة واردة من محمد سعد العتيبي» (اسم ب كاملاً) · لأ «محمد» مرتين و«سعد» = ثلاث،
 *     ولب ثلاثٌ من ثلاث، فيتعادلان «أقوى» ويأخذ كلاهما درجة الاسم، وقرب الاستحقاق يجعل أ 90 «جاهزاً» ولا اقتراح لب · وأ نفسه بلا جدٍّ
 *     سميّ («محمد سعد الحربي») لا يأخذ شيئاً (الضابط).
 *  ب) البيان «حوالة واردة من محمد» وحده، وب «محمد فهد العتيبي» قسطه يستحق 1 أكتوبر كأ: لأ «اسمٌ كامل» بكلمةٍ واحدة فيُسقط اسمَ ب الأول
 *     (D2-2: من وافق اسمُه الأول وحده لا يأخذ درجة الاسم إن وُجد اسمٌ كامل)، فأ 90 «جاهز» بلا منافس · وبلا الجدّ السميّ يتعادلان فيُراجعان.
 * لماذا يهم: تسمية الابن باسم جدّه هي الغالبة في المملكة، و«محمد» أشيع الأسماء؛ و«اعتماد الجاهزة» يسجّل مال ب سداداً لقسط أ، فمن دفع
 * «متأخر» ومن لم يدفع «مسدِّد» (كـD2-2 وF2-2) · وقرار المالك ج.١ «بدرجة ثقة وسببها» وDESIGN §١٣.٢٢ «فالجاهز يحتاج ما يعرّف صاحبه».
 * السلوك الصحيح: الاسم يُوافَق بكلماته المختلفة لا بتكرارها («محمد» كلمةٌ واحدة ولو تكررت في الاسم): في (أ) اسم ب الكامل هو الأقوى فلا
 * «جاهز» لأ، وفي (ب) لا اسم كاملاً لأحد فيتعادلان بالاسم الأول ولا «جاهز» · كما يحدث تماماً حين لا يتكرر اسم الجدّ.
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';

function world(a: { name: string; start: string }, b: { name: string; start: string }, descr: string) {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع H2-1', 0);
  const p = addProperty(db, { name: 'عمارة مصطنعة H2-1' });
  const ca = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'H2-1A' }), {
    tenant: a.name, idNumber: '1000000981', phone: '0500000981', valueHalalas: 3000000, cycle: 'شهرية',
    start: a.start, end: '2027-09-30', depositHalalas: 0,
  }));
  const cb = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'H2-1B' }), {
    tenant: b.name, idNumber: '1000000982', phone: '0500000982', valueHalalas: 3000000, cycle: 'شهرية',
    start: b.start, end: '2027-09-19', depositHalalas: 0,
  }));
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', descr, '', '2,500.00', '2,500.00']]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); // i18n-exempt: رسالة اختبار
  saveStatement(db, bank, r, { name: 'oct-h2-1.csv', hash: 'h2-1' });
  const who = (id: string) => (id === ca ? 'أ' : id === cb ? 'ب' : '?');
  const out = collectionSuggestions(db, bank).map((s) => ({
    to: s.target.kind === 'installments' ? who(s.target.contractId) : s.target.kind, level: s.level, score: s.score, reasons: s.reasons,
  }));
  db.close();
  return out;
}
const ready = (xs: ReturnType<typeof world>) => xs.filter((s) => s.level === 'ready');

describe('H2-1 · [عالٍ] اسم الجدّ السميّ يُعدّ كلمتين فيصير للمستأجر «اسمٌ كامل» بكلمةٍ واحدة ويأخذ الإيداع «جاهزاً» (collect.ts:148 و151-163)', () => {
  const B = { name: 'محمد سعد العتيبي', start: '2026-09-20' };

  test('الضابط (أ): أ «محمد سعد الحربي» بلا جدٍّ سميّ: حوالة «محمد سعد العتيبي» تُقترح لب باسمه ولا شيء لأ', () => {
    const out = world({ name: 'محمد سعد الحربي', start: '2026-10-01' }, B, 'حوالة واردة من محمد سعد العتيبي');
    expect(out.map((s) => [s.to, s.level, s.reasons.includes('name')])).toEqual([['ب', 'review', true]]);
  });

  test('(أ) أ «محمد سعد محمد الحربي»: حوالة «محمد سعد العتيبي» (اسم ب كاملاً) لا تكون «جاهزة» لقسط أ', () => {
    // (الواقع: [{ to: 'أ', level: 'ready', score: 90, reasons: ['amount', 'date', 'name'] }] ولا اقتراح لب)
    expect(ready(world({ name: 'محمد سعد محمد الحربي', start: '2026-10-01' }, B, 'حوالة واردة من محمد سعد العتيبي'))).toEqual([]);
  });

  test('الضابط (ب): «حوالة واردة من محمد» ومستأجران اسمهما الأول «محمد» بلا جدٍّ سميّ: يتعادلان فلا «جاهز»', () => {
    expect(ready(world({ name: 'محمد سعد الحربي', start: '2026-10-01' }, { name: 'محمد فهد العتيبي', start: '2026-10-01' }, 'حوالة واردة من محمد'))).toEqual([]);
  });

  test('(ب) «حوالة واردة من محمد» وأ «محمد سعد محمد الحربي»: لا «جاهز» لأ باسمٍ أوله «محمد» كاسم ب', () => {
    // (الواقع: [{ to: 'أ', level: 'ready', score: 90, reasons: ['amount', 'date', 'name'] }])
    expect(ready(world({ name: 'محمد سعد محمد الحربي', start: '2026-10-01' }, { name: 'محمد فهد العتيبي', start: '2026-10-01' }, 'حوالة واردة من محمد'))).toEqual([]);
  });
});

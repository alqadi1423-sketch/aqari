/**
 * المدقق F2 · الجولة السادسة عشرة · على 50556c3 · «من حمل البيانُ اسمه كاملاً هو الدافع» (إصلاح D2-2) لا يمنع أخاه أو أباه في العمارة
 * نفسها من درجة الاسم: يكفيهما اسم الأب والعائلة المشتركان · بياناتٌ مصطنعة كلها (أسماءٌ وأرقامٌ مخترعة).
 *   TZ=Asia/Riyadh npx jest tests/d4.auditF2.siblingName.test.ts
 *
 * F2-2 · عالٍ · src/domain/bankStatement/collect.ts:153 (named: «hits(d, n) >= 2» يكفي وحده أياً كان من حمل البيانُ اسمه كاملاً، والأسبقية
 * «full» لا تُفحص إلا لمن وافق اسمُه الأول وحده) مع collect.ts:146-151 (fullNames: كل طرفٍ وافقت منه كلمتان «اسمٌ كامل»، فالأخ بأبيه وعائلته
 * «كامل» كالدافع) وcollect.ts:219-232 (المنافس من يقلّ عن الأعلى بخمسٍ فأقل): عمارةٌ بإيجارٍ واحد (2,500 شهرياً) · المستأجر أ «سعد فهد
 * القحطاني» قسطه يستحق 1 أكتوبر، وأخوه ب «محمد فهد القحطاني» قسطه يستحق 20 سبتمبر ولم يُسدَّد · وحوالةٌ يوم 2 أكتوبر بيانها «حوالة واردة
 * من محمد فهد القحطاني» بمبلغ 2,500 · فاسم ب كاملاً في البيان (ثلاث كلماتٍ من ثلاث)، ولأ منه «فهد» و«القحطاني» (كلمتان) واسمه الأول
 * «سعد» غائب · فيأخذ أ درجة الاسم: أ = 50 + 20 (يومٌ واحد) + 20 = 90، وب = 50 + 10 (12 يوماً) + 20 = 80، فلا تنازع (الفرق 10) ·
 * «جاهزٌ للاعتماد» لقسط أ ولا شيء لب، و«اعتماد الجاهزة» يسجّل مال ب سداداً لأخيه · ومثله الأب «فهد سعد القحطاني» مستأجراً.
 * لماذا يهم: الأقارب في عمارةٍ واحدة بالإيجار نفسه شائعٌ في المملكة، والإخوة يشتركون في اسم الأب والعائلة دائماً؛ والاسم هو ما يعرّف الدافع
 * حين لا يفرّق المبلغ (DESIGN §١٣.٢٢ «فالجاهز يحتاج ما يعرّف صاحبه» · قرار المالك ج.١ «بدرجة ثقة وسببها») · والنتيجة كـD2-2: من لم
 * يدفع «مسدِّد» ومن دفع «متأخر».
 * السلوك الصحيح: البيان الذي فيه اسم مستأجرٍ آخر كاملاً لا يكون «جاهزاً» لمن غاب اسمه الأول عنه ووافقه في اسم الأب والعائلة وحدهما ·
 * (تنبيه المدقق: نصّ W5 «اسم المستأجر الأول أو اسمان منه» يجيز حرفياً درجة الاسم لأ هنا، وقرار سجل القرارات ٦٤ (٤) نصّه «الاسم الأول وحده»؛
 * فالمطلوب مدّ أسبقية الاسم الكامل إلى «اسم الأب والعائلة» حين يكون في البيان اسمٌ كامل لطرفٍ آخر، ولا يتغيّر W5 حين لا اسم كاملاً لغيره.)
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';

function world(relative: string | null) {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع F2-2', 0);
  const p = addProperty(db, { name: 'عمارة مصطنعة F2-2' });
  const a = relative ? confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'F2-A' }), {
    tenant: relative, idNumber: '1000000951', phone: '0500000951', valueHalalas: 3000000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  })) : null;
  const b = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'F2-B' }), {
    tenant: 'محمد فهد القحطاني', idNumber: '1000000952', phone: '0500000952', valueHalalas: 3000000, cycle: 'شهرية',
    start: '2026-09-20', end: '2027-09-19', depositHalalas: 0,
  }));
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة من محمد فهد القحطاني', '', '2,500.00', '2,500.00']]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); // i18n-exempt: رسالة اختبار
  saveStatement(db, bank, r, { name: 'oct-f2-2.csv', hash: 'f2-2' });
  const who = (id: string) => (id === a ? 'أ' : id === b ? 'ب' : '?');
  const out = collectionSuggestions(db, bank).map((s) => ({
    to: s.target.kind === 'installments' ? who(s.target.contractId) : s.target.kind, level: s.level, score: s.score, reasons: s.reasons,
  }));
  db.close();
  return out;
}

describe('F2-2 · [عالٍ] أخو الدافع أو أبوه في العمارة نفسها يأخذ درجة الاسم باسم الأب والعائلة فيصير الإيداع «جاهزاً» لقسطه (collect.ts:146-153)', () => {
  test('الضابط: بلا قريبٍ مستأجر، الإيداع يُقترح لقسط ب باسمه', () => {
    expect(world(null).map((s) => [s.to, s.reasons.includes('name')])).toEqual([['ب', true]]);
  });

  test('الأخ «سعد فهد القحطاني»: حوالة «محمد فهد القحطاني» لا تكون «جاهزة» لقسطه', () => {
    // (الواقع: [{ to: 'أ', level: 'ready', score: 90, reasons: ['amount', 'date', 'name'] }] ولا اقتراح لب)
    expect(world('سعد فهد القحطاني').filter((s) => s.to === 'أ' && s.level === 'ready')).toEqual([]);
  });

  test('الأب «فهد سعد القحطاني»: حوالة ابنه لا تكون «جاهزة» لقسطه', () => {
    // (الواقع: [{ to: 'أ', level: 'ready', score: 90, reasons: ['amount', 'date', 'name'] }])
    expect(world('فهد سعد القحطاني').filter((s) => s.to === 'أ' && s.level === 'ready')).toEqual([]);
  });
});

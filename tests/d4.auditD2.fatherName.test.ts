/**
 * المدقق D2 · الجولة الخامسة عشرة · على f5036b1 · «الاسم في البيان» في اقتراحات التحصيل يكفيه أن يقع اسم المستأجر الأول في أي موضعٍ من
 * البيان، فاسم أبي الدافع يُعدّ اسمَ مستأجرٍ آخر · بياناتٌ مصطنعة كلها (أسماءٌ وأرقامٌ مخترعة).
 *   TZ=Asia/Riyadh npx jest tests/d4.auditD2.fatherName.test.ts
 *
 * D2-2 · عالٍ · src/domain/bankStatement/collect.ts:136 (named: n[0] في كلمات البيان، أينما وقعت) مع collect.ts:152-154 (الاسم +20 ثنائيٌّ لا
 * يفرّق بين كلمةٍ واحدة والاسم كاملاً) وcollect.ts:203-204 (المنافس من يقلّ عن الأعلى بخمسٍ فأقل): عمارةٌ بإيجارٍ واحد (2,500 شهرياً) ·
 * المستأجر أ «فهد عبدالله العتيبي» قسطه يستحق 1 أكتوبر، والمستأجر ب «محمد فهد القحطاني» قسطه يستحق 20 سبتمبر ولم يُسدَّد · وحوالةٌ
 * يوم 2 أكتوبر بيانها «حوالة واردة من محمد فهد القحطاني» بمبلغ 2,500 · فاسم ب كاملاً في البيان (ثلاث كلماتٍ من ثلاث)، و«فهد» فيه اسم أبيه ·
 * لكن «فهد» اسم أ الأول فيُعدّ «الاسم» لأ أيضاً: أ = 50 + 20 (يومٌ واحد) + 20 = 90، وب = 50 + 10 (12 يوماً) + 20 = 80، والفرق 10 فلا
 * «تنازع» · فيُقترح الإيداع «جاهزاً للاعتماد» (90) لقسط أ وحده ولا يظهر لب شيء، و«اعتماد الجاهزة» يسجّل مال ب سداداً لأ.
 * لماذا يهم: الإيجار الواحد في العمارة يجعل المبلغ لا يفرّق، والاسم هو ما يعرّف الدافع (DESIGN §١٣.٢٢ «فالجاهز يحتاج ما يعرّف صاحبه» · W٥) · والاسم الأول في المملكة
 * اسم أبٍ لكثيرين (محمد وفهد وعبدالله وسعد…)، فالتقاء الاسم الأول لمستأجرٍ باسم أبي مستأجرٍ آخر معتاد · والنتيجة أ «مسدِّد» وهو لم يدفع
 * (فلا تُتابَع متأخراته)، وب «متأخر» وقد دفع.
 * السلوك الصحيح: البيان الذي فيه اسم مستأجرٍ آخر كاملاً لا يكون «جاهزاً» لمن وافق اسمُه الأول كلمةً فيه وحدها · (تبقى قاعدة W٥ كما هي:
 * «حوالة واردة سالم» لقسط «سالم المصطنع» وحده جاهزة · tests/d6.bankStatementCollect.test.ts)
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';

function world(withA: boolean) {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع D2-2', 0);
  const p = addProperty(db, { name: 'عمارة مصطنعة D2-2' });
  const a = withA ? confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'D2-A' }), {
    tenant: 'فهد عبدالله العتيبي', idNumber: '1000000921', phone: '0500000921', valueHalalas: 3000000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  })) : null;
  const b = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'D2-B' }), {
    tenant: 'محمد فهد القحطاني', idNumber: '1000000922', phone: '0500000922', valueHalalas: 3000000, cycle: 'شهرية',
    start: '2026-09-20', end: '2027-09-19', depositHalalas: 0,
  }));
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة من محمد فهد القحطاني', '', '2,500.00', '2,500.00']]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); // i18n-exempt: رسالة اختبار
  saveStatement(db, bank, r, { name: 'oct-d2-2.csv', hash: 'd2-2' });
  const who = (id: string) => (id === a ? 'أ' : id === b ? 'ب' : '?');
  const out = collectionSuggestions(db, bank).map((s) => ({
    to: s.target.kind === 'installments' ? who(s.target.contractId) : s.target.kind, level: s.level, score: s.score, reasons: s.reasons,
  }));
  const dueB = db.get<{ d: string }>(`SELECT MIN(due_date) AS d FROM contract_installments WHERE contract_id = ?`, [b])!.d;
  db.close();
  return { out, dueB };
}

describe('D2-2 · [عالٍ] اسم أبي الدافع يوافق اسم مستأجرٍ آخر الأول فيصير الإيداع «جاهزاً» لقسط من لم يدفع (collect.ts:136 و152)', () => {
  test('الضابط: بلا المستأجر أ، الإيداع يُقترح لقسط ب (20 سبتمبر) باسمه', () => {
    const w = world(false);
    expect(w.dueB).toBe('2026-09-20');
    expect(w.out.map((s) => [s.to, s.reasons.includes('name')])).toEqual([['ب', true]]);
  });

  test('ومع المستأجر أ «فهد …»: حوالة «محمد فهد القحطاني» لا تكون «جاهزة» لقسط أ', () => {
    const w = world(true);
    // (الواقع: [{ to: 'أ', level: 'ready', score: 90, reasons: ['amount', 'date', 'name'] }] ولا اقتراح لب)
    expect(w.out.filter((s) => s.to === 'أ' && s.level === 'ready')).toEqual([]);
  });
});

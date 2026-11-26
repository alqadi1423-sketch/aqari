/**
 * المدقق D2 · الجولة الخامسة عشرة · على f5036b1 · «أقساطٌ متتالية بتحويلٍ واحد» لا تُقترح لمستأجرٍ متأخرٍ يسدّد متأخراته: نافذة الـ٤٥ يوماً
 * تُقاس من استحقاق أقدم قسطٍ في المتتالية لا من آخرها · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditD2.arrearsRun.test.ts
 *
 * D2-11 · منخفض · src/domain/bankStatement/collect.ts:114-115 (يوم القالب = استحقاق run[0] أي أقدم القائم) وcollect.ts:121-124 مع
 * collect.ts:128 و150 (النافذة ±45 يوماً حول ذلك اليوم): عقدٌ شهري بـ1,000 من 1 أغسطس لم يُسدَّد منه شيء، والمستأجر يحوّل 3,000 يوم 3
 * أكتوبر باسمه (أغسطس وسبتمبر وأكتوبر) · المتتالية [أغسطس، سبتمبر، أكتوبر] مجموعها 3,000 لكن يومها 1 أغسطس وبينه وبين السطر 63 يوماً فلا
 * تُقترح، ولا قسط واحد بالمبلغ، فلا اقتراح أصلاً · ومثله قسطان (سبتمبر وأكتوبر) يُسدَّدان يوم 20 أكتوبر (49 يوماً) · أما التحويل نفسه مقدَّماً
 * يوم 3 أغسطس فيُقترح.
 * لماذا يهم: قرار المالك ج.٢ «تحويلٌ واحد لعدة أقساط» (DESIGN §١٣.٢٢: «حتى اثني عشر»)، وأشيع صوره في العقار سداد المتأخر دفعةً واحدة؛
 * فالمتتالية لا تُقترح إلا لمن يدفع مقدَّماً، والنافذة تجعل «حتى اثني عشر» لا يقع إلا مقدَّماً.
 * السلوك الصحيح: المتتالية من أقدم القائم تُقترح لإيداعٍ بمجموعها قريبٍ من استحقاق آخرها (أو بينه وبين أقدمها) · (يخالف هذا نصّ
 * DESIGN «أقدم القائم والمتتالية منه بنافذة ٤٥ يوماً» إن كانت النافذة تُقاس من الأقدم؛ ولا يخالف «المتتالية تبدأ بأقدم القائم».)
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';

function suggest(date: string, amount: string) {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع D2-11', 0);
  const p = addProperty(db, { name: 'عمارة مصطنعة D2-11' });
  const c = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'D2-11' }), {
    tenant: 'نايف المصطنع', idNumber: '1000000931', phone: '0500000931', valueHalalas: 1200000, cycle: 'شهرية',
    start: '2026-08-01', end: '2027-07-31', depositHalalas: 0,
  }));
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    [date, 'حوالة واردة من نايف المصطنع', '', amount, amount]]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); // i18n-exempt: رسالة اختبار
  saveStatement(db, bank, r, { name: 'd2-11.csv', hash: 'd2-11-' + date });
  const due = new Map(db.all<{ id: string; d: string }>(`SELECT id, due_date AS d FROM contract_installments WHERE contract_id = ?`, [c]).map((x) => [x.id, x.d]));
  const out = collectionSuggestions(db, bank).map((s) => (s.target.kind === 'installments' && s.target.contractId === c ? s.target.installmentIds.map((i) => due.get(i)) : s.target.kind));
  db.close();
  return out;
}

describe('D2-11 · [منخفض] سداد المتأخر بتحويلٍ واحد لا يُقترح: نافذة المتتالية من أقدم قسطٍ فيها (collect.ts:114-115 و128)', () => {
  test('الضابط: ثلاثة أقساطٍ مقدَّماً يوم 3 أغسطس تُقترح متتاليةً', () => {
    expect(suggest('2026/08/03', '3,000.00')).toEqual([['2026-08-01', '2026-09-01', '2026-10-01']]);
  });

  test('أغسطس وسبتمبر وأكتوبر متأخرةً تُسدَّد يوم 3 أكتوبر: تُقترح المتتالية', () => {
    // (الواقع: [] لا اقتراح)
    expect(suggest('2026/10/03', '3,000.00')).toEqual([['2026-08-01', '2026-09-01', '2026-10-01']]);
  });
});

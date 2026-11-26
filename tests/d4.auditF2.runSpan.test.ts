/**
 * المدقق F2 · الجولة السادسة عشرة · على 50556c3 · فهرس «الأقساط المتتالية بمداها» (إصلاح D2-11) يبحث عن المتتالية بأقدم استحقاقٍ فيها إلى
 * 400 يومٍ قبل السطر وحدها، فالمتتالية التي تجاوز مداها سنةً (عقدٌ نصف سنوي أو ربع سنوي أو سنوي متأخرٌ سنة) لا تُقترح وإن وقع السطر في مداها
 * المعلن · بياناتٌ مصطنعة كلها (أسماءٌ وأرقامٌ مخترعة).
 *   TZ=Asia/Riyadh npx jest tests/d4.auditF2.runSpan.test.ts
 *
 * F2-8 · منخفض · src/domain/bankStatement/collect.ts:130 (RUN_SPAN = 400: «أطول مدى متتاليةٍ بأيامها (اثنا عشر قسطاً شهرياً) مع نافذتها») مع
 * collect.ts:177 (البحث يبدأ بالمتتاليات التي أقدم استحقاقها ≥ يوم السطر − 400) وcollect.ts:179 (المدى المعلن: من 45 يوماً قبل أقدمها إلى 45
 * بعد آخرها) وcollect.ts:124 (حتى اثني عشر قسطاً أياً كانت دورة العقد): عقدٌ نصف سنوي بـ15,000 للقسط، أقساط 1 يوليو 2025 و1 يناير 2026 و1
 * يوليو 2026 لم يُسدَّد منها شيء، والمستأجر يحوّل 45,000 باسمه · يوم 4 أغسطس 2026 (399 يوماً بعد أقدمها) تُقترح المتتالية، ويوم 10 أغسطس
 * (405 أيام، وقبل نهاية المدى المعلن 15 أغسطس) لا يُقترح شيء.
 * لماذا يهم: قرار المالك ج.٢ «حوالة لعدة أقساط» وDESIGN §١٣.٢٢ «حتى اثني عشر» وD2-11 «فسداد المتأخرات يُقترح»؛ والدفع نصف السنوي والربع
 * السنوي أشيع دورات الإيجار السكني، واثنا عشر قسطاً ربع سنوي ثلاث سنوات · والحدّ مبنيٌّ على الشهري وحده.
 * السلوك الصحيح: المتتالية تُقترح لسطرٍ في مداها المعلن أياً كانت دورة العقد: الإيداع يوم 10 أغسطس يُقترح للأقساط الثلاثة كما يوم 4 أغسطس.
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';

function suggestedFor(day: string) {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع F2-8', 0);
  const p = addProperty(db, { name: 'عمارة مصطنعة F2-8' });
  const c = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'F2-8' }), {
    tenant: 'سالم مصطنع الحربي', idNumber: '1000000961', phone: '0500000961', valueHalalas: 6000000, cycle: 'نصف سنوية',
    start: '2025-07-01', end: '2027-06-30', depositHalalas: 0,
  }));
  const dues = db.all<{ d: string }>(`SELECT due_date AS d FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 3`, [c]).map((x) => x.d);
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    [day, 'حوالة واردة من سالم مصطنع الحربي', '', '45,000.00', '45,000.00']]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); // i18n-exempt: رسالة اختبار
  saveStatement(db, bank, r, { name: 'f2-8.csv', hash: 'f2-8-' + day });
  const out = collectionSuggestions(db, bank).map((s) => (s.target.kind === 'installments' ? s.target.installmentIds.length : s.target.kind));
  db.close();
  return { dues, out };
}

describe('F2-8 · [منخفض] متتاليةٌ مداها فوق سنة (دورةٌ غير شهرية) لا تُقترح بعد 400 يومٍ من أقدمها وإن وقع السطر في مداها (collect.ts:130 و177)', () => {
  test('الضابط: الأقساط الثلاثة القائمة، وإيداع 4 أغسطس 2026 يُقترح لها', () => {
    expect(suggestedFor('2026/08/04')).toEqual({ dues: ['2025-07-01', '2026-01-01', '2026-07-01'], out: [3] });
  });

  test('إيداع 10 أغسطس 2026 (40 يوماً بعد آخرها، قبل نهاية مداها 15 أغسطس) يُقترح لها كذلك', () => {
    // (الواقع: { dues: [...], out: [] })
    expect(suggestedFor('2026/08/10').out).toEqual([3]);
  });
});

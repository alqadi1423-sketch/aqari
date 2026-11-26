/**
 * المدقق W · الجولة الحادية عشرة · «جاهزة للاعتماد» بتعريفٍ زائف لصاحب الإيداع · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditW.suggestIdentity.test.ts
 *
 * DESIGN §١٣.٢٢: «فالجاهز يحتاج ما يعرّف صاحبه (اسماً أو رقماً)» · والجاهز يُعتمد جملةً بـ«اعتماد الجاهزة» فيُسجَّل التحصيل لمستأجرٍ
 * بعينه ويُطابَق الإيداع به.
 *
 * W4 · متوسط · src/domain/bankStatement/collect.ts:42-45 (sharesNumber): «الرقم المشترك» كل أربعة أرقامٍ فأكثر في رقم العقد · ورقم
 * العقد EJ-2026-001 (contracts/rules.ts: nextContractNo) جزؤه الوحيد بأربعة أرقام هو السنة، وتسلسله «001» دون الأربعة فلا يُقرأ أبداً ·
 * فكل إيداعٍ في بيانه «2026» (تاريخٌ في وصف الحوالة، أو رقم فاتورةٍ أخرى INV-2026-…) يأخذ +15 «مرجع» لكل عقدٍ في السنة، فيصير «جاهزاً»
 * بلا اسمٍ ولا رقمٍ يعرّف صاحبه.
 * السلوك الصحيح: السنة المشتركة ليست رقم العقد · الإيداع بلا اسمٍ ولا رقمٍ مميِّز «تحتاج مراجعة» لا «جاهزة»، وسببه بلا «ref».
 *
 * W5 · متوسط · src/domain/bankStatement/collect.ts:36-41 (nameWords وsharesName): كل كلمةٍ من ثلاثة أحرفٍ فأكثر من اسم المستأجر تكفي
 * «اسماً» (+20)، ومنها «عبد» صدرُ الاسم المركّب (عبد الله، عبد الرحمن…) · والتعليق يَعِد باستبعاد الأوصاف الشائعة ولا يستبعد شيئاً ·
 * فحوالةٌ من «عبد الرحمن» (ليس مستأجراً) تُقترح «جاهزة» بسبب «الاسم» لقسط المستأجر «عبد الله الحربي».
 * السلوك الصحيح: «عبد» وحده لا يعرّف أحداً: الاقتراح «تحتاج مراجعة» بلا سبب «name».
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';

function setup(tenant: string, line: string[]) {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع W4', 0);
  const prop = addProperty(db, { name: 'عقار مصطنع W4' });
  const c = confirmContract(db, contractInput(addUnit(db, prop, { unit_no: 'W4-1' }), {
    tenant, idNumber: '1000000941', phone: '0500000941', valueHalalas: 1440000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'], line]);
  if (!r.ok) throw new Error(r.error);
  saveStatement(db, bank, r, { name: 'w4-oct.csv', hash: 'w4' });
  return { db, bank, c };
}

describe('W4 · السنة في رقم العقد تُعدّ «رقماً مشتركاً»', () => {
  test('حوالةٌ بلا اسمٍ في بيانها تاريخٌ من 2026 لا تصير «جاهزة» لعقد EJ-2026-001 بسبب «ref»', () => {
    const s = setup('سالم الدوسري', ['2026/10/03', 'حوالة سريع واردة 03/10/2026', '', '1,200.00', '1,200.00']);
    expect(s.db.get<{ no: string }>(`SELECT contract_no AS no FROM contracts WHERE id = ?`, [s.c])!.no).toBe('EJ-2026-001');
    const [sg] = collectionSuggestions(s.db, s.bank);
    // الواقع: ready · 90 · [amount, date, ref, unique]
    expect({ level: sg.level, ref: sg.reasons.includes('ref') }).toEqual({ level: 'review', ref: false });
    s.db.close();
  });
});

describe('W5 · «عبد» صدر الاسم المركّب يُعدّ اسماً مشتركاً', () => {
  test('حوالةٌ من «عبد الرحمن» لا تُقترح «جاهزة» بسبب «الاسم» لقسط «عبد الله الحربي»', () => {
    const s = setup('عبد الله الحربي', ['2026/10/02', 'حوالة واردة عبد الرحمن', '', '1,200.00', '1,200.00']);
    const [sg] = collectionSuggestions(s.db, s.bank);
    // الواقع: ready · 95 · [amount, date, name, unique]
    expect({ level: sg.level, name: sg.reasons.includes('name') }).toEqual({ level: 'review', name: false });
    s.db.close();
  });
});

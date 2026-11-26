/**
 * المدقق الخارجي V · الجولة الحادية عشرة · كشف البنك · مطابقة الإيداع بالتحصيل (src/domain/bankStatement/collect.ts · قرار المالك
 * 2026-10-09 ج.١ وج.٢ وج.٧ · DESIGN §١٣.٢٢: «فالجاهز يحتاج ما يعرّف صاحبه (اسماً أو رقماً)») · كل اختبارٍ يسقط على الشيفرة الحالية
 * ويصف السلوك الصحيح · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditV.collect.test.ts
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';

describe('V٦ · [عالٍ] كلمةٌ عامة يشترك فيها البيان واسم المستأجر («شركة» أو «عبد») تُحسب «اسماً» فيصير الاقتراح «جاهزاً» لمستأجرٍ آخر (collect.ts:38)', () => {
  // nameWords يأخذ كل كلمةٍ من ثلاثة أحرفٍ فأكثر بلا استثناء (وتعليقه يقول «بلا «المصطنع» وأمثاله من الأوصاف الشائعة»): فـ«شركة» في
  // «حوالة من شركة الريان» تطابق المستأجر «شركة الأفق»، و«عبد» في «عبد الرحمن» تطابق «عبد الله» · +20 فوق منافسيه بالإيجار نفسه فلا
  // «تعادل»، فيصير 90 «جاهزاً للاعتماد» ويُعتمد بـ«اعتماد الجاهزة» قسطاً لمستأجرٍ لم يدفع، ويبقى من دفع مديناً
  test('ثلاث وحداتٍ بإيجارٍ واحد (1,500)، وإيداعان من دافعَين ليسا من المستأجرين: لا «جاهز» ولا سبب «الاسم»', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع للمدقق V', 0);
    const p = addProperty(db, { name: 'عقار مصطنع للمدقق V' });
    ['شركة الأفق للتجارة', 'عبد الله الشهري', 'نادر الحربي'].forEach((tenant, i) => confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'V-' + i }), {
      tenant, idNumber: '100000060' + i, phone: '050000060' + i, valueHalalas: 1800000, cycle: 'شهرية', start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    })));
    const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/02', 'حوالة واردة من شركة الريان للمقاولات', '', '1,500.00', '1,500.00'],
      ['2026/10/03', 'حوالة واردة من عبد الرحمن القرني', '', '1,500.00', '3,000.00']]);
    if (!r.ok) throw new Error(r.error);
    saveStatement(db, bank, r, { name: 'oct.pdf', hash: 'v6' });
    const s = collectionSuggestions(db, bank);
    // الصحيح: «شركة» و«عبد» وأمثالهما لا تعرّف الدافع، فالاقتراح بالمبلغ والتاريخ وحدهما «يحتاج مراجعة» بين ثلاثة مستأجرين متساوين
    expect(s.length).toBeGreaterThan(0);
    expect(s.filter((x) => x.level === 'ready' || x.reasons.includes('name')).map((x) => x.line.descr)).toEqual([]);
  });
});

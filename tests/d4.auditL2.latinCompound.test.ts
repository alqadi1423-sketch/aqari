/**
 * المدقق L2 · الجولة التاسعة عشرة · على 5c203a6 · صدور الأسماء المركّبة «عبد» و«أبو» تُضمّ إلى ما بعدها بالعربية وحدها؛ فالاسم المكتوب بالحروف
 * اللاتينية («Abdul Rahman» و«Abu Bakr»، كما تكتبه بيانات الحوالات الإنجليزية ويُدخَل به اسم المستأجر الوافد) صدرُه وحده اسمه الأول ·
 * بياناتٌ مصطنعة كلها (أسماءٌ وأرقامٌ مخترعة).
 *   TZ=Asia/Riyadh npx jest tests/d4.auditL2.latinCompound.test.ts
 *
 * L2-3 · متوسط · src/domain/bankStatement/collect.ts:39 (NAME_PREFIX: «عبد» و«ابو» و«ام» بالعربية وحدها) وcollect.ts:54-58 (nameTokens: «abdul»
 * و«abu» كلمتان مستقلتان) مع collect.ts:167 (named: الاسم الأول في كلمات البيان، ولا اسم كاملاً): عقدٌ بإيجار 2,500 شهرياً لمستأجرٍ مسجَّلٍ
 * «Abdul Rahman Khan»، وحوالةٌ يوم 2 أكتوبر بالمبلغ نفسه:
 *  أ) من غيره «TRANSFER FROM ABDUL KAREEM SHAH»: درجة الاسم لأن «abdul» اسمه الأول، فهي 95 «جاهزة» (والبيان نفسه بالعربية «عبد الكريم شاه»
 *     لمستأجرٍ «عبد الرحمن خان» 75 «تحتاج مراجعة»: الضابط) · وكذلك «Abu Bakr Siddiqui» وحوالة «ABU HASSAN».
 *  ب) منه بكتابة البنك الموصولة «TRANSFER FROM ABDULRAHMAN KHAN»: لا درجة اسم («abdul» ليست في البيان، و«khan» العائلة وحدها) فهي 75.
 * لماذا يهم: هذا خلل W5 نفسه («عبد» وحدها كانت اسماً مشتركاً) وH2-2 (الموصول والمفصول اسمٌ واحد) بالحروف اللاتينية: «Abdul» و«Abu» صدرُ
 * آلاف الأسماء، وحوالات «سريع» تكتب اسم المحوِّل بالإنجليزية كثيراً، ومستأجرو العقار الوافدون تُكتب أسماؤهم بها · و«اعتماد الجاهزة» يسجّل
 * مال غيره سداداً لقسطه (كـD2-2)، ويُترك صاحب الإيداع بلا اسمه.
 * السلوك الصحيح (W5 وH2-2 · DESIGN §١٣.٢٢ «الصدر المركّب عبد وأبو مع ما بعده»): «Abdul/Abd/Abu» مع ما بعده اسمٌ واحد مفصولاً أو موصولاً كما
 * بالعربية: (أ) 75 «تحتاج مراجعة» بلا درجة اسم، و(ب) 95 «جاهزة» بالاسم.
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';

function suggest(tenant: string, descr: string) {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع L2-3', 0);
  const p = addProperty(db, { name: 'عمارة مصطنعة L2-3' });
  confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'L2-3A' }), {
    tenant, idNumber: '2000000193', phone: '0500000193', valueHalalas: 3000000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const r = readStatementGrid([['Opening Balance', '0.00'], ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
    ['02/10/2026', descr, '', '2,500.00', '2,500.00']]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); // i18n-exempt: رسالة اختبار
  saveStatement(db, bank, r, { name: 'oct-l2-3.csv', hash: 'l2-3' });
  const out = collectionSuggestions(db, bank).map((s) => [s.score, s.level, s.reasons.includes('name')]);
  db.close();
  return out;
}

describe('L2-3 · [متوسط] «Abdul» و«Abu» بالحروف اللاتينية اسمٌ أول وحدها فيصير إيداع غير المستأجر «جاهزاً» ولا يُعرف المستأجر بكتابة البنك (collect.ts:39 و54-58)', () => {
  test('الضابط: بالعربية «عبد الكريم شاه» لا يأخذ درجة الاسم لـ«عبد الرحمن خان»', () => {
    expect(suggest('عبد الرحمن خان', 'حوالة واردة من عبد الكريم شاه')).toEqual([[75, 'review', false]]);
  });

  test('أ) «ABDUL KAREEM SHAH» لا يأخذ درجة الاسم لـ«Abdul Rahman Khan»، ولا «ABU HASSAN» لـ«Abu Bakr Siddiqui»', () => {
    // (الواقع: [[[95, 'ready', true]], [[95, 'ready', true]]])
    expect([
      suggest('Abdul Rahman Khan', 'TRANSFER FROM ABDUL KAREEM SHAH'),
      suggest('Abu Bakr Siddiqui', 'SARIE TRANSFER ABU HASSAN'),
    ]).toEqual([[[75, 'review', false]], [[75, 'review', false]]]);
  });

  test('ب) «ABDULRAHMAN KHAN» (كتابة البنك الموصولة) هو المستأجر «Abdul Rahman Khan»: 95 «جاهزة» بالاسم', () => {
    // (الواقع: [[75, 'review', false]])
    expect(suggest('Abdul Rahman Khan', 'TRANSFER FROM ABDULRAHMAN KHAN')).toEqual([[95, 'ready', true]]);
  });
});

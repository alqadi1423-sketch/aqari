/**
 * المدقق H2 · الجولة السابعة عشرة · على 3f2c136 · الاسم المركّب «عبدالعزيز» متصلاً و«عبد العزيز» مفصولاً كلمتان مختلفتان في مطابقة الاسم،
 * فيأخذ درجةَ الاسم مستأجرٌ آخر كُتب اسمه بالوجه الذي كتبه البنك · بياناتٌ مصطنعة كلها (أسماءٌ وأرقامٌ مخترعة).
 *   TZ=Asia/Riyadh npx jest tests/d4.auditH2.compoundName.test.ts
 *
 * H2-2 · متوسط · src/domain/bankStatement/collect.ts:53 (الصدر المفصول «عبد» يُضمّ إلى ما بعده بعد نزع «ال» منه: «عبد العزيز» ← «عبدعزيز»)
 * وcollect.ts:55 (المتصل «عبدالعزيز» كلمةٌ لا تبدأ بـ«ال» فتبقى «عبدالعزيز») مع collect.ts:163 (named: الاسم الأول في كلمات البيان، ولا اسم
 * كاملاً): عمارةٌ بإيجارٍ واحد (2,500 شهرياً) وقسطان يستحقان 1 أكتوبر: أ «عبدالعزيز سعد الحربي» (أدخله المالك متصلاً كما في الهوية) وب
 * «عبد العزيز فهد العتيبي» (مفصولاً)، وحوالةٌ يوم 2 أكتوبر «حوالة واردة من عبد العزيز الحربي» (اسم أ الأول وعائلته، والبنك يفصل) · فلأ
 * «الحربي» وحدها ولا يُعرف اسمه الأول، ولب اسمه الأول، فيأخذ ب درجة الاسم: ب 90 «جاهز» ولا شيء لأ · والأسماء الثلاثة بكتابةٍ واحدة (كلها
 * مفصولة أو كلها متصلة): أ 90 «جاهز» (الضابطان) · وعكسه كذلك (أ مفصولاً وب والبيان متصلين) · ولا يصيب «عبدالله» وحده لأن «الله» لا تُنزع
 * منها «ال» (أربعة أحرف).
 * لماذا يهم: «عبدالعزيز» و«عبدالرحمن» و«عبدالكريم» و«عبدالإله» من أشيع الأسماء في المملكة وتُكتب بالوجهين في الهويات وبيانات الحوالات
 * وإدخال المالك؛ و«اعتماد الجاهزة» يسجّل مال أ سداداً لقسط ب (كـD2-2: من دفع «متأخر» ومن لم يدفع «مسدِّد») · وW5 جعل «الصدر المركّب مع ما
 * بعده» اسماً واحداً، فالكتابتان اسمٌ واحد.
 * السلوك الصحيح: الاسم المركّب كلمةٌ واحدة بمسافةٍ أو بدونها: يُقترح الإيداع لأ كما حين تتفق الكتابتان، ولا «جاهز» لب.
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';

function world(aName: string, bName: string, descr: string) {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع H2-2', 0);
  const p = addProperty(db, { name: 'عمارة مصطنعة H2-2' });
  const ca = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'H2-2A' }), {
    tenant: aName, idNumber: '1000000983', phone: '0500000983', valueHalalas: 3000000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const cb = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'H2-2B' }), {
    tenant: bName, idNumber: '1000000984', phone: '0500000984', valueHalalas: 3000000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', descr, '', '2,500.00', '2,500.00']]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); // i18n-exempt: رسالة اختبار
  saveStatement(db, bank, r, { name: 'oct-h2-2.csv', hash: 'h2-2' });
  const who = (id: string) => (id === ca ? 'أ' : id === cb ? 'ب' : '?');
  const out = collectionSuggestions(db, bank).map((s) => [s.target.kind === 'installments' ? who(s.target.contractId) : s.target.kind, s.level, s.reasons.includes('name')]);
  db.close();
  return out;
}
const toA = [['أ', 'ready', true]];

describe('H2-2 · [متوسط] «عبدالعزيز» متصلاً و«عبد العزيز» مفصولاً اسمان مختلفان فيصير الإيداع «جاهزاً» لسميّ الاسم الأول (collect.ts:53 و55 و163)', () => {
  test('الضابطان: الأسماء كلها مفصولة أو كلها متصلة: الإيداع «جاهز» لأ باسمه', () => {
    expect([
      world('عبد العزيز سعد الحربي', 'عبد العزيز فهد العتيبي', 'حوالة واردة من عبد العزيز الحربي'),
      world('عبدالعزيز سعد الحربي', 'عبدالعزيز فهد العتيبي', 'حوالة واردة من عبدالعزيز الحربي'),
    ]).toEqual([toA, toA]);
  });

  test('أ متصلاً وب والبيان مفصولين: الإيداع لأ لا «جاهزٌ» لب', () => {
    // (الواقع: [['ب', 'ready', true]])
    expect(world('عبدالعزيز سعد الحربي', 'عبد العزيز فهد العتيبي', 'حوالة واردة من عبد العزيز الحربي')).toEqual(toA);
  });

  test('وعكسه: أ مفصولاً وب والبيان متصلين', () => {
    // (الواقع: [['ب', 'ready', true]])
    expect(world('عبد العزيز سعد الحربي', 'عبدالعزيز فهد العتيبي', 'حوالة واردة من عبدالعزيز الحربي')).toEqual(toA);
  });
});

/**
 * المدقق N2 · الجولة العشرون · على af2ba1f · إصلاح L2-3 ضمّ صدور الأسماء اللاتينية («Abdul/Abd/Abdel/Abu») إلى ما بعدها كالعربية، وبقيت وصلات
 * الأسماء («بن/بنت/ابن») عربيةً وحدها؛ فـ«bin» و«ibn» في الاسم المكتوب بالحروف اللاتينية كلمةٌ مميِّزة تُعدّ من الاسم الكامل · بياناتٌ مصطنعة
 * كلها (أسماءٌ وأرقامٌ مخترعة).
 *   TZ=Asia/Riyadh npx jest tests/d4.auditN2.latinLink.test.ts
 *
 * N2-1 · متوسط · src/domain/bankStatement/collect.ts:41 (NAME_LINK: «بن» و«بنت» و«ابن» و«ال» بالعربية وحدها) وcollect.ts:58 (nameTokens: «bin»
 * ثلاثة أحرف فتبقى كلمةً) مع collect.ts:156-168 (fullNames: كلمتان من اسمٍ مسجَّل «اسمٌ كامل» فـnamed صحيح ولو لم يكن الاسم الأول فيه):
 * عقدٌ بإيجار 2,500 شهرياً لمستأجرٍ مسجَّلٍ «Fahad bin Saad Otaibi»، وحوالةٌ يوم 2 أكتوبر بالمبلغ نفسه من غيره «TRANSFER FROM KHALID BIN SAAD»:
 * «bin» و«saad» كلمتان مشتركتان فيصير «Fahad bin Saad Otaibi» الاسم الكامل في البيان، فتأخذ درجة الاسم وتصير 95 «جاهزة» · وكذلك «ibn» ·
 * والبيان نفسه بالعربية («حوالة من خالد بن سعد» لمستأجرٍ «فهد بن سعد العتيبي») 75 «تحتاج مراجعة»: الضابط، وبلا «bin» كذلك.
 * لماذا يهم: «بن» في أكثر الأسماء السعودية، وأسماء الأب شائعة («سعد»، «محمد»)، وحوالات «سريع» تكتب اسم المحوِّل بالإنجليزية كثيراً كما قرّر
 * L2-3 · فإيداع خالد بن سعد يُقترح «جاهزاً» سداداً لقسط فهد بن سعد، و«اعتماد الجاهزة» يسجّله تحصيلاً من غير صاحبه (كـD2-2 وW5) · وهو L2-3
 * نفسه: ما يُصنع بالعربية يُصنع باللاتينية.
 * السلوك الصحيح (W5 وD2-2: «الوصلات لا تعرّف أحداً»، و«العائلة/اسم الأب وحده لا يكفي»): «bin/bint/ibn» وصلاتٌ كـ«بن/بنت/ابن»، فالحوالة من خالد
 * بن سعد 75 «تحتاج مراجعة» بلا درجة اسم كالعربية، والحوالة من «FAHAD BIN SAAD» تبقى 95 «جاهزة» بالاسم (الضابط الثاني) · (لا يمسّ قراراً: الوصلات
 * في nameTokens لا تعرّف أحداً بالعربية أصلاً.)
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';
import { collectionSuggestions } from '@/domain/bankStatement/collect';

function suggest(tenant: string, descr: string) {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع N2-1', 0);
  const p = addProperty(db, { name: 'عمارة مصطنعة N2-1' });
  confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'N2-1A' }), {
    tenant, idNumber: '2000000291', phone: '0500000291', valueHalalas: 3000000, cycle: 'شهرية',
    start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const r = readStatementGrid([['Opening Balance', '0.00'], ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
    ['02/10/2026', descr, '', '2,500.00', '2,500.00']]);
  if (!r.ok) throw new Error('لم يُقرأ: ' + r.error); // i18n-exempt: رسالة اختبار
  saveStatement(db, bank, r, { name: 'oct-n2-1.csv', hash: 'n2-1' });
  const out = collectionSuggestions(db, bank).map((s) => [s.score, s.level, s.reasons.includes('name')]);
  db.close();
  return out;
}

describe('N2-1 · [متوسط] «bin/ibn» اللاتينية كلمةٌ من الاسم فيصير إيداع «خالد بن سعد» «جاهزاً» لقسط «فهد بن سعد» (collect.ts:41 و58)', () => {
  test('الضابط: بالعربية «خالد بن سعد» لا يأخذ درجة الاسم لـ«فهد بن سعد العتيبي»', () => {
    expect(suggest('فهد بن سعد العتيبي', 'حوالة واردة من خالد بن سعد')).toEqual([[75, 'review', false]]);
  });

  test('الضابط: «FAHAD BIN SAAD» هو المستأجر «Fahad bin Saad Otaibi»: 95 «جاهزة» بالاسم', () => {
    expect(suggest('Fahad bin Saad Otaibi', 'TRANSFER FROM FAHAD BIN SAAD')).toEqual([[95, 'ready', true]]);
  });

  test('«KHALID BIN SAAD» لا يأخذ درجة الاسم لـ«Fahad bin Saad Otaibi»، ولا «KHALID IBN SAAD» لـ«Fahad Ibn Saad Otaibi»', () => {
    // (الواقع: [[[95, 'ready', true]], [[95, 'ready', true]]])
    expect([
      suggest('Fahad bin Saad Otaibi', 'TRANSFER FROM KHALID BIN SAAD'),
      suggest('Fahad Ibn Saad Otaibi', 'SARIE TRANSFER KHALID IBN SAAD'),
    ]).toEqual([[[75, 'review', false]], [[75, 'review', false]]]);
  });
});

/**
 * المدقق الخارجي X · الجولة الثانية عشرة · قارئ كشف البنك (src/domain/bankStatement/read.ts وdictionary.json) بعد إصلاحات V · كل اختبارٍ
 * يسقط على الشيفرة الحالية (7ef3f8e) ويصف السلوك الصحيح · بياناتٌ مصطنعة كلها.
 *   TZ=Asia/Riyadh npx jest tests/d4.auditX.reader.test.ts
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementGrid, type StatementResult } from '@/domain/bankStatement/read';
import { saveStatement } from '@/domain/bankStatement/store';

const amounts = (r: StatementResult) => (r.ok ? r.lines.map((l) => l.amount) : r.error + (r.detail ? ':' + r.detail : ''));

describe('X4 · [متوسط] رقم الحساب يُؤخذ من أي خليةٍ فيها «Account» ومن تاريخٍ بشرطات، فكشفٌ صحيحٌ مطبوعٌ فيه رقم حسابه يُرفض «لحسابٍ آخر» (read.ts:350-356)', () => {
  // إصلاح V٧ حصر الرقم في خلية الكلمة أو التي تليها، لكن الكلمة ما زالت «account» وحدها (فتطابق «Account Statement» و«Account Opening
  // Date») والرقم أي أرقامٍ بمسافاتٍ وشرطات (فيطابق «01-10-2026 - 31-10-2026») · وأول صفٍّ يطابق يُعاد فلا يُنظر في صف «Account Number»
  // بعده · فعنوان الكشف الشائع «Account Statement 01-10-2026 - 31-10-2026» يصنع رقم حساب «0110202631102026»، وsaveStatement يرفض الكشف
  // لأنه لا يطابق آيبان البنك، والرقم الصحيح مطبوعٌ في الصف التالي
  const save = (head: string[][]) => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع للمدقق X', 0);
    db.run(`UPDATE banks SET iban = 'SA0300000000000012345678' WHERE id = ?`, [bank]);
    const r = readStatementGrid([...head, ['Opening Balance', '0.00'], ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
      ['02/10/2026', 'Transfer in (synthetic)', '', '500.00', '500.00']]);
    if (!r.ok) throw new Error(r.error);
    try { return [r.account, saveStatement(db, bank, r, { name: 'x4.pdf', hash: 'x4' }).added]; } catch (e) { return [r.account, (e as Error).message]; } finally { db.close(); }
  };
  test('عنوانٌ بفترةٍ بشرطات ثم «Account Number 000012345678»: الرقم 000012345678 ويُحفظ الكشف', () => {
    // الواقع: ['0110202631102026', 'الكشف لحسابٍ آخر (0110202631102026) لا لهذا البنك …']
    expect(save([['Account Statement 01-10-2026 - 31-10-2026'], ['Account Number', '000012345678']])).toEqual(['000012345678', 1]);
  });
  test('«Account Opening Date | 2019-05-01» قبل «Account Number»: تاريخ الفتح ليس رقم الحساب', () => {
    // الواقع: ['20190501', 'الكشف لحسابٍ آخر (20190501) …']
    expect(save([['Account Opening Date', '2019-05-01'], ['Account Number', '000012345678']])).toEqual(['000012345678', 1]);
  });
});

describe('X5 · [متوسط] عمود المؤشر «Debit/Credit» يبقى دور «مدين»، فقيمه «CR» و«DR» خلايا مبلغٍ لا تُقرأ ويُرفض الكشف (dictionary.json:48-61 · إصلاح V٨ ناقص)', () => {
  // V٨ أضاف «dr cr» و«cr dr» و«debit credit indicator» و«مدين دائن» إلى دور النوع، ولم يضف الصيغة الإنجليزية بالكلمتين «Debit/Credit» (أو
  // «Credit/Debit») · foldText يجعلها «debit credit» فتطابق «debit» في المدين · ثم unreadable(debitCol) يرى «CR» نصاً فيُرفض الكشف «format»
  // بلا شاشة أعمدة، كما في V٨ نفسه
  const read = (indicator: string) => readStatementGrid([
    ['Opening Balance', '1,000.00'],
    ['Date', 'Narrative', 'Amount', indicator, 'Balance'],
    ['02/10/2026', 'Transfer in (synthetic)', '500.00', 'CR', '1,500.00'],
    ['05/10/2026', 'POS purchase (synthetic)', '200.00', 'DR', '1,300.00'],
    ['Closing Balance', '1,300.00'],
  ]);
  test('«Amount | Debit/Credit | Balance» و«Credit/Debit»: الحركتان بإشارتيهما', () => {
    // الواقع: ['format:amount', 'format:amount']
    expect([amounts(read('Debit/Credit')), amounts(read('Credit/Debit'))]).toEqual([[50000, -20000], [50000, -20000]]);
  });
});

describe('X6 · [منخفض] صفّا الرصيد الافتتاحي والختامي المؤرَّخان بـ«0.00» في المدين والدائن يُحفظان حركتين بصفر، والافتتاحي المطبوع «مشتق» (read.ts:217-219)', () => {
  // إصلاح V٢/V١٣ يعدّ الصف حركةً متى كان في خلية مدينٍ أو دائنٍ أي نص (cellText ≠ '')، و«0.00» نصٌّ · وتصدير Excel الشائع يكتب الصفر في
  // الخانة الفارغة · فصفّ «الرصيد الافتتاحي» المؤرَّخ (U٧) يصير سطراً بصفر ولا يُقرأ افتتاحيه (فيُنبَّه «اشتُق الافتتاحي»)، وكذلك الختامي:
  // سطران زائفان في الكشف وفي «ما في الكشف وحده» · والقرار ٦٠: «ما لا مبلغ فيه ليس حركة»
  test('كشفٌ بأصفارٍ في الخانات الفارغة: حركتان، والافتتاحي 1,000 مطبوعاً بلا تنبيه', () => {
    const r = readStatementGrid([
      ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/01', 'الرصيد الافتتاحي', '0.00', '0.00', '1,000.00'],
      ['2026/10/02', 'حوالة واردة مصطنعة', '0.00', '50.00', '1,050.00'],
      ['2026/10/05', 'رسوم مصطنعة', '10.00', '0.00', '1,040.00'],
      ['2026/10/31', 'الرصيد الختامي', '0.00', '0.00', '1,040.00'],
    ]);
    // الواقع: [0, 5000, -1000, 0] بتنبيه openingDerived
    expect([amounts(r), r.ok && r.opening, r.ok && r.warnings]).toEqual([[5000, -1000], 100000, []]);
  });
});

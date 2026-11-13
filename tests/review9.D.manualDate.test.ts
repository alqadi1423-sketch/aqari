/**
 * D-2 · عالٍ · src/ui/DateField.tsx:32 (الكتابة اليدوية تمرّر أي أرقام وشرطات) ← app/(tabs)/collect.tsx:290 ← src/domain/contracts/service.ts:637
 *
 * السيناريو: في نافذة «تسجيل دفعة إيجار» يضغط المستخدم زرّ القلم بجانب «تاريخ الدفعة» ويكتب التاريخ بيده «2026-1-15»
 * (بلا صفرٍ قبل الشهر). حقل التاريخ لا يفحص الصيغة (isValidISODate معرَّفة في DateField.tsx ولا يستدعيها أحد)، فيصل النص
 * كما هو إلى recordRentPayment، والخدمة لا تفحص الصيغة أيضاً، فتُسجَّل الدفعة وقيدها بتاريخ «2026-1-15».
 *
 * لماذا يهم: التواريخ في القاعدة نصوصٌ تُقارن حرفاً حرفاً، و«2026-1-15» أكبر من «2026-01-31» وأصغر من «2026-10-01»،
 * فلا يقع في أي شهرٍ ولا أي ربع: يغيب من تقارير الشهر والربع ومن الإقرار الضريبي وهو في الرصيد. والأخطر أن قفل الربع المقدَّم
 * إقراره (isFiledDate ← quarterId يطلب شهراً من رقمين) لا يتعرّف عليه، فتُرحَّل دفعةٌ في فترةٍ مجمَّدة بلا رفض.
 *
 * السلوك الصحيح: تاريخٌ ليس بصيغة YYYY-MM-DD صحيحة يُرفض قبل أن يصل الدفتر (في الحقل نفسه، وفي الخدمة حارساً أخيراً)،
 * كما يُرفض التاريخ «2026-01-15» في الربع المقدَّم اليوم. بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';

function setup() {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع للمراجعة');
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار مصطنع للمراجعة' })),
    { tenant: 'مستأجر مصطنع للمراجعة', idNumber: '1000000901', phone: '0500000901', depositHalalas: 0,
      start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000 }));
  const inst = db.get<{ id: string }>(
    `SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  const pay = (date: string) => recordRentPayment(db, cid, {
    installmentId: inst.id, period: 'يناير', date,
    lines: [{ method: 'bank', bankId: bank, amountHalalas: 50000 }], discountHalalas: 0, notes: '',
  });
  return { db, pay };
}

test.failing('D-2 تاريخ دفعةٍ مكتوبٌ يدوياً بلا صفر «2026-1-15» يُرفض ولا يصل الدفتر', () => {
  const { db, pay } = setup();
  // اليوم: يُقبل ويُكتب القيد بتاريخٍ لا يقع في أي شهر
  expect(() => pay('2026-1-15')).toThrow();
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries WHERE date = '2026-1-15'`)!.n).toBe(0);
  db.close();
});

test.failing('D-2 والتاريخ نفسه لا يتجاوز قفل الربع المقدَّم إقراره', () => {
  const { db, pay } = setup();
  db.run(`INSERT INTO vat_filings (id, period_from, period_to, filed_at, snapshot, created_at) VALUES (?,?,?,?,?,?)`,
    ['2026-Q1', '2026-01-01', '2026-03-31', '2026-04-10', '{}', '2026-04-10T00:00:00.000Z']);
  // الضابط: التاريخ بصيغته الصحيحة في الربع المقدَّم يُرفض اليوم
  expect(() => pay('2026-01-15')).toThrow();
  // الخطأ: اليوم نفسه بلا صفرٍ يمرّ ويُرحَّل في الفترة المجمَّدة
  expect(() => pay('2026-1-15')).toThrow();
  db.close();
});

/**
 * المراجعة الشاملة 2026-11-13 · R12-DEP-4 · كل كشفٍ يتوازن وحده، و«إجمالي محصَّل» العقد و«دخله» (contractCollectedValue) بالقاعدة نفسها ·
 * بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * (أ) التجديد كاختبار المدقق (review12.money.creditAcrossRenewal): (أ) ستة أقساط ١٬٠٠٠ دُفع عنها ٧٬٠٠٠ نقداً، فالفائض ١٬٠٠٠ رصيدٌ دائن
 *     للمستأجر (2410) · ثم سُدّد قسط يوليو في (ب) المجدَّد من الرصيد.
 *     الصحيح: محصَّل (أ) ٦٬٠٠٠ (٧٬٠٠٠ − ١٬٠٠٠ حُوّل رصيداً)، ومحصَّل (ب) ١٬٠٠٠ (سداد يوليو من الرصيد) · ومجموعهما ٧٬٠٠٠ = النقد ·
 *     وكشف (أ) صفر وفيه سطرٌ مدين ١٬٠٠٠ «فائضٌ حُوّل إلى رصيد المستأجر الدائن».
 * (ب) العقد الواحد (A2.1 · review9.A2.creditDoubleCount): ٣٬٠٠٠ عن قسطين بألفين، ثم الثالث من الرصيد · المحصَّل ٣٬٠٠٠ لا ٤٬٠٠٠ ولا ٢٬٠٠٠.
 * (ج) فائضٌ قديم دخل إيراداً ثم حُوّل رصيداً (surplus_credit) واستُعمل في العقد نفسه: لا يُعدّ مرتين · المحصَّل = النقد ٢٢٠٬٠٠٠.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordBulkRentPayment, recordRentPayment, applyTenantCredit, renewContract } from '@/domain/contracts/service';
import { tenantStatementRows } from '@/domain/statement';
import { contractCollectedValue } from '@/domain/stats';
import { postEntry } from '@/domain/accounting/post';
import { settleSurplus } from '@/domain/ledgerReview';
import { accountBalance } from '@/domain/accounting/ledger';

type Row = { debitHalalas: number; creditHalalas: number; future?: boolean; descr: string };
const balanceDue = (rows: Row[]) => rows.filter((r) => !r.future).reduce((s, r) => s + r.debitHalalas - r.creditHalalas, 0);
const SURPLUS_LINE = 'فائضٌ حُوّل إلى رصيد المستأجر الدائن';

test('R12-DEP-4 (أ) · رصيدٌ دائن نشأ في العقد السابق واستُعمل في المجدَّد: كل كشفٍ صفر، والمحصَّل لكلٍّ بما سدّده', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار محصَّلٍ مصطنع' }), { unit_no: 'CC-1' });
  const a = confirmContract(db, contractInput(u, { tenant: 'مستأجر محصَّلٍ مصطنع', idNumber: '1000012031', phone: '0500012031',
    start: '2026-01-01', end: '2026-06-30', valueHalalas: 600000, depositHalalas: 0 }));
  const ia = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [a]);
  recordBulkRentPayment(db, a, { installmentIds: ia.map((x) => x.id), date: '2026-06-01', lines: [{ method: 'cash', amountHalalas: 700000 }], notes: '' });
  const b = renewContract(db, a, { start: '2026-07-01', end: '2026-12-31', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: false,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  const ib = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [b]);
  applyTenantCredit(db, b, { installmentId: ib[0].id, amountHalalas: 100000, date: '2026-07-01' });

  // ٧٠٠٬٠٠٠ − ١٠٠٬٠٠٠ فائضٌ حُوّل رصيداً = ٦٠٠٬٠٠٠ · وسداد يوليو من الرصيد ١٠٠٬٠٠٠ · ومجموعهما ٧٠٠٬٠٠٠ = النقد
  expect([contractCollectedValue(db, a), contractCollectedValue(db, b)]).toEqual([600000, 100000]);
  expect(accountBalance(db, '1100')).toBe(700000);
  // كشف (أ): أقساط ٦٠٠٬٠٠٠ مدين + فائض ١٠٠٬٠٠٠ مدين − ٧٠٠٬٠٠٠ دائن = صفر
  const ra = tenantStatementRows(db, a, '2026-07-15') as Row[];
  expect(balanceDue(ra)).toBe(0);
  expect(ra.filter((r) => r.descr === SURPLUS_LINE).map((r) => [r.debitHalalas, r.creditHalalas])).toEqual([[100000, 0]]);
  // كشف (ب): يوليو ١٠٠٬٠٠٠ مدين − سداده من الرصيد ١٠٠٬٠٠٠ دائن = صفر
  expect(balanceDue(tenantStatementRows(db, b, '2026-07-15') as Row[])).toBe(0);
  db.close();
});

test('R12-DEP-4 (ب) · الرصيد الدائن في العقد نفسه (A2.1): المحصَّل ٣٬٠٠٠ والكشف صفر', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار عقدٍ واحدٍ مصطنع' }), { unit_no: 'CC-2' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر عقدٍ واحدٍ مصطنع', idNumber: '1000012032', phone: '0500012032',
    start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, depositHalalas: 0 }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  recordBulkRentPayment(db, cid, { installmentIds: [insts[0].id, insts[1].id], date: '2026-02-01', lines: [{ method: 'cash', amountHalalas: 300000 }], notes: '' });
  applyTenantCredit(db, cid, { installmentId: insts[2].id, amountHalalas: 100000, date: '2026-03-01' });
  // ٣٠٠٬٠٠٠ − ١٠٠٬٠٠٠ فائض + ١٠٠٬٠٠٠ سداد من الرصيد = ٣٠٠٬٠٠٠
  expect(contractCollectedValue(db, cid)).toBe(300000);
  // ثلاثة أقساط ٣٠٠٬٠٠٠ مدين + فائض ١٠٠٬٠٠٠ مدين − ٣٠٠٬٠٠٠ − ١٠٠٬٠٠٠ دائن = صفر
  expect(balanceDue(tenantStatementRows(db, cid, '2026-03-15') as Row[])).toBe(0);
  db.close();
});

test('R12-DEP-4 (ج) · فائضٌ قديم حُوّل رصيداً (surplus_credit) واستُعمل في العقد نفسه لا يُعدّ مرتين', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار فائضٍ قديمٍ مصطنع' }), { unit_no: 'CC-3' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر فائضٍ قديمٍ مصطنع', idNumber: '1000012033', phone: '0500012033',
    start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, depositHalalas: 0 }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  recordRentPayment(db, cid, { installmentId: insts[0], period: 'يناير', date: '2026-01-05', notes: '', discountHalalas: 0,
    lines: [{ method: 'cash', amountHalalas: 100000 }] });
  // دفعةٌ منقولة بنقدٍ زائد عن قسطها ٢٠٬٠٠٠ دخل إيراداً (كما في surplusRefund.test.ts)
  const e = postEntry(db, { date: '2026-02-03', memo: 'تحصيل منقول', srcType: 'rent_payment', srcId: 'PX-CC3',
    lines: [{ account: '1100', debit: 120000, credit: 0 }, { account: '4200', debit: 0, credit: 120000 }] })!;
  db.run(`INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,method_label,notes,journal_entry_id,created_at)
          VALUES (?,?,?,'فبراير','2026-02-03',120000,0,120000,'','',?,'x')`, ['PX-CC3', cid, insts[1], e.id]);
  db.run(`UPDATE contract_installments SET paid_halalas = 100000, status = 'مدفوعة' WHERE id = ?`, [insts[1]]);
  settleSurplus(db, cid, { action: 'credit', amountHalalas: 20000, date: '2026-03-10' });
  applyTenantCredit(db, cid, { installmentId: insts[2], amountHalalas: 20000, date: '2026-03-11' });
  // ١٠٠٬٠٠٠ + ١٢٠٬٠٠٠ − ٢٠٬٠٠٠ حُوّلت رصيداً + ٢٠٬٠٠٠ سداد مارس من الرصيد = ٢٢٠٬٠٠٠ = النقد
  expect(contractCollectedValue(db, cid)).toBe(220000);
  expect(accountBalance(db, '1100')).toBe(220000);
  // أقساط ٣٠٠٬٠٠٠ + فائض ٢٠٬٠٠٠ مدين − (١٠٠٬٠٠٠ + ١٢٠٬٠٠٠ + ٢٠٬٠٠٠) دائن = ٨٠٬٠٠٠ باقي مارس
  expect(balanceDue(tenantStatementRows(db, cid, '2026-03-15') as Row[])).toBe(80000);
  db.close();
});

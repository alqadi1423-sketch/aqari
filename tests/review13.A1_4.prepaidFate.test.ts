/**
 * A1-4 · قرار المالك س١٦: ما قُبض عن مدةٍ بعد الإنهاء يُسأل عنه عند الإلغاء · «يُحتفظ به» (الافتراضي) فيُحسب إيراداً يوم الإنهاء،
 * أو «يُردّ» بقيد ردٍّ نقداً أو تحويلاً · والثابت: مجموع استحقاق العقد عبر عمره = إيراد إيجاره المحتفَظ به في الدفتر. بيانات مصطنعة.
 *
 * الأرقام الذهبية (عقد ١٢٬٠٠٠ = ١٢٠٠٠٠٠ هللة لسنة 2026، ٣٦٥ يوماً):
 *  (أ) شهري، سُدّد يناير إلى يونيو (٦٠٠٠٠٠)، أُلغي 2026-06-15: المكتسب ١٢٠٠٠٠٠ × ١٦٦ ÷ ٣٦٥ = ٥٤٥٧٥٣ · وحتى 05-31: × ١٥١ ÷ ٣٦٥ = ٤٩٦٤٣٨
 *      فنصيب يونيو من التوزيع ٤٩٣١٥، والزيادة يوم الإنهاء ٦٠٠٠٠٠ − ٥٤٥٧٥٣ = ٥٤٢٤٧ · فإيراد يونيو ١٠٣٥٦٢، ويوليو وما بعده صفر.
 *  (ب) سنوي مدفوع كاملاً 2026-01-01، أُلغي 2026-03-31: المكتسب × ٩٠ ÷ ٣٦٥ = ٢٩٥٨٩٠، والمقدَّم بعد الإنهاء ٩٠٤١١٠ ·
 *      ردّه نقداً كاملاً يترك 4200 = ٢٩٥٨٩٠ = الاستحقاق عبر العمر، و1100 = ١٢٠٠٠٠٠ − ٩٠٤١١٠ = ٢٩٥٨٩٠.
 *  (ج) يبدأ 2026-02-01، سُدّد قسطه الأول ١٠٠٠٠٠ في 01-20، وأُلغي 01-25 قبل بدايته: المكتسب صفر، فالمقبوض كله إيرادٌ يوم الإلغاء.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, reasonOf } from './helpers/rederive';
import { confirmContract, cancelContract, recordRentPayment } from '@/domain/contracts/service';
import { periodRevenueAccrual, monthlyRevenueExpenseAccrual, prepaidUnearned } from '@/domain/accrual';
import { accountBalance, bankBalance } from '@/domain/accounting/ledger';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { depositCashToBank } from '@/domain/cashOps';
import type { DB } from '@/db/adapter';

const cancel = (date: string, prepaidRefund?: { amountHalalas: number; method: 'cash' | 'bank'; bankId?: string | null }) => ({
  date, reason: 'غادر المستأجر', installmentsFate: 'cancel' as const, settle: false,
  deductionHalalas: 0, refundHalalas: 0, deductionReason: '', prepaidRefund: prepaidRefund ?? null });

function payAll(db: DB, cid: string, upTo: string, on?: string) {
  for (const i of db.all<{ id: string; due_date: string; amount_halalas: number }>(
    `SELECT id, due_date, amount_halalas FROM contract_installments WHERE contract_id = ? AND due_date <= ? ORDER BY due_date`, [cid, upTo])) {
    recordRentPayment(db, cid, { installmentId: i.id, period: '', date: on ?? i.due_date,
      lines: [{ method: 'cash', amountHalalas: Number(i.amount_halalas) }], discountHalalas: 0, notes: '' });
  }
}
function contract(db: DB, unit: string, cycle: string, start = '2026-01-01', end = '2026-12-31') {
  const u = addUnit(db, addProperty(db, { name: 'عقار إنهاء مصطنع ' + unit }), { unit_no: unit });
  return confirmContract(db, contractInput(u, { tenant: 'مستأجر إنهاء مصطنع ' + unit, idNumber: '',
    valueHalalas: 1200000, cycle, start, end, depositHalalas: 0 }));
}
const status = (db: DB, cid: string) => db.get<{ s: string }>(`SELECT status AS s FROM contracts WHERE id = ?`, [cid])!.s;

test('A1-4 (أ) «يُحتفظ به»: الزيادة ٥٤٢٤٧ يوم الإنهاء في شهره، ولا شيء بعده', () => {
  const db = memDb();
  const cid = contract(db, 'P-1', 'شهرية');
  payAll(db, cid, '2026-06-01');
  expect(prepaidUnearned(db, cid, '2026-06-15')).toBe(54247); // معاينة نافذة الإلغاء
  cancelContract(db, cid, cancel('2026-06-15'));
  expect(prepaidUnearned(db, cid)).toBe(54247);
  const m = monthlyRevenueExpenseAccrual(db, '2026-05', '2026-08');
  expect(m.get('2026-06')!.revenue).toBe(49315 + 54247);
  expect(m.get('2026-07')!.revenue).toBe(0);
  expect(m.get('2026-08')!.revenue).toBe(0);
  expect(periodRevenueAccrual(db, '2026-06-15', '2026-06-15')).toBe(accrualDay(db) + 54247);
  expect(periodRevenueAccrual(db, null, null)).toBe(600000);
  expect(accountBalance(db, '4200')).toBe(600000);
  db.close();
});
/** نصيب يومٍ واحد (06-15) من التوزيع: ١٢٠٠٠٠٠ × ١٦٦ ÷ ٣٦٥ − ١٢٠٠٠٠٠ × ١٦٥ ÷ ٣٦٥ = ٥٤٥٧٥٣ − ٥٤٢٤٦٦ */
const accrualDay = (_db: DB) => 545753 - 542466;

test('A1-4 (ب) «يُردّ» نقداً كاملاً: الإيراد المحتفَظ به = الاستحقاق عبر العمر = ٢٩٥٨٩٠، والنقد خرج', () => {
  const db = memDb();
  const cid = contract(db, 'P-2', 'سنوية');
  payAll(db, cid, '2026-01-01');
  expect(prepaidUnearned(db, cid, '2026-03-31')).toBe(904110);
  cancelContract(db, cid, cancel('2026-03-31', { amountHalalas: 904110, method: 'cash' }));
  expect(accountBalance(db, '4200')).toBe(295890);
  expect(accountBalance(db, '1100')).toBe(295890);
  expect(periodRevenueAccrual(db, null, null)).toBe(295890);
  expect(prepaidUnearned(db, cid)).toBe(0);
  // والربع الأول كله ٢٩٥٨٩٠ ولا زيادة يوم الإنهاء
  expect(periodRevenueAccrual(db, '2026-03-31', '2026-03-31')).toBe(Math.round(1200000 * 90 / 365) - Math.round(1200000 * 89 / 365));
  db.close();
});

test('A1-4 «يُردّ» جزئياً بتحويلٍ بنكي: حركة بنك سالبة، والباقي إيرادٌ يوم الإنهاء · وإلغاء الردّ يعيده محتفَظاً به', () => {
  const db = memDb();
  const cid = contract(db, 'P-3', 'سنوية');
  payAll(db, cid, '2026-01-01');
  db.run(`INSERT INTO banks (id, name, created_at) VALUES ('bk-a14', 'بنك مصطنع', '2026-01-01')`);
  depositCashToBank(db, { bankId: 'bk-a14', amountHalalas: 1000000, date: '2026-01-02' });
  cancelContract(db, cid, cancel('2026-03-31', { amountHalalas: 400000, method: 'bank', bankId: 'bk-a14' }));
  expect(bankBalance(db, 'bk-a14')).toBe(600000);
  expect(accountBalance(db, '4200')).toBe(800000);
  expect(periodRevenueAccrual(db, null, null)).toBe(800000);
  expect(periodRevenueAccrual(db, '2026-04-01', null)).toBe(0);
  // إلغاء الردّ من مصدره: يُعكس القيد وحركة البنك، فيعود المقبوض كله محتفَظاً به
  const e = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'prepaid_refund' AND src_id = ?`, [cid])!;
  const act = entrySourceAction(db, e.id);
  expect(act?.kind).toBe('op');
  if (act?.kind === 'op') { expect(act.blockers).toEqual([]); act.run('2026-04-02', 'سُجّل خطأً'); }
  expect(bankBalance(db, 'bk-a14')).toBe(1000000);
  expect(accountBalance(db, '4200')).toBe(1200000);
  expect(periodRevenueAccrual(db, null, null)).toBe(1200000);
  // والردّ يوم الإنهاء أنقص زيادته يومها (٩٠٤١١٠ − ٤٠٠٠٠٠ = ٥٠٤١١٠)، وإلغاؤه يعيد ٤٠٠٠٠٠ يوم الإلغاء (04-02) لا قبله:
  // فلا تتغير فترةٌ مضت
  expect(periodRevenueAccrual(db, '2026-03-31', '2026-03-31')).toBe(Math.round(1200000 * 90 / 365) - Math.round(1200000 * 89 / 365) + 504110);
  expect(periodRevenueAccrual(db, '2026-04-01', '2026-04-30')).toBe(400000);
  db.close();
});

test('A1-4 الردّ فوق المقدَّم يُرفض ولا يُلغى العقد', () => {
  const db = memDb();
  const cid = contract(db, 'P-4', 'سنوية');
  payAll(db, cid, '2026-01-01');
  expect(() => cancelContract(db, cid, cancel('2026-03-31', { amountHalalas: 904111, method: 'cash' })))
    .toThrow('المبلغ (9,041.11) أكبر مما قُبض عن مدةٍ بعد الإنهاء (9,041.10)');
  expect(status(db, cid)).toBe('سارٍ');
  expect(accountBalance(db, '4200')).toBe(1200000);
  expect(() => cancelContract(db, cid, cancel('2026-03-31', { amountHalalas: 1000, method: 'bank', bankId: null })))
    .toThrow('اختر الحساب البنكي الذي خرج منه التحويل');
  expect(status(db, cid)).toBe('سارٍ');
  db.close();
});

test('A1-4 (ج) أُلغي قبل بدايته: المكتسب صفر، والمقبوض كله إيرادٌ يوم الإلغاء', () => {
  const db = memDb();
  const cid = contract(db, 'P-5', 'شهرية', '2026-02-01', '2027-01-31');
  payAll(db, cid, '2026-02-01', '2026-01-20');
  cancelContract(db, cid, cancel('2026-01-25'));
  expect(periodRevenueAccrual(db, '2026-01-25', '2026-01-25')).toBe(100000);
  expect(periodRevenueAccrual(db, null, '2026-01-24')).toBe(0);
  expect(periodRevenueAccrual(db, null, null)).toBe(100000);
  db.close();
});

test('A1-4 عقدٌ عليه متأخر عند الإنهاء: لا زيادة، والمكتسب كما هو', () => {
  const db = memDb();
  const cid = contract(db, 'P-6', 'شهرية');
  payAll(db, cid, '2026-03-01'); // ٣٠٠٠٠٠ والمكتسب حتى 06-15 ٥٤٥٧٥٣
  cancelContract(db, cid, { ...cancel('2026-06-15'), installmentsFate: 'keep' });
  expect(prepaidUnearned(db, cid)).toBe(0);
  expect(periodRevenueAccrual(db, null, null)).toBe(545753);
  db.close();
});

test('A1-4 جهاز المالك يرفض قيد ردّ إيجارٍ مقدَّم من جهاز عضو', async () => {
  const s = await pair();
  const cid = contract(s.owner, 'P-7', 'سنوية');
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  payAll(s.dev, cid, '2026-01-01');
  cancelContract(s.dev, cid, cancel('2026-03-31', { amountHalalas: 100000, method: 'cash' }));
  await sync(s.dev, s.r);
  // قيد الردّ بكاتبٍ عضو، كأن عضواً رحّله من جهازه
  const k = asMember(s.r, 'prepaid_refund');
  await ownerPulls(s.owner, s.r);
  expect(s.owner.get<{ s: string }>(`SELECT status AS s FROM contracts WHERE id = ?`, [cid])!.s).toBe('ملغى');
  expect(has(s.owner, k)).toBe(false);
  expect(reasonOf(s.owner, k)).toBe('ردّ الإيجار المقدَّم للمالك وحده · لا يُطبَّق من جهاز عضو');
  s.close();
});

test('A1-4 الإلغاء بلا جواب يبقى «يُحتفظ به» ولا قيد ردّ', () => {
  const db = memDb();
  const cid = contract(db, 'P-8', 'سنوية');
  payAll(db, cid, '2026-01-01');
  cancelContract(db, cid, cancel('2026-03-31'));
  expect(db.get(`SELECT 1 FROM journal_entries WHERE src_type = 'prepaid_refund'`)).toBeFalsy();
  expect(periodRevenueAccrual(db, '2026-03-31', '2026-03-31')).toBe(Math.round(1200000 * 90 / 365) - Math.round(1200000 * 89 / 365) + 904110);
  db.close();
});

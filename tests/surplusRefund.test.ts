/**
 * الفائض عن الأقساط · نقد في الدفتر لم يُنسب لقسط، يبقى ظاهراً حتى يُردّ للمستأجر أو يُحوَّل رصيداً دائناً له،
 * بقيد جديد بتاريخ التنفيذ وطريقته وفي سجل العمليات. بيانات اصطناعية لا بيانات أحد.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { postEntry } from '@/domain/accounting/post';
import { accountBalance } from '@/domain/accounting/ledger';
import { contractSurpluses, settleSurplus, planLedgerRepair, applyLedgerRepair } from '@/domain/ledgerReview';
import { semanticIssues } from '@/domain/backup/semantic';
import { monthlyRevenueExpenseAccrual } from '@/domain/accrual';
import type { DB } from '@/db/adapter';

let seq = 0;
function contract(db: DB, monthly = 100000) {
  const p = addProperty(db);
  const u = addUnit(db, p, { rent: monthly });
  seq += 1;
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر ' + seq, valueHalalas: monthly * 12, depositHalalas: 0,
    idNumber: '10' + String(20000000 + seq), start: '2026-01-01', end: '2026-12-31' }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  return { cid, insts };
}

/** فائض كما يقع في البيانات المنقولة: دفعة قيدها بنقد أكثر مما سُدّد على أقساط عقدها */
function withSurplus(db: DB, extra = 20000) {
  const k = contract(db);
  recordRentPayment(db, k.cid, { installmentId: k.insts[0], period: 'يناير', date: '2026-01-05', notes: '',
    discountHalalas: 0, lines: [{ method: 'cash', amountHalalas: 100000 }] });
  // قيد دفعة نُقلت بنقد زائد عن قسطها (قيدها بالنقد كله، والقسط بمبلغه)
  const e = postEntry(db, { date: '2026-02-03', memo: 'تحصيل منقول', srcType: 'rent_payment', srcId: 'PX' + seq,
    lines: [{ account: '1100', debit: 100000 + extra, credit: 0 }, { account: '4200', debit: 0, credit: 100000 + extra }] })!;
  db.run(`INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,method_label,notes,journal_entry_id,created_at)
          VALUES (?,?,?,'فبراير','2026-02-03',?,0,?,'','',?,'x')`, ['PX' + seq, k.cid, k.insts[1], 100000 + extra, 100000 + extra, e.id]);
  db.run(`UPDATE contract_installments SET paid_halalas = 100000, status = 'مدفوعة' WHERE id = ?`, [k.insts[1]]);
  return k;
}

test('الفائض يظهر بمبلغه · والعقود السليمة لا فائض لها', () => {
  const db = memDb();
  const clean = contract(db);
  recordRentPayment(db, clean.cid, { installmentId: clean.insts[0], period: 'يناير', date: '2026-01-05', notes: '',
    discountHalalas: 0, lines: [{ method: 'cash', amountHalalas: 60000 }] });
  const k = withSurplus(db);
  expect(contractSurpluses(db).map((s) => [s.contractId, s.amount, s.cash, s.paid])).toEqual([[k.cid, 20000, 220000, 200000]]);
  db.close();
});

test('الردّ نقداً: مدين الإيراد · دائن النقدية · بتاريخ التنفيذ · ويختفي الفائض · وفي سجل العمليات', () => {
  const db = memDb();
  const k = withSurplus(db);
  const cash0 = accountBalance(db, '1100');
  const rev0 = accountBalance(db, '4200');
  const e = settleSurplus(db, k.cid, { action: 'refund', amountHalalas: 20000, date: '2026-03-10', method: 'cash' });
  expect(db.get(`SELECT date, src_type AS t, src_id AS s FROM journal_entries WHERE id = ?`, [e.id]))
    .toEqual({ date: '2026-03-10', t: 'surplus_refund', s: k.cid });
  expect(db.all(`SELECT account_code AS a, debit_halalas AS d, credit_halalas AS c FROM journal_lines WHERE entry_id = ? ORDER BY account_code`, [e.id]))
    .toEqual([{ a: '1100', d: 0, c: 20000 }, { a: '4200', d: 20000, c: 0 }]);
  expect(cash0 - accountBalance(db, '1100')).toBe(20000);
  expect(Math.abs(rev0) - Math.abs(accountBalance(db, '4200'))).toBe(20000);
  expect(contractSurpluses(db)).toEqual([]);
  expect(db.get<{ e: string }>(`SELECT entity_name AS e FROM audit_log WHERE entity_type = 'ردّ فائض للمستأجر'`)!.e).toContain(e.no);
  expect(semanticIssues(db)).toEqual([]);
  db.close();
});

test('الردّ تحويلاً: حركة بنكية سالبة مربوطة بالقيد · والردّ الجزئي يُبقي الباقي ظاهراً', () => {
  const db = memDb();
  const bank = addBank(db);
  const k = withSurplus(db, 30000);
  const e = settleSurplus(db, k.cid, { action: 'refund', amountHalalas: 10000, date: '2026-03-10', method: 'bank', bankId: bank });
  expect(db.get(`SELECT amount_halalas AS a, journal_no AS j FROM bank_tx WHERE journal_no = ?`, [e.no])).toEqual({ a: -10000, j: e.no });
  expect(contractSurpluses(db).map((s) => s.amount)).toEqual([20000]);
  db.close();
});

test('التحويل رصيداً دائناً: مدين الإيراد · دائن أرصدة المستأجرين 2410 · ورصيد المستأجر يزيد', () => {
  const db = memDb();
  const k = withSurplus(db);
  const tid = db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [k.cid])!.t;
  const e = settleSurplus(db, k.cid, { action: 'credit', amountHalalas: 20000, date: '2026-03-10' });
  expect(db.all(`SELECT account_code AS a, debit_halalas AS d, credit_halalas AS c FROM journal_lines WHERE entry_id = ? ORDER BY account_code`, [e.id]))
    .toEqual([{ a: '2410', d: 0, c: 20000 }, { a: '4200', d: 20000, c: 0 }]);
  expect(db.get<{ c: number }>(`SELECT credit_halalas AS c FROM tenants WHERE id = ?`, [tid])!.c).toBe(20000);
  expect(contractSurpluses(db)).toEqual([]);
  db.close();
});

test('لا ردّ فوق الفائض ولا بلا طريقة ولا نقداً فوق رصيد المحفظة · ولا قيد يبقى من محاولة مرفوضة', () => {
  const db = memDb();
  const k = withSurplus(db);
  const n0 = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n);
  expect(() => settleSurplus(db, k.cid, { action: 'refund', amountHalalas: 30000, date: '2026-03-10', method: 'cash' })).toThrow('أكبر من الفائض');
  expect(() => settleSurplus(db, k.cid, { action: 'refund', amountHalalas: 20000, date: '2026-03-10' })).toThrow('حدّد طريقة الردّ');
  expect(() => settleSurplus(db, k.cid, { action: 'refund', amountHalalas: 20000, date: '2026-03-10', method: 'bank' })).toThrow('اختر الحساب البنكي');
  // المحفظة: نقدها ٢٢٠٠ خرج منه ٢١٠٠ فبقي ١٠٠ لا تكفي لردّ ٢٠٠
  postEntry(db, { date: '2026-03-01', memo: 'م', lines: [{ account: '5400', debit: 210000, credit: 0 }, { account: '1100', debit: 0, credit: 210000 }] });
  expect(() => settleSurplus(db, k.cid, { action: 'refund', amountHalalas: 20000, date: '2026-03-10', method: 'cash' })).toThrow('لا يكفي');
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n)).toBe(n0 + 1);
  db.close();
});

test('فائض عقد يُصحَّح من الدفتر يظهر بعد التصحيح حتى يُسوّى · وعرض الاستحقاق لا يطرح الردّ من إيراد موزَّع', () => {
  const db = memDb();
  const k = contract(db);
  // نقد ٢٢٠٠ على قسطين ١٠٠٠ بخصم ١٠٠ لكل قسط في قيود خصم منفصلة · فالسعة ١٨٠٠ والفائض ٤٠٠
  const e = postEntry(db, { date: '2026-01-05', memo: 'تحصيل منقول', srcType: 'rent_payment', srcId: 'PS',
    lines: [{ account: '1100', debit: 220000, credit: 0 }, { account: '4200', debit: 0, credit: 220000 }] })!;
  for (const id of k.insts.slice(2)) db.run(`UPDATE contract_installments SET status = 'ملغية' WHERE id = ?`, [id]);
  db.run(`INSERT INTO contract_payments (id,contract_id,installment_id,period,date,gross_halalas,discount_halalas,net_halalas,method_label,notes,journal_entry_id,created_at)
          VALUES ('PS',?,?,'يناير','2026-01-05',220000,0,220000,'','',?,'x')`, [k.cid, k.insts[0], e.id]);
  for (const t of ['trg_inst_update_cap']) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  db.run(`UPDATE contract_installments SET paid_halalas = 110000 WHERE id = ?`, [k.insts[0]]);
  db.run(`UPDATE contract_installments SET paid_halalas = 110000 WHERE id = ?`, [k.insts[1]]);
  for (const i of k.insts.slice(0, 2)) {
    postEntry(db, { date: '2026-01-01', memo: 'خصم', srcType: 'discount', srcId: i,
      lines: [{ account: '4900', debit: 10000, credit: 0 }, { account: '4200', debit: 0, credit: 10000 }] });
  }
  const plan = planLedgerRepair(db);
  expect(plan.issues.map((x) => x.reason)).toEqual(['نقد زائد 400.00 عن أقساط العقد بعد خصومها في الدفتر · لم يُنسب لقسط ويبقى قرارُه لك']);
  expect(contractSurpluses(db)).toEqual([]); // العقد في التصحيح أولاً
  applyLedgerRepair(db, plan);
  expect(contractSurpluses(db).map((s) => s.amount)).toEqual([40000]);
  const before = monthlyRevenueExpenseAccrual(db, '2026-03', '2026-03').get('2026-03')!.revenue;
  settleSurplus(db, k.cid, { action: 'refund', amountHalalas: 40000, date: '2026-03-10', method: 'cash' });
  expect(monthlyRevenueExpenseAccrual(db, '2026-03', '2026-03').get('2026-03')!.revenue).toBe(before);
  expect(contractSurpluses(db)).toEqual([]);
  db.close();
});

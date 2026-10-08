/**
 * ملاحظات التحقق المستقل على إصلاحات القوائم والتسوية (مراجعة التثبيت #12 و#13 و#14 و#15) · بيانات مصطنعة
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment, saveDepositSettlement, cancelContract } from '@/domain/contracts/service';
import { ownerCashIn } from '@/domain/cashOps';
import { postEntry } from '@/domain/accounting/post';
import { accountBalance, accountPeriodChange, periodRevenueExpense } from '@/domain/accounting/ledger';
import { financialStatementBlock, cashFlowFigures, withLiveFormulas } from '@/domain/finStatements';
import { tenantStatementRows } from '@/domain/statement';
import type { ReportBlock } from '@/domain/officeBuild';

const money = (c: unknown) => (typeof c === 'object' && c && 'money' in c ? Number((c as { money: number }).money) : 0);
/** يقيّم صيغ إكسل الرمزية على قيم الكتلة: SUM({S0Ra}:{S0Rb}) و{S0Rx}+{S0Ry} */
function evalFormula(b: ReportBlock, f: string): number {
  const rows = b.sections[0].rows;
  const cell = (n: number) => money(rows[n - 1][1]);
  const sum = f.match(/^SUM\(\{S0R(\d+)\}:\{S0R(\d+)\}\)$/);
  if (sum) { let s = 0; for (let i = Number(sum[1]); i <= Number(sum[2]); i++) s += cell(i); return s; }
  return f.split('+').reduce((s, part) => s + cell(Number(part.match(/^\{S0R(\d+)\}$/)![1])), 0);
}

test('D1 صيغ إكسل للتدفقات من مواضع صفوفها: الإجمالي = تغيّر النقدية', () => {
  const db = memDb();
  const bank = addBank(db);
  ownerCashIn(db, { amountHalalas: 100000, date: '2026-01-02' });
  const u = addUnit(db, addProperty(db, { name: 'عقار إكسل مصطنع' }), { unit_no: 'X-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر إكسل مصطنع', idNumber: '1000000207', phone: '0500000141',
    valueHalalas: 1200000, start: '2026-01-01', end: '2026-12-31', depositHalalas: 50000 }));
  const i0 = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  recordRentPayment(db, cid, { installmentId: i0, period: 'يناير', date: '2026-01-05', notes: '', discountHalalas: 0, lines: [{ method: 'bank', bankId: bank, amountHalalas: 100000 }] });
  const b = withLiveFormulas('cash', financialStatementBlock(db, 'cash', '2026-01-01', '2026-12-31'));
  const change = accountPeriodChange(db, '1100', '2026-01-01', '2026-12-31');
  for (const row of b.sections[0].rows) {
    const c = row[1] as { money?: number; f?: string };
    if (c && typeof c === 'object' && c.f) expect([row[0], evalFormula(b, c.f)]).toEqual([row[0], c.money]);
  }
  const total = b.totals[b.totals.length - 1][1] as { money: number; f: string };
  expect(evalFormula(b, total.f)).toBe(change);
  db.close();
});

test('D2 التسوية ثم الإلغاء بتسوية: لا ترحيل مرتين', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 500000, date: '2025-01-01' });
  const u = addUnit(db, addProperty(db, { name: 'عقار ترتيب مصطنع' }), { unit_no: 'O-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر ترتيب مصطنع', idNumber: '1000000215', phone: '0500000151',
    valueHalalas: 600000, start: '2025-01-01', end: '2025-12-31', depositHalalas: 100000 }));
  saveDepositSettlement(db, cid, { date: '2026-01-05', deductionHalalas: 30000, deductionReason: 'إصلاح مصطنع', refundHalalas: 70000, notes: '' });
  const cash = accountBalance(db, '1100');
  cancelContract(db, cid, { date: '2026-01-06', reason: 'إلغاء مصطنع', installmentsFate: 'keep', settle: true, deductionHalalas: 30000, refundHalalas: 70000, deductionReason: 'إصلاح مصطنع' });
  expect([accountBalance(db, '2400'), accountBalance(db, '1100'), accountBalance(db, '4300')]).toEqual([0, cash, 30000]);
  db.close();
});

test('D4 حقوق الملكية بلا بداية: الافتتاحي على الإيراد في أولها كالمركز', () => {
  const db = memDb();
  db.run(`UPDATE accounts SET opening_halalas = 50000 WHERE code IN ('1100', '4300')`);
  const bal = financialStatementBlock(db, 'balance', null, '2026-12-31');
  const eqTotal = bal.sections[2].rows.reduce((s, r) => s + money(r[1]), 0);
  const eq = financialStatementBlock(db, 'equity', null, '2026-12-31');
  expect(money(eq.totals[eq.totals.length - 1][1])).toBe(eqTotal);
  db.close();
});

test('D5 القسط القادم المسدَّد مقدماً لا يظهر رصيداً دائناً للمستأجر', () => {
  const db = memDb();
  const bank = addBank(db);
  const u = addUnit(db, addProperty(db, { name: 'عقار مقدّم مصطنع' }), { unit_no: 'P-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر مقدّم مصطنع', idNumber: '1000000223', phone: '0500000161',
    valueHalalas: 1200000, cycle: 'نصف سنوية', start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  recordRentPayment(db, cid, { installmentId: insts[0], period: 'الأول', date: '2026-01-05', notes: '', discountHalalas: 0, lines: [{ method: 'bank', bankId: bank, amountHalalas: 600000 }] });
  recordRentPayment(db, cid, { installmentId: insts[1], period: 'الثاني', date: '2026-03-01', notes: '', discountHalalas: 0, lines: [{ method: 'bank', bankId: bank, amountHalalas: 600000 }] });
  const rows = tenantStatementRows(db, cid, '2026-03-15');
  const current = rows.filter((r) => !r.future).reduce((s, r) => s + r.debitHalalas - r.creditHalalas, 0);
  expect(current).toBe(0);
  expect(rows.filter((r) => r.future)).toHaveLength(0);
  db.close();
});

test('D6 عكس قيد أصلٍ غير نقدي غير نقدي: لا أثر له في التشغيلي ولا الاستثماري', () => {
  const db = memDb();
  postEntry(db, { date: '2026-03-01', memo: 'إهلاك ما فات مصطنع', lines: [{ account: '5600', debit: 5000, credit: 0 }, { account: '1490', debit: 0, credit: 5000 }], srcType: 'asset_catchup', srcId: 'A1' });
  postEntry(db, { date: '2026-03-02', memo: 'عكسه مصطنع', lines: [{ account: '1490', debit: 5000, credit: 0 }, { account: '5600', debit: 0, credit: 5000 }], srcType: 'asset_catchup_rev', srcId: 'A1' });
  const pe = periodRevenueExpense(db, '2026-01-01', '2026-12-31');
  const cf = cashFlowFigures(db, '2026-01-01', '2026-12-31', pe.revenue - pe.expense);
  expect([cf.opCash, cf.investing]).toEqual([0, 0]);
  db.close();
});

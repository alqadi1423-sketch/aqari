/**
 * مراجعة التثبيت #14 · قائمة التدفقات النقدية تطابق تغيّر النقدية (1100) · بيانات مصطنعة:
 * إيداع المالك (تمويلي)، وتأمين مقبوض (تشغيلي عبر 2400)، وشراء أصل وإهلاكه (استثماري وغير نقدي)
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { ownerCashIn } from '@/domain/cashOps';
import { savePurchase } from '@/domain/purchases';
import { financialStatementBlock, cashFlowFigures } from '@/domain/finStatements';
import { accountPeriodChange, periodRevenueExpense } from '@/domain/accounting/ledger';

test('#١٤ صافي التغير في النقدية = تغيّر 1100 في المدة · بالأقسام الثلاثة', () => {
  const db = memDb();
  const bank = addBank(db);
  ownerCashIn(db, { amountHalalas: 100000, date: '2026-01-02' });
  const u = addUnit(db, addProperty(db, { name: 'عقار تدفقات مصطنع' }), { unit_no: 'T-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر تدفقات مصطنع', idNumber: '1000000116', phone: '0500000071',
    valueHalalas: 1200000, start: '2026-01-01', end: '2026-12-31', depositHalalas: 50000 }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  recordRentPayment(db, cid, { installmentId: insts[0], period: 'يناير', date: '2026-01-05', notes: '', discountHalalas: 0, lines: [{ method: 'bank', bankId: bank, amountHalalas: 100000 }] });
  savePurchase(db, {
    supplier: 'مورد مصطنع', date: '2026-02-15', due: '2026-02-15', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
    exempt: false, excludeFromVat: true, subtotalHalalas: 60000, taxHalalas: 0, totalHalalas: 60000,
    lines: [{ descr: 'مكيف مصطنع', qty: 1, amountHalalas: 60000, isAsset: true, category: '1410', unitId: u, room: '' }],
  });
  const from = '2026-01-01', to = '2026-12-31';
  const net = periodRevenueExpense(db, from, to).revenue - periodRevenueExpense(db, from, to).expense;
  const cf = cashFlowFigures(db, from, to, net);
  const cashChange = accountPeriodChange(db, '1100', from, to);
  expect(cf.opCash + cf.investing + cf.financing).toBe(cashChange);
  expect(cf.financing).toBe(100000);
  // والمصدَّر: سطر صافي التغير هو تغيّر النقدية
  const b = financialStatementBlock(db, 'cash', from, to);
  expect(b.totals[b.totals.length - 1][1]).toEqual({ money: cashChange });
  db.close();
});

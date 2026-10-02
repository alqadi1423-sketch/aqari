/**
 * التقارير المفصلة والسداد المقسَّم · على دورة عمل حقيقية:
 * عقد بدفعة، فاتورة شراء على الوحدة تُسدَّد مقسَّمة (نقداً + تحويل)، ثم التقارير الأربعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { savePurchase, payPurchaseSplit, unmarkPurchasePaid } from '@/domain/purchases';
import { unitReportData, propertyReportData, supplierReportData, invoicesReportData } from '@/domain/reportData';
import { saveInvoice } from '@/domain/invoices';
import { bankBalance, walletCashBalance } from '@/domain/accounting/ledger';
import { uid } from '@/domain/ids';

function seed() {
  const db = memDb();
  const pid = addProperty(db);
  const uidd = addUnit(db, pid, { unit_no: 'A-1' });
  const bank = addBank(db, 'بنك التقرير', 0);
  const cid = confirmContract(db, contractInput(uidd, {
    tenant: 'مستأجر التقرير', valueHalalas: 1200000, depositHalalas: 0,
    start: '2026-01-01', end: '2026-12-31',
  }));
  const inst = db.get<{ id: string }>(
    `SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid]
  )!;
  recordRentPayment(db, cid, {
    installmentId: inst.id, date: '2026-02-05', period: 'فبراير',
    lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '',
  });
  db.run(`INSERT INTO suppliers (id, name, category, default_category, created_at) VALUES (?,?,?,?,?)`,
    ['SUP1', 'مورد التقرير', 'صيانة', 'صيانة', new Date().toISOString()]);
  const purId = savePurchase(db, {
    supplier: 'مورد التقرير', date: '2026-02-10', due: '2026-03-10', category: 'مصروفات أخرى',
    incorpItem: '', amortize: false, amortizeMonths: null, exempt: true, excludeFromVat: false,
    unitId: uidd, propertyId: null, subtotalHalalas: 40000, taxHalalas: 0, totalHalalas: 40000, meterId: null, meterReading: null,
  });
  return { db, pid, uidd, bank, cid, purId };
}

describe('التقارير المفصلة والسداد المقسَّم', () => {
  test('سداد فاتورة مقسَّم (نقداً + تحويل): قيد واحد وحركة بنكية بقدر الشطر البنكي', () => {
    const { db, bank, purId } = seed();
    payPurchaseSplit(db, purId, [
      { method: 'cash', amountHalalas: 15000 },
      { method: 'bank', bankId: bank, amountHalalas: 25000 },
    ], '2026-02-15');
    expect(bankBalance(db, bank)).toBe(-25000); // الشطر البنكي فقط
    const p = db.get<{ paid: number; payment_method: string }>(
      `SELECT paid, payment_method FROM purchases WHERE id = ?`, [purId])!;
    expect(Number(p.paid)).toBe(1);
    expect(p.payment_method).toBe('نقداً + تحويل بنكي');
    // التراجع قيد عكسي لا إخفاء: الحركة البنكية الأصلية باقية وتقابلها معاكسة فيصفر الرصيد
    unmarkPurchasePaid(db, purId);
    expect(bankBalance(db, bank)).toBe(0);
    const txs = db.all<{ amount_halalas: number; deleted_at: string | null }>(
      `SELECT amount_halalas, deleted_at FROM bank_tx WHERE bank_id = ?`, [bank]);
    expect(txs).toHaveLength(2);
    expect(txs.every((t) => t.deleted_at === null)).toBe(true);
    expect(txs.reduce((s, t) => s + Number(t.amount_halalas), 0)).toBe(0);
    expect(Number(db.get<{ paid: number }>(`SELECT paid FROM purchases WHERE id = ?`, [purId])!.paid)).toBe(0);
    // قيد السداد باقٍ بلا deleted_at ومختوم بقيد عكس مرحّل يذكر رقم الفاتورة
    const je = db.get<{ id: string; reversed_by: string | null; deleted_at: string | null }>(
      `SELECT id, reversed_by, deleted_at FROM journal_entries WHERE src_type = 'purchase_pay' AND src_id = ?`, [purId])!;
    expect(je.deleted_at).toBeNull();
    expect(je.reversed_by).not.toBeNull();
    const rev = db.get<{ status: string; memo: string; src_type: string }>(
      `SELECT status, memo, src_type FROM journal_entries WHERE id = ?`, [je.reversed_by!])!;
    expect(rev.status).toBe('مرحّل');
    expect(rev.src_type).toBe('purchase_pay_rev');
    expect(rev.memo).toContain('عكس سداد الفاتورة');
    db.close();
  });

  test('مجموع لا يساوي الإجمالي ← رفض يسمّي الفارق', () => {
    const { db, bank, purId } = seed();
    expect(() => payPurchaseSplit(db, purId, [
      { method: 'bank', bankId: bank, amountHalalas: 10000 },
    ])).toThrow(/الفارق/);
    db.close();
  });

  test('تقرير الوحدة شامل: عقودها ومقبوضاتها ومصاريفها وصافيها', () => {
    const { db, uidd, bank, purId } = seed();
    payPurchaseSplit(db, purId, [{ method: 'bank', bankId: bank, amountHalalas: 40000 }]);
    const r = unitReportData(db, uidd, null)!;
    expect(r.unit.unit_no).toBe('A-1');
    expect(r.contracts.length).toBe(1);
    expect(r.payments.length).toBe(1);
    expect(r.expenses.length).toBe(1);
    expect(r.totals.income).toBe(100000);
    expect(r.totals.expenses).toBe(40000);
    expect(r.totals.net).toBe(60000);
    // المدة تقصّ: فترة لا تشمل الدفعة
    const r2 = unitReportData(db, uidd, '2026-03-01')!;
    expect(r2.payments.length).toBe(0);
    db.close();
  });

  test('تقرير العقار: الوحدات بمستأجرها والدخل والمصاريف مفصولة', () => {
    const { db, pid } = seed();
    const r = propertyReportData(db, pid, null)!;
    expect(r.units.length).toBe(1);
    expect(r.units[0].tenant).toBe('مستأجر التقرير');
    expect(r.occupancy.pct).toBe(100);
    expect(r.totals.income).toBe(100000);
    expect(r.totals.units).toBe(40000);
    db.close();
  });

  test('تقرير المورد: فواتيره وإجمالياته المسدَّد والمتبقي', () => {
    const { db, bank, purId } = seed();
    payPurchaseSplit(db, purId, [{ method: 'card', bankId: bank, amountHalalas: 40000 }]);
    const r = supplierReportData(db, 'SUP1', null)!;
    expect(r.purchases.length).toBe(1);
    expect(r.totals.total).toBe(40000);
    expect(r.totals.paid).toBe(40000);
    expect(r.totals.outstanding).toBe(0);
    db.close();
  });

  test('تقرير الفواتير: الصفوف والإجماليات حسب الحالة', () => {
    const { db } = seed();
    saveInvoice(db, {
      customer: 'عميل', customerVat: '', issue: '2026-02-01', due: '2026-03-01', notes: '',
      lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 50000, taxPct: 15 }],
    }, 'مستحقة');
    const r = invoicesReportData(db, null);
    expect(r.grand.count).toBe(1);
    expect(r.byStatus.find((s) => s.status === 'مستحقة')?.count).toBe(1);
    db.close();
  });

  test('الشمول الجديد: أقساط الوحدة وصافي كل وحدة وفئات المورد وعملاء الفواتير', () => {
    const { db, pid, uidd } = seed();
    const u = unitReportData(db, uidd, null)!;
    // ١٢ قسطاً على العقد، المحصَّل منها ١٬٠٠٠٫٠٠
    expect(u.installments.count).toBe(12);
    expect(u.installments.collected).toBe(100000);
    expect(u.installments.outstanding).toBeGreaterThan(0);
    const pr = propertyReportData(db, pid, null)!;
    const pu = pr.perUnit.find((x) => x.unit_no === 'A-1')!;
    expect(pu.income).toBe(100000);
    expect(pu.expenses).toBe(40000);
    expect(pu.net).toBe(60000);
    const sr = supplierReportData(db, 'SUP1', null)!;
    expect(sr.byCategory).toEqual([{ category: 'مصروفات أخرى', count: 1, total: 40000 }]);
    saveInvoice(db, {
      customer: 'عميل التجميع', customerVat: '', issue: '2026-02-01', due: '2026-03-01', notes: '',
      lines: [{ descr: 'خدمة', qty: 2, priceHalalas: 25000, taxPct: 15 }],
    }, 'مستحقة');
    const ir = invoicesReportData(db, null);
    expect(ir.byCustomer[0].customer).toBe('عميل التجميع');
    expect(ir.byCustomer[0].count).toBe(1);
    db.close();
  });

  test('المحفظة النقدية: المقبوض نقداً حاضر والمدفوع نقداً يخصم', () => {
    const { db, purId } = seed();
    expect(walletCashBalance(db)).toBe(100000); // دفعة الإيجار النقدية
    payPurchaseSplit(db, purId, [{ method: 'cash', amountHalalas: 40000 }]);
    expect(walletCashBalance(db)).toBe(60000);
    db.close();
  });
});

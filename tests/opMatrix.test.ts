/**
 * جدول العمليات والجداول (docs/PERMISSIONS.md §٣) · يشغّل كل عملية من عمليات الخدمة بقسمها
 * ويقرأ صندوق الصادر: ما أنشأته وما عدّلته (بأعمدته) وما حذفته. فلا يُكتب جدول القواعد باليد،
 * وكل عملية تكتب ما ليس في OP_WRITES تُسقط هذا الاختبار.
 */
import { memDb } from './helpers/testDb';
import { SYNC_TABLES } from '@/db/syncTables';
import { setCapture, setSyncState } from '@/sync/engine';
import type { DB } from '@/db/adapter';
import type { SectionKey } from '@/domain/access/sections';
import { OP_WRITES, opAllows } from '@/domain/access/opWrites';
import { saveProperty, saveUnit, bulkAddUnits, toggleUnitMaintenance } from '@/domain/propertiesService';
import { createReservation, cancelReservation } from '@/domain/reservations';
import {
  saveDraft, confirmContract, recordRentPayment, renewContract, cancelContract,
  saveDepositSettlement, saveTenantRating, recordBulkRentPayment, setInstallmentSchedule,
} from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { saveClaim, collectClaim, deleteClaim } from '@/domain/claims';
import { saveInvoice, setInvoiceStatus, payInvoice, deleteInvoice } from '@/domain/invoices';
import { savePurchase, payPurchase, unmarkPurchasePaid, deletePurchase } from '@/domain/purchases';
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { depositCashToBank, transferBetweenBanks, pettyCashExpense, ownerCashIn, ownerCashOut } from '@/domain/cashOps';
import { addOccupant, markOccupantLeft } from '@/domain/occupants';
import { createHandoverForContract, lockHandover } from '@/domain/handover/service';
import { postEntry, reverseEntryById } from '@/domain/accounting/post';
import { supplierMeters } from '@/domain/meters';
import { today, addDays } from '@/domain/dates';
import { uid } from '@/domain/ids';

type Seen = Map<SectionKey, Map<string, { create: boolean; update: Set<string>; del: boolean }>>;

function snapshot(db: DB): Map<string, Map<string, Record<string, unknown>>> {
  const out = new Map<string, Map<string, Record<string, unknown>>>();
  for (const t of SYNC_TABLES) {
    const m = new Map<string, Record<string, unknown>>();
    for (const r of db.all<Record<string, unknown>>(`SELECT *, ${t.pk(t.name)} AS __pk FROM ${t.name}`)) m.set(String(r.__pk), r);
    out.set(t.name, m);
  }
  return out;
}

function tracker(db: DB) {
  const seen: Seen = new Map();
  const track = <T>(op: SectionKey, fn: () => T): T => {
    db.run(`DELETE FROM sync_outbox`);
    const before = snapshot(db);
    const r = fn();
    const after = snapshot(db);
    const rows = db.all<{ tbl: string; pk: string; op: string }>(`SELECT tbl, pk, op FROM sync_outbox`);
    const bySec = seen.get(op) ?? new Map();
    seen.set(op, bySec);
    for (const o of rows) {
      const e = bySec.get(o.tbl) ?? { create: false, update: new Set<string>(), del: false };
      bySec.set(o.tbl, e);
      const prev = before.get(o.tbl)?.get(o.pk);
      const next = after.get(o.tbl)?.get(o.pk);
      if (o.op === 'delete') { e.del = true; continue; }
      if (!prev) { e.create = true; continue; }
      if (!next) continue;
      for (const k of Object.keys(next)) if (k !== '__pk' && prev[k] !== next[k]) e.update.add(k);
    }
    return r;
  };
  return { seen, track };
}

test('كل عملية تكتب ما يجيزه جدول OP_WRITES لقسمها وحده', () => {
  const db = memDb();
  setSyncState(db, 'uid', 'U-matrix');
  setCapture(db, true);
  const { seen, track } = tracker(db);
  const T = today();

  const propertyId = track('props', () => saveProperty(db, {
    name: 'برج المصفوفة', address: 'عنوان تجريبي', floors: 2, activityType: 'سكني', activitySubtype: '',
    ownership: 'ملك', deedNo: '', leaseValueHalalas: null, leaseCycle: null, leaseStart: null, leaseEnd: null,
    opRate: null, lat: null, lng: null, floorCategories: {}, areas: [{ name: 'المدخل', items: [{ name: 'باب', descr: '' }] }], meters: [],
  }));
  const supplierId = uid();
  track('purchases', () => db.run(`INSERT INTO suppliers (id, name, utility_type, created_at) VALUES (?,?,?,?)`,
    [supplierId, 'مورد كهرباء تجريبي', 'كهرباء', new Date().toISOString()]));
  const unit1 = track('props', () => saveUnit(db, {
    propertyId, unitNo: 'A-1', floor: 'الأرضي', type: 'سكني', subtype: 'عوائل', rentMonthlyHalalas: 250000,
    rooms: [{ name: 'الصالة', items: [{ name: 'مكيف', descr: '' }] }], meters: [{ kind: 'كهرباء', number: 'E-1', supplierId }],
  }));
  track('props', () => bulkAddUnits(db, propertyId, 2, { prefix: 'B-', start: 1, floor: 'الطابق 1', type: 'سكني', subtype: 'عوائل', rentHalalas: 200000 }));
  track('maintenance', () => toggleUnitMaintenance(db, unit1));
  track('maintenance', () => toggleUnitMaintenance(db, unit1));
  const bankId = uid();
  track('banks', () => db.run(`INSERT INTO banks (id, name, opening_halalas, opening_date, created_at) VALUES (?,?,?,?,?)`,
    [bankId, 'بنك تجريبي', 1000000, T, new Date().toISOString()]));

  const resId = track('reservations', () => createReservation(db, { unitId: unit1, name: 'مستأجر تجريبي', phone: '0500000001', depositHalalas: 100000, expiryDate: addDays(T, 30) }));
  const input = {
    tenant: 'مستأجر تجريبي', phone: '0500000001', idNumber: '1000000009', unitId: unit1, valueHalalas: 3000000, cycle: 'شهرية',
    start: T, end: addDays(T, 364), depositHalalas: 300000, ejarNo: '', services: '', furnished: 'غير مؤثثة', typeSpecific: {},
  };
  const contractId = track('contracts', () => saveDraft(db, input));
  track('contracts', () => confirmContract(db, { ...input, reservationId: resId }, contractId));
  const insts = db.all<{ id: string; amount_halalas: number }>(`SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [contractId]);
  const pay1 = track('collect', () => recordRentPayment(db, contractId, {
    installmentId: insts[0].id, period: 'الأول', date: T, lines: [{ method: 'bank', bankId, amountHalalas: 100000 }], discountHalalas: 0, notes: '',
  }));
  track('collect', () => recordBulkRentPayment(db, contractId, { installmentIds: [insts[1].id, insts[2].id], date: T, lines: [{ method: 'cash', amountHalalas: Number(insts[1].amount_halalas) + Number(insts[2].amount_halalas) }], notes: '' }));
  track('collect', () => cancelPayment(db, pay1, { reason: 'خطأ إدخال' }));
  // موعد السداد المتفق عليه ومهلته من شاشة القسط بصلاحية التحصيل (مراجعة التثبيت #38)
  track('collect', () => setInstallmentSchedule(db, insts[3].id, { agreedDate: addDays(T, 20), graceUntil: addDays(T, 25), reason: 'اتفاق مصطنع' }));
  track('contracts', () => addOccupant(db, contractId, { name: 'ساكن تجريبي', nationalId: '2000000001', relation: 'أخرى', movedIn: T }));
  const occ = db.get<{ id: string }>(`SELECT id FROM occupants WHERE contract_id = ? AND name = 'ساكن تجريبي'`, [contractId]);
  if (occ) track('contracts', () => markOccupantLeft(db, occ.id, T));
  const hid = track('handover', () => createHandoverForContract(db, contractId));
  if (hid) track('handover', () => lockHandover(db, hid));

  // عقد ثانٍ ينتهي ← تجديد ← إلغاء بتسوية
  const unit2 = db.get<{ id: string }>(`SELECT id FROM units WHERE property_id = ? AND unit_no = 'B-1'`, [propertyId])!.id;
  const c2 = track('contracts', () => confirmContract(db, { ...input, tenant: 'مستأجر ثانٍ', phone: '0500000002', idNumber: '1000000017', unitId: unit2, start: addDays(T, -335), end: addDays(T, 30), depositHalalas: 150000 }));
  const c3 = track('contracts', () => renewContract(db, c2, {
    start: addDays(T, 31), end: addDays(addDays(T, 31), 364), valueHalalas: 3300000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 50000, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '',
  }));
  track('contracts', () => cancelContract(db, c3, {
    date: addDays(T, 40), reason: 'إخلال', installmentsFate: 'cancel', settle: true, deductionHalalas: 250000, refundHalalas: 0, deductionReason: 'أضرار',
  }));
  const autoClaim = db.get<{ id: string }>(`SELECT id FROM claims WHERE contract_id = ?`, [c3])!;
  track('claims', () => collectClaim(db, autoClaim.id));
  const manual = track('claims', () => saveClaim(db, { contractId, amountHalalas: 20000, reason: 'كسر', date: T }));
  track('claims', () => deleteClaim(db, manual));

  // عقد ثالث منتهٍ ← تسوية تأمين وتقييم
  const unit3 = db.get<{ id: string }>(`SELECT id FROM units WHERE property_id = ? AND unit_no = 'B-2'`, [propertyId])!.id;
  const c4 = track('contracts', () => confirmContract(db, { ...input, tenant: 'مستأجر ثالث', phone: '0500000003', idNumber: '1000000025', unitId: unit3, start: addDays(T, -400), end: addDays(T, -35), depositHalalas: 100000 }));
  track('deposits', () => saveDepositSettlement(db, c4, { date: T, deductionHalalas: 20000, deductionReason: 'تنظيف', refundHalalas: 80000, notes: '' }));
  track('contracts', () => saveTenantRating(db, c4, { onTime: 'ممتاز', paymentCommit: 'ممتاز', contractCommit: 'ممتاز', unitCondition: 'ممتاز', neighborComplaints: 'لا', notes: '' }));

  // الفواتير
  const invId = track('invoices', () => saveInvoice(db, { customer: 'عميل تجريبي', customerVat: '', issue: T, due: addDays(T, 30), notes: '', lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 50000, taxPct: 15 }] }, 'مسودة'));
  track('invoices', () => setInvoiceStatus(db, invId, 'مستحقة'));
  track('invoices', () => payInvoice(db, invId, { method: 'bank', bankId, date: T }));
  const inv2 = track('invoices', () => saveInvoice(db, { customer: 'عميل تجريبي', customerVat: '', issue: T, due: T, notes: '', lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 1000, taxPct: 0 }] }, 'مسودة'));
  track('invoices', () => deleteInvoice(db, inv2));

  // المشتريات
  const meterId = supplierMeters(db, supplierId)[0].id;
  const purId = track('purchases', () => savePurchase(db, {
    supplier: 'مورد كهرباء تجريبي', date: T, due: addDays(T, 10), category: 'كهرباء', incorpItem: '', amortize: false, amortizeMonths: null,
    exempt: false, excludeFromVat: false, unitId: unit1, propertyId, subtotalHalalas: 40000, taxHalalas: 6000, totalHalalas: 46000, meterId, meterReading: 5230,
  }));
  track('purchases', () => payPurchase(db, purId, 'bank', bankId, T));
  track('purchases', () => unmarkPurchasePaid(db, purId));
  track('purchases', () => deletePurchase(db, purId));

  // التقبيل
  track('reservations', () => recordKeyMoneyDeal(db, { unitId: unit1, contractId, outgoing: 'مستأجر تجريبي', incoming: 'قادم تجريبي', amountHalalas: 500000, date: T, commissionHalalas: 25000, method: 'bank', bankId, notes: '' }));
  const res2 = track('reservations', () => createReservation(db, { unitId: unit3, name: 'حاجز تجريبي', phone: '0500000004', depositHalalas: 50000, expiryDate: addDays(T, 10) }));
  track('reservations', () => cancelReservation(db, res2, true));

  // البنوك والنقد
  const bank2 = uid();
  track('banks', () => db.run(`INSERT INTO banks (id, name, opening_halalas, opening_date, created_at) VALUES (?,?,?,?,?)`, [bank2, 'بنك ثانٍ تجريبي', 0, T, new Date().toISOString()]));
  track('banks', () => ownerCashIn(db, { amountHalalas: 100000, date: T }));
  track('banks', () => depositCashToBank(db, { bankId, amountHalalas: 50000, date: T }));
  track('banks', () => transferBetweenBanks(db, { fromBankId: bankId, toBankId: bank2, amountHalalas: 10000, date: T }));
  track('banks', () => pettyCashExpense(db, { amountHalalas: 1000, descr: 'مصروف نثري', date: T }));
  track('banks', () => ownerCashOut(db, { amountHalalas: 1000, date: T }));

  // الدفتر
  const je = track('ledger', () => postEntry(db, { date: T, memo: 'قيد يدوي تجريبي', lines: [{ account: '1100', debit: 1000, credit: 0 }, { account: '3100', debit: 0, credit: 1000 }] }));
  track('ledger', () => reverseEntryById(db, je!.id, 'تجربة'));

  const report: Record<string, Record<string, string>> = {};
  const offending: string[] = [];
  for (const [op, tbls] of seen) {
    report[op] = {};
    for (const [t, e] of tbls) {
      report[op][t] = [e.create ? 'C' : '', e.update.size ? 'U(' + [...e.update].sort().join(',') + ')' : '', e.del ? 'D' : ''].filter(Boolean).join(' ');
      if (e.create && !opAllows(op, t, 'create')) offending.push(`${op} ينشئ ${t}`);
      if (e.update.size && !opAllows(op, t, 'update', [...e.update])) offending.push(`${op} يعدّل ${t}: ${[...e.update].join(',')}`);
      if (e.del && !opAllows(op, t, 'delete')) offending.push(`${op} يحذف ${t}`);
    }
  }
  if (process.env.OP_MATRIX_PRINT) console.log(JSON.stringify(report, null, 1));
  expect(offending).toEqual([]);
  expect(Object.keys(OP_WRITES).length).toBeGreaterThan(0);
});

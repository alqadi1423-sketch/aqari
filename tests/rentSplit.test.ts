/**
 * فصل إيراد العقد (قرار المالك ٢٠٢٦-١٠-٠٧ · الهجرة ٣٢): قيمة العقد «كامل قيمة الإيجار»، والخدمات والمواقف فوقها،
 * وإجمالي العقد مجموع الثلاثة وهو مجموع الأقساط. الإيراد يُقسم بنسبتها من الإجمالي على 4200 و4210 و4220 ·
 * والعقد بلا تفصيل كله إيجار · ومراجعة الدفتر تعدّ الثلاثة معاً · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import type { DB } from '@/db/adapter';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { accountMovement } from '@/domain/accounting/ledger';
import { planLedgerRepair } from '@/domain/ledgerReview';
import { rentSplit } from '@/domain/accounting/rentSplit';
import { revenueSplitOf } from '@/domain/pdf/ejarExtras';
import { contractCancelledValue } from '@/domain/stats';

const credit = (db: DB, code: string) => { const m = accountMovement(db, code, null, null); return m.credit - m.debit; };
const insts = (db: DB, c: string) => db.all<{ id: string; due_date: string; amount_halalas: number }>(
  `SELECT id, due_date, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);

function world(valueHalalas: number, split: { servicesHalalas?: number; parkingHalalas?: number }) {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار فصل الإيراد' }), { unit_no: 'S-1' });
  const c = confirmContract(db, { ...contractInput(u, { tenant: 'مستأجر فصل مصطنع', idNumber: '1000007001', phone: '0500007001', depositHalalas: 0, start: '2026-01-01', end: '2026-12-31', valueHalalas, cycle: 'شهرية' } as never), ...split });
  return { db, c };
}

test('الإيجار أربعة آلاف وثمانمئة والخدمات تسعمئة والمواقف ثلاثمئة: الأقساط من الإجمالي، والتحصيل يُقسم بالنسبة', () => {
  const { db, c } = world(480000, { servicesHalalas: 90000, parkingHalalas: 30000 });
  const rows = insts(db, c);
  expect(rows.reduce((s, r) => s + r.amount_halalas, 0)).toBe(600000);
  const i = rows[0];
  expect(i.amount_halalas).toBe(50000);
  recordRentPayment(db, c, { installmentId: i.id, period: i.due_date, date: i.due_date, lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  expect(credit(db, '4210')).toBe(7500);
  expect(credit(db, '4220')).toBe(2500);
  expect(credit(db, '4200')).toBe(40000);
  // مراجعة الدفتر لا ترى فرقاً: المحصَّل من الحسابات الثلاثة
  expect(planLedgerRepair(db).changes).toEqual([]);
});

test('العقد بلا تفصيل: الأقساط من قيمته والإيراد كله إيجار كما كان', () => {
  const { db, c } = world(600000, {});
  const rows = insts(db, c);
  expect(rows.reduce((s, r) => s + r.amount_halalas, 0)).toBe(600000);
  recordRentPayment(db, c, { installmentId: rows[0].id, period: rows[0].due_date, date: rows[0].due_date, lines: [{ method: 'cash', amountHalalas: 50000 }], discountHalalas: 0, notes: '' });
  expect([credit(db, '4200'), credit(db, '4210'), credit(db, '4220')]).toEqual([50000, 0, 0]);
});

test('الهللات الباقية على الإيجار فيطابق المجموع المحصَّل · والنسبة من الإجمالي', () => {
  const { db, c } = world(600000, { servicesHalalas: 100000, parkingHalalas: 100000 });
  const sp = rentSplit(db, c, 10001);
  expect(sp.rent + sp.services + sp.parking).toBe(10001);
  expect(sp.services).toBe(Math.floor((10001 * 100000) / 800000));
});

test('العقد الملغى بلا أقساط: قيمته الملغاة من إجماليه', () => {
  const { db, c } = world(480000, { servicesHalalas: 90000, parkingHalalas: 30000 });
  db.run(`DELETE FROM contract_installments WHERE contract_id = ?`, [c]);
  expect(contractCancelledValue(db, { id: c, status: 'ملغى', value_halalas: 480000 })).toBe(600000);
});

test('الخدمات والمواقف من بيانات العقد المقروءة: الخدمات مجموع الثلاثة، والمواقف الباقي بعد الإيجار والخدمات', () => {
  expect(revenueSplitOf({ property: {}, unit: {}, tenant: {}, lessor: {}, meters: [], rooms: [], acUnits: [], financial: { totalValue: 690000, rentValue: 600000, gas: 0, electricity: 60000, water: 30000 } }))
    .toEqual({ servicesHalalas: 90000, parkingHalalas: 0 });
  expect(revenueSplitOf({ property: {}, unit: {}, tenant: {}, lessor: {}, meters: [], rooms: [], acUnits: [], financial: { totalValue: 600000, rentValue: 600000 } })).toEqual({});
  expect(revenueSplitOf(null)).toEqual({});
});

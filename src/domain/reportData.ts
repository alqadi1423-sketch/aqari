/**
 * مجمّعات بيانات التقارير المفصلة · وحدة / عقار / مورد / فواتير ·
 * كلٌّ بمدة قابلة للتحديد (from فارغ = من البداية) وشامل لتفاصيل نوعه،
 * وتُغذّي تصدير PDF وإكسل من مصدر واحد.
 */
import type { DB } from '../db/adapter';
import { today } from './dates';
import { contractStatusLabel } from './contracts/rules';
import { contractTotalSql } from './accounting/rentSplit';

const period = (col: string, from: string | null, to: string) =>
  ` AND (${from ? `${col} >= '${from}' AND ` : ''}${col} <= '${to}')`;

export interface UnitReport {
  unit: { unit_no: string; floor: string; type: string; subtype: string; rent_monthly_halalas: number };
  propertyName: string;
  contracts: Array<{ contract_no: string | null; tenant_name: string; start: string | null; end: string | null; value_halalas: number; total_halalas: number; services_halalas: number; parking_halalas: number; status: string }>;
  payments: Array<{ date: string; period: string; method_label: string; net_halalas: number; tenant_name: string }>;
  expenses: Array<{ date: string; supplier_name: string; category: string; total_halalas: number; paid: number }>;
  handoversCount: number;
  installments: { count: number; due: number; collected: number; outstanding: number };
  meters: Array<{ kind: string; number: string; supplier: string }>;
  totals: { income: number; expenses: number; net: number };
}

export function unitReportData(db: DB, unitId: string, from: string | null, to: string = today()): UnitReport | null {
  const unit = db.get<UnitReport['unit'] & { property_id: string }>(
    `SELECT unit_no, floor, type, subtype, rent_monthly_halalas, property_id FROM units WHERE id = ?`, [unitId]
  );
  if (!unit) return null;
  const propertyName = db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [unit.property_id])?.name ?? 'لا يوجد';
  // حالة العقد في التقرير محسوبة كما تظهر في الشاشات · لا المخزّنة الخام
  const contracts = db.all<UnitReport['contracts'][number]>(
    `SELECT contract_no, tenant_name, start, end, value_halalas, ${contractTotalSql(db)} AS total_halalas,
            ${contractTotalSql(db) === 'value_halalas' ? '0 AS services_halalas, 0 AS parking_halalas' : 'services_halalas, parking_halalas'}, status FROM contracts
     WHERE unit_id = ? AND deleted_at IS NULL ORDER BY COALESCE(start,'') DESC`, [unitId]
  ).map((c) => ({ ...c, status: contractStatusLabel(c) }));
  const payments = db.all<UnitReport['payments'][number]>(
    `SELECT p.date, p.period, p.method_label, p.net_halalas, c.tenant_name
     FROM contract_payments p JOIN contracts c ON c.id = p.contract_id
     WHERE p.cancelled_at IS NULL AND c.unit_id = ?${period('p.date', from, to)}
     ORDER BY p.date DESC`, [unitId]
  );
  const expenses = db.all<UnitReport['expenses'][number]>(
    `SELECT date, supplier_name, category, total_halalas, paid FROM purchases
     WHERE unit_id = ? AND deleted_at IS NULL${period('date', from, to)}
     ORDER BY date DESC`, [unitId]
  );
  const handoversCount = Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM handovers WHERE unit_id = ? AND deleted_at IS NULL`, [unitId]
  )!.n);
  const instRow = db.get<{ n: number; due: number; collected: number }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN i.due_date <= '${to}' AND i.status != 'ملغية' THEN i.amount_halalas ELSE 0 END),0) AS due,
            COALESCE(SUM(CASE WHEN i.status != 'ملغية' THEN i.paid_halalas ELSE 0 END),0) AS collected
     FROM contract_installments i JOIN contracts c ON c.id = i.contract_id
     WHERE c.unit_id = ? AND c.deleted_at IS NULL AND c.status NOT IN ('مسودة','ملغى')`, [unitId]
  )!;
  const installments = {
    count: Number(instRow.n), due: Number(instRow.due), collected: Number(instRow.collected),
    outstanding: Math.max(0, Number(instRow.due) - Number(instRow.collected)),
  };
  const unitMeters = db.all<{ kind: string; number: string; supplier: string }>(
    `SELECT m.kind, m.number, COALESCE(sp.name,'لا يوجد') AS supplier FROM meters m
     LEFT JOIN suppliers sp ON sp.id = m.supplier_id
     WHERE m.owner_type = 'unit' AND m.owner_id = ? AND m.deleted_at IS NULL`, [unitId]
  );
  const income = payments.reduce((s, p) => s + Number(p.net_halalas), 0);
  const exp = expenses.reduce((s, e) => s + Number(e.total_halalas), 0);
  return { unit, propertyName, contracts, payments, expenses, handoversCount, installments, meters: unitMeters, totals: { income, expenses: exp, net: income - exp } };
}

export interface PropertyReport {
  property: { name: string; address: string; ownership: string; deed_no: string; floors: number | null };
  units: Array<{ unit_no: string; floor: string; type: string; rent_monthly_halalas: number; tenant: string | null }>;
  occupancy: { total: number; occupied: number; pct: number };
  payments: Array<{ date: string; period: string; net_halalas: number; tenant_name: string; unit_label: string; unit_no: string }>;
  sharedExpenses: Array<{ date: string; supplier_name: string; category: string; total_halalas: number }>;
  unitExpenses: Array<{ date: string; supplier_name: string; category: string; total_halalas: number; unit_no: string }>;
  perUnit: Array<{ unit_no: string; income: number; expenses: number; net: number }>;
  totals: { income: number; shared: number; units: number; net: number };
}

export function propertyReportData(db: DB, propertyId: string, from: string | null, to: string = today()): PropertyReport | null {
  const property = db.get<PropertyReport['property']>(
    `SELECT name, address, ownership, deed_no, floors FROM properties WHERE id = ?`, [propertyId]
  );
  if (!property) return null;
  const T = today();
  const units = db.all<PropertyReport['units'][number] & { id: string }>(
    `SELECT u.id, u.unit_no, u.floor, u.type, u.rent_monthly_halalas,
            (SELECT c.tenant_name FROM contracts c
             WHERE c.unit_id = u.id AND c.deleted_at IS NULL AND c.status NOT IN ('مسودة','ملغى')
               AND c.start <= '${T}' AND c.end >= '${T}' LIMIT 1) AS tenant
     FROM units u WHERE u.property_id = ? AND u.deleted_at IS NULL
     ORDER BY COALESCE(u.unit_no_key, u.unit_no), u.unit_no`, [propertyId]
  );
  const occupied = units.filter((u) => u.tenant).length;
  const payments = db.all<PropertyReport['payments'][number]>(
    `SELECT p.date, p.period, p.net_halalas, c.tenant_name, c.unit_label, u.unit_no
     FROM contract_payments p JOIN contracts c ON c.id = p.contract_id
     JOIN units u ON u.id = c.unit_id
     WHERE u.property_id = ? AND p.cancelled_at IS NULL${period('p.date', from, to)}
     ORDER BY p.date DESC`, [propertyId]
  );
  const sharedExpenses = db.all<PropertyReport['sharedExpenses'][number]>(
    `SELECT date, supplier_name, category, total_halalas FROM purchases
     WHERE property_id = ? AND unit_id IS NULL AND deleted_at IS NULL${period('date', from, to)}
     ORDER BY date DESC`, [propertyId]
  );
  const unitExpenses = db.all<PropertyReport['unitExpenses'][number]>(
    `SELECT pu.date, pu.supplier_name, pu.category, pu.total_halalas, u.unit_no
     FROM purchases pu JOIN units u ON u.id = pu.unit_id
     WHERE u.property_id = ? AND pu.deleted_at IS NULL${period('pu.date', from, to)}
     ORDER BY pu.date DESC`, [propertyId]
  );
  const income = payments.reduce((s, p) => s + Number(p.net_halalas), 0);
  const shared = sharedExpenses.reduce((s, e) => s + Number(e.total_halalas), 0);
  const unitsExp = unitExpenses.reduce((s, e) => s + Number(e.total_halalas), 0);
  const perUnitMap = new Map<string, { income: number; expenses: number }>();
  for (const u of units) perUnitMap.set(u.unit_no, { income: 0, expenses: 0 });
  for (const p2 of payments) {
    const k = p2.unit_no;
    const cur = perUnitMap.get(k) ?? { income: 0, expenses: 0 };
    cur.income += Number(p2.net_halalas); perUnitMap.set(k, cur);
  }
  for (const e of unitExpenses) {
    const cur = perUnitMap.get(e.unit_no) ?? { income: 0, expenses: 0 };
    cur.expenses += Number(e.total_halalas); perUnitMap.set(e.unit_no, cur);
  }
  const perUnit = [...perUnitMap.entries()].map(([unit_no, v]) => ({
    unit_no, income: v.income, expenses: v.expenses, net: v.income - v.expenses,
  }));
  return {
    property, units, payments, sharedExpenses, unitExpenses, perUnit,
    occupancy: { total: units.length, occupied, pct: units.length ? Math.round((occupied / units.length) * 100) : 0 },
    totals: { income, shared, units: unitsExp, net: income - shared - unitsExp },
  };
}

export interface SupplierReport {
  supplier: { name: string; vat: string; phone: string; category: string; utility_type: string };
  meters: Array<{ kind: string; number: string; label: string }>;
  purchases: Array<{ no: string; date: string; category: string; total_halalas: number; paid: number; target: string }>;
  byCategory: Array<{ category: string; count: number; total: number }>;
  totals: { count: number; total: number; paid: number; outstanding: number };
}

export function supplierReportData(db: DB, supplierId: string, from: string | null, to: string = today()): SupplierReport | null {
  const supplier = db.get<SupplierReport['supplier'] & { id: string }>(
    `SELECT id, name, vat, phone, category, utility_type FROM suppliers WHERE id = ?`, [supplierId]
  );
  if (!supplier) return null;
  const meters = db.all<{ kind: string; number: string; owner_type: string; owner_id: string }>(
    `SELECT kind, number, owner_type, owner_id FROM meters WHERE supplier_id = ? AND deleted_at IS NULL`, [supplierId]
  ).map((m) => {
    const label = m.owner_type === 'property'
      ? (db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [m.owner_id])?.name ?? 'لا يوجد') + ' (مشترك)'
      : 'وحدة ' + (db.get<{ unit_no: string }>(`SELECT unit_no FROM units WHERE id = ?`, [m.owner_id])?.unit_no ?? 'لا يوجد');
    return { kind: m.kind, number: m.number, label };
  });
  const purchases = db.all<{ no: string; date: string; category: string; total_halalas: number; paid: number; unit_id: string | null; property_id: string | null }>(
    `SELECT no, date, category, total_halalas, paid, unit_id, property_id FROM purchases
     WHERE supplier_name = (SELECT name FROM suppliers WHERE id = ?) AND deleted_at IS NULL${period('date', from, to)}
     ORDER BY date DESC`, [supplierId]
  ).map((p) => {
    const target = p.unit_id
      ? 'وحدة ' + (db.get<{ unit_no: string }>(`SELECT unit_no FROM units WHERE id = ?`, [p.unit_id])?.unit_no ?? 'لا يوجد')
      : p.property_id
        ? (db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [p.property_id])?.name ?? 'لا يوجد')
        : 'لا يوجد';
    return { no: p.no, date: p.date, category: p.category, total_halalas: p.total_halalas, paid: p.paid, target };
  });
  const total = purchases.reduce((s, p) => s + Number(p.total_halalas), 0);
  const paid = purchases.filter((p) => Number(p.paid)).reduce((s, p) => s + Number(p.total_halalas), 0);
  const catMap = new Map<string, { count: number; total: number }>();
  for (const p2 of purchases) {
    const cur = catMap.get(p2.category) ?? { count: 0, total: 0 };
    cur.count += 1; cur.total += Number(p2.total_halalas); catMap.set(p2.category, cur);
  }
  const byCategory = [...catMap.entries()].map(([category, v]) => ({ category, ...v }));
  return { supplier, meters, purchases, byCategory, totals: { count: purchases.length, total, paid, outstanding: total - paid } };
}

export interface InvoicesReport {
  rows: Array<{ no: string; customer_name: string; issue: string; due: string; status: string; total_halalas: number }>;
  byStatus: Array<{ status: string; count: number; total: number }>;
  byCustomer: Array<{ customer: string; count: number; total: number }>;
  grand: { count: number; total: number };
}

export function invoicesReportData(db: DB, from: string | null, to: string = today()): InvoicesReport {
  const rows = db.all<InvoicesReport['rows'][number]>(
    `SELECT no, customer_name, issue, due, status, total_halalas FROM invoices
     WHERE deleted_at IS NULL${period('issue', from, to)}
     ORDER BY issue DESC, created_at DESC`
  );
  const map = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    const cur = map.get(r.status) ?? { count: 0, total: 0 };
    cur.count += 1;
    cur.total += Number(r.total_halalas);
    map.set(r.status, cur);
  }
  const byStatus = [...map.entries()].map(([status, v]) => ({ status, ...v }));
  const custMap = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    const cur = custMap.get(r.customer_name) ?? { count: 0, total: 0 };
    cur.count += 1; cur.total += Number(r.total_halalas); custMap.set(r.customer_name, cur);
  }
  const byCustomer = [...custMap.entries()].map(([customer, v]) => ({ customer, ...v }))
    .sort((a, b) => b.total - a.total);
  return {
    rows, byStatus, byCustomer,
    grand: { count: rows.length, total: rows.reduce((s, r) => s + Number(r.total_halalas), 0) },
  };
}

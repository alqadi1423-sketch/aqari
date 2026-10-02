/**
 * الإحصاءات المشتقة لشاشات الرئيسية والتحصيل والعقارات · كلها استعلامات، لا شيء مخزَّن.
 */
import type { DB } from '../db/adapter';
import { today, daysBetween } from './dates';
import { unitActiveReservation, unitCurrentContract, expireOldReservations } from './contracts/rules';
import { INSTALLMENT_DISCOUNT_SQL, installmentRemaining } from './contracts/installments';

export interface InstallmentView {
  installmentId: string;
  contractId: string;
  contractNo: string | null;
  contractStatus: string;
  tenant: string;
  phone: string;
  unitId: string;
  unitNo: string;
  dueDate: string;
  amount: number;
  paid: number;
  /** خصمٌ مُنح على القسط · مشتقّ من دفعاته · يُعرض بنداً ولا يُطوى في المسدَّد */
  discount: number;
  remaining: number;
  /** أيام التأخير (موجب = متأخرة) */
  daysLate: number;
  status: string;
  /** الحالة المعروضة مع عدد أيام التأخير */
  displayStatus: string;
  cls: 'paid' | 'due' | 'late' | 'mut';
  /** موعد سداد متفق عليه يحل محل الاستحقاق · ومهلة لا يُحتسب متأخراً قبلها */
  agreedDate: string | null;
  graceUntil: string | null;
  effectiveDue: string;
}

/** كل الأقساط (لغير المسودات) · أساس شاشة التحصيل المبنية على الدفعة لا الشخص */
export function allInstallments(db: DB, T: string = today()): InstallmentView[] {
  const rows = db.all<{
    installmentId: string; contractId: string; contractNo: string | null; contractStatus: string;
    tenant: string; phone: string; unitId: string; unitNo: string;
    dueDate: string; amount: number; paid: number; discount: number; status: string;
    agreedDate: string | null; graceUntil: string | null;
  }>(
    `SELECT i.id AS installmentId, c.id AS contractId, c.contract_no AS contractNo,
            c.status AS contractStatus, c.tenant_name AS tenant, c.phone AS phone,
            c.unit_id AS unitId, COALESCE(u.unit_no,'') AS unitNo,
            i.due_date AS dueDate, i.amount_halalas AS amount, i.paid_halalas AS paid,
            ${INSTALLMENT_DISCOUNT_SQL} AS discount,
            i.status AS status, i.agreed_date AS agreedDate, i.grace_until AS graceUntil
     FROM contract_installments i
     JOIN contracts c ON c.id = i.contract_id
     LEFT JOIN units u ON u.id = c.unit_id
     WHERE c.status != 'مسودة' AND c.deleted_at IS NULL
     ORDER BY COALESCE(i.agreed_date, i.due_date)`
  );
  return rows.map((r) => {
    const amount = Number(r.amount);
    const paid = Number(r.paid);
    const discount = Number(r.discount);
    // المتبقّي = القسط ناقص المسدَّد ناقص الخصم · قسطٌ خُصم بقيته ليس متأخراً
    const remaining = installmentRemaining(amount, paid, discount);
    // الموعد المتفق عليه يحل محل الاستحقاق · والمهلة تمنع احتساب التأخر قبلها
    const effectiveDue = r.agreedDate || r.dueDate;
    let daysLate = effectiveDue ? daysBetween(T, effectiveDue) : 0;
    if (r.graceUntil && T <= r.graceUntil) daysLate = Math.min(daysLate, 0);
    let displayStatus: string;
    let cls: InstallmentView['cls'];
    if (r.status === 'ملغية') { displayStatus = 'ملغاة'; cls = 'mut'; }
    else if (remaining <= 0) { displayStatus = 'مدفوعة'; cls = 'paid'; }
    else if (paid > 0 && daysLate > 0) { displayStatus = 'مدفوعة جزئياً · متأخرة ' + daysLate + ' يوماً'; cls = 'late'; }
    else if (paid > 0) { displayStatus = 'مدفوعة جزئياً'; cls = 'due'; }
    else if (daysLate > 0) { displayStatus = 'متأخرة ' + daysLate + ' يوماً'; cls = 'late'; }
    else { displayStatus = 'مستحقة'; cls = 'due'; }
    return { ...r, amount, paid, discount, remaining, daysLate, displayStatus, cls, effectiveDue };
  });
}

export type CollectFilter = 'due' | 'late' | 'month' | 'soon' | 'paid' | 'all';

export function filterInstallments(all: InstallmentView[], f: CollectFilter, T: string = today()): InstallmentView[] {
  const mo = T.slice(0, 7);
  switch (f) {
    case 'due': return all.filter((x) => x.remaining > 0 && x.status !== 'ملغية');
    case 'late': return all.filter((x) => x.remaining > 0 && x.daysLate > 0 && x.status !== 'ملغية');
    case 'month': return all.filter((x) => x.effectiveDue.slice(0, 7) === mo);
    case 'soon': return all.filter((x) => x.remaining > 0 && x.daysLate < 0 && x.status !== 'ملغية');
    case 'paid': return all.filter((x) => x.remaining <= 0 && x.status !== 'ملغية');
    default: return all;
  }
}

export interface CollectKpis {
  dueThisMonth: number;
  paidThisMonth: number;
  lateSum: number;
  lateCount: number;
  collectionPct: number;
}

export function collectKpis(all: InstallmentView[], T: string = today()): CollectKpis {
  const mo = T.slice(0, 7);
  const inMonth = all.filter((x) => x.dueDate.slice(0, 7) === mo);
  const late = all.filter((x) => x.remaining > 0 && x.daysLate > 0 && x.status !== 'ملغية');
  const totalDue = all.reduce((s, x) => s + x.amount, 0);
  const totalPaid = all.reduce((s, x) => s + x.paid, 0);
  return {
    dueThisMonth: inMonth.reduce((s, x) => s + x.amount, 0),
    paidThisMonth: inMonth.reduce((s, x) => s + x.paid, 0),
    lateSum: late.reduce((s, x) => s + x.remaining, 0),
    lateCount: late.length,
    collectionPct: totalDue ? Math.round((totalPaid / totalDue) * 100) : 0,
  };
}

export const AGING_BUCKETS: Array<[string, number, number]> = [
  ['لم يحن', -1e9, -1],
  ['من 1 إلى 30 يوماً', 0, 30],
  ['من 31 إلى 60 يوماً', 31, 60],
  ['من 61 إلى 90 يوماً', 61, 90],
  ['أكثر من 90', 91, 1e9],
];

/** أعمار الذمم المدينة */
export function agingBuckets(all: InstallmentView[]): number[] {
  const vals = AGING_BUCKETS.map(() => 0);
  for (const x of all) {
    if (x.remaining <= 0 || x.status === 'ملغية') continue;
    AGING_BUCKETS.forEach((b, k) => {
      if (x.daysLate >= b[1] && x.daysLate <= b[2]) vals[k] += x.remaining;
    });
  }
  return vals;
}

/** رصيد المستأجر المستحق · مشتق من أقساط عقوده غير الملغية */
export function tenantOutstanding(db: DB, name: string): number {
  const row = db.get<{ s: number }>(
    `SELECT COALESCE(SUM(MAX(0, i.amount_halalas - i.paid_halalas - ${INSTALLMENT_DISCOUNT_SQL})),0) AS s
     FROM contract_installments i JOIN contracts c ON c.id = i.contract_id
     WHERE TRIM(c.tenant_name) = TRIM(?) AND c.status NOT IN ('مسودة','ملغى')
       AND i.status != 'ملغية' AND c.deleted_at IS NULL`,
    [name]
  );
  return row ? Number(row.s) : 0;
}

export interface UnitStatusInfo {
  key: 'maintenance' | 'rented' | 'reserved' | 'vacant';
  label: string;
  color: string;
  bg: string;
}

/** حالة الوحدة الظاهرة · بألوان النموذج */
/**
 * حالات كل الوحدات دفعة واحدة · ثلاثة استعلامات بدل استعلامين لكل وحدة.
 * قوائم الوحدات الكبيرة تعتمد عليها بدل unitStatusInfo لكل صف.
 */
export function allUnitStatuses(db: DB, T: string = today()): Map<string, UnitStatusInfo> {
  expireOldReservations(db, T);
  const out = new Map<string, UnitStatusInfo>();
  for (const u of db.all<{ id: string; under_maintenance: number }>(
    `SELECT id, under_maintenance FROM units WHERE deleted_at IS NULL`
  )) {
    out.set(u.id, Number(u.under_maintenance)
      ? { key: 'maintenance', label: 'صيانة', color: '#DC6B3F', bg: '#FCEEE7' }
      : { key: 'vacant', label: 'شاغرة', color: '#8A93A6', bg: '#F0F1F3' });
  }
  for (const r of db.all<{ unit_id: string; name: string }>(
    `SELECT unit_id, name FROM reservations WHERE status = 'نشط' AND deleted_at IS NULL`
  )) {
    const cur = out.get(r.unit_id);
    if (cur && cur.key === 'vacant') {
      out.set(r.unit_id, { key: 'reserved', label: 'محجوزة · ' + r.name, color: '#B08D3D', bg: '#FBF3DF' });
    }
  }
  for (const c of db.all<{ unit_id: string; tenant_name: string }>(
    `SELECT unit_id, tenant_name FROM contracts
     WHERE deleted_at IS NULL AND status NOT IN ('مسودة','ملغى')
       AND unit_id IS NOT NULL AND start <= ? AND end >= ?`, [T, T]
  )) {
    const cur = out.get(c.unit_id);
    if (cur && cur.key !== 'maintenance') {
      out.set(c.unit_id, { key: 'rented', label: 'مؤجَّرة · ' + c.tenant_name, color: '#2E8B57', bg: '#E7F5EC' });
    }
  }
  return out;
}

export function unitStatusInfo(db: DB, unit: { id: string; under_maintenance: number }, T: string = today()): UnitStatusInfo {
  if (unit.under_maintenance) return { key: 'maintenance', label: 'صيانة', color: '#DC6B3F', bg: '#FCEEE7' };
  const c = unitCurrentContract(db, unit.id, T);
  if (c) return { key: 'rented', label: 'مؤجَّرة · ' + c.tenant_name, color: '#2E8B57', bg: '#E7F5EC' };
  const r = unitActiveReservation(db, unit.id, T);
  if (r) return { key: 'reserved', label: 'محجوزة · ' + r.name, color: '#B08D3D', bg: '#FBF3DF' };
  return { key: 'vacant', label: 'شاغرة', color: '#8A93A6', bg: '#F0F1F3' };
}

/** المحصَّل الفعلي لعقد */
export function contractCollectedValue(db: DB, contractId: string): number {
  const inst = db.get<{ n: number; s: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status='مدفوعة' THEN amount_halalas ELSE 0 END),0) AS s
     FROM contract_installments WHERE contract_id = ?`,
    [contractId]
  )!;
  if (Number(inst.n) > 0) return Number(inst.s);
  const pay = db.get<{ s: number }>(
    `SELECT COALESCE(SUM(net_halalas),0) AS s FROM contract_payments WHERE contract_id = ?`,
    [contractId]
  )!;
  return Number(pay.s);
}

export function contractCancelledValue(db: DB, c: { id: string; status: string; value_halalas: number }): number {
  if (c.status !== 'ملغى') return 0;
  const inst = db.get<{ n: number; s: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status='ملغية' THEN amount_halalas ELSE 0 END),0) AS s
     FROM contract_installments WHERE contract_id = ?`,
    [c.id]
  )!;
  if (Number(inst.n) > 0) return Number(inst.s);
  const collected = contractCollectedValue(db, c.id);
  return Math.max(0, Number(c.value_halalas) - collected);
}

export interface PropertyStats {
  total: number;
  occupied: number;
  vacant: number;
  occupancyPct: number;
  income: number;
  cancelledValue: number;
  cancelledCount: number;
}

/** إحصاءات مجمَّعة باستعلامات ثابتة العدد · propertyId فارغ = كل المحفظة */
function aggregatedStats(db: DB, propertyId: string | null, T: string): PropertyStats {
  const unitFilter = propertyId ? `AND u.property_id = ?` : '';
  const p = propertyId ? [propertyId] : [];

  const total = Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM units u WHERE u.deleted_at IS NULL ${unitFilter}`, p
  )!.n);
  const occupied = Number(db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT c.unit_id) AS n FROM contracts c
     JOIN units u ON u.id = c.unit_id
     WHERE c.deleted_at IS NULL AND c.status NOT IN ('مسودة','ملغى')
       AND c.start <= ? AND c.end >= ? ${unitFilter}`,
    [T, T, ...p]
  )!.n);
  // المحصَّل: من الأقساط المدفوعة، ومن سجل الدفعات للعقود التي بلا جدول أقساط
  const instPaid = Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(CASE WHEN i.status='مدفوعة' THEN i.amount_halalas ELSE 0 END),0) AS s
     FROM contract_installments i
     JOIN contracts c ON c.id = i.contract_id
     JOIN units u ON u.id = c.unit_id
     WHERE c.deleted_at IS NULL ${unitFilter}`, p
  )!.s);
  const payOnly = Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(pm.net_halalas),0) AS s
     FROM contract_payments pm
     JOIN contracts c ON c.id = pm.contract_id
     JOIN units u ON u.id = c.unit_id
     WHERE c.deleted_at IS NULL ${unitFilter}
       AND NOT EXISTS (SELECT 1 FROM contract_installments i WHERE i.contract_id = c.id)`, p
  )!.s);
  const cancelled = db.get<{ n: number; v: number }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM((SELECT COALESCE(SUM(CASE WHEN i.status='ملغية' THEN i.amount_halalas ELSE 0 END),0)
                          FROM contract_installments i WHERE i.contract_id = c.id)),0) AS v
     FROM contracts c JOIN units u ON u.id = c.unit_id
     WHERE c.deleted_at IS NULL AND c.status = 'ملغى' ${unitFilter}`, p
  )!;
  return {
    total,
    occupied,
    vacant: total - occupied,
    occupancyPct: total ? Math.round((occupied / total) * 100) : 0,
    income: instPaid + payOnly,
    cancelledValue: Number(cancelled.v),
    cancelledCount: Number(cancelled.n),
  };
}

export function propertyStats(db: DB, propertyId: string, T: string = today()): PropertyStats {
  return aggregatedStats(db, propertyId, T);
}

/**
 * إحصاءات كل العقارات دفعة واحدة · خمسة استعلامات GROUP BY للمحفظة كلها
 * بدل خمسة استعلامات لكل عقار. قائمة العقارات تعتمد عليها.
 */
export function allPropertyStats(db: DB, T: string = today()): Map<string, PropertyStats> {
  const out = new Map<string, PropertyStats>();
  const blank = (): PropertyStats => ({
    total: 0, occupied: 0, vacant: 0, occupancyPct: 0, income: 0, cancelledValue: 0, cancelledCount: 0,
  });
  const ensure = (pid: string) => {
    let s = out.get(pid);
    if (!s) { s = blank(); out.set(pid, s); }
    return s;
  };
  for (const r of db.all<{ pid: string; n: number }>(
    `SELECT u.property_id AS pid, COUNT(*) AS n FROM units u
     WHERE u.deleted_at IS NULL GROUP BY u.property_id`
  )) ensure(r.pid).total = Number(r.n);
  for (const r of db.all<{ pid: string; n: number }>(
    `SELECT u.property_id AS pid, COUNT(DISTINCT c.unit_id) AS n
     FROM contracts c JOIN units u ON u.id = c.unit_id
     WHERE c.deleted_at IS NULL AND c.status NOT IN ('مسودة','ملغى')
       AND c.start <= ? AND c.end >= ?
     GROUP BY u.property_id`, [T, T]
  )) ensure(r.pid).occupied = Number(r.n);
  for (const r of db.all<{ pid: string; s: number }>(
    `SELECT u.property_id AS pid,
            COALESCE(SUM(CASE WHEN i.status='مدفوعة' THEN i.amount_halalas ELSE 0 END),0) AS s
     FROM contract_installments i
     JOIN contracts c ON c.id = i.contract_id
     JOIN units u ON u.id = c.unit_id
     WHERE c.deleted_at IS NULL GROUP BY u.property_id`
  )) ensure(r.pid).income += Number(r.s);
  for (const r of db.all<{ pid: string; s: number }>(
    `SELECT u.property_id AS pid, COALESCE(SUM(pm.net_halalas),0) AS s
     FROM contract_payments pm
     JOIN contracts c ON c.id = pm.contract_id
     JOIN units u ON u.id = c.unit_id
     WHERE c.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM contract_installments i WHERE i.contract_id = c.id)
     GROUP BY u.property_id`
  )) ensure(r.pid).income += Number(r.s);
  for (const r of db.all<{ pid: string; n: number; v: number }>(
    `SELECT u.property_id AS pid, COUNT(*) AS n,
            COALESCE(SUM((SELECT COALESCE(SUM(CASE WHEN i.status='ملغية' THEN i.amount_halalas ELSE 0 END),0)
                          FROM contract_installments i WHERE i.contract_id = c.id)),0) AS v
     FROM contracts c JOIN units u ON u.id = c.unit_id
     WHERE c.deleted_at IS NULL AND c.status = 'ملغى' GROUP BY u.property_id`
  )) { const s = ensure(r.pid); s.cancelledCount = Number(r.n); s.cancelledValue = Number(r.v); }
  for (const s of out.values()) {
    s.vacant = s.total - s.occupied;
    s.occupancyPct = s.total ? Math.round((s.occupied / s.total) * 100) : 0;
  }
  return out;
}

export function portfolioStats(db: DB, T: string = today()): PropertyStats {
  return aggregatedStats(db, null, T);
}

/** عدد الوحدات المحجوزة بحجز نشط · استعلام واحد */
export function reservedUnitsCount(db: DB, T: string = today()): number {
  db.transaction(() => {
    db.run(`UPDATE reservations SET status='منتهي' WHERE status='نشط' AND expiry_date < ? AND deleted_at IS NULL`, [T]);
  });
  return Number(db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT r.unit_id) AS n FROM reservations r
     JOIN units u ON u.id = r.unit_id
     WHERE r.status = 'نشط' AND r.deleted_at IS NULL AND u.deleted_at IS NULL`
  )!.n);
}

export interface PropertyMapStatus {
  key: 'full' | 'held' | 'vacant' | 'partial' | 'empty';
  label: string;
  color: string;
  pct: number | null;
  rented: number;
  total: number;
  reserved: number;
}

/** حالة العقار للخريطة · ألوان النموذج الخمسة */
export function propertyMapStatus(db: DB, propertyId: string, T: string = today()): PropertyMapStatus {
  const units = db.all<{ id: string }>(
    `SELECT id FROM units WHERE property_id = ? AND deleted_at IS NULL`, [propertyId]
  );
  if (!units.length) return { key: 'empty', label: 'بلا وحدات', color: '#6B7280', pct: null, rented: 0, total: 0, reserved: 0 };
  let rented = 0, reserved = 0;
  for (const u of units) {
    if (unitCurrentContract(db, u.id, T)) { rented++; continue; }
    if (unitActiveReservation(db, u.id, T)) reserved++;
  }
  const pct = Math.round((rented / units.length) * 100);
  const base = { pct, rented, total: units.length, reserved };
  if (pct === 100) return { key: 'full', label: 'مؤجَّر بالكامل', color: '#1E6E5C', ...base };
  if (rented === 0 && reserved > 0) return { key: 'held', label: 'محجوز', color: '#B08D3D', ...base };
  if (rented === 0) return { key: 'vacant', label: 'شاغر بالكامل', color: '#AE4438', ...base };
  return { key: 'partial', label: 'مؤجَّر جزئياً', color: '#C9A961', ...base };
}

/** نسبة الأيام المؤجَّرة خلال آخر 365 يوماً */
export function unitOccupancyRate365(db: DB, unitId: string, T: string = today()): number {
  const end = new Date(T + 'T00:00:00');
  const start = new Date(end);
  start.setDate(start.getDate() - 365);
  let occupiedDays = 0;
  const cs = db.all<{ start: string; end: string }>(
    `SELECT start, end FROM contracts
     WHERE unit_id = ? AND deleted_at IS NULL AND status != 'مسودة'
       AND start IS NOT NULL AND end IS NOT NULL`,
    [unitId]
  );
  for (const c of cs) {
    const cs_ = new Date(c.start + 'T00:00:00');
    const ce = new Date(c.end + 'T00:00:00');
    const oS = cs_ > start ? cs_ : start;
    const oE = ce < end ? ce : end;
    if (oE >= oS) occupiedDays += Math.round((oE.getTime() - oS.getTime()) / 86400000) + 1;
  }
  return Math.min(100, Math.round((occupiedDays / 365) * 100));
}

export interface OccupancyDays {
  /** أيام-وحدة مشغولة فعلاً خلال الفترة */
  occupiedUnitDays: number;
  /** الطاقة: عدد الوحدات × أيام الفترة */
  capacityUnitDays: number;
  /** النسبة المئوية المقرَّبة */
  pct: number;
  units: number;
  days: number;
  from: string;
  to: string;
}

/**
 * إشغال الفترة بالأيام لا باللحظة · «إشغال أغسطس ٦١٪ · ٤٩٤ من ٨٠٦ يوم-وحدة».
 * وحدة سكنت ١٢ يوماً تُحسب ١٢، لا شهراً كاملاً ولا صفراً · والنسبة اللحظية
 * (portfolioStats/propertyStats) تبقى كما هي إلى جانبها لمن يريد «الإشغال الآن».
 *
 * المدة الملغاة تتوقف يوم الإلغاء: المستأجر الذي غادر لم يعد ساكناً بعدها.
 * وتداخل عقدين على وحدة واحدة يُحسب يوماً واحداً لا يومين.
 */
export function occupancyByDays(
  db: DB,
  from: string,
  to: string,
  propertyId: string | null = null
): OccupancyDays {
  const days = from && to ? daysBetween(to, from) + 1 : 0;
  const empty: OccupancyDays = {
    occupiedUnitDays: 0, capacityUnitDays: 0, pct: 0, units: 0, days: 0, from, to,
  };
  if (days <= 0) return empty;

  const unitFilter = propertyId ? `AND u.property_id = ?` : '';
  const p: string[] = propertyId ? [propertyId] : [];
  const units = Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM units u WHERE u.deleted_at IS NULL ${unitFilter}`, p
  )!.n);
  if (!units) return { ...empty, days };

  const rows = db.all<{ unitId: string; start: string; end: string; status: string; cancelDate: string | null }>(
    `SELECT c.unit_id AS unitId, c.start AS start, c.end AS end,
            c.status AS status, c.cancel_date AS cancelDate
     FROM contracts c
     JOIN units u ON u.id = c.unit_id
     WHERE c.deleted_at IS NULL AND u.deleted_at IS NULL AND c.status != 'مسودة'
       AND c.start IS NOT NULL AND c.end IS NOT NULL AND c.start != '' AND c.end != ''
       AND c.start <= ? AND c.end >= ? ${unitFilter}`,
    [to, from, ...p]
  );

  // مدد السكن مقصوصة على حدّي الفترة، مجمَّعة بالوحدة
  const byUnit = new Map<string, Array<[string, string]>>();
  for (const r of rows) {
    let end = r.end;
    if (r.status === 'ملغى') {
      if (!r.cancelDate) continue;
      if (r.cancelDate < end) end = r.cancelDate;
    }
    const s = r.start > from ? r.start : from;
    const e = end < to ? end : to;
    if (e < s) continue;
    const list = byUnit.get(r.unitId);
    if (list) list.push([s, e]);
    else byUnit.set(r.unitId, [[s, e]]);
  }

  let occupiedUnitDays = 0;
  for (const spans of byUnit.values()) {
    spans.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    let curS = spans[0][0];
    let curE = spans[0][1];
    for (let i = 1; i < spans.length; i++) {
      const [s, e] = spans[i];
      // الملاصق أو المتداخل يندمج فلا يُحسب اليوم مرتين
      if (daysBetween(s, curE) <= 1) { if (e > curE) curE = e; continue; }
      occupiedUnitDays += daysBetween(curE, curS) + 1;
      curS = s; curE = e;
    }
    occupiedUnitDays += daysBetween(curE, curS) + 1;
  }

  const capacityUnitDays = units * days;
  return {
    occupiedUnitDays,
    capacityUnitDays,
    pct: capacityUnitDays ? Math.round((occupiedUnitDays / capacityUnitDays) * 100) : 0,
    units,
    days,
    from,
    to,
  };
}

export interface OccupancyBoth {
  /** إشغال المدة بالأيام: «إشغال أغسطس ٦١٪ · ٤٩٤ من ٨٠٦ يوم-وحدة» */
  period: OccupancyDays;
  /** الإشغال اللحظي: «الإشغال الآن ٧٣٪ · ١٩ من ٢٦ وحدة» */
  now: { occupied: number; total: number; pct: number };
}

/** المقياسان معاً في نداء واحد · الشاشة تعرض سطرين لا سطراً */
export function occupancySummary(
  db: DB,
  from: string,
  to: string,
  T: string = today(),
  propertyId: string | null = null
): OccupancyBoth {
  const s = aggregatedStats(db, propertyId, T);
  return {
    period: occupancyByDays(db, from, to, propertyId),
    now: { occupied: s.occupied, total: s.total, pct: s.occupancyPct },
  };
}

export interface TopPerformers {
  topPropRevenue: { id: string; amount: number } | null;
  topPropExpense: { id: string; amount: number } | null;
  topUnitRevenue: { id: string; amount: number } | null;
  topUnitExpense: { id: string; amount: number } | null;
}

/** العقار/الوحدة الأعلى دخلاً وصرفاً · من الفواتير والمشتريات المرتبطة */
export function computeTopPerformers(db: DB): TopPerformers {
  const propRevenue: Record<string, number> = {};
  const propExpense: Record<string, number> = {};
  const unitRevenue: Record<string, number> = {};
  const unitExpense: Record<string, number> = {};
  const unitProp = new Map(
    db.all<{ id: string; property_id: string }>(`SELECT id, property_id FROM units`).map((u) => [u.id, u.property_id])
  );
  for (const v of db.all<{ unit_id: string | null; property_id: string | null; total_halalas: number }>(
    `SELECT unit_id, property_id, total_halalas FROM invoices WHERE deleted_at IS NULL`
  )) {
    const amt = Number(v.total_halalas);
    if (v.unit_id) {
      unitRevenue[v.unit_id] = (unitRevenue[v.unit_id] || 0) + amt;
      const pid = unitProp.get(v.unit_id);
      if (pid) propRevenue[pid] = (propRevenue[pid] || 0) + amt;
    } else if (v.property_id) propRevenue[v.property_id] = (propRevenue[v.property_id] || 0) + amt;
  }
  for (const p of db.all<{ unit_id: string | null; property_id: string | null; total_halalas: number }>(
    `SELECT unit_id, property_id, total_halalas FROM purchases WHERE deleted_at IS NULL`
  )) {
    const amt = Number(p.total_halalas);
    if (p.unit_id) {
      unitExpense[p.unit_id] = (unitExpense[p.unit_id] || 0) + amt;
      const pid = unitProp.get(p.unit_id);
      if (pid) propExpense[pid] = (propExpense[pid] || 0) + amt;
    } else if (p.property_id) propExpense[p.property_id] = (propExpense[p.property_id] || 0) + amt;
  }
  const topOf = (obj: Record<string, number>) => {
    const entries = Object.entries(obj);
    if (!entries.length) return null;
    entries.sort((a, b) => b[1] - a[1]);
    return { id: entries[0][0], amount: entries[0][1] };
  };
  return {
    topPropRevenue: topOf(propRevenue),
    topPropExpense: topOf(propExpense),
    topUnitRevenue: topOf(unitRevenue),
    topUnitExpense: topOf(unitExpense),
  };
}

/** توزيع المصروفات بالفئة (للوحة الرئيسية) خلال فترة */
export function expenseSplit(db: DB, from: string | null, to: string | null): Array<[string, number]> {
  const conds = [`deleted_at IS NULL`];
  const params: string[] = [];
  if (from) { conds.push(`date >= ?`); params.push(from); }
  if (to) { conds.push(`date <= ?`); params.push(to); }
  const rows = db.all<{ category: string; s: number }>(
    `SELECT COALESCE(NULLIF(TRIM(category),''),'غير مصنَّف') AS category, SUM(subtotal_halalas) AS s
     FROM purchases WHERE ${conds.join(' AND ')}
     GROUP BY 1 ORDER BY s DESC`,
    params
  );
  return rows.map((r) => [r.category, Number(r.s)]);
}

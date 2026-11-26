/**
 * القاعدة ١٣: العدّاد يشير لمورده · عدّادات كثيرة لمورد واحد.
 * الميزة لنوعين فقط: كهرباء وماء. المورد له «نوع خدمة»، والعدّاد يختار من موردي نوعه.
 * عند اختيار المورد في فاتورة الشراء تظهر كل عدّاداته (وتُضيَّق بالعقار المرتبط إن وُجد).
 */
import type { DB } from '../db/adapter';
import { uid } from './ids';

export const METER_KINDS = ['كهرباء', 'ماء', 'إنترنت', 'غاز'] as const; // i18n-exempt: أنواع العدادات المخزّنة (الغاز: الهجرة ٣١)
export const UTILITY_KINDS = ['كهرباء', 'ماء', 'غاز'] as const; // i18n-exempt: أنواع الخدمة المخزّنة (الغاز: الهجرة ٤٠)
/** شعار كل خدمة: الكهرباء برق · المياه قطرة · الإنترنت واي فاي */
export const METER_ICON: Record<string, string> = { 'كهرباء': 'bolt', 'ماء': 'drop', 'إنترنت': 'wifi', 'غاز': 'flame' }; // i18n-exempt: أنواع العدادات المخزّنة

export type MeterKind = (typeof METER_KINDS)[number];

export interface MeterRow {
  id: string;
  owner_type: 'property' | 'unit';
  owner_id: string;
  kind: string;
  number: string;
  supplier_id: string | null;
}

export interface LabeledMeter extends MeterRow {
  label: string;
}

export function isUtilityKind(kind: string): boolean {
  return (UTILITY_KINDS as readonly string[]).includes(kind);
}

/** موردو نوع خدمة معيّن (كهرباء/ماء) */
export function utilitySuppliers(db: DB, kind: string): Array<{ id: string; name: string }> {
  return db.all(
    `SELECT id, name FROM suppliers
     WHERE utility_type = ? AND archived = 0 AND deleted_at IS NULL ORDER BY name`,
    [kind]
  );
}

// التسمية نص خالص · الشعار يُرسم أيقونة SVG في الواجهة لا كلمة داخل النص
function labelFor(db: DB, m: MeterRow): string {
  if (m.owner_type === 'property') {
    const p = db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [m.owner_id]);
    return `${m.kind} · ${p?.name ?? 'لا يوجد'} (مشترك)`;
  }
  const u = db.get<{ unit_no: string; property_id: string }>(
    `SELECT unit_no, property_id FROM units WHERE id = ?`, [m.owner_id]
  );
  const p = u ? db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [u.property_id]) : undefined;
  return `${m.kind} · ${p?.name ?? 'لا يوجد'} / وحدة ${u?.unit_no ?? 'لا يوجد'}`;
}

export function allMeters(db: DB): LabeledMeter[] {
  const rows = db.all<MeterRow>(`SELECT * FROM meters WHERE deleted_at IS NULL`);
  return rows.map((m) => ({ ...m, label: labelFor(db, m) }));
}

/** كل عدادات مورد · «عدّادات كثيرة لمورد واحد» */
export function supplierMeters(db: DB, supplierId: string): LabeledMeter[] {
  return allMeters(db).filter((m) => m.supplier_id === supplierId);
}

/** عدادات مالك محدد (عقار أو وحدة) */
export function metersOf(db: DB, ownerType: 'property' | 'unit', ownerId: string): LabeledMeter[] {
  return allMeters(db).filter((m) => m.owner_type === ownerType && m.owner_id === ownerId);
}

/**
 * عدّادات المورد لعرضها في فاتورة الشراء · كلها، وإن حُدد عقار
 * ضُيّقت لعداداته (المشتركة أو عدادات وحداته) إن وُجد منها شيء.
 */
export function metersForPurchase(db: DB, supplierId: string, propertyId?: string | null): LabeledMeter[] {
  let list = supplierMeters(db, supplierId);
  if (propertyId) {
    const narrowed = list.filter((m) => {
      if (m.owner_type === 'property') return m.owner_id === propertyId;
      const u = db.get<{ property_id: string }>(`SELECT property_id FROM units WHERE id = ?`, [m.owner_id]);
      return u?.property_id === propertyId;
    });
    if (narrowed.length) list = narrowed;
  }
  return list;
}

export interface MeterInput {
  id?: string;
  kind: string;
  number: string;
  supplierId?: string | null;
}

/** استبدال عدادات مالك (من محرر الوحدة/العقار) · التصفية والربط بموردي النوع فقط */
export function replaceMeters(
  db: DB,
  ownerType: 'property' | 'unit',
  ownerId: string,
  meters: MeterInput[]
): void {
  db.transaction(() => {
    const keep = meters.filter((m) => (m.number || '').trim());
    const existingIds = db
      .all<{ id: string }>(`SELECT id FROM meters WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL`, [ownerType, ownerId])
      .map((r) => r.id);
    const keepIds = new Set(keep.map((m) => m.id).filter(Boolean));
    for (const oldId of existingIds) {
      if (!keepIds.has(oldId))
        db.run(`UPDATE meters SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), oldId]);
    }
    for (const m of keep) {
      const supplierId = isUtilityKind(m.kind) ? m.supplierId || null : null; // الميزة لنوعين فقط
      if (m.id && existingIds.includes(m.id)) {
        db.run(`UPDATE meters SET kind = ?, number = ?, supplier_id = ? WHERE id = ?`, [
          m.kind, m.number.trim(), supplierId, m.id,
        ]);
      } else {
        db.run(
          `INSERT INTO meters (id, owner_type, owner_id, kind, number, supplier_id) VALUES (?,?,?,?,?,?)`,
          [m.id || 'MT_' + uid(), ownerType, ownerId, m.kind, m.number.trim(), supplierId]
        );
      }
    }
  });
}

/** تسجيل قراءة عداد بلا فاتورة · فاتورة الشراء لا تكتب هنا منذ E-7: سجلها يُشتق منها */
export function addMeterReading(
  db: DB,
  meterId: string,
  reading: number | null,
  amountHalalas: number,
  date: string,
  ref: string
): void {
  db.run(
    `INSERT INTO meter_readings (id, meter_id, date, reading, amount_halalas, ref) VALUES (?,?,?,?,?,?)`,
    [uid(), meterId, date, reading, amountHalalas, ref]
  );
}

/**
 * سجل العداد يتبع فاتورته (المراجعة الشاملة 2026-11-13 · E-7): سطور فواتير الشراء الحيّة المربوطة به (عدادها وقراءتها ومبلغها وتاريخها
 * ورقمها)، ومعها من جدول القراءات ما ليس من فاتورة (قراءات محضر الاستلام) · فتعديل الفاتورة يغيّر سطرها، وحذفها يُخرجه، واستعادتها
 * تعيده · وسطرٌ كتبه إصدارٌ سابق لفاتورةٍ (مرجعه رقمها) لا يُعدّ مرتين ولا يبقى بعد حذفها
 */
const METER_ROWS_SQL = `
  SELECT date, meter_reading AS reading, total_halalas AS amount_halalas, no AS ref FROM purchases
   WHERE meter_id = ? AND deleted_at IS NULL
  UNION ALL
  SELECT r.date, r.reading, r.amount_halalas, r.ref FROM meter_readings r
   WHERE r.meter_id = ? AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.no = r.ref)`;

export function meterReadings(
  db: DB,
  meterId: string
): Array<{ date: string; reading: number | null; amount_halalas: number; ref: string }> {
  return db.all(`SELECT * FROM (${METER_ROWS_SQL}) ORDER BY date DESC, ref DESC`, [meterId, meterId]);
}

/** آخر قراءةٍ مسجّلة للعداد من سجله الحيّ · «القراءة السابقة» في فاتورة الشراء · وفاتورةٌ تُعدَّل لا تُقترح قراءتها هي */
export function lastMeterReading(db: DB, meterId: string, exceptRef?: string): number | null {
  const r = db.get<{ reading: number | null }>(
    `SELECT reading FROM (${METER_ROWS_SQL}) WHERE reading IS NOT NULL AND ref != ? ORDER BY date DESC LIMIT 1`,
    [meterId, meterId, exceptRef ?? '']);
  return r?.reading ?? null;
}

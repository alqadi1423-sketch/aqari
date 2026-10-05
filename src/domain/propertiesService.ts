/**
 * حفظ العقارات والوحدات · التفاصيل (الأقسام/الغرف) والعدادات وفئات الطوابق.
 */
import type { DB } from '../db/adapter';
import { retagUnitTree } from './unitMove';
import { uid } from './ids';
import { naturalKey } from './sortKey';
import { replaceMeters, type MeterInput } from './meters';
import { unitCurrentContract } from './contracts/rules';
import { assertNoRefs } from './refs';
import { logAudit } from './audit';

export interface PropertyInput {
  name: string;
  address: string;
  floors: number | null;
  activityType: string;
  activitySubtype: string;
  ownership: 'ملك' | 'إيجار' | 'تشغيل';
  deedNo: string;
  leaseValueHalalas: number | null;
  leaseCycle: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
  opRate: number | null;
  lat: number | null;
  lng: number | null;
  floorCategories: Record<string, string>;
  areas: Array<{ name: string; items: Array<{ name: string; descr: string }> }>;
  meters: MeterInput[];
}

export function saveProperty(db: DB, input: PropertyInput, existingId?: string): string {
  if (!input.name.trim()) throw new Error('الرجاء إدخال اسم العقار');
  return db.transaction(() => {
    const id = existingId ?? 'P_' + uid();
    const fields = [
      input.name.trim(), input.address.trim(), input.floors, input.activityType,
      input.activityType === 'سكني' ? input.activitySubtype : '',
      input.ownership, input.deedNo.trim(),
      input.leaseValueHalalas, input.leaseCycle, input.leaseStart, input.leaseEnd,
      input.opRate, input.lat, input.lng,
    ];
    if (existingId) {
      db.run(
        `UPDATE properties SET name=?, address=?, floors=?, activity_type=?, activity_subtype=?,
          ownership=?, deed_no=?, lease_value_halalas=?, lease_cycle=?, lease_start=?, lease_end=?,
          op_rate=?, lat=?, lng=? WHERE id = ?`,
        [...fields, existingId]
      );
    } else {
      db.run(
        `INSERT INTO properties (id, name, address, floors, activity_type, activity_subtype, ownership,
          deed_no, lease_value_halalas, lease_cycle, lease_start, lease_end, op_rate, lat, lng, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, ...fields, new Date().toISOString()]
      );
    }
    // فئات الطوابق
    db.run(`DELETE FROM property_floor_categories WHERE property_id = ?`, [id]);
    for (const [floor, cat] of Object.entries(input.floorCategories)) {
      if (cat.trim())
        db.run(`INSERT INTO property_floor_categories (property_id, floor_label, category) VALUES (?,?,?)`, [
          id, floor, cat.trim(),
        ]);
    }
    // الأقسام والمحتويات
    db.run(`DELETE FROM property_areas WHERE property_id = ?`, [id]);
    input.areas.filter((a) => a.name.trim()).forEach((a, ai) => {
      const areaId = uid();
      db.run(`INSERT INTO property_areas (id, property_id, area_name, sort) VALUES (?,?,?,?)`, [
        areaId, id, a.name.trim(), ai,
      ]);
      a.items.filter((it) => it.name.trim()).forEach((it, ii) => {
        db.run(`INSERT INTO property_area_items (id, area_id, name, descr, sort) VALUES (?,?,?,?,?)`, [
          uid(), areaId, it.name.trim(), it.descr.trim(), ii,
        ]);
      });
    });
    replaceMeters(db, 'property', id, input.meters);
    logAudit(db, 'العقارات', existingId ? 'update' : 'create', 'عقار', input.name.trim());
    return id;
  });
}

/** الحذف لعقار خالٍ وحده · المرتبط يُرفض حذفه بأعداد مرتبطاته ويُعرض أرشفته */
export function deleteProperty(db: DB, id: string): void {
  const p = db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [id]);
  assertNoRefs(db, 'property', id, 'العقار', p?.name ?? '');
  db.transaction(() => {
    db.run(`UPDATE properties SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    if (p) logAudit(db, 'العقارات', 'delete', 'عقار', p.name);
  });
}

/** الأرشفة بدل الحذف: يختفي من القوائم ويبقى في الدفتر والتقارير كما هو */
export function setPropertyArchived(db: DB, id: string, archived: boolean): void {
  db.transaction(() => {
    const p = db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [id]);
    db.run(`UPDATE properties SET archived = ? WHERE id = ?`, [archived ? 1 : 0, id]);
    if (p) logAudit(db, 'العقارات', 'update', archived ? 'أرشفة عقار' : 'إلغاء أرشفة عقار', p.name);
  });
}

export interface UnitInput {
  propertyId: string;
  unitNo: string;
  floor: string;
  type: string;
  subtype: string;
  rentMonthlyHalalas: number;
  rooms: Array<{ name: string; items: Array<{ name: string; descr: string }> }>;
  meters: MeterInput[];
}

export function saveUnit(db: DB, input: UnitInput, existingId?: string): string {
  if (!input.unitNo.trim()) throw new Error('الرجاء إدخال رقم الوحدة');
  const dup = db.get<{ id: string }>(
    `SELECT id FROM units WHERE property_id = ? AND unit_no = ? AND deleted_at IS NULL AND id != ?`,
    [input.propertyId, input.unitNo.trim(), existingId ?? '']
  );
  if (dup) throw new Error(`رقم الوحدة "${input.unitNo.trim()}" مستخدَم بالفعل في هذا العقار · اختر رقماً آخر`);
  return db.transaction(() => {
    const id = existingId ?? 'U_' + uid();
    // مفتاح الترتيب الطبيعي يُحسب عند الحفظ لا وقت العرض
    const noKey = naturalKey(input.unitNo.trim());
    const fields = [
      input.propertyId, input.unitNo.trim(), noKey, input.floor, input.type.trim() || 'سكني',
      input.subtype.trim(), input.rentMonthlyHalalas,
    ];
    if (existingId) {
      const before = db.get<{ p: string }>(`SELECT property_id AS p FROM units WHERE id = ?`, [existingId])?.p;
      db.run(
        `UPDATE units SET property_id=?, unit_no=?, unit_no_key=?, floor=?, type=?, subtype=?, rent_monthly_halalas=? WHERE id = ?`,
        [...fields, existingId]
      );
      // نُقلت إلى عقار آخر: كل ما تحتها يُعاد وسمه ورفعه (المراجعة ٤.١٢)
      if (before && before !== input.propertyId) retagUnitTree(db, existingId, input.propertyId);
    } else {
      db.run(
        `INSERT INTO units (id, property_id, unit_no, unit_no_key, floor, type, subtype, rent_monthly_halalas, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, ...fields, new Date().toISOString()]
      );
    }
    db.run(`DELETE FROM unit_rooms WHERE unit_id = ?`, [id]);
    input.rooms.filter((r) => r.name.trim()).forEach((r, ri) => {
      const roomId = uid();
      db.run(`INSERT INTO unit_rooms (id, unit_id, room_name, sort) VALUES (?,?,?,?)`, [roomId, id, r.name.trim(), ri]);
      r.items.filter((it) => it.name.trim()).forEach((it, ii) => {
        db.run(`INSERT INTO unit_room_items (id, room_id, name, descr, sort) VALUES (?,?,?,?,?)`, [
          uid(), roomId, it.name.trim(), it.descr.trim(), ii,
        ]);
      });
    });
    replaceMeters(db, 'unit', id, input.meters);
    logAudit(db, 'العقارات', existingId ? 'update' : 'create', 'وحدة', input.unitNo.trim());
    return id;
  });
}

/** الحذف لوحدة خالية وحدها · المرتبطة بعقود أو غيرها تُرفض بأعدادها وتُعرض أرشفتها */
export function deleteUnit(db: DB, id: string): void {
  const u = db.get<{ unit_no: string }>(`SELECT unit_no FROM units WHERE id = ?`, [id]);
  assertNoRefs(db, 'unit', id, 'الوحدة', u?.unit_no ?? '');
  db.transaction(() => {
    db.run(`UPDATE units SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    if (u) logAudit(db, 'العقارات', 'delete', 'وحدة', u.unit_no);
  });
}

/** الأرشفة بدل الحذف للوحدة */
export function setUnitArchived(db: DB, id: string, archived: boolean): void {
  db.transaction(() => {
    const u = db.get<{ unit_no: string }>(`SELECT unit_no FROM units WHERE id = ?`, [id]);
    db.run(`UPDATE units SET archived = ? WHERE id = ?`, [archived ? 1 : 0, id]);
    if (u) logAudit(db, 'العقارات', 'update', archived ? 'أرشفة وحدة' : 'إلغاء أرشفة وحدة', u.unit_no);
  });
}

/** إضافة الوحدات دفعة واحدة · مرقَّمة بالتسلسل وتخطّي المكرر */
export function bulkAddUnits(
  db: DB,
  propertyId: string,
  count: number,
  opts: { prefix: string; start: number; floor: string; type: string; subtype: string; rentHalalas: number }
): { added: number; skipped: number } {
  return db.transaction(() => {
    let added = 0, skipped = 0;
    for (let i = 0; i < count; i++) {
      const no = opts.prefix + (opts.start + i);
      const dup = db.get(
        `SELECT id FROM units WHERE property_id = ? AND unit_no = ? AND deleted_at IS NULL`,
        [propertyId, no]
      );
      if (dup) { skipped++; continue; }
      db.run(
        `INSERT INTO units (id, property_id, unit_no, unit_no_key, floor, type, subtype, rent_monthly_halalas, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        ['U_' + uid(), propertyId, no, naturalKey(no), opts.floor, opts.type || 'سكني', opts.subtype, opts.rentHalalas, new Date().toISOString()]
      );
      added++;
    }
    logAudit(db, 'العقارات', 'create', 'إضافة وحدات دفعة واحدة', added + ' وحدة');
    return { added, skipped };
  });
}

export function toggleUnitMaintenance(db: DB, id: string): boolean {
  return db.transaction(() => {
    const u = db.get<{ under_maintenance: number; unit_no: string }>(
      `SELECT under_maintenance, unit_no FROM units WHERE id = ?`, [id]
    );
    if (!u) return false;
    const next = Number(u.under_maintenance) ? 0 : 1;
    db.run(`UPDATE units SET under_maintenance = ? WHERE id = ?`, [next, id]);
    logAudit(db, 'العقارات', 'update', next ? 'وضع تحت الصيانة' : 'إنهاء الصيانة', u.unit_no);
    return !!next;
  });
}

export const UNIT_TYPE_CONFIG: Record<string, { label: string; kind: 'select' | 'text'; options?: string[] }> = {
  'سكني': { label: 'الفئة السكنية المستهدفة', kind: 'select', options: ['عوائل', 'عزاب', 'طالبات', 'طلاب', 'بنات', 'عمال', 'عام '] },
  'محل': { label: 'النشاط التجاري المسموح به', kind: 'text' },
  'معرض': { label: 'النشاط التجاري المسموح به', kind: 'text' },
  'مكتب': { label: 'النشاط المسموح به', kind: 'text' },
  'مخزن': { label: 'الاستخدام المسموح به', kind: 'text' },
  'أخرى': { label: 'وصف النوع', kind: 'text' },
};

export const PROPERTY_ACTIVITIES = ['', 'سكني', 'سكن طلاب', 'سكن طالبات', 'محل', 'معرض', 'مكتب', 'مخزن', 'مختلط'];
export const RESIDENTIAL_SUBTYPES = ['عوائل', 'عزاب', 'طالبات', 'طلاب', 'بنات', 'عمال'];

export function floorLabels(floors: number | null): string[] {
  const n = floors ?? 0;
  return ['الأرضي', ...Array.from({ length: n }, (_, i) => 'الطابق ' + (i + 1))];
}

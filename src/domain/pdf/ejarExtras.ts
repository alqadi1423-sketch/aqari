/**
 * بنود عقد إيجار التي لها خانة في التطبيق ولم تكن تُقرأ (قرارات تفصيل العقد ٢٠٢٦-١٠-٠٧، أولاً):
 *  - تُقرأ وتُعرض مقارنةً بالقائم قبل الحفظ، ولا يُكتب فوق قيمة قائمة إلا بموافقة المستخدم في شاشة المراجعة.
 *  - بيانات المؤجّر للمقارنة والتنبيه وحدها، ولا تُكتب فوق بيانات المنشأة أبداً.
 *  - فحوص الجدول: عدد الصفوف والدفعة الدورية والأخيرة مقابل المقروء.
 * القراءة على تسميات إيجار الإنجليزية الثابتة بعد نزع المسافات (المبدأ في parseEjar)، والقيم العربية من
 * السطر بعد تصحيح اتجاهه: «التسمية الإنجليزية القيمة:التسمية العربية».
 */
import type { DB } from '../../db/adapter';
import { uid } from '../ids';
import { flatLatin, fixArabicOrder, arabicIsVisual, type ScheduleRow } from './parseEjar';
import { FURNISHED_OPTIONS } from '../contracts/vocab';
import { floorLabels } from '../propertiesService';

export type MeterKind = 'electricity' | 'water' | 'gas';
// i18n-exempt: أنواع العدادات المخزّنة (الغاز منذ الهجرة ٣١)
const METER_KIND_OF: Record<MeterKind, string> = { electricity: 'كهرباء', water: 'ماء', gas: 'غاز' };
export interface EjarExtras {
  property: { nationalAddress?: string; usage?: string; floors?: number; deedNo?: string };
  unit: { unitNo?: string; unitType?: string; floorNo?: string; furnished?: (typeof FURNISHED_OPTIONS)[number] };
  tenant: { email?: string };
  lessor: { name?: string; cr?: string; unified?: string };
  financial: {
    rentValue?: number; totalValue?: number; gas?: number; electricity?: number; water?: number; parking?: number;
    regular?: number; last?: number; count?: number;
  };
  meters: Array<{ kind: MeterKind; number: string; reading: number | null }>;
  /** جدول الغرف: النوع وعدده · وجدول المكيفات للأصول لاحقاً */
  rooms: Array<{ type: string; count: number }>;
  acUnits: Array<{ type: string; count: number }>;
}

const halalas = (s: string | undefined) => {
  if (!s) return undefined;
  const v = parseFloat(s.replace(/[,،\s]/g, ''));
  return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : undefined;
};

/** مقطع بين تسميتين في نصٍّ مسطّح */
function between(tf: string, a: RegExp, b: RegExp): string {
  const i = tf.search(a);
  if (i < 0) return '';
  const rest = tf.slice(i + 1);
  const j = rest.search(b);
  return tf.slice(i, j >= 0 ? i + 1 + j : i + 1200);
}

/** قيمة عربية بعد تسمية إنجليزية حتى أول «:» في سطرٍ مصحَّح الاتجاه */
function arabicAfter(lines: string[], label: RegExp): string | undefined {
  for (const l of lines) {
    const m = l.match(label);
    if (!m) continue;
    const rest = l.slice((m.index ?? 0) + m[0].length);
    const v = rest.split(':')[0].replace(/[A-Za-z].*$/, '').trim();
    if (v && v !== '-') return v;
  }
  return undefined;
}

export function parseEjarExtras(raw: string): EjarExtras {
  const t = String(raw || '');
  const rev = arabicIsVisual(t);
  // المسطّح بلا أسطر أيضاً: التسمية الطويلة قد تنكسر على سطرين («Number of Rent / Payments»)
  const tf = flatLatin(t);
  const one = tf.replace(/\n/g, '');
  const lines = t.split('\n').map((l) => fixArabicOrder(l, rev));
  const num = (re: RegExp, s = one) => s.match(re)?.[1];
  const out: EjarExtras = { property: {}, unit: {}, tenant: {}, lessor: {}, financial: {}, meters: [], rooms: [], acUnits: [] };

  // العقار
  out.property.usage = arabicAfter(lines, /Property\s*Usage/i);
  const floors = num(/NumberofFloors:?(\d{1,3})/i);
  if (floors) out.property.floors = Number(floors);
  const deed = num(/TitleDeedNo:?:?(\d{6,})/i);
  if (deed) out.property.deedNo = deed;
  out.property.nationalAddress = arabicAfter(lines, /National\s*Address/i);

  // الوحدة
  const unitNo = num(/UnitNo\.?:?([A-Za-z0-9٠-٩\-\/]{1,12}?)(?=:|UnitType|$)/i);
  if (unitNo) out.unit.unitNo = unitNo;
  out.unit.unitType = arabicAfter(lines, /Unit\s*Type/i);
  const floorNo = num(/FloorNo\.?:?(-?\d{1,3})/i);
  if (floorNo) out.unit.floorNo = floorNo;
  const furnished = arabicAfter(lines, /Furnished/i);
  const status = arabicAfter(lines, /Furnishing\s*Status/i);
  out.unit.furnished = mapFurnished(furnished, status);

  // المستأجر: البريد من مقطعه وحده
  const tn = between(one, /TenantData/i, /TenantRepresentativeData/i);
  // المسطّح يلصق التسمية التالية بالبريد («…testMobileNo.») · فالامتداد الأخير بحروفٍ صغيرة لا يتبعها صغير
  const em = tn.match(/Email:?([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*?\.[a-z]{2,6})(?![a-z])/);
  if (em) out.tenant.email = em[1].toLowerCase();

  // المؤجّر · للمقارنة وحدها
  const ls = between(one, /LessorData/i, /LessorRepresentativeData/i);
  const cr = ls.match(/CRNo\.?:?(\d{8,12})/i);
  if (cr) out.lessor.cr = cr[1];
  const un = ls.match(/UnifiedNumber:?(\d{8,12})/i);
  if (un) out.lessor.unified = un[1];
  out.lessor.name = arabicAfter(lines, /name\s*\/\s*Founder/i) ?? arabicAfter(lines, /Company\s*name/i);

  // البيانات المالية
  const money = /:?([\d,]+(?:\.\d{1,2})?)/.source;
  const f = out.financial;
  f.rentValue = halalas(num(new RegExp('Totalrentvalue' + money, 'i')));
  f.totalValue = halalas(num(new RegExp('TotalContractvalue' + money, 'i')));
  f.gas = halalas(num(new RegExp('Gastotal' + money, 'i')));
  f.electricity = halalas(num(new RegExp('Electricitytotal' + money, 'i')));
  f.water = halalas(num(new RegExp('Watertotal' + money, 'i')));
  f.parking = halalas(num(new RegExp('ParkingAnnualAmount' + money, 'i')));
  f.regular = halalas(num(new RegExp('RegularRentPayment' + money, 'i')));
  f.last = halalas(num(new RegExp('LastRentPayment' + money, 'i')));
  const cnt = num(/NumberofRentPayments:?(\d{1,3})/i);
  if (cnt) f.count = Number(cnt);

  // العدادات: الرقم بعد تسميته، والقراءة الحالية أقرب ما قبله
  for (const [kind, label] of [['electricity', 'Electricitymeternumber'], ['gas', 'Gasmeternumber'], ['water', 'Watermeternumber']] as const) {
    const i = one.search(new RegExp(label, 'i'));
    if (i < 0) continue;
    const n = one.slice(i + label.length).match(/^:?(\d{4,})/);
    if (!n) continue;
    const before = one.slice(Math.max(0, i - 80), i);
    const rd = [...before.matchAll(/Currentmeterreading:?(\d+(?:\.\d+)?)/gi)].pop();
    out.meters.push({ kind, number: n[1], reading: rd ? Number(rd[1]) : null });
  }

  // جدولا الغرف والمكيفات (قرار المالك: تُبنى القراءة على هيئة الجدول وتُفحص على الجوال) · بعد عنوان كلٍّ منهما
  // سطورٌ فيها أزواج «نوع وعدد» بأيّ الترتيبين، حتى أول سطرٍ لاتيني غير عنوانهما
  const table = (header: RegExp, stop: RegExp) => {
    const rows: Array<{ type: string; count: number }> = [];
    let inside = false;
    for (const l of lines) {
      const flat = l.replace(/\s+/g, '');
      if (header.test(flat)) { inside = true; continue; }
      if (!inside) continue;
      if (stop.test(flat) || (/[A-Za-z]{3,}/.test(l) && !header.test(flat))) break;
      rows.push(...pairsOf(l));
    }
    return rows;
  };
  out.rooms = table(/NumberRoomType/i, /NumberACType|meter|TenantAuthority|FinancialData/i);
  out.acUnits = table(/NumberACType/i, /meter|TenantAuthority|FinancialData/i);
  return out;
}

// عناوين أعمدة الجدولين بالعربية لا تُعدّ أنواعاً
const HEADER_WORD = /^(نوع|العدد|عدد|الغرفة|المكيف)/; // i18n-exempt: مفردات الملف

/** أزواج «نوع وعدد» في سطرٍ مصحَّح الاتجاه · العدد قبل النوع أو بعده */
export function pairsOf(line: string): Array<{ type: string; count: number }> {
  const toks = line.match(/\d{1,3}|[\u0600-\u06FF][\u0600-\u06FF\s/]*[\u0600-\u06FF]|[\u0600-\u06FF]/g) ?? [];
  const items = toks.map((x) => x.trim()).filter((x) => x && !HEADER_WORD.test(x));
  if (!items.length) return [];
  const numFirst = /^\d+$/.test(items[0]);
  const out: Array<{ type: string; count: number }> = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    const [a, b] = numFirst ? [items[i + 1], items[i]] : [items[i], items[i + 1]];
    if (/^\d+$/.test(b) && !/^\d+$/.test(a) && Number(b) > 0) out.push({ type: a, count: Number(b) });
  }
  return out;
}

// مفردات ملف إيجار · قيم مطابقة لا نصوص عرض
const YES = /^(نعم|yes)$/i; // i18n-exempt: مفردات الملف
const PARTIAL = /جزئ/; // i18n-exempt: مفردات الملف

/** «مؤثثة» و«حالة التأثيث» في خانة التطبيق الواحدة (قرار المالك: تُدمجان) */
export function mapFurnished(furnished?: string, status?: string): (typeof FURNISHED_OPTIONS)[number] | undefined {
  if (!furnished && !status) return undefined;
  if (status && PARTIAL.test(status)) return FURNISHED_OPTIONS[2];
  if (furnished && YES.test(furnished.trim())) return FURNISHED_OPTIONS[1];
  if (furnished) return FURNISHED_OPTIONS[0];
  return undefined;
}

// i18n-exempt: مفردات ملف إيجار لأنواع الوحدات تُطابق أنواع التطبيق
const UNIT_TYPE_MAP: Array<[RegExp, string]> = [
  [/(شقة|شقه|فيلا|فيلل|دور|ملحق|استوديو|غرفة|غرفه|سكن)/, 'سكني'], // i18n-exempt: مفردات المطابقة
  [/معرض/, 'معرض'], // i18n-exempt: مفردات المطابقة
  [/محل/, 'محل'], // i18n-exempt: مفردات المطابقة
  [/مكتب/, 'مكتب'], // i18n-exempt: مفردات المطابقة
  [/(مستودع|مخزن)/, 'مخزن'], // i18n-exempt: مفردات المطابقة
];
export const mapUnitType = (v?: string): string | null => (v ? UNIT_TYPE_MAP.find(([re]) => re.test(v))?.[1] ?? null : null);

// i18n-exempt: مفردات ملف إيجار لغرض العقار
const USAGE_MAP: Array<[RegExp, string]> = [
  [/سكني.*تجاري|تجاري.*سكني/, 'مختلط'], // i18n-exempt: مفردات المطابقة
  [/سكني/, 'سكني'], // i18n-exempt: مفردات المطابقة
  [/تجاري/, 'محل'], // i18n-exempt: مفردات المطابقة
];
export const mapUsage = (v?: string): string | null => (v ? USAGE_MAP.find(([re]) => re.test(v))?.[1] ?? null : null);

/** رقم الطابق في الملف إلى تسمية طوابق التطبيق (٠ = الأرضي) */
export const mapFloor = (v?: string): string | null => {
  if (v == null || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return floorLabels(n)[n] ?? null;
};

/* ═══════════ فحوص الجدول ═══════════ */

export interface ScheduleCheck { code: 'count' | 'regular' | 'last'; expected: number; actual: number }

/** عدد الصفوف والدفعة الدورية والأخيرة مقابل البيانات المالية المقروءة · الفارق تنبيه في المراجعة */
/** فرق مجموع جدول إيجار عن إجمالي العقد بالهللات · صفر = متطابقان (المراجعة #2: لا استبدال صامت) */
export function scheduleSumGap(schedule: Array<{ amountHalalas: number }> | null | undefined, totalHalalas: number): number {
  if (!schedule?.length) return 0;
  return schedule.reduce((s, r) => s + Number(r.amountHalalas || 0), 0) - totalHalalas;
}

export function scheduleChecks(schedule: ScheduleRow[] | null | undefined, f: EjarExtras['financial']): ScheduleCheck[] {
  if (!schedule?.length) return [];
  const out: ScheduleCheck[] = [];
  if (f.count != null && f.count !== schedule.length) out.push({ code: 'count', expected: f.count, actual: schedule.length });
  if (f.regular != null) {
    const bad = schedule.slice(0, -1).find((r) => r.amountHalalas !== f.regular);
    if (bad) out.push({ code: 'regular', expected: f.regular, actual: bad.amountHalalas });
  }
  const last = schedule[schedule.length - 1].amountHalalas;
  if (f.last != null && f.last !== last) out.push({ code: 'last', expected: f.last, actual: last });
  return out;
}

/* ═══════════ المقارنة بالقائم والتطبيق بالموافقة ═══════════ */

export type ExtraKey =
  | 'property.address' | 'property.usage' | 'property.floors' | 'property.deed'
  | 'unit.type' | 'unit.floor' | 'tenant.email'
  | 'meter.electricity' | 'meter.water' | 'meter.gas' | 'unit.rooms';

export interface ExtraDiff {
  key: ExtraKey;
  /** القيمة القائمة · '' فارغة */
  current: string;
  /** المقروء كما سيُكتب */
  read: string;
  /** القائم فارغ: يُملأ افتراضاً · والمختلف لا يُكتب إلا بموافقة صريحة */
  fillsEmpty: boolean;
  /** لا خانة له في التطبيق (عداد الغاز) · يُعرض ولا يُكتب */
  noSlot?: boolean;
  /** قراءة العداد الحالية · تُسجَّل قراءة استلام */
  reading?: number | null;
}

/** ما قُرئ مقارناً بالعقار والوحدة والمستأجر · لا يعود المتطابق */
export function compareExtras(db: DB, x: EjarExtras, ctx: { unitId: string; tenantName: string }): ExtraDiff[] {
  const u = db.get<{ property_id: string; type: string; floor: string }>(`SELECT property_id, type, floor FROM units WHERE id = ?`, [ctx.unitId]);
  if (!u) return [];
  const p = db.get<{ address: string | null; activity_type: string | null; floors: number | null; deed_no: string | null }>(
    `SELECT address, activity_type, floors, deed_no FROM properties WHERE id = ?`, [u.property_id]);
  const tenant = db.get<{ email: string }>(`SELECT email FROM tenants WHERE name = ? AND deleted_at IS NULL`, [ctx.tenantName.trim()]);
  const out: ExtraDiff[] = [];
  const add = (key: ExtraKey, current: string | number | null | undefined, read: string | number | null | undefined, extra: Partial<ExtraDiff> = {}) => {
    if (read == null || read === '') return;
    const c = current == null ? '' : String(current).trim();
    const r = String(read).trim();
    if (c === r && !extra.reading) return;
    out.push({ key, current: c, read: r, fillsEmpty: !c, ...extra });
  };
  add('property.address', p?.address, x.property.nationalAddress);
  add('property.usage', p?.activity_type, mapUsage(x.property.usage));
  add('property.floors', p?.floors, x.property.floors);
  add('property.deed', p?.deed_no, x.property.deedNo);
  add('unit.type', u.type, mapUnitType(x.unit.unitType));
  add('unit.floor', u.floor, mapFloor(x.unit.floorNo));
  if (x.rooms.length) {
    const cur = db.all<{ room_name: string }>(`SELECT room_name FROM unit_rooms WHERE unit_id = ? ORDER BY sort`, [ctx.unitId]).map((r) => r.room_name);
    const want = roomNames(x.rooms);
    const missing = want.filter((n) => !cur.includes(n));
    if (missing.length) out.push({ key: 'unit.rooms', current: cur.join(ROOM_SEP), read: want.join(ROOM_SEP), fillsEmpty: !cur.length });
  }
  if (tenant) add('tenant.email', tenant.email, x.tenant.email);
  else if (x.tenant.email) out.push({ key: 'tenant.email', current: '', read: x.tenant.email, fillsEmpty: true });
  for (const m of x.meters) {
    const kind = METER_KIND_OF[m.kind];
    const cur = db.get<{ number: string }>(`SELECT number FROM meters WHERE owner_type = 'unit' AND owner_id = ? AND kind = ? AND deleted_at IS NULL`, [ctx.unitId, kind]);
    add(('meter.' + m.kind) as ExtraKey, cur?.number, m.number, { reading: m.reading });
  }
  return out;
}

/**
 * يكتب ما وافق عليه المستخدم وحده · بعد إنشاء العقد (فالمستأجر قد أُنشئ) ·
 * وقراءة العداد الحالية قراءة استلام بتاريخ بداية العقد
 */
export function applyExtras(db: DB, diffs: ExtraDiff[], approved: Set<ExtraKey>, ctx: { unitId: string; tenantName: string; tenantId?: string | null; start: string; handoverRef: string }): number {
  const u = db.get<{ property_id: string }>(`SELECT property_id FROM units WHERE id = ?`, [ctx.unitId]);
  if (!u) return 0;
  let n = 0;
  db.transaction(() => {
    for (const d of diffs) {
      if (d.noSlot || !approved.has(d.key)) continue;
      switch (d.key) {
        case 'property.address': db.run(`UPDATE properties SET address = ? WHERE id = ?`, [d.read, u.property_id]); break;
        case 'property.usage': db.run(`UPDATE properties SET activity_type = ? WHERE id = ?`, [d.read, u.property_id]); break;
        case 'property.floors': db.run(`UPDATE properties SET floors = ? WHERE id = ?`, [Number(d.read), u.property_id]); break;
        case 'property.deed': db.run(`UPDATE properties SET deed_no = ? WHERE id = ?`, [d.read, u.property_id]); break;
        case 'unit.type': db.run(`UPDATE units SET type = ? WHERE id = ?`, [d.read, ctx.unitId]); break;
        case 'unit.floor': db.run(`UPDATE units SET floor = ? WHERE id = ?`, [d.read, ctx.unitId]); break;
        case 'unit.rooms': {
          // تُضاف الغرف الناقصة وحدها · والقائمة ومحتوياتها لا تُمسّ
          const cur = new Set(db.all<{ room_name: string }>(`SELECT room_name FROM unit_rooms WHERE unit_id = ?`, [ctx.unitId]).map((r) => r.room_name));
          let sort = Number(db.get<{ m: number }>(`SELECT COALESCE(MAX(sort), -1) AS m FROM unit_rooms WHERE unit_id = ?`, [ctx.unitId])?.m ?? -1);
          for (const name of d.read.split(ROOM_SEP)) {
            if (!name || cur.has(name)) continue;
            db.run(`INSERT INTO unit_rooms (id, unit_id, room_name, sort) VALUES (?,?,?,?)`, [uid(), ctx.unitId, name, ++sort]);
          }
          break;
        }
        // لمستأجر العقد بمعرّفه: الاسم لا يميّز صاحبي هويتين (التحقق المستقل) · وبالاسم لما لا معرّف له
        case 'tenant.email': if (ctx.tenantId) db.run(`UPDATE tenants SET email = ? WHERE id = ?`, [d.read, ctx.tenantId]);
          else db.run(`UPDATE tenants SET email = ? WHERE name = ? AND deleted_at IS NULL`, [d.read, ctx.tenantName.trim()]);
          break;
        case 'meter.electricity':
        case 'meter.water':
        case 'meter.gas': {
          const kind = METER_KIND_OF[d.key.slice(6) as MeterKind];
          let m = db.get<{ id: string }>(`SELECT id FROM meters WHERE owner_type = 'unit' AND owner_id = ? AND kind = ? AND deleted_at IS NULL`, [ctx.unitId, kind]);
          if (m) db.run(`UPDATE meters SET number = ? WHERE id = ?`, [d.read, m.id]);
          else { const id = uid(); db.run(`INSERT INTO meters (id, owner_type, owner_id, kind, number) VALUES (?,?,?,?,?)`, [id, 'unit', ctx.unitId, kind, d.read]); m = { id }; }
          if (d.reading != null) {
            db.run(`INSERT INTO meter_readings (id, meter_id, date, reading, amount_halalas, ref) VALUES (?,?,?,?,0,?)`, [uid(), m.id, ctx.start, d.reading, ctx.handoverRef]);
          }
          break;
        }
        default: break;
      }
      n++;
    }
  });
  return n;
}

/** الوحدة برقمها داخل العقار المختار · للاختيار الآلي */
export function unitByNumber(db: DB, propertyId: string, unitNo: string): string | null {
  const norm = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/\s+/g, '').toLowerCase();
  const rows = db.all<{ id: string; unit_no: string }>(`SELECT id, unit_no FROM units WHERE property_id = ? AND deleted_at IS NULL`, [propertyId]);
  return rows.find((r) => norm(r.unit_no) === norm(unitNo))?.id ?? null;
}

/**
 * الخدمات والمواقف من بيانات العقد المالية المقروءة (قرار المالك ٢٠٢٦-١٠-٠٧) · الخدمات مجموع الغاز والكهرباء
 * والمياه، والمواقف ما بقي من إجمالي قيمة العقد بعد كامل قيمة الإيجار والخدمات
 */
export function revenueSplitOf(x?: EjarExtras | null): { servicesHalalas?: number; parkingHalalas?: number; otherHalalas?: number } {
  const f = x?.financial;
  if (!f || f.totalValue == null || f.rentValue == null) return {};
  const services = (f.gas ?? 0) + (f.electricity ?? 0) + (f.water ?? 0);
  // المواقف من خانتها (ParkingAnnualAmount)، وما بقي من الإجمالي فرقٌ يُعرض ولا يدخل المواقف (دراسة القائم · قرار المالك 2026-10-09)
  const parking = f.parking ?? 0;
  const other = f.totalValue - f.rentValue - services - parking;
  if (!services && !parking && !other) return {};
  return { servicesHalalas: services, parkingHalalas: parking, ...(other ? { otherHalalas: other } : {}) };
}

/** أسماء الغرف من «النوع وعدده»: الواحدة باسم نوعها، والأكثر مرقّمة */
export function roomNames(rooms: Array<{ type: string; count: number }>): string[] {
  return rooms.flatMap((r) => (r.count === 1 ? [r.type] : Array.from({ length: Math.min(r.count, 30) }, (_, i) => r.type + ' ' + (i + 1))));
}

// i18n-exempt: فاصل قائمة الغرف في قيمة المقارنة (يُكتب ويُقرأ في الموضعين)
const ROOM_SEP = '، ';

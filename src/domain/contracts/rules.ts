/**
 * قواعد العمل الثلاث عشرة · تُنقل حرفياً من النموذج برسائلها.
 * دوال خالصة تعمل على القاعدة وتعيد رسالة الخطأ العربية أو null عند السلامة.
 */
import type { DB } from '../../db/adapter';
import { dfmt, today, daysBetween } from '../dates';
import { normalizePhone } from '../phone';
import { deviceLetter, withLetter, takeNumber } from '../numbering';

export const RENEW_WINDOW_DAYS = 60;

export interface ContractRow {
  id: string;
  contract_no: string | null;
  tenant_name: string;
  phone: string;
  id_number: string;
  unit_id: string;
  unit_label: string;
  unit_type: string | null;
  value_halalas: number;
  cycle: string;
  start: string | null;
  end: string | null;
  deposit_halalas: number;
  ejar_no: string;
  services: string;
  furnished: string;
  type_specific: string;
  status: 'مسودة' | 'سارٍ' | 'منتهٍ' | 'ملغى';
  cancel_date: string | null;
  cancel_reason: string | null;
  cancel_deduction_halalas: number | null;
  cancel_refund_halalas: number | null;
  cancel_deduction_reason: string | null;
  renewed_from: string | null;
  renewed_to: string | null;
  renew_count: number;
  archived: number;
}

export interface UnitRow {
  id: string;
  property_id: string;
  unit_no: string;
  floor: string;
  type: string;
  subtype: string;
  under_maintenance: number;
}

export interface PropertyRow {
  id: string;
  name: string;
  activity_type: string;
  activity_subtype: string;
  ownership: string;
  lease_start: string | null;
  lease_end: string | null;
  floors: number | null;
}

export function getUnit(db: DB, unitId: string): UnitRow | undefined {
  return db.get<UnitRow>(`SELECT * FROM units WHERE id = ? AND deleted_at IS NULL`, [unitId]);
}
export function getProperty(db: DB, propertyId: string): PropertyRow | undefined {
  return db.get<PropertyRow>(`SELECT * FROM properties WHERE id = ? AND deleted_at IS NULL`, [propertyId]);
}
export function getContract(db: DB, id: string): ContractRow | undefined {
  return db.get<ContractRow>(`SELECT * FROM contracts WHERE id = ? AND deleted_at IS NULL`, [id]);
}
export function floorCategory(db: DB, propertyId: string, floor: string): string | null {
  const row = db.get<{ category: string }>(
    `SELECT category FROM property_floor_categories WHERE property_id = ? AND floor_label = ?`,
    [propertyId, floor]
  );
  return row ? row.category : null;
}

/** رقم العقد المعروض: المسودة تُعرض «خانة فارغة» */
export function contractDisplayId(c: Pick<ContractRow, 'status' | 'contract_no'>): string {
  return c.status === 'مسودة' ? 'لا يوجد' : c.contract_no || 'لا يوجد';
}

/**
 * الحالة المعروضة مشتقة من التواريخ:
 * لا يصبح العقد سارياً قبل تاريخ بدايته (قادم)، وبعد تاريخ نهايته يُكتب منتهٍ.
 */
export type ContractDisplayStatus = 'مسودة' | 'ملغى' | 'موثَّق ولم يبدأ' | 'سارٍ' | 'ينتهي قريباً' | 'منتهٍ';

/**
 * أقل ما تحتاجه دوال الحالة · الحالة نصّ عام كي تقبل صفوف التقارير والمطبوعات
 * كما تقبل صفوف الشاشات (قيد CHECK في القاعدة هو حارس القيم الفعلي).
 */
export interface ContractStatusInput { status: string; start?: string | null; end?: string | null }

/**
 * حالة العقد من التاريخ · الدالة الواحدة التي تستدعيها كل الشاشات فلا تتناقض:
 * ملغى يسبق كل شيء ثم مسودة ثم موثَّق ولم يبدأ ثم سارٍ/ينتهي قريباً (٦٠ يوماً) ثم منتهٍ.
 */
export function contractDisplayStatus(
  c: ContractStatusInput,
  T: string = today()
): ContractDisplayStatus {
  if (c.status === 'ملغى') return 'ملغى';
  if (c.status === 'مسودة') return 'مسودة';
  if (c.start && c.start > T) return 'موثَّق ولم يبدأ';
  if (c.end && c.end < T) return 'منتهٍ';
  if (c.end && daysBetween(c.end, T) >= 0 && daysBetween(c.end, T) <= 60) return 'ينتهي قريباً';
  return 'سارٍ';
}

/** سارٍ بمعناه الواسع: يشمل «ينتهي قريباً» · للمرشِّحات والإحصاءات */
export const isActiveDisplay = (s: ContractDisplayStatus): boolean => s === 'سارٍ' || s === 'ينتهي قريباً';

/**
 * نص الانتهاء بعدد أيامه بالصيغة العربية الصحيحة:
 * صفر «ينتهي اليوم» · واحد «ينتهي غداً» · اثنان «ينتهي بعد يومين»
 * · من ٣ إلى ١٠ «ينتهي بعد N أيام» · ١١ فأكثر «ينتهي بعد N يوماً».
 */
export function expiryLabel(days: number): string {
  const d = Math.max(0, Math.round(days));
  if (d === 0) return 'ينتهي اليوم';
  if (d === 1) return 'ينتهي غداً';
  if (d === 2) return 'ينتهي بعد يومين';
  if (d <= 10) return 'ينتهي بعد ' + d + ' أيام';
  return 'ينتهي بعد ' + d + ' يوماً';
}

/**
 * النص المعروض للحالة · الحالة المنطقية تبقى كما هي للمرشِّحات والإحصاءات،
 * و«ينتهي قريباً» وحدها تُعرض بعدد أيامها الفعلي.
 */
export function contractStatusLabel(
  c: ContractStatusInput,
  T: string = today()
): string {
  const ds = contractDisplayStatus(c, T);
  if (ds !== 'ينتهي قريباً') return ds;
  return expiryLabel(daysToContractEnd(c, T) ?? 0);
}

/**
 * لون الشارة لكل حالة · معلن هنا وحده فتتطابق الشارة في كل شاشة
 * (القائمة والتفاصيل وملف المستأجر والوحدة) ولا تتفرق الخرائط.
 */
export function contractStatusKind(
  c: ContractStatusInput,
  T: string = today()
): string {
  const map: Record<ContractDisplayStatus, string> = {
    'مسودة': 'draft', 'ملغى': 'overdue', 'منتهٍ': 'draft',
    'سارٍ': 'paid', 'ينتهي قريباً': 'due', 'موثَّق ولم يبدأ': 'due',
  };
  return map[contractDisplayStatus(c, T)] ?? 'draft';
}

/** تحديث الحالة المخزنة للعقود التي تجاوزت نهايتها */
export function refreshContractStatuses(db: DB, T: string = today()): void {
  db.transaction(() => {
    db.run(
      `UPDATE contracts SET status = 'منتهٍ'
       WHERE status = 'سارٍ' AND end IS NOT NULL AND end < ? AND deleted_at IS NULL`,
      [T]
    );
  });
}

/** العقد المُنشأ لا يُعدَّل ولا يُحذف */
export function contractLocked(c: Pick<ContractRow, 'status'>): boolean {
  return c.status !== 'مسودة';
}

/** انتهاء العقد (يفتح التقييم والتصرف بالتأمين) */
export function contractEnded(c: Pick<ContractRow, 'status' | 'end'>, T: string = today()): boolean {
  if (c.status === 'ملغى') return true;
  // التجديد يجعل الحالة «منتهٍ» قبل نهايته، فالحكم بالتاريخ · وعقدٌ بلا نهاية بحالته
  if (!c.end) return c.status === 'منتهٍ';
  return c.end < T;
}

export function daysToContractEnd(c: { end?: string | null }, T: string = today()): number | null {
  if (!c.end) return null;
  return daysBetween(c.end, T);
}

/** «التجديد يتاح قبل الانتهاء بستين يوماً، ولا يُجدَّد عقد له خلف» */
export function canRenewContract(c: ContractRow, T: string = today()): boolean {
  if (c.status === 'مسودة' || c.status === 'ملغى') return false;
  if (c.renewed_to) return false;
  const d = daysToContractEnd(c, T);
  return d !== null && d <= RENEW_WINDOW_DAYS;
}

/** سبب منع التجديد · بنفس رسائل النموذج */
export function renewBlockReason(c: ContractRow, T: string = today()): string | null {
  if (c.status === 'مسودة') return 'المسودة تُحوَّل لعقد ولا تُجدَّد';
  if (c.status === 'ملغى') return 'العقد الملغى لا يُجدَّد';
  if (c.renewed_to) return 'هذا العقد مُجدَّد بالفعل · العقد الجديد ' + c.renewed_to;
  const d = daysToContractEnd(c, T);
  if (d !== null && d > RENEW_WINDOW_DAYS)
    return 'التجديد يتاح قبل انتهاء العقد بـ' + RENEW_WINDOW_DAYS + ' يوماً · يتبقّى ' + d + ' يوماً';
  return null;
}

export function datesOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
  return startA <= endB && startB <= endA;
}

/** القاعدة ٣: منع تعارض العقود على نفس الوحدة زمنياً (المسودة والملغى بعد قصّه لا يتعارضان) */
export function findContractConflict(
  db: DB,
  unitId: string,
  start: string,
  end: string,
  excludeContractId?: string | null
): ContractRow | null {
  if (!start || !end) return null;
  const rows = db.all<ContractRow>(
    `SELECT * FROM contracts
     WHERE unit_id = ? AND deleted_at IS NULL AND status != 'مسودة'
       AND start IS NOT NULL AND end IS NOT NULL`,
    [unitId]
  );
  for (const c of rows) {
    if (excludeContractId && c.id === excludeContractId) continue;
    if (datesOverlap(start, end, c.start!, c.end!)) return c;
  }
  return null;
}

export interface ReservationRow {
  id: string;
  unit_id: string;
  name: string;
  phone: string;
  deposit_halalas: number;
  expiry_date: string;
  status: string;
}

/** انقضاء الحجوزات المنتهية زمنياً */
export function expireOldReservations(db: DB, T: string = today()): void {
  db.transaction(() => {
    db.run(
      `UPDATE reservations SET status = 'منتهي'
       WHERE status = 'نشط' AND expiry_date < ? AND deleted_at IS NULL`,
      [T]
    );
  });
}

export function unitActiveReservation(db: DB, unitId: string, T: string = today()): ReservationRow | null {
  expireOldReservations(db, T);
  return (
    db.get<ReservationRow>(
      `SELECT * FROM reservations WHERE unit_id = ? AND status = 'نشط' AND deleted_at IS NULL`,
      [unitId]
    ) ?? null
  );
}

/** العقد الساري على الوحدة اليوم (المسودة لا تشغل وحدة) */
export function unitCurrentContract(db: DB, unitId: string, T: string = today()): ContractRow | null {
  return (
    db.get<ContractRow>(
      `SELECT * FROM contracts
       WHERE unit_id = ? AND deleted_at IS NULL AND status NOT IN ('مسودة','ملغى')
         AND start <= ? AND end >= ?`,
      [unitId, T, T]
    ) ?? null
  );
}

export interface ContractInput {
  tenant: string;
  phone: string;
  unitId: string;
  start: string;
  end: string;
  valueHalalas: number;
  /** حجز الوحدة المحوَّل لهذا العقد (بمعرّفه) */
  reservationId?: string | null;
}

/** الحقل الذي سبّب رفض التحقق · تظلّله الواجهة بالأحمر وتمرّر إليه */
export type ContractField = 'tenant' | 'phone' | 'unitId' | 'start' | 'end' | 'value';
let lastValidationField: ContractField | null = null;
/** حقل آخر رفض أعادته validateConfirmedContract (يُقرأ مباشرة بعدها) */
export function lastContractErrorField(): ContractField | null {
  return lastValidationField;
}

/**
 * التحقق قبل إنشاء عقد موثَّق (غير مسودة) · القواعد ١ و٢ و٣ و٤ بنصوص النموذج.
 * يعيد رسالة الخطأ أو null، ويسجّل الحقل المسبِّب في lastContractErrorField.
 */
export function validateConfirmedContract(
  db: DB,
  input: ContractInput,
  excludeContractId?: string | null
): string | null {
  const fail = (field: ContractField | null, msg: string) => {
    lastValidationField = field;
    return msg;
  };
  lastValidationField = null;
  const { tenant, unitId, start, end, valueHalalas } = input;
  if (!tenant.trim()) return fail('tenant', 'الرجاء إدخال اسم المستأجر');
  if (!unitId) return fail('unitId', 'اختر الوحدة المؤجَّرة، أو احفظ العقد كمسودة إن لم يكتمل بعد');
  if (!start) return fail('start', 'أدخل تاريخ بداية العقد، أو احفظه كمسودة إن لم يكتمل بعد');
  if (!end) return fail('end', 'أدخل تاريخ نهاية العقد، أو احفظه كمسودة إن لم يكتمل بعد');
  if (!valueHalalas) return fail('value', 'أدخل قيمة العقد، أو احفظه كمسودة إن لم يكتمل بعد');
  if (start > end) return fail('end', `تاريخ البداية (${dfmt(start)}) يجب أن يسبق تاريخ النهاية (${dfmt(end)})`);
  const ph = input.phone.trim();
  if (ph && !normalizePhone(ph)) return fail('phone', `رقم الجوال "${ph}" ليس رقم جوال سعودي صحيح · تُقبل الصيغ: 05XXXXXXXX أو +9665XXXXXXXX أو 009665XXXXXXXX`);

  const u = getUnit(db, unitId);
  if (!u) return fail('unitId', 'أضف وحدة أولاً من شاشة العقارات');
  const unitProp = getProperty(db, u.property_id);

  // القاعدة ١أ: نشاط العقار يقيّد نوع الوحدة
  if (
    unitProp && unitProp.activity_type && unitProp.activity_type !== 'مختلط' &&
    u.type && u.type !== unitProp.activity_type
  ) {
    return fail('unitId', `تعذّر الحفظ · العقار "${unitProp.name}" مخصَّص لنشاط "${unitProp.activity_type}"، والوحدة المختارة من نوع "${u.type}". إمّا عدّل نوع الوحدة، أو اجعل العقار "مختلط" من تعديل بياناته`);
  }
  // القاعدة ١ب: فئة العقار
  if (unitProp && unitProp.activity_subtype && u.subtype && u.subtype !== unitProp.activity_subtype) {
    return fail('unitId', `تعذّر الحفظ · العقار "${unitProp.name}" مخصَّص لفئة "${unitProp.activity_subtype}" فقط، والوحدة المختارة فئتها "${u.subtype}". إمّا عدّل فئة الوحدة، أو أزل تخصيص الفئة عن العقار`);
  }
  // القاعدة ١ج: فئة الطابق
  const floorCat = unitProp ? floorCategory(db, unitProp.id, u.floor) : null;
  if (floorCat && u.subtype && u.subtype !== floorCat) {
    return fail('unitId', `تعذّر الحفظ · طابق "${u.floor}" بهذا العقار مخصَّص لفئة "${floorCat}" فقط، والوحدة المختارة فئتها "${u.subtype}"`);
  }
  // القاعدة ٢: العقار المستأجَر من الغير
  if (unitProp && unitProp.ownership === 'إيجار' && unitProp.lease_start && unitProp.lease_end) {
    if (start < unitProp.lease_start || end > unitProp.lease_end) {
      return fail('end', `تعذّر الحفظ · عقد "${unitProp.name}" الأساسي (الذي تستأجره الشركة) ساري من ${dfmt(unitProp.lease_start)} إلى ${dfmt(unitProp.lease_end)} فقط، ولا يمكن تأجير الوحدة لفترة تتجاوز هذا النطاق`);
    }
  }
  // القاعدة ٣: منع التعارض الزمني
  const conflict = findContractConflict(db, unitId, start, end, excludeContractId);
  if (conflict) {
    return fail('start', `تعذّر إنشاء العقد · تتداخل مدته مع العقد ${conflict.contract_no} لـ"${conflict.tenant_name}" على نفس الوحدة (من ${dfmt(conflict.start)} إلى ${dfmt(conflict.end)})`);
  }
  // القاعدة ٤: الحجز بعربون يمنع التأجير لغير صاحبه · والعقد لصاحبه يحمل معرّف الحجز لا اسمه (المراجعة ٤.٤)
  const activeRsv = unitActiveReservation(db, unitId);
  if (activeRsv && input.reservationId !== activeRsv.id) {
    return fail('tenant', `تعذّر الحفظ · هذه الوحدة محجوزة بعربون لـ"${activeRsv.name}" حتى ${dfmt(activeRsv.expiry_date)}. لا يمكن تأجيرها لمستأجر آخر قبل انتهاء الحجز، أو اختر «تحويل الحجز إلى هذا العقد» إن كان المستأجر صاحبه`);
  }
  if (!activeRsv && input.reservationId) return fail('tenant', 'تعذّر الحفظ · الحجز المختار لم يعد قائماً على هذه الوحدة');
  return null;
}

/** رقم العقد التالي EJ-YYYY-### · المسودات لا تستهلك رقماً من التسلسل */
export function nextContractNo(db: DB, dateStr?: string): string {
  const yr = new Date((dateStr || today()) + 'T00:00:00').getFullYear();
  // من كتلة هذا الجهاز (numbering.ts) · والتسلسل واحد عبر السنين، والسنة من تاريخ العقد
  const n = takeNumber(db, 'EJ');
  if (n !== null) return 'EJ-' + yr + '-' + String(n).padStart(3, '0');
  const rows = db.all<{ contract_no: string }>(
    `SELECT contract_no FROM contracts
     WHERE contract_no IS NOT NULL AND status != 'مسودة' AND deleted_at IS NULL`
  );
  // بلا كتلة: الترقيم القديم · تسلسل هذا الجهاز وحده بلا حرف أو بحرفه بعد الرقم
  const letter = deviceLetter(db);
  const own = new RegExp('^EJ-\\d{4}-(\\d+)' + (letter ? '-' + letter : '') + '$');
  let max = 0;
  for (const r of rows) {
    const m = String(r.contract_no || '').match(own);
    if (m) max = Math.max(max, +m[1]);
  }
  return withLetter('EJ-' + yr + '-' + String(max + 1).padStart(3, '0'), letter);
}

/** القاعدة ٩: التقبيل لا يُسجَّل على عقد ملغى أو مسودة */
export function keyMoneyBlockReason(c: Pick<ContractRow, 'status'> | null): string | null {
  if (!c) return null;
  if (c.status === 'ملغى') return 'العقد ملغى · لا يُسجَّل عليه تقبيل';
  if (c.status === 'مسودة') return 'العقد لسا مسودة ولم يُوثَّق · لا يُسجَّل عليه تقبيل';
  return null;
}

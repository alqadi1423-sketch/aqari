/**
 * دورة حياة العقد: مسودة ← مراجعة ← توثيق (قفل) ← تجديد/إلغاء + الدفعات.
 * كل دالة تتم بمعاملة واحدة، والترحيل المحاسبي عبر مسار postEvent الواحد.
 */
import { correctionDate } from '../vatFilings';
import type { DB } from '../../db/adapter';
import { requireCash } from '../cashGuard';
import type { ScheduleRow } from '../pdf/parseEjar';
import { uid } from '../ids';
import { today, dfmt } from '../dates';
import {
  generateInstallments, INSTALLMENT_DISCOUNT_SQL, installmentRemaining,
  DISCOUNT_KINDS, DISCOUNT_REDUCES_INSTALLMENT, type DiscountKind,
} from './installments';
import { recomputeInstallments } from './paid';
import {
  validateConfirmedContract,
  nextContractNo,
  unitActiveReservation,
  getUnit,
  getProperty,
  getContract,
  contractLocked,
  contractEnded,
  renewBlockReason,
  findContractConflict,
  lastContractErrorField,
  type ContractRow,
  type ContractField,
} from './rules';
import {
  postContractDeposit,
  postDepositCarry,
  postDepositDeduct, postDepositDeductMove,
  postDepositRefund,
  postReservationConvert,
  postClaim,
  postRentCollection,
  postEntry,
  reverseEntryBySource,
} from '../accounting/post';
import { logAudit } from '../audit';
import { fmt } from '../money';
import { linkContractTenant } from '../tenants';
import { seedTenantOccupant, carryOccupantsToRenewal } from '../occupants';
import { createHandoverForContract } from '../handover/service';
import { normalizePhone } from '../phone';
import { rentRevenueLines } from '../accounting/rentSplit';
import { t } from '../../i18n';

export class RuleViolation extends Error {
  /** الحقل المسبِّب · تظلّله الواجهة بالأحمر */
  field: ContractField | null;
  constructor(message: string, field: ContractField | null = null) {
    super(message);
    this.name = 'RuleViolation';
    this.field = field;
  }
}

export interface ContractDraftInput {
  tenant: string;
  phone: string;
  idNumber: string;
  unitId: string;
  valueHalalas: number;
  cycle: string;
  start: string;
  end: string;
  depositHalalas: number;
  /** جهة قبض التأمين: المكتب · منصة إيجار · طرف آخر */
  depositHolder?: string;
  depositHolderName?: string;
  ejarNo: string;
  services: string;
  furnished: string;
  typeSpecific: Record<string, string>;
  /** حجز الوحدة الذي يتحوّل لهذا العقد · الربط بمعرّفه لا بالاسم (المراجعة ٤.٤) */
  reservationId?: string | null;
  /** جدول الدفعات كما قُرئ من ملف إيجار · null = قُرئ الملف وتعذّر جدوله */
  schedule?: ScheduleRow[] | null;
  /** العقد قُرئ من ملف إيجار · فإن تعذّر جدوله حُسبت الأقساط ونُبّه عليها */
  fromEjarFile?: boolean;
  /** ما في قيمة العقد للخدمات (غاز وكهرباء ومياه) وللمواقف · يُقسم بهما الإيراد (الهجرة ٣٢) */
  servicesHalalas?: number;
  parkingHalalas?: number;
}

/** مبلغا الخدمات والمواقف في العقد · فوق قيمته («كامل قيمة الإيجار»)، وإجمالي العقد مجموع الثلاثة */
function saveRevenueSplit(db: DB, id: string, input: ContractDraftInput): void {
  if (input.servicesHalalas === undefined && input.parkingHalalas === undefined) return;
  if (!db.all<{ name: string }>(`PRAGMA table_info(contracts)`).some((c) => c.name === 'services_halalas')) return;
  const s = Math.max(0, input.servicesHalalas ?? 0);
  const p = Math.max(0, input.parkingHalalas ?? 0);
  db.run(`UPDATE contracts SET services_halalas = ?, parking_halalas = ? WHERE id = ?`, [s, p, id]);
}

/** إجمالي العقد من مدخله: الإيجار والخدمات والمواقف · منه تُولَّد الأقساط ويُطابَق جدول إيجار */
export function draftTotal(input: Pick<ContractDraftInput, 'valueHalalas' | 'servicesHalalas' | 'parkingHalalas'>): number {
  return input.valueHalalas + Math.max(0, input.servicesHalalas ?? 0) + Math.max(0, input.parkingHalalas ?? 0);
}

/** مصدر تواريخ الأقساط (الهجرة ٢٤) */
export const SOURCE_FILE = 'ملف';
export const SOURCE_COMPUTED = 'محسوبة';

/**
 * الجدول صالحٌ لعقدٍ بمدته · كل تاريخ داخلها ومتصاعد. التواريخ والمبالغ من الملف كما هي دائماً:
 * لا استبدال صامت إن خالف مجموعها إجمالي العقد (قرار المالك 2026-10-07)، بل تنبيه أحمر بالفرق ولا توثيق حتى يتطابقا.
 */
export function scheduleInstallments(schedule: ScheduleRow[] | null | undefined, start: string, end: string, _totalHalalas?: number):
  Array<{ dueDate: string; deadline: string | null; amountHalalas: number }> | null {
  if (!schedule || !schedule.length || !start || !end) return null;
  for (let i = 0; i < schedule.length; i++) {
    const d = schedule[i].dueDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < start || d > end || (i && d < schedule[i - 1].dueDate)) return null;
  }
  // آخر مهلة السداد إلى مهلة القسط (grace_until) · لا تسبق الاستحقاق
  const dl = (r: ScheduleRow) => (r.deadline && r.deadline > r.dueDate ? r.deadline : null);
  return schedule.map((r) => ({ dueDate: r.dueDate, deadline: dl(r), amountHalalas: Number(r.amountHalalas) }));
}

/** مبلغا الخدمات والمواقف المحفوظان مع المسودة · يُستعملان حين يأتي النموذج المعاد فتحه بلا قراءة الملف */
function withStoredSplit(db: DB, input: ContractDraftInput, draftId?: string): ContractDraftInput {
  if (!draftId || input.servicesHalalas !== undefined || input.parkingHalalas !== undefined) return input;
  if (!db.all<{ name: string }>(`PRAGMA table_info(contracts)`).some((c) => c.name === 'services_halalas')) return input;
  const r = db.get<{ s: number; p: number }>(`SELECT services_halalas AS s, parking_halalas AS p FROM contracts WHERE id = ?`, [draftId]);
  if (!r || (!Number(r.s) && !Number(r.p))) return input;
  return { ...input, servicesHalalas: Number(r.s), parkingHalalas: Number(r.p) };
}

/** قاعدة ما قبل الهجرة ٢٤ (نسخة تُراجَع قبل ترقيتها) بلا عمودي الجدول والمصدر · فتُحسب أقساطها كما كانت */
function hasEjarColumns(db: DB): boolean {
  return db.all<{ name: string }>(`PRAGMA table_info(contracts)`).some((c) => c.name === 'installments_source');
}

/** ما يُحفظ مع المسودة من قراءة الملف · فلا يضيع الجدول إن أُغلق النموذج ثم وُثّق العقد لاحقاً */
function ejarColumns(input: ContractDraftInput): { schedule: string | null; source: string | null } | null {
  if (input.schedule === undefined && input.fromEjarFile === undefined) return null;
  const schedule = input.schedule && input.schedule.length ? JSON.stringify(input.schedule) : null;
  return { schedule, source: schedule ? SOURCE_FILE : input.fromEjarFile ? SOURCE_COMPUTED : null };
}

function unitLabel(db: DB, unitId: string): string {
  const u = getUnit(db, unitId);
  if (!u) return 'لا يوجد';
  const p = getProperty(db, u.property_id);
  return (p ? p.name : 'لا يوجد') + ' · ' + u.unit_no;
}

/** حفظ مسودة (جديدة أو تعديل مسودة قائمة) · بلا رقم، بلا جدول دفعات */
export function saveDraft(db: DB, input: ContractDraftInput, draftId?: string): string {
  if (!input.tenant.trim()) throw new RuleViolation('الرجاء إدخال اسم المستأجر');
  return db.transaction(() => {
    const id = draftId ?? uid();
    const u = input.unitId ? getUnit(db, input.unitId) : undefined;
    const fields = [
      input.tenant.trim(), normalizePhone(input.phone) ?? input.phone.trim(), input.idNumber.trim(), input.unitId || null,
      input.unitId ? unitLabel(db, input.unitId) : '', u?.type ?? null,
      input.valueHalalas, input.cycle, input.start || null, input.end || null,
      input.depositHalalas, input.ejarNo.trim(), input.services.trim(), input.furnished,
      JSON.stringify(input.typeSpecific || {}),
    ];
    if (draftId) {
      const c = getContract(db, draftId);
      if (!c) throw new RuleViolation('تعذّر العثور على العقد');
      if (contractLocked(c)) throw new RuleViolation('العقد مُنشأ ولا يُعدَّل · استخدم إلغاء العقد');
      db.run(
        `UPDATE contracts SET tenant_name=?, phone=?, id_number=?, unit_id=?, unit_label=?, unit_type=?,
         value_halalas=?, cycle=?, start=?, end=?, deposit_halalas=?, ejar_no=?, services=?, furnished=?, type_specific=?
         WHERE id = ?`,
        [...fields, draftId]
      );
      logAudit(db, 'العقود', 'update', 'مسودة عقد', input.tenant);
    } else {
      db.run(
        `INSERT INTO contracts (id, tenant_name, phone, id_number, unit_id, unit_label, unit_type,
          value_halalas, cycle, start, end, deposit_halalas, ejar_no, services, furnished, type_specific,
          status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'مسودة',?)`,
        [id, ...fields, new Date().toISOString()]
      );
      logAudit(db, 'العقود', 'create', 'مسودة عقد', input.tenant);
    }
    db.run(`UPDATE contracts SET deposit_holder = ?, deposit_holder_name = ? WHERE id = ?`,
      [input.depositHolder || 'المكتب', input.depositHolderName || '', id]);
    const ej = hasEjarColumns(db) ? ejarColumns(input) : null;
    if (ej) db.run(`UPDATE contracts SET ejar_schedule = ?, installments_source = ? WHERE id = ?`, [ej.schedule, ej.source, id]);
    // الخدمات والمواقف تُحفظ مع المسودة وتعود عند فتحها (المراجعة #1)
    saveRevenueSplit(db, id, input);
    // تغيير مستأجر المسودة يغيّر ربطها (دراسة القائم): يُعاد البحث بهويته واسمه في كل حفظ
    if (draftId) db.run(`UPDATE contracts SET tenant_id = NULL WHERE id = ?`, [id]);
    linkContractTenant(db, id);
    seedTenantOccupant(db, id);
    return id;
  });
}

/** حذف مسودة · المسودات فقط تُحذف */
export function deleteDraft(db: DB, id: string): void {
  const c = getContract(db, id);
  if (!c) return;
  if (contractLocked(c)) throw new RuleViolation('العقد مُنشأ ولا يُحذف · استخدم إلغاء العقد');
  db.transaction(() => {
    db.run(`UPDATE contracts SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    logAudit(db, 'العقود', 'delete', 'مسودة عقد', c.tenant_name);
  });
}

/**
 * توثيق عقد (جديد أو ترقية مسودة): القواعد ← الرقم ← جدول الدفعات ← قيد التأمين
 * ← تحويل الحجز ← مزامنة المستأجر. بعده العقد مقفل.
 */
export function confirmContract(db: DB, inputRaw: ContractDraftInput, draftId?: string): string {
  const input = withStoredSplit(db, inputRaw, draftId);
  const err = validateConfirmedContract(
    db,
    {
      tenant: input.tenant, phone: input.phone, unitId: input.unitId,
      start: input.start, end: input.end, valueHalalas: input.valueHalalas,
      reservationId: input.reservationId ?? null,
    },
    draftId
  );
  if (err) throw new RuleViolation(err, lastContractErrorField());

  return db.transaction(() => {
    if (draftId) {
      const c = getContract(db, draftId);
      if (!c) throw new RuleViolation('تعذّر العثور على العقد');
      if (contractLocked(c)) throw new RuleViolation('العقد مُنشأ ولا يُعدَّل · استخدم إلغاء العقد');
    }
    const id = draftId ?? uid();
    // «تأخذ رقمها عند التأكيد» · رقم إيجار إن وُجد وإلا التسلسل
    const contractNo = input.ejarNo.trim() || nextContractNo(db, input.start);
    const u = getUnit(db, input.unitId)!;
    const fields = [
      contractNo, input.tenant.trim(), normalizePhone(input.phone) ?? input.phone.trim(), input.idNumber.trim(), input.unitId,
      unitLabel(db, input.unitId), u.type,
      input.valueHalalas, input.cycle, input.start, input.end,
      input.depositHalalas, input.ejarNo.trim(), input.services.trim(), input.furnished,
      JSON.stringify(input.typeSpecific || {}),
    ];
    if (draftId) {
      db.run(
        `UPDATE contracts SET contract_no=?, tenant_name=?, phone=?, id_number=?, unit_id=?, unit_label=?, unit_type=?,
         value_halalas=?, cycle=?, start=?, end=?, deposit_halalas=?, ejar_no=?, services=?, furnished=?, type_specific=?,
         status='سارٍ' WHERE id = ?`,
        [...fields, draftId]
      );
    } else {
      db.run(
        `INSERT INTO contracts (id, contract_no, tenant_name, phone, id_number, unit_id, unit_label, unit_type,
          value_halalas, cycle, start, end, deposit_halalas, ejar_no, services, furnished, type_specific,
          status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'سارٍ',?)`,
        [id, ...fields, new Date().toISOString()]
      );
    }
    saveRevenueSplit(db, id, input);
    // «جدول الدفعات يُولَّد آلياً عند الإنشاء ولا يُعاد توليده»
    const hasInstallments = db.get(
      `SELECT id FROM contract_installments WHERE contract_id = ? LIMIT 1`, [id]
    );
    if (!hasInstallments) {
      // عقد إيجار من ملفه: التواريخ من جدول الدفعات فيه دائماً (قرار المالك ٢٠٢٦-١٠-٠٥) · وإن تعذّر
      // جدوله حُسبت بالدالة ووُسم العقد «محسوبة» فينبَّه عليه
      const cols = hasEjarColumns(db);
      const stored = cols ? db.get<{ s: string | null; src: string | null }>(
        `SELECT ejar_schedule AS s, installments_source AS src FROM contracts WHERE id = ?`, [id]) : undefined;
      const ej = ejarColumns(input) ?? { schedule: stored?.s ?? null, source: stored?.src ?? null };
      let parsed: ScheduleRow[] | null = null;
      try { parsed = ej.schedule ? (JSON.parse(ej.schedule) as ScheduleRow[]) : null; } catch { parsed = null; }
      const fromFile = scheduleInstallments(parsed, input.start, input.end, draftTotal(input));
      if (fromFile) {
        const sum = fromFile.reduce((x, r) => x + r.amountHalalas, 0);
        if (sum !== draftTotal(input)) {
          throw new RuleViolation(t('lease.scheduleSumMismatch', { lng: 'ar', sum: fmt(sum), total: fmt(draftTotal(input)) }), 'value');
        }
      }
      const insts: Array<{ id: string; dueDate: string; amountHalalas: number; deadline?: string | null }> = fromFile
        ? fromFile.map((x) => ({ id: uid(), ...x }))
        : generateInstallments(input.start, input.end, draftTotal(input), input.cycle);
      insts.forEach((inst, i) => {
        db.run(
          `INSERT INTO contract_installments (id, contract_id, due_date, amount_halalas, sort, grace_until)
           VALUES (?,?,?,?,?,?)`,
          [inst.id, id, inst.dueDate, inst.amountHalalas, i, inst.deadline ?? null]
        );
      });
      const source = fromFile ? SOURCE_FILE : (ej.source ? SOURCE_COMPUTED : null);
      if (cols) db.run(`UPDATE contracts SET ejar_schedule = ?, installments_source = ? WHERE id = ?`, [ej.schedule, source, id]);
    }
    // استلام التأمين
    db.run(`UPDATE contracts SET deposit_holder = ?, deposit_holder_name = ? WHERE id = ?`,
      [input.depositHolder || 'المكتب', input.depositHolderName || '', id]);
    postContractDeposit(db, {
      id, contract_no: contractNo, tenant: input.tenant, start: input.start,
      deposit: input.depositHalalas, holder: input.depositHolder,
    });
    // تحويل الحجز لعقد · بمعرّف الحجز الذي اختاره المستخدم، والعربون يسدّد الأقساط بالترتيب بتاريخ العقد (المراجعة ٤.٤)
    if (input.reservationId) convertReservation(db, input.reservationId, id, contractNo, input.tenant, input.start);
    // نموذج الاستلام والتسليم يُنشأ تلقائياً من تفاصيل الوحدة · واحد لكل عقد
    createHandoverForContract(db, id);
    logAudit(db, 'العقود', 'create', 'عقد إيجار', input.tenant, null, { contractNo });
    linkContractTenant(db, id);
    seedTenantOccupant(db, id);
    return id;
  });
}

/** أقساط العقد القائمة بمتبقيها بترتيب الاستحقاق · ما يتسع له العربون */
function openInstallments(db: DB, contractId: string) {
  return db.all<{ id: string; amount_halalas: number; paid_halalas: number; discount: number; due_date: string }>(
    `SELECT i.id, i.amount_halalas, i.paid_halalas, ${INSTALLMENT_DISCOUNT_SQL} AS discount, i.due_date
     FROM contract_installments i WHERE i.contract_id = ? AND i.status <> 'ملغية' ORDER BY i.due_date, i.sort`, [contractId])
    .map((i) => ({ ...i, remaining: installmentRemaining(Number(i.amount_halalas), Number(i.paid_halalas), Number(i.discount)) }));
}

/** مجموع المتبقي على أقساط العقد القائمة · سقف ما يسدّده العربون */
export function depositRoom(db: DB, contractId: string): number {
  return openInstallments(db, contractId).reduce((sum, i) => sum + i.remaining, 0);
}

/**
 * العربون إيجارٌ مقبوض مقدَّماً (المراجعة ٤.٤): يُوزَّع على المتبقي من الأقساط بترتيب استحقاقها، لكل قسط دفعةٌ
 * بتاريخ العقد وقيدها (مدين 2450 / دائن الإيجار) فينقص المتبقي عليه ويظهر في كشف المستأجر. وما زاد يُرفض.
 */
export function allocateDeposit(
  db: DB,
  a: { rsvId: string; amount: number; contractId: string; contractNo: string; tenant: string; date: string }
): void {
  let left = a.amount;
  const covered: string[] = [];
  for (const i of openInstallments(db, a.contractId)) {
    if (left <= 0) break;
    if (i.remaining <= 0) continue;
    const amt = Math.min(left, i.remaining);
    left -= amt;
    const period = 'قسط ' + dfmt(i.due_date);
    const entry = postReservationConvert(db, { id: a.rsvId, amount: amt, tenant: a.tenant, date: a.date, period, contractId: a.contractId }, a.contractNo);
    db.run(
      `INSERT INTO contract_payments (id, contract_id, installment_id, period, date, gross_halalas,
        discount_halalas, net_halalas, method_label, notes, journal_entry_id, created_at)
       VALUES (?,?,?,?,?,?,0,?,?,?,?,?)`,
      [uid(), a.contractId, i.id, period, a.date, amt, amt, 'من العربون', 'عربون الحجز محوَّل', entry ? entry.id : null, new Date().toISOString()]);
    covered.push(i.id);
  }
  if (left > 0) throw new RuleViolation('العربون (' + fmt(a.amount) + ') يتجاوز المتبقي على أقساط العقد · ردّ الزائد قبل التحويل');
  if (covered.length) recomputeInstallments(db, covered);
}

function convertReservation(db: DB, rsvId: string, contractId: string, contractNo: string, tenant: string, date: string): void {
  const rsv = db.get<{ id: string; deposit_halalas: number }>(
    `SELECT id, deposit_halalas FROM reservations WHERE id = ? AND status = 'نشط' AND deleted_at IS NULL`, [rsvId]);
  if (!rsv) throw new RuleViolation('الحجز غير قائم · انتهى أو أُلغي أو تحوّل');
  allocateDeposit(db, { rsvId: rsv.id, amount: Number(rsv.deposit_halalas), contractId, contractNo, tenant, date });
  db.run(`UPDATE reservations SET status = 'محوَّل لعقد', converted_contract_id = ?, deposit_outcome = 'محوَّل', deposit_settled_date = ? WHERE id = ?`,
    [contractId, date, rsv.id]);
}

export interface CancelInput {
  date: string;
  reason: string;
  /** مصير الدفعات المتبقية: keep = تبقى مستحقة، cancel = تُلغى جميعها */
  installmentsFate: 'keep' | 'cancel';
  settle: boolean;
  deductionHalalas: number;
  refundHalalas: number;
  deductionReason: string;
  /** التأمين لدى «طرف آخر»: وصل المخصوم إلى المكتب فيُسجَّل قبضاً (قرار المالك على #26) */
  deductReceived?: boolean;
}

/** القاعدة ١١: إلغاء العقد · خصم من التأمين، والفائض مطالبة تلقائية */
/** جهة قبض التأمين · المكتب ما لم يُذكر غيره */
const depositHolderOf = (c: unknown): string => ((c as { deposit_holder?: string | null }).deposit_holder || 'المكتب');

export function cancelContract(db: DB, contractId: string, input: CancelInput): { excessClaimCreated: boolean } {
  const c = getContract(db, contractId);
  if (!c) throw new RuleViolation('تعذّر العثور على العقد');
  if (c.status === 'مسودة') throw new RuleViolation('العقد لسا مسودة ولم يُوثَّق · احذفه بدل الإلغاء');
  if (c.status === 'ملغى') throw new RuleViolation('العقد ملغى بالفعل');

  return db.transaction(() => {
    const date = input.date || today();
    let excessClaimCreated = false;
    let deduction = 0, refund = 0;
    if (input.settle) {
      // لا تسوية في الإلغاء لعقدٍ سُوّي تأمينه (تُعدَّل التسوية من شاشتها بصلاحية التأمين) أو رُحِّل تأمينه إلى المجدَّد
      if (db.get(`SELECT 1 FROM deposit_settlements WHERE contract_id = ?`, [contractId])) throw new RuleViolation(t('deposit.alreadySettled'));
      if (depositCarried(db, contractId)) throw new RuleViolation(t('deposit.carried'));
      // مسار التسوية الواحد (مراجعة التثبيت #15 و#25 و#26 و#27): يعكس تسويةً سابقة إن وُجدت (التحقق المستقل: التسوية
      // ثم الإلغاء بتسوية كانا يرحّلان مرتين)، والزيادة على التأمين مطالبة تلقائية، والنقص لا يُحفظ
      const r = applyDepositSettlement(db, c, contractId, {
        date, deductionHalalas: input.deductionHalalas || 0, deductionReason: input.deductionReason || '',
        refundHalalas: input.refundHalalas || 0, notes: '', deductReceived: input.deductReceived,
      }, 'فرق تسوية التأمين عند إلغاء العقد'); // i18n-exempt: سبب مطالبة مخزَّن
      excessClaimCreated = r.excessClaimCreated;
      deduction = r.deduction; refund = r.refund;
    }
    if (input.installmentsFate === 'cancel') {
      // ما غطّاه المسدَّدُ والخصمُ لا يُلغى · الخصم يُطرح هنا كما في كل موضع يبني حالة قسط
      db.run(
        `UPDATE contract_installments SET status = 'ملغية'
         WHERE id IN (
           SELECT i.id FROM contract_installments i
           WHERE i.contract_id = ? AND i.due_date >= ? AND i.status != 'مدفوعة'
             AND i.amount_halalas - i.paid_halalas - ${INSTALLMENT_DISCOUNT_SQL} > 0
         )`,
        [contractId, date]
      );
    }
    const newEnd = c.end && c.end > date ? date : c.end; // الوحدة تصبح متاحة من تاريخ الإلغاء
    db.run(
      `UPDATE contracts SET status='ملغى', cancel_date=?, cancel_reason=?,
        cancel_deduction_halalas=?, cancel_refund_halalas=?, cancel_deduction_reason=?, end=?
       WHERE id = ?`,
      [date, input.reason.trim(), input.settle ? input.deductionHalalas : null,
       input.settle ? refund : null, input.deductionReason.trim() || null, newEnd, contractId]
    );
    logAudit(db, 'العقود', 'update', 'إلغاء عقد', c.tenant_name, { status: c.status }, { status: 'ملغى' });
    return { excessClaimCreated };
  });
}

export interface RenewInput {
  start: string;
  end: string;
  valueHalalas: number;
  cycle: string;
  carryDeposit: boolean;
  extraDepositHalalas: number;
  services: string;
  furnished: string;
  ejarNo: string;
  note: string;
  /** الخدمات والمواقف في العقد الجديد · وغيابهما ينقلهما من العقد السابق (المراجعة #3) */
  servicesHalalas?: number;
  parkingHalalas?: number;
}

/** تحذيرات التجديد · بنصوص النموذج (تُعرض قبل التنفيذ وتمنع التأكيد) */
export function renewWarnings(db: DB, contractId: string, input: Partial<RenewInput>): string[] {
  const c = getContract(db, contractId);
  const warn: string[] = [];
  if (!c) return ['تعذّر العثور على العقد'];
  const { start, end, valueHalalas } = input;
  if (start && c.end && start <= c.end) warn.push('العقد الجديد يجب أن يبدأ بعد ' + c.end.split('-').reverse().join('/'));
  if (start && end && start >= end) warn.push('تاريخ النهاية يجب أن يقع بعد البداية');
  if (!valueHalalas) warn.push('أدخل قيمة العقد');
  if (start && end) {
    const clash = findContractConflict(db, c.unit_id, start, end, c.id);
    if (clash) warn.push('تتداخل المدة مع العقد ' + (clash.contract_no || ''));
    const u = getUnit(db, c.unit_id);
    const prop = u ? getProperty(db, u.property_id) : undefined;
    if (prop && prop.ownership === 'إيجار' && prop.lease_end && end > prop.lease_end)
      warn.push('العقار مستأجَر من الغير حتى ' + prop.lease_end.split('-').reverse().join('/') + ' · لا يجوز تجاوزها');
  }
  return warn;
}

/** القاعدة ٧: التجديد · عقد جديد نظيف، والقديم منتهٍ وله خلف. التجديد لانهائي. */
export function renewContract(db: DB, contractId: string, input: RenewInput): string {
  const c = getContract(db, contractId);
  if (!c) throw new RuleViolation('تعذّر العثور على العقد');
  const block = renewBlockReason(c);
  if (block) throw new RuleViolation(block);
  const warns = renewWarnings(db, contractId, input);
  if (warns.length) throw new RuleViolation(warns[0]);

  return db.transaction(() => {
    const newId = uid();
    const contractNo = input.ejarNo.trim() || nextContractNo(db, input.start);
    const totalDeposit = (input.carryDeposit ? Number(c.deposit_halalas) : 0) + (input.extraDepositHalalas || 0);
    db.run(
      `INSERT INTO contracts (id, contract_no, tenant_name, phone, id_number, unit_id, unit_label, unit_type,
        value_halalas, cycle, start, end, deposit_halalas, ejar_no, services, furnished, type_specific,
        status, renewed_from, renew_count, renew_note, created_at, deposit_holder, deposit_holder_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'سارٍ',?,?,?,?,?,?)`,
      // جهة قبض التأمين واسمها كما في العقد السابق: التأمين المرحَّل لديها (مراجعة التثبيت #16)
      [newId, contractNo, c.tenant_name, c.phone, c.id_number, c.unit_id, c.unit_label, c.unit_type,
       input.valueHalalas, input.cycle, input.start, input.end, totalDeposit,
       input.ejarNo.trim(), input.services.trim(), input.furnished, c.type_specific,
       c.id, (Number(c.renew_count) || 0) + 1, input.note.trim() || null, new Date().toISOString(),
       depositHolderOf(c), (c as unknown as { deposit_holder_name?: string | null }).deposit_holder_name || '']
    );
    const prevSplit = db.all<{ name: string }>(`PRAGMA table_info(contracts)`).some((x) => x.name === 'services_halalas')
      ? db.get<{ s: number; p: number }>(`SELECT services_halalas AS s, parking_halalas AS p FROM contracts WHERE id = ?`, [c.id])
      : undefined;
    const split = {
      servicesHalalas: Math.max(0, input.servicesHalalas ?? Number(prevSplit?.s ?? 0)),
      parkingHalalas: Math.max(0, input.parkingHalalas ?? Number(prevSplit?.p ?? 0)),
    };
    if (prevSplit) db.run(`UPDATE contracts SET services_halalas = ?, parking_halalas = ? WHERE id = ?`, [split.servicesHalalas, split.parkingHalalas, newId]);
    const insts = generateInstallments(input.start, input.end, draftTotal({ valueHalalas: input.valueHalalas, ...split }), input.cycle);
    insts.forEach((inst, i) => {
      db.run(
        `INSERT INTO contract_installments (id, contract_id, due_date, amount_halalas, sort)
         VALUES (?,?,?,?,?)`,
        [inst.id, newId, inst.dueDate, inst.amountHalalas, i]
      );
    });
    db.run(`UPDATE contracts SET status='منتهٍ', renewed_to=? WHERE id = ?`, [contractNo, c.id]);

    if (input.carryDeposit && Number(c.deposit_halalas) > 0) {
      postDepositCarry(db, {
        fromNo: c.contract_no || '', toNo: contractNo, toId: newId,
        deposit: Number(c.deposit_halalas), date: input.start,
      });
    }
    if ((input.extraDepositHalalas || 0) > 0) {
      postContractDeposit(db, {
        id: newId, contract_no: contractNo, tenant: c.tenant_name,
        start: input.start, deposit: input.extraDepositHalalas, holder: (c as unknown as { deposit_holder?: string }).deposit_holder,
      });
    }
    createHandoverForContract(db, newId); // العقد الجديد له نموذجه الواحد
    logAudit(db, 'العقود', 'create', 'تجديد عقد', (c.contract_no || '') + ' ← ' + contractNo);
    linkContractTenant(db, newId);
    carryOccupantsToRenewal(db, contractId, newId);
    seedTenantOccupant(db, newId);
    return newId;
  });
}

export type PayMethod = 'bank' | 'cash' | 'cheque' | 'card';
export const PAY_METHOD_LABEL: Record<PayMethod, string> = {
  cash: 'نقداً', bank: 'تحويل بنكي', cheque: 'شيك', card: 'بطاقة',
};
export interface RentPaymentLine {
  method: PayMethod;
  bankId?: string;
  amountHalalas: number;
}

export interface RentPaymentInput {
  installmentId?: string | null;
  period: string;
  date: string;
  /** طرق السداد بالمقبوض فعلاً · مجموعها هو النقد الداخل */
  lines: RentPaymentLine[];
  /** الخصم فوق المقبوض · يغطي المقبوضُ معه من القسط */
  discountHalalas: number;
  /** نوع الخصم · لازم متى كان فيه خصم، ولا يُفترض أحدهما */
  discountKind?: DiscountKind | null;
  notes: string;
}

/** تسجيل دفعة إيجار (سداد متعدد الطرق) · قيد التحصيل + حركات البنوك + تحديث القسط */
export function recordRentPayment(db: DB, contractId: string, input: RentPaymentInput): string {
  const c = getContract(db, contractId);
  if (!c) throw new RuleViolation('تعذّر العثور على العقد');
  // العقد الملغى تبقى أقساطه السابقة لإلغائه دَيناً يُحصَّل بقسطه المحدد (المراجعة ٤.٩)
  if (c.status === 'ملغى' && !input.installmentId) throw new RuleViolation('العقد ملغى · التحصيل على أقساطه القائمة وحدها، فاختر القسط');
  const rawLines = input.lines.filter((l) => (l.amountHalalas || 0) > 0);
  if (!rawLines.length) throw new RuleViolation('أدخل مبلغاً واحداً على الأقل');
  for (const l of rawLines) {
    if (l.method !== 'cash' && !l.bankId)
      throw new RuleViolation('اختر الحساب البنكي الذي يستقر فيه المبلغ (' + PAY_METHOD_LABEL[l.method] + ')، أو بدِّل الطريقة لنقداً');
  }
  // طرق السداد بالمقبوض فعلاً والخصم فوقه · والمقبوض مع الخصم لا يتجاوز المتبقي على القسط
  const received = rawLines.reduce((s, l) => s + l.amountHalalas, 0);
  const discountIn = input.discountHalalas || 0;
  if (discountIn < 0) throw new RuleViolation('الخصم لا يكون سالباً');
  const kind = discountIn > 0 ? input.discountKind ?? null : null;
  if (discountIn > 0 && !kind)
    throw new RuleViolation('حدّد نوع الخصم: خصم بعد الاستحقاق أو تنزيل من قيمة القسط');
  if (kind && !DISCOUNT_KINDS.includes(kind)) throw new RuleViolation('نوع خصم غير معروف');
  if (kind === DISCOUNT_REDUCES_INSTALLMENT && !input.installmentId)
    throw new RuleViolation('التنزيل من قيمة القسط يحتاج قسطاً محدداً');
  if (input.installmentId) {
    const cur = db.get<{ amount_halalas: number; paid_halalas: number; discount: number; status: string }>(
      `SELECT i.amount_halalas, i.paid_halalas, ${INSTALLMENT_DISCOUNT_SQL} AS discount, i.status
       FROM contract_installments i WHERE i.id = ? AND i.contract_id = ?`,
      [input.installmentId, contractId]
    );
    if (!cur) throw new RuleViolation('القسط غير موجود على هذا العقد');
    if (cur.status === 'ملغية') throw new RuleViolation('القسط ملغى مع العقد · لا تحصيل عليه');
    const remaining = installmentRemaining(Number(cur.amount_halalas), Number(cur.paid_halalas), Number(cur.discount));
    if (remaining <= 0) throw new RuleViolation('القسط مسدَّد بالكامل · لا متبقّي عليه');
    if (received + discountIn > remaining)
      throw new RuleViolation(`المقبوض مع الخصم (${fmt(received + discountIn)}) يتجاوز المتبقي على القسط (${fmt(remaining)})`);
  }
  return db.transaction(() => {
    const net = received;
    const discount = discountIn;
    const gross = net + discount;
    const date = input.date || today();
    const bankNames = db.all<{ id: string; name: string }>(
      `SELECT id, name FROM banks WHERE deleted_at IS NULL`
    );
    const bankName = (id?: string) => bankNames.find((b) => b.id === id)?.name || '';
    const methodsLabel = rawLines
      .map((l) => (l.method === 'cash' ? 'نقداً' : PAY_METHOD_LABEL[l.method] + ' · ' + bankName(l.bankId)))
      .join(' + ');

    // تنزيل من القسط: القسط نفسه يُخفَّض أولاً · فالإيراد بالمخفَّض ولا سطر خصم، والعقد كما هو
    if (kind === DISCOUNT_REDUCES_INSTALLMENT) {
      const before = Number(db.get<{ a: number }>(`SELECT amount_halalas AS a FROM contract_installments WHERE id = ?`, [input.installmentId!])!.a);
      db.run(`UPDATE contract_installments SET amount_halalas = ? WHERE id = ?`, [before - discount, input.installmentId!]);
      logAudit(db, 'التحصيل', 'update', 'تنزيل من قيمة القسط',
        c.tenant_name + ' · عقد ' + (c.contract_no || 'لا يوجد') + ' · ' + fmt(discount) + ' · يخالف قيمة العقد الموثّقة في منصة إيجار',
        { amount_halalas: before }, { amount_halalas: before - discount });
    }

    const entry = postRentCollection(db, {
      contractId, contractNo: c.contract_no || '', tenant: c.tenant_name,
      net, date, period: input.period, discount, discountKind: kind,
      srcId: input.installmentId || contractId,
    });

    const paymentId = uid();
    db.run(
      `INSERT INTO contract_payments (id, contract_id, installment_id, period, date, gross_halalas,
        discount_halalas, net_halalas, method_label, notes, journal_entry_id, created_at, discount_kind)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [paymentId, contractId, input.installmentId ?? null, input.period, date, gross, discount, net,
       methodsLabel, input.notes.trim(), entry ? entry.id : null, new Date().toISOString(), kind]
    );
    for (const l of rawLines) {
      db.run(
        `INSERT INTO payment_lines (id, payment_id, method, bank_id, amount_halalas) VALUES (?,?,?,?,?)`,
        // الشيك والبطاقة يستقران في حسابٍ بنكي: السطر بنكيٌّ ببنكه، واسم الطريقة في بيان الدفعة (دراسة القائم)
        [uid(), paymentId, l.method === 'cash' ? 'cash' : 'bank', l.method === 'cash' ? null : l.bankId!, l.amountHalalas]
      );
      if (l.method !== 'cash') {
        db.run(
          `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
           VALUES (?,?,?,?,?,1,?,?,?)`,
          [uid(), l.bankId!, date,
           'تحصيل إيجار · ' + c.tenant_name + (input.period ? ' (' + input.period + ')' : ''),
           l.amountHalalas, entry ? entry.no : '',
           'تحصيل إيجار · ' + PAY_METHOD_LABEL[l.method], new Date().toISOString()]
        );
      }
    }
    // المسدَّد والحالة يُحسبان من الدفعات (paid.ts) · والخصم لا يُطوى في المسدَّد، فالحالة من الاثنين معاً
    if (input.installmentId) recomputeInstallments(db, [input.installmentId]);
    logAudit(db, 'التحصيل', 'create', 'دفعة إيجار', c.tenant_name);
    return paymentId;
  });
}

export interface DepositSettlementInput {
  date: string;
  deductionHalalas: number;
  deductionReason: string;
  refundHalalas: number;
  notes: string;
  /** وجهة المخصوم حين يكون التأمين لدى المنصة: يبقى في محفظة إيجار أو يُحوَّل لحسابنا */
  deductDestination?: 'محفظة إيجار' | 'حسابنا';
  /** التأمين لدى «طرف آخر»: وصل المخصوم إلى المكتب فيُسجَّل قبضاً (قرار المالك على #26) */
  deductReceived?: boolean;
}

/** رُحِّل تأمين العقد إلى عقده المجدَّد · فلا تسوية له (مراجعة التثبيت #28) */
export function depositCarried(db: DB, contractId: string): boolean {
  return !!db.get(
    `SELECT 1 FROM contracts n JOIN journal_entries e ON e.src_type = 'deposit_carry' AND e.src_id = n.id
     WHERE n.renewed_from = ? AND n.deleted_at IS NULL AND e.reversed_by IS NULL LIMIT 1`, [contractId]);
}

/** المطالبة التلقائية لزيادة التسوية على التأمين · مصدرها */
const SETTLEMENT_CLAIM = 'تسوية تأمين'; // i18n-exempt: مصدر مخزَّن

/**
 * مسار التسوية الواحد للتسوية بعد الانتهاء وللإلغاء بتسوية:
 *  - قرار المالك على #27: «تسوية لا تساوي التأمين: الزيادة مطالبة تلقائية، والنقص لا يُحفظ حتى يُوزَّع.»
 *  - قرار المالك على #26: «الخصم من تأمين «طرف آخر»: لا قيد عند الخصم، ويُسجَّل قبضاً إن وصل المال للمكتب.»
 *  - تسويةٌ سابقة تُعكس قيودها ومطالبتها المفتوحة قبل الجديدة، فلا يُرحَّل شيء مرتين (#15)
 *  - والمخصوم من تأمينٍ لدى المنصة يُقفل من 1260 (#25)
 */
function applyDepositSettlement(db: DB, c: ContractRow, contractId: string, input: DepositSettlementInput, claimReason: string):
  { excessClaimCreated: boolean; deduction: number; refund: number; prev: Record<string, unknown> | undefined } {
  const holder = depositHolderOf(c);
  const deposit = Number(c.deposit_halalas) || 0;
  let deduction = Math.max(0, input.deductionHalalas || 0);
  const refund = Math.max(0, input.refundHalalas || 0);
  if (refund > deposit) throw new RuleViolation(t('deposit.refundOver'));
  const sum = deduction + refund;
  if (sum < deposit) throw new RuleViolation(t('deposit.mustDistribute', { left: fmt(deposit - sum) }));
  const excess = sum - deposit;
  deduction -= excess;
  const prev = db.get<Record<string, unknown>>(`SELECT date, deduction_halalas, refund_halalas FROM deposit_settlements WHERE contract_id = ?`, [contractId]);
  // مطالبة التسوية السابقة: المحصَّلة لا تتغير، والمفتوحة تُعكس وتُحذف وتُنشأ الجديدة إن بقيت زيادة
  const prevClaim = db.get<{ id: string; status: string; amount_halalas: number }>(
    `SELECT id, status, amount_halalas FROM claims WHERE contract_id = ? AND source = ? AND deleted_at IS NULL`, [contractId, SETTLEMENT_CLAIM]);
  if (prevClaim && prevClaim.status !== 'مفتوحة' && Number(prevClaim.amount_halalas) !== excess) { // i18n-exempt: حالة مخزّنة
    throw new RuleViolation(t('deposit.claimCollected'));
  }
  // ومطالبة الزيادة المفتوحة لا يحذفها مسار التسوية: حذفها لصاحب صلاحية المطالبات من شاشتها (التحقق المستقل: لمسُ
  // «حذف المطالبة» من قسم التأمين كان يجيز لعضوٍ حذف أي مطالبة في عقاره)
  if (prevClaim && Number(prevClaim.amount_halalas) !== excess) throw new RuleViolation(t('deposit.claimFirst'));
  // ردّ التأمين نقداً حين يقبضه المكتب · بصافي الفرق عن ردٍّ سابق يُعكس (قرار المالك ٢٠٢٦-١٠-٠٥) · والسابق من قيده الحيّ
  // لا من صفّ التسوية وحده (التحقق المستقل N2)
  // كفاية النقد بصافي أثر التسوية على النقدية مقابل قيودها الحيّة: الرد نقداً خارجٌ، والمخصوم الواصل (طرف آخر، أو من
  // المنصة إلى حسابنا) داخل، وعكس الداخل خارج (التحقق المستقل E2) · قرار المالك ٢٠٢٦-١٠-٠٥
  const liveCash = Number(db.get<{ v: number }>(
    `SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas), 0) AS v FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.src_type IN ('deposit_deduct', 'deposit_refund', 'deposit_deduct_move') AND e.src_id = ? AND e.reversed_by IS NULL
       AND e.deleted_at IS NULL AND e.status = 'مرحّل' AND l.account_code = '1100'`, [contractId])?.v ?? 0); // i18n-exempt: حالة مخزّنة
  const newCash = (holder === 'طرف آخر' && input.deductReceived ? deduction : 0) // i18n-exempt: جهة مخزّنة
    + (holder === 'منصة إيجار' && (input.deductDestination ?? 'محفظة إيجار') === 'حسابنا' ? deduction : 0) // i18n-exempt: جهة ووجهة مخزّنتان
    - (holder === 'المكتب' ? refund : 0); // i18n-exempt: جهة مخزّنة
  requireCash(db, liveCash - newCash, 'تسوية التأمين');
  // كل قيدٍ حيّ من كل مصدر (التحقق المستقل E3: عقودٌ قبل صفّ التسوية فيها مجموعتا قيود)
  for (const [src, memo] of [['deposit_deduct', 'عكس الخصم السابق'], ['deposit_refund', 'عكس الرد السابق'], ['deposit_deduct_move', 'عكس استقرار المخصوم']]) {
    for (let i = 0; i < 20 && reverseEntryBySource(db, src, contractId, 'تعديل تسوية التأمين · ' + memo); i++) { /* حتى لا يبقى حيّ */ }
  }
  // تعديل تسويةٍ قائمة: قيودها الجديدة قيود تصحيح بتاريخها، إلا في فترةٍ قُدِّم إقرارها فاليوم كعكسها (#29)
  const postDate = prev ? correctionDate(db, input.date) : input.date;
  let excessClaimCreated = false;
  if (excess > 0 && !prevClaim) {
    const claimId = uid();
    db.run(
      `INSERT INTO claims (id, contract_id, amount_halalas, reason, date, status, source, created_at)
       VALUES (?,?,?,?,?,'مفتوحة',?,?)`,
      [claimId, contractId, excess, input.deductionReason.trim() || claimReason, input.date, SETTLEMENT_CLAIM, new Date().toISOString()]
    );
    postClaim(db, { id: claimId, amount: excess, reason: input.deductionReason.trim() || claimReason, date: postDate });
    excessClaimCreated = true;
  }
  postDepositDeduct(db, { id: contractId, contract_no: c.contract_no || '', holder, received: !!input.deductReceived }, deduction, postDate);
  // التأمين لدى المنصة: المخصوم يُقفل من 1260 ويستقر في محفظة إيجار أو حسابنا
  if (holder === 'منصة إيجار' && deduction > 0) { // i18n-exempt: جهة مخزّنة
    postDepositDeductMove(db, { id: contractId, contract_no: c.contract_no || '' }, deduction, postDate,
      input.deductDestination ?? 'محفظة إيجار'); // i18n-exempt: وجهة مخزّنة
  }
  postDepositRefund(db, { id: contractId, contract_no: c.contract_no || '', holder }, refund, postDate);
  db.run(
    `INSERT INTO deposit_settlements (contract_id, date, deduction_halalas, deduction_reason, refund_halalas, notes, deduct_destination)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(contract_id) DO UPDATE SET date = excluded.date, deduction_halalas = excluded.deduction_halalas,
       deduction_reason = excluded.deduction_reason, refund_halalas = excluded.refund_halalas, notes = excluded.notes,
       deduct_destination = excluded.deduct_destination`,
    [contractId, input.date, deduction, input.deductionReason.trim(), refund, input.notes.trim(),
     holder === 'منصة إيجار' ? (input.deductDestination ?? 'محفظة إيجار') : ''] // i18n-exempt: قيم مخزّنة
  );
  return { excessClaimCreated, deduction, refund, prev };
}

/** القاعدة ٨: التصرف بالتأمين · بعد انتهاء العقد فقط. التعديل يعكس الترحيل السابق ويعيد الترحيل. */
export function saveDepositSettlement(db: DB, contractId: string, input: DepositSettlementInput): void {
  const c = getContract(db, contractId);
  if (!c) throw new RuleViolation('تعذّر العثور على العقد');
  if (!contractEnded(c)) throw new RuleViolation('التصرف بالتأمين يتاح بعد انتهاء العقد');
  if (depositCarried(db, contractId)) throw new RuleViolation(t('deposit.carried'));
  db.transaction(() => {
    const r = applyDepositSettlement(db, c, contractId, input, 'فرق تسوية التأمين'); // i18n-exempt: سبب مطالبة مخزَّن
    // السجل يوثّق: من ماذا إلى ماذا · والقيود الأولى باقية معكوسة لا ممحوة
    logAudit(db, 'العقود', 'update', r.prev ? 'تعديل تسوية تأمين' : 'تسوية تأمين', c.tenant_name,
      r.prev, { deduction_halalas: r.deduction, refund_halalas: r.refund, date: input.date });
  });
}

export interface TenantRatingInput {
  onTime: string;
  paymentCommit: string;
  contractCommit: string;
  unitCondition: string;
  neighborComplaints: string;
  notes: string;
}

/** القاعدة ٨: التقييم · بعد انتهاء العقد فقط */
export function saveTenantRating(db: DB, contractId: string, input: TenantRatingInput): void {
  const c = getContract(db, contractId);
  if (!c) throw new RuleViolation('تعذّر العثور على العقد');
  if (!contractEnded(c)) throw new RuleViolation('تقييم المستأجر يتاح بعد انتهاء العقد');
  db.transaction(() => {
    db.run(
      `INSERT INTO tenant_ratings (contract_id, on_time, payment_commit, contract_commit, unit_condition, neighbor_complaints, notes, rated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(contract_id) DO UPDATE SET
         on_time=excluded.on_time, payment_commit=excluded.payment_commit,
         contract_commit=excluded.contract_commit, unit_condition=excluded.unit_condition,
         neighbor_complaints=excluded.neighbor_complaints, notes=excluded.notes, rated_at=excluded.rated_at`,
      [contractId, input.onTime, input.paymentCommit, input.contractCommit,
       input.unitCondition, input.neighborComplaints, input.notes.trim(), today()]
    );
    logAudit(db, 'العقود', 'update', 'تقييم مستأجر', c.tenant_name);
  });
}

export const RATING_SCALE_SCORE: Record<string, number | null> = {
  'ممتاز': 4, 'جيد': 3, 'متوسط': 2, 'ضعيف': 1,
  'لا توجد': 4, 'نادرة': 2, 'متكررة': 1, 'لم يُسلَّم بعد': null,
};

export function tenantRatingOverall(r: TenantRatingInput | null): { label: string; cls: string } | null {
  if (!r) return null;
  const scores = [r.onTime, r.paymentCommit, r.contractCommit, r.unitCondition, r.neighborComplaints]
    .map((v) => RATING_SCALE_SCORE[v])
    .filter((v): v is number => v != null);
  if (!scores.length) return null;
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (avg >= 3.5) return { label: 'ممتاز', cls: 'paid' };
  if (avg >= 2.5) return { label: 'جيد', cls: 'due' };
  if (avg >= 1.5) return { label: 'متوسط', cls: 'draft' };
  return { label: 'ضعيف', cls: 'overdue' };
}

/**
 * التحصيل الجماعي: دفعة واحدة تُوزَّع على أقساط محددة بترتيب استحقاقها،
 * والفائض يبقى رصيداً دائناً للمستأجر (حساب 2410 وسجل المستأجر) لا إيراداً.
 * قيد واحد وسند واحد · «دفع ٥٬٠٠٠ عن ثلاثة أشهر: تسجيلة واحدة لا ثلاث».
 */
export function recordBulkRentPayment(
  db: DB,
  contractId: string,
  input: { installmentIds: string[]; date: string; lines: RentPaymentLine[]; notes: string }
): string {
  const c = getContract(db, contractId);
  if (!c) throw new RuleViolation('تعذّر العثور على العقد');
  // العقد الملغى: التوزيع على أقساطه القائمة غير الملغاة وحدها (المراجعة ٤.٩)
  const rawLines = input.lines.filter((l) => (l.amountHalalas || 0) > 0);
  if (!rawLines.length) throw new RuleViolation('أدخل مبلغاً واحداً على الأقل');
  for (const l of rawLines) {
    if (l.method !== 'cash' && !l.bankId)
      throw new RuleViolation('اختر الحساب البنكي الذي يستقر فيه المبلغ (' + PAY_METHOD_LABEL[l.method] + ')، أو بدِّل الطريقة لنقداً');
  }
  if (!input.installmentIds.length) throw new RuleViolation('اختر قسطاً واحداً على الأقل');
  return db.transaction(() => {
    const insts = db.all<{ id: string; due_date: string; amount_halalas: number; paid_halalas: number; discount: number; status: string }>(
      `SELECT i.id, i.due_date, i.amount_halalas, i.paid_halalas, ${INSTALLMENT_DISCOUNT_SQL} AS discount, i.status
       FROM contract_installments i
       WHERE i.contract_id = ? AND i.id IN (${input.installmentIds.map(() => '?').join(',')})
         AND i.status != 'ملغية' ORDER BY i.due_date`,
      [contractId, ...input.installmentIds]
    );
    if (!insts.length) throw new RuleViolation('الأقساط المحددة غير موجودة على هذا العقد');
    const net = rawLines.reduce((s, l) => s + l.amountHalalas, 0);
    const date = input.date || today();

    // التوزيع بترتيب الاستحقاق · الفائض رصيد للمستأجر · والمتبقّي يطرح الخصم كما في كل موضع
    let left = net;
    const allocations: Array<{ installmentId: string; amount: number }> = [];
    for (const i of insts) {
      if (left <= 0) break;
      const remaining = installmentRemaining(Number(i.amount_halalas), Number(i.paid_halalas), Number(i.discount));
      if (remaining <= 0) continue;
      const take = Math.min(remaining, left);
      allocations.push({ installmentId: i.id, amount: take });
      left -= take;
    }
    const allocated = net - left;
    const excess = left;

    // قيد واحد: النقدية بالكامل، الإيراد بالمخصَّص، والفائض أمانة دائنة للمستأجر
    const entry = postEntry(db, {
      date,
      memo: 'تحصيل جماعي · ' + c.tenant_name + ' (عقد ' + (c.contract_no || 'لا يوجد') + ') · ' +
        allocations.length + ' قسط' + (excess > 0 ? ' · فائض رصيداً ' + fmt(excess) : ''),
      srcType: 'rent',
      srcId: contractId,
      lines: [
        { account: '1100', descr: 'تحصيل جماعي', debit: net, credit: 0 },
        ...(allocated > 0 ? rentRevenueLines(db, contractId, allocated, 'إيجار مخصَّص على ' + allocations.length + ' قسط', 'credit') : []),
        ...(excess > 0 ? [{ account: '2410', descr: 'فائض تحصيل · رصيد دائن للمستأجر', debit: 0, credit: excess }] : []),
      ],
    });

    const bankNames = db.all<{ id: string; name: string }>(`SELECT id, name FROM banks WHERE deleted_at IS NULL`);
    const bankName = (id?: string) => bankNames.find((b) => b.id === id)?.name || '';
    const methodsLabel = rawLines
      .map((l) => (l.method === 'cash' ? 'نقداً' : PAY_METHOD_LABEL[l.method] + ' · ' + bankName(l.bankId)))
      .join(' + ');

    const paymentId = uid();
    db.run(
      `INSERT INTO contract_payments (id, contract_id, installment_id, period, date, gross_halalas,
        discount_halalas, net_halalas, method_label, notes, journal_entry_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [paymentId, contractId, null, 'تحصيل جماعي · ' + allocations.length + ' قسط', date, net, 0, net,
       methodsLabel, input.notes.trim(), entry ? entry.id : null, new Date().toISOString()]
    );
    for (const l of rawLines) {
      db.run(
        `INSERT INTO payment_lines (id, payment_id, method, bank_id, amount_halalas) VALUES (?,?,?,?,?)`,
        // الشيك والبطاقة يستقران في حسابٍ بنكي: السطر بنكيٌّ ببنكه، واسم الطريقة في بيان الدفعة (دراسة القائم)
        [uid(), paymentId, l.method === 'cash' ? 'cash' : 'bank', l.method === 'cash' ? null : l.bankId!, l.amountHalalas]
      );
      if (l.method !== 'cash') {
        db.run(
          `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
           VALUES (?,?,?,?,?,1,?,?,?)`,
          [uid(), l.bankId!, date, 'تحصيل جماعي · ' + c.tenant_name, l.amountHalalas,
           entry ? entry.no : '', 'تحصيل إيجار · ' + PAY_METHOD_LABEL[l.method], new Date().toISOString()]
        );
      }
    }
    for (const a of allocations) {
      db.run(`INSERT INTO payment_allocations (id, payment_id, installment_id, amount_halalas) VALUES (?,?,?,?)`,
        [uid(), paymentId, a.installmentId, a.amount]);
    }
    recomputeInstallments(db, allocations.map((a) => a.installmentId));
    if (excess > 0) {
      const tid = db.get<{ tenant_id: string | null }>(`SELECT tenant_id FROM contracts WHERE id = ?`, [contractId])?.tenant_id;
      if (tid) db.run(`UPDATE tenants SET credit_halalas = credit_halalas + ? WHERE id = ?`, [excess, tid]);
    }
    logAudit(db, 'التحصيل', 'create', 'تحصيل جماعي', c.tenant_name + ' · ' + allocations.length + ' قسط');
    return paymentId;
  });
}

/**
 * موعد سداد متفق عليه ومهلة للقسط · الحالة والفرز يتبعان الموعد الجديد،
 * والمهلة تمنع احتساب التأخر قبلها · ويُسجَّل السبب في سجل العمليات إلزاماً.
 */
export function setInstallmentSchedule(
  db: DB,
  installmentId: string,
  input: { agreedDate: string | null; graceUntil: string | null; reason: string }
): void {
  const cur = db.get<{ id: string; due_date: string; agreed_date: string | null; grace_until: string | null; contract_id: string }>(
    `SELECT id, due_date, agreed_date, grace_until, contract_id FROM contract_installments WHERE id = ?`,
    [installmentId]
  );
  if (!cur) throw new Error('القسط غير موجود');
  const settingSomething = !!(input.agreedDate || input.graceUntil);
  if (settingSomething && !input.reason.trim())
    throw new Error('لا يُغيَّر موعد قسط بلا سبب مكتوب · اكتب سبب الاتفاق أو المهلة');
  db.transaction(() => {
    db.run(`UPDATE contract_installments SET agreed_date = ?, grace_until = ? WHERE id = ?`, [
      input.agreedDate, input.graceUntil, installmentId,
    ]);
    logAudit(db, 'التحصيل', 'update', 'موعد سداد قسط', input.reason.trim() || 'إزالة الاتفاق',
      { agreed_date: cur.agreed_date, grace_until: cur.grace_until },
      { agreed_date: input.agreedDate, grace_until: input.graceUntil });
  });
}

/** آخر دفعة سدّدت قسطاً بعينه · لفتح سند القبض من جدول الأقساط */
export function paymentForInstallment(db: DB, installmentId: string): string | null {
  const direct = db.get<{ id: string }>(
    `SELECT id FROM contract_payments WHERE installment_id = ? AND cancelled_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [installmentId]
  );
  if (direct) return direct.id;
  const alloc = db.get<{ payment_id: string }>(
    `SELECT pa.payment_id FROM payment_allocations pa
     JOIN contract_payments p ON p.id = pa.payment_id
     WHERE pa.installment_id = ? AND p.cancelled_at IS NULL ORDER BY p.created_at DESC LIMIT 1`,
    [installmentId]
  );
  return alloc ? alloc.payment_id : null;
}

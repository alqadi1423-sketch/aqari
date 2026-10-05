/**
 * دورة حياة العقد: مسودة ← مراجعة ← توثيق (قفل) ← تجديد/إلغاء + الدفعات.
 * كل دالة تتم بمعاملة واحدة، والترحيل المحاسبي عبر مسار postEvent الواحد.
 */
import type { DB } from '../../db/adapter';
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
}

function unitLabel(db: DB, unitId: string): string {
  const u = getUnit(db, unitId);
  if (!u) return 'لا يوجد';
  const p = getProperty(db, u.property_id);
  return (p ? p.name : 'لا يوجد') + ' · ' + u.unit_no;
}

/** مزامنة المستأجر إلى قائمة المستأجرين */
export function syncTenantToCustomer(db: DB, name: string, phone: string): void {
  if (!name.trim()) return;
  const existing = db.get<{ id: string; phone: string }>(
    `SELECT id, phone FROM tenants WHERE TRIM(name) = ? AND deleted_at IS NULL`,
    [name.trim()]
  );
  if (existing) {
    if (phone && !existing.phone)
      db.run(`UPDATE tenants SET phone = ? WHERE id = ?`, [phone, existing.id]);
    return;
  }
  db.run(`INSERT INTO tenants (id, name, phone, created_at) VALUES (?,?,?,?)`, [
    uid(), name.trim(), phone || '', new Date().toISOString(),
  ]);
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
    syncTenantToCustomer(db, input.tenant, input.phone);
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
export function confirmContract(db: DB, input: ContractDraftInput, draftId?: string): string {
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
    // «جدول الدفعات يُولَّد آلياً عند الإنشاء ولا يُعاد توليده»
    const hasInstallments = db.get(
      `SELECT id FROM contract_installments WHERE contract_id = ? LIMIT 1`, [id]
    );
    if (!hasInstallments) {
      const insts = generateInstallments(input.start, input.end, input.valueHalalas, input.cycle);
      insts.forEach((inst, i) => {
        db.run(
          `INSERT INTO contract_installments (id, contract_id, due_date, amount_halalas, sort)
           VALUES (?,?,?,?,?)`,
          [inst.id, id, inst.dueDate, inst.amountHalalas, i]
        );
      });
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
    syncTenantToCustomer(db, input.tenant, input.phone);
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
    const entry = postReservationConvert(db, { id: a.rsvId, amount: amt, tenant: a.tenant, date: a.date, period }, a.contractNo);
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
}

/** القاعدة ١١: إلغاء العقد · خصم من التأمين، والفائض مطالبة تلقائية */
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
      deduction = input.deductionHalalas || 0;
      refund = input.refundHalalas || 0;
      const deposit = Number(c.deposit_halalas) || 0;
      if (deduction > deposit) {
        // «إن تجاوز الخصمُ التأمينَ تُنشأ مطالبة تلقائية بالفرق»
        const excess = deduction - deposit;
        const claimId = uid();
        db.run(
          `INSERT INTO claims (id, contract_id, amount_halalas, reason, date, status, source, created_at)
           VALUES (?,?,?,?,?,'مفتوحة','تسوية تأمين',?)`,
          [claimId, contractId, excess,
           input.deductionReason || 'فرق تسوية التأمين عند إلغاء العقد', date, new Date().toISOString()]
        );
        postClaim(db, { id: claimId, amount: excess, reason: input.deductionReason || 'فرق تسوية التأمين عند إلغاء العقد', date });
        excessClaimCreated = true;
        refund = 0;
        deduction = deposit; // يُخصم التأمين كاملاً والفائض صار مطالبة
      }
      postDepositDeduct(db, { id: contractId, contract_no: c.contract_no || '' }, deduction, date);
      postDepositRefund(db, { id: contractId, contract_no: c.contract_no || '', holder: (c as unknown as { deposit_holder?: string }).deposit_holder }, refund, date);
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
        status, renewed_from, renew_count, renew_note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'سارٍ',?,?,?,?)`,
      [newId, contractNo, c.tenant_name, c.phone, c.id_number, c.unit_id, c.unit_label, c.unit_type,
       input.valueHalalas, input.cycle, input.start, input.end, totalDeposit,
       input.ejarNo.trim(), input.services.trim(), input.furnished, c.type_specific,
       c.id, (Number(c.renew_count) || 0) + 1, input.note.trim() || null, new Date().toISOString()]
    );
    const insts = generateInstallments(input.start, input.end, input.valueHalalas, input.cycle);
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
  if (c.status === 'ملغى') throw new RuleViolation('العقد ملغى');
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
    const cur = db.get<{ amount_halalas: number; paid_halalas: number; discount: number }>(
      `SELECT i.amount_halalas, i.paid_halalas, ${INSTALLMENT_DISCOUNT_SQL} AS discount
       FROM contract_installments i WHERE i.id = ? AND i.contract_id = ?`,
      [input.installmentId, contractId]
    );
    if (!cur) throw new RuleViolation('القسط غير موجود على هذا العقد');
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
        [uid(), paymentId, l.method, l.method === 'bank' ? l.bankId! : null, l.amountHalalas]
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
}

/** القاعدة ٨: التصرف بالتأمين · بعد انتهاء العقد فقط. التعديل يعكس الترحيل السابق ويعيد الترحيل. */
export function saveDepositSettlement(db: DB, contractId: string, input: DepositSettlementInput): void {
  const c = getContract(db, contractId);
  if (!c) throw new RuleViolation('تعذّر العثور على العقد');
  if (!contractEnded(c)) throw new RuleViolation('التصرف بالتأمين يتاح بعد انتهاء العقد');
  db.transaction(() => {
    const existing = db.get(`SELECT contract_id FROM deposit_settlements WHERE contract_id = ?`, [contractId]);
    const prevVals = existing
      ? db.get(`SELECT date, deduction_halalas, refund_halalas FROM deposit_settlements WHERE contract_id = ?`, [contractId])
      : undefined;
    if (existing) {
      reverseEntryBySource(db, 'deposit_deduct', contractId, 'تعديل تسوية التأمين · عكس الخصم السابق');
      reverseEntryBySource(db, 'deposit_refund', contractId, 'تعديل تسوية التأمين · عكس الرد السابق');
      reverseEntryBySource(db, 'deposit_deduct_move', contractId, 'تعديل تسوية التأمين · عكس استقرار المخصوم');
      db.run(
        `UPDATE deposit_settlements SET date=?, deduction_halalas=?, deduction_reason=?, refund_halalas=?, notes=?, deduct_destination=?
         WHERE contract_id = ?`,
        [input.date, input.deductionHalalas, input.deductionReason.trim(), input.refundHalalas,
         input.notes.trim(), input.deductDestination ?? '', contractId]
      );
    } else {
      db.run(
        `INSERT INTO deposit_settlements (contract_id, date, deduction_halalas, deduction_reason, refund_halalas, notes, deduct_destination)
         VALUES (?,?,?,?,?,?,?)`,
        [contractId, input.date, input.deductionHalalas, input.deductionReason.trim(),
         input.refundHalalas, input.notes.trim(), input.deductDestination ?? '']
      );
    }
    postDepositDeduct(db, { id: contractId, contract_no: c.contract_no || '' }, input.deductionHalalas, input.date);
    // التأمين لدى المنصة: المخصوم يُقفل من 1260 ويستقر في محفظة إيجار أو حسابنا
    if ((c as unknown as { deposit_holder?: string }).deposit_holder === 'منصة إيجار' && input.deductionHalalas > 0) {
      postDepositDeductMove(db, { id: contractId, contract_no: c.contract_no || '' }, input.deductionHalalas, input.date,
        input.deductDestination ?? 'محفظة إيجار');
    }
    postDepositRefund(db, { id: contractId, contract_no: c.contract_no || '', holder: (c as unknown as { deposit_holder?: string }).deposit_holder }, input.refundHalalas, input.date);
    // السجل يوثّق: من ماذا إلى ماذا · والقيود الأولى باقية معكوسة لا ممحوة
    logAudit(db, 'العقود', 'update', existing ? 'تعديل تسوية تأمين' : 'تسوية تأمين', c.tenant_name,
      existing ? prevVals : undefined,
      { deduction_halalas: input.deductionHalalas, refund_halalas: input.refundHalalas, date: input.date });
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
  if (c.status === 'ملغى') throw new RuleViolation('العقد ملغى');
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
        ...(allocated > 0 ? [{ account: '4200', descr: 'إيجار مخصَّص على ' + allocations.length + ' قسط', debit: 0, credit: allocated }] : []),
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
        [uid(), paymentId, l.method, l.method === 'bank' ? l.bankId! : null, l.amountHalalas]
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
    `SELECT id FROM contract_payments WHERE installment_id = ? ORDER BY created_at DESC LIMIT 1`,
    [installmentId]
  );
  if (direct) return direct.id;
  const alloc = db.get<{ payment_id: string }>(
    `SELECT pa.payment_id FROM payment_allocations pa
     JOIN contract_payments p ON p.id = pa.payment_id
     WHERE pa.installment_id = ? ORDER BY p.created_at DESC LIMIT 1`,
    [installmentId]
  );
  return alloc ? alloc.payment_id : null;
}

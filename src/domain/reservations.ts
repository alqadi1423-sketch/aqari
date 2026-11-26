/**
 * الحجوزات بعربون · الإنشاء يرحّل (1100/2450)، والإلغاء يسوّي العربون: مصادرةً (2450/4300) أو ردّاً (2450/1100)،
 * والتحويل لعقد يسدّد به أقساطه (contracts/service). ولكل عربون مآلٌ واحد في deposit_outcome.
 */
import type { DB } from '../db/adapter';
import { requireCash } from './cashGuard';
import { moneyError } from './moneyGuard';
import { requireBankFor, linkBankTx, hasDepositBankCols } from './accounting/bankLink';
import { t } from '../i18n';
import { uid } from './ids';
import { today, dfmt, addDays } from './dates';
import { postReservationDeposit, postReservationForfeit, postReservationRefund } from './accounting/post';
import { unitActiveReservation, unitCurrentContract, findContractConflict } from './contracts/rules';
import { logAudit } from './audit';
import { requireISODate, requireOpenPeriod } from './vatFilings';

export interface ReservationInput {
  unitId: string;
  name: string;
  phone: string;
  depositHalalas: number;
  expiryDate: string;
  /** قبض العربون تحويلاً إلى هذا البنك · الفارغ نقداً في المحفظة (A1-6 · قرار المالك س١٧) */
  bankId?: string | null;
  /** تاريخ قبض العربون · به يُؤرَّخ الحجز وقيده وحركة بنكه، والغائب اليوم (A1-12) */
  date?: string;
}

export function createReservation(db: DB, input: ReservationInput): string {
  if (!input.name.trim() || !input.expiryDate)
    throw new Error('الرجاء إدخال اسم صاحب الحجز وتاريخ انتهاء الحجز');
  // العربون غير سالب (A1-7): −٥٠٠ كان يُحفظ بلا قيد فيحمرّ فحص عربون الحجوزات
  const depositErr = moneyError('ReservationDeposit', input.depositHalalas);
  if (depositErr) throw new Error(depositErr);
  // تاريخ القبض بصيغته، لا بعد اليوم ولا في ربعٍ قُدِّم إقراره · والانتهاء بصيغته لا يسبق اليوم ولا القبض (A1-12): انتهاءٌ مضى كان يُقبل
  // فينتهي الحجز عند أول فحص وعربونه محتجز
  const T = today();
  const date = input.date ?? T;
  requireISODate(date);
  if (date > T) throw new Error(t('reservation.dateFuture'));
  requireOpenPeriod(db, date);
  requireISODate(input.expiryDate);
  if (input.expiryDate < T || input.expiryDate < date) throw new Error(t('reservation.expiryPast'));
  // الحجز يبدأ بعد نهاية العقد الساري (أو اليوم للشاغرة) ويُقبل ما دام ينتهي بعدها، فيُحجز لمستأجرٍ قادم قبل خروج الحالي (A1-12) ·
  // ولا يتعارض بمدته مع عقدٍ موثَّق على الوحدة
  const current = unitCurrentContract(db, input.unitId);
  const from = current?.end ? addDays(current.end, 1) : T;
  if (input.expiryDate < from) throw new Error(t('reservation.beforeVacant', { date: dfmt(current?.end ?? T) }));
  const clash = findContractConflict(db, input.unitId, from, input.expiryDate, current?.id);
  if (clash) throw new Error(t('reservation.contractClash', { no: clash.contract_no || '', start: dfmt(clash.start), end: dfmt(clash.end) }));
  const existing = unitActiveReservation(db, input.unitId);
  if (existing)
    throw new Error('يوجد حجز نشط على هذه الوحدة بالفعل حتى ' + dfmt(existing.expiry_date));
  const bank = input.depositHalalas > 0 && input.bankId && hasDepositBankCols(db) ? input.bankId : null;
  const bankName = bank ? requireBankFor(db, bank) : '';
  return db.transaction(() => {
    const id = uid();
    db.run(
      `INSERT INTO reservations (id, unit_id, name, phone, deposit_halalas, expiry_date, created_date, status)
       VALUES (?,?,?,?,?,?,?,'نشط')`,
      [id, input.unitId, input.name.trim(), input.phone.trim(), input.depositHalalas,
       input.expiryDate, date]
    );
    if (bank) db.run(`UPDATE reservations SET bank_id = ? WHERE id = ?`, [bank, id]);
    const entry = postReservationDeposit(db, { id, name: input.name, deposit: input.depositHalalas, date });
    // والعربون المقبوض تحويلاً يدخل البنك لا المحفظة (A1-6)
    if (entry && bank) {
      linkBankTx(db, { bankId: bank, date, amount: input.depositHalalas, entryNo: entry.no,
        descr: t('depositBank.rsvTx', { name: input.name.trim(), bank: bankName, lng: 'ar' }), source: t('depositBank.rsvSrc', { lng: 'ar' }) });
    }
    logAudit(db, 'العقارات', 'create', 'حجز بعربون', input.name);
    return id;
  });
}

/**
 * إلغاء الحجز أو تسوية عربون حجزٍ انتهى · مصادرةً إيراداً أو ردّاً لصاحبه، وكلاهما بقيد بتاريخه (المراجعة ٤.٥).
 * العربون يُسوّى مرة واحدة: المحوَّل لعقد أو المسوّى قبلُ يُرفض.
 */
export function cancelReservation(db: DB, id: string, forfeitDeposit: boolean, date: string = today(), refundBankId?: string | null): void {
  requireOpenPeriod(db, date); // المراجعة الشاملة · البند ٩: لا ترحيل ولا نقد في ربعٍ قُدِّم إقراره
  db.transaction(() => {
    const r = db.get<{ name: string; deposit_halalas: number; status: string; deposit_outcome: string | null }>(
      `SELECT name, deposit_halalas, status, deposit_outcome FROM reservations WHERE id = ?`, [id]
    );
    if (!r) return;
    if (r.status === 'محوَّل لعقد') throw new Error('الحجز محوَّل لعقد · عربونه سُدّد به العقد');
    if (r.deposit_outcome) throw new Error('عربون هذا الحجز ' + r.deposit_outcome + ' من قبل');
    const deposit = Number(r.deposit_halalas);
    // والردّ تحويلاً يخرج من البنك ويكفيه رصيده، والنقد من المحفظة (A1-6)
    const bankCols = hasDepositBankCols(db);
    const refundBank = !forfeitDeposit && deposit > 0 && refundBankId && bankCols ? refundBankId : null;
    const bankName = refundBank ? requireBankFor(db, refundBank, deposit, 0, date) : ''; // بتاريخ الرد (A2.8)
    if (!forfeitDeposit && !refundBank) requireCash(db, deposit, 'ردّ العربون', date); // بتاريخ الرد (A2.8)
    const outcome = deposit > 0 ? (forfeitDeposit ? 'مصادَر' : 'مردود') : null;
    db.run(`UPDATE reservations SET status = 'منتهي', deposit_outcome = ?, deposit_settled_date = ? WHERE id = ?`,
      [outcome, outcome ? date : null, id]);
    if (bankCols) db.run(`UPDATE reservations SET refund_bank_id = ? WHERE id = ?`, [refundBank, id]);
    if (deposit > 0) {
      if (forfeitDeposit) postReservationForfeit(db, { id, name: r.name, deposit, date });
      else {
        const entry = postReservationRefund(db, { id, name: r.name, deposit, date });
        if (entry && refundBank) {
          linkBankTx(db, { bankId: refundBank, date, amount: -deposit, entryNo: entry.no,
            descr: t('depositBank.rsvRefundTx', { name: r.name, bank: bankName, lng: 'ar' }), source: t('depositBank.rsvRefundSrc', { lng: 'ar' }) });
        }
      }
    }
    logAudit(db, 'العقارات', 'update', 'إلغاء حجز', r.name, null, outcome ? { deposit_outcome: outcome, date } : undefined);
  });
}

/**
 * حجوزاتٌ انتهت وعربونها محتجز بلا تسوية (المراجعة ٤.٥) · منها ما رُدّ فعلاً في نسخة سابقة بلا قيد،
 * ولا تميّزه البيانات عن المحتجز، فتُعرض للمالك ليقرّر لكلٍّ: ردّاً بتاريخه أو مصادرة.
 */
export function heldExpiredDeposits(db: DB): Array<{ id: string; name: string; unit_id: string; deposit_halalas: number; expiry_date: string }> {
  return db.all(
    `SELECT id, name, unit_id, deposit_halalas, expiry_date FROM reservations
     WHERE deleted_at IS NULL AND status = 'منتهي' AND deposit_outcome IS NULL AND deposit_halalas > 0
       AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.src_type = 'reservation_forfeit' AND e.src_id = reservations.id
                       AND e.deleted_at IS NULL AND e.reversed_by IS NULL)
     ORDER BY expiry_date`
  );
}

/**
 * الحجوزات بعربون · الإنشاء يرحّل (1100/2450)، والإلغاء يسوّي العربون: مصادرةً (2450/4300) أو ردّاً (2450/1100)،
 * والتحويل لعقد يسدّد به أقساطه (contracts/service). ولكل عربون مآلٌ واحد في deposit_outcome.
 */
import type { DB } from '../db/adapter';
import { requireCash } from './cashGuard';
import { uid } from './ids';
import { today, dfmt } from './dates';
import { postReservationDeposit, postReservationForfeit, postReservationRefund } from './accounting/post';
import { unitActiveReservation, unitCurrentContract } from './contracts/rules';
import { logAudit } from './audit';

export interface ReservationInput {
  unitId: string;
  name: string;
  phone: string;
  depositHalalas: number;
  expiryDate: string;
}

export function createReservation(db: DB, input: ReservationInput): string {
  if (!input.name.trim() || !input.expiryDate)
    throw new Error('الرجاء إدخال اسم صاحب الحجز وتاريخ انتهاء الحجز');
  if (unitCurrentContract(db, input.unitId))
    throw new Error('هذه الوحدة مؤجَّرة حالياً بعقد سارٍ · لا يمكن حجزها');
  const existing = unitActiveReservation(db, input.unitId);
  if (existing)
    throw new Error('يوجد حجز نشط على هذه الوحدة بالفعل حتى ' + dfmt(existing.expiry_date));
  return db.transaction(() => {
    const id = uid();
    db.run(
      `INSERT INTO reservations (id, unit_id, name, phone, deposit_halalas, expiry_date, created_date, status)
       VALUES (?,?,?,?,?,?,?,'نشط')`,
      [id, input.unitId, input.name.trim(), input.phone.trim(), input.depositHalalas,
       input.expiryDate, today()]
    );
    postReservationDeposit(db, { id, name: input.name, deposit: input.depositHalalas });
    logAudit(db, 'العقارات', 'create', 'حجز بعربون', input.name);
    return id;
  });
}

/**
 * إلغاء الحجز أو تسوية عربون حجزٍ انتهى · مصادرةً إيراداً أو ردّاً لصاحبه، وكلاهما بقيد بتاريخه (المراجعة ٤.٥).
 * العربون يُسوّى مرة واحدة: المحوَّل لعقد أو المسوّى قبلُ يُرفض.
 */
export function cancelReservation(db: DB, id: string, forfeitDeposit: boolean, date: string = today()): void {
  db.transaction(() => {
    const r = db.get<{ name: string; deposit_halalas: number; status: string; deposit_outcome: string | null }>(
      `SELECT name, deposit_halalas, status, deposit_outcome FROM reservations WHERE id = ?`, [id]
    );
    if (!r) return;
    if (r.status === 'محوَّل لعقد') throw new Error('الحجز محوَّل لعقد · عربونه سُدّد به العقد');
    if (r.deposit_outcome) throw new Error('عربون هذا الحجز ' + r.deposit_outcome + ' من قبل');
    const deposit = Number(r.deposit_halalas);
    if (!forfeitDeposit) requireCash(db, deposit, 'ردّ العربون');
    const outcome = deposit > 0 ? (forfeitDeposit ? 'مصادَر' : 'مردود') : null;
    db.run(`UPDATE reservations SET status = 'منتهي', deposit_outcome = ?, deposit_settled_date = ? WHERE id = ?`,
      [outcome, outcome ? date : null, id]);
    if (deposit > 0) {
      if (forfeitDeposit) postReservationForfeit(db, { id, name: r.name, deposit, date });
      else postReservationRefund(db, { id, name: r.name, deposit, date });
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

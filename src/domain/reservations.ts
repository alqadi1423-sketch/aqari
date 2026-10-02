/**
 * الحجوزات بعربون · الإنشاء يرحّل (1100/2450)، والإلغاء مع مصادرة اختيارية (2450/4300).
 */
import type { DB } from '../db/adapter';
import { uid } from './ids';
import { today, dfmt } from './dates';
import { postReservationDeposit, postReservationForfeit } from './accounting/post';
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

/** إلغاء الحجز · مع خيار مصادرة العربون إيراداً */
export function cancelReservation(db: DB, id: string, forfeitDeposit: boolean): void {
  db.transaction(() => {
    const r = db.get<{ name: string; deposit_halalas: number; status: string }>(
      `SELECT name, deposit_halalas, status FROM reservations WHERE id = ?`, [id]
    );
    if (!r) return;
    db.run(`UPDATE reservations SET status = 'منتهي' WHERE id = ?`, [id]);
    if (forfeitDeposit && Number(r.deposit_halalas) > 0) {
      postReservationForfeit(db, { id, name: r.name, deposit: Number(r.deposit_halalas) });
    }
    logAudit(db, 'العقارات', 'update', 'إلغاء حجز', r.name);
  });
}

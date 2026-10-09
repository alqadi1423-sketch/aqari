/**
 * ساكنو الوحدة · سجلٌّ كامل: من سكن ومتى غادر · للأمن وإثبات الشرط الإضافي
 * وبيان الشاغلين للجهات. المستأجر يُضاف تلقائياً أول ساكن، والمغادرة تُؤرَّخ
 * ولا تُمحى، والساكنون ينتقلون مع التجديد.
 */
import type { DB } from '../db/adapter';
import { uid } from './ids';
import { logAudit } from './audit';
import { normalizePhone } from './phone';

export const OCCUPANT_RELATIONS = [
  'نفسه', 'زوجة', 'ابن', 'ابنة', 'أب', 'أم', 'أخ', 'قريب', 'عامل', 'أخرى',
] as const;

export interface OccupantRow {
  id: string;
  contract_id: string;
  unit_id: string | null;
  name: string;
  national_id: string;
  phone: string;
  relation: string;
  nationality: string;
  moved_in: string | null;
  moved_out: string | null;
}

export interface OccupantInput {
  name: string;
  nationalId: string;
  phone?: string;
  relation?: string;
  nationality?: string;
  movedIn?: string | null;
}

export function addOccupant(db: DB, contractId: string, input: OccupantInput): string {
  const name = input.name.trim();
  const nat = input.nationalId.trim();
  if (!name) throw new Error('اكتب اسم الساكن');
  if (!nat) throw new Error('اكتب رقم هوية الساكن · إلزامي لبيان الشاغلين');
  const c = db.get<{ unit_id: string | null; start: string | null }>(
    `SELECT unit_id, start FROM contracts WHERE id = ?`, [contractId]);
  if (!c) throw new Error('تعذّر العثور على العقد');
  const id = uid();
  db.transaction(() => {
    db.run(
      `INSERT INTO occupants (id, contract_id, unit_id, name, national_id, phone, relation, nationality, moved_in, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, contractId, c.unit_id, name, nat,
       input.phone ? (normalizePhone(input.phone) ?? input.phone.trim()) : '',
       input.relation || 'أخرى', (input.nationality ?? '').trim(),
       input.movedIn ?? c.start, new Date().toISOString()]
    );
    logAudit(db, 'الساكنون', 'create', 'ساكن', name);
  });
  return id;
}

export function updateOccupant(db: DB, id: string, patch: Partial<OccupantInput>): void {
  const cur = db.get<OccupantRow>(`SELECT * FROM occupants WHERE id = ?`, [id]);
  if (!cur) throw new Error('تعذّر العثور على الساكن');
  db.transaction(() => {
    db.run(
      `UPDATE occupants SET name = ?, national_id = ?, phone = ?, relation = ?, nationality = ? WHERE id = ?`,
      [patch.name?.trim() || cur.name,
       patch.nationalId?.trim() || cur.national_id,
       patch.phone !== undefined ? (normalizePhone(patch.phone) ?? patch.phone.trim()) : cur.phone,
       patch.relation || cur.relation,
       patch.nationality !== undefined ? patch.nationality.trim() : cur.nationality,
       id]
    );
    logAudit(db, 'الساكنون', 'update', 'ساكن', patch.name?.trim() || cur.name);
  });
}

/** تسجيل المغادرة · يخرج من العدد ويبقى في السجل بتاريخه */
export function markOccupantLeft(db: DB, id: string, date: string): void {
  const cur = db.get<{ name: string }>(`SELECT name FROM occupants WHERE id = ?`, [id]);
  if (!cur) throw new Error('تعذّر العثور على الساكن');
  db.transaction(() => {
    db.run(`UPDATE occupants SET moved_out = ? WHERE id = ?`, [date, id]);
    logAudit(db, 'الساكنون', 'update', 'مغادرة ساكن', cur.name + ' · ' + date);
  });
}

export function deleteOccupant(db: DB, id: string): void {
  const cur = db.get<{ name: string }>(`SELECT name FROM occupants WHERE id = ?`, [id]);
  db.transaction(() => {
    db.run(`UPDATE occupants SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    logAudit(db, 'الساكنون', 'delete', 'ساكن', cur?.name ?? id);
  });
}

/** ساكنو عقد (الحاليون أولاً ثم المغادرون بتواريخهم) */
export function occupantsOf(db: DB, contractId: string): OccupantRow[] {
  return db.all<OccupantRow>(
    `SELECT * FROM occupants WHERE contract_id = ? AND deleted_at IS NULL
     ORDER BY (moved_out IS NOT NULL), created_at`, [contractId]);
}

/** الساكنون الحاليون لوحدة (عبر عقودها غير الملغاة) */
export function occupantsOfUnit(db: DB, unitId: string): OccupantRow[] {
  return db.all<OccupantRow>(
    `SELECT o.* FROM occupants o JOIN contracts c ON c.id = o.contract_id
     WHERE o.unit_id = ? AND o.deleted_at IS NULL AND o.moved_out IS NULL
       AND c.deleted_at IS NULL AND c.status NOT IN ('ملغى')
     ORDER BY o.created_at`, [unitId]);
}

/** المستأجر نفسه أول ساكن تلقائياً · إن لم يكن هو الساكن يحذفه المستخدم */
export function seedTenantOccupant(db: DB, contractId: string): void {
  const c = db.get<{ tenant_name: string; id_number: string; phone: string; start: string | null; status: string }>(
    `SELECT tenant_name, id_number, phone, start, status FROM contracts WHERE id = ?`, [contractId]);
  if (!c || c.status === 'مسودة') return;
  const exists = db.get(`SELECT id FROM occupants WHERE contract_id = ? AND relation = 'نفسه' AND deleted_at IS NULL`, [contractId]);
  if (exists) return;
  addOccupant(db, contractId, {
    name: c.tenant_name, nationalId: c.id_number || 'لا يوجد', phone: c.phone,
    relation: 'نفسه', movedIn: c.start,
  });
}

/** الساكنون الحاليون غير المستأجر نفسه · يُسأل عنهم عند التجديد «هل غادر الساكنون؟» */
export function otherCurrentOccupants(db: DB, contractId: string): number {
  return Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM occupants WHERE contract_id = ? AND deleted_at IS NULL AND moved_out IS NULL AND relation != ?`,
    [contractId, 'نفسه'])?.n ?? 0); // i18n-exempt: صلة مخزّنة
}

/**
 * انتقال الساكنين الحاليين مع تجديد العقد · leftOn: غادر الساكنون (جواب «نعم» · قرار المالك 2026-08-20) فتُسجَّل
 * مغادرتهم بتاريخها وينتقل المستأجر نفسه وحده
 */
export function carryOccupantsToRenewal(db: DB, oldContractId: string, newContractId: string, opts: { leftOn?: string } = {}): number {
  let current = db.all<OccupantRow>(
    `SELECT * FROM occupants WHERE contract_id = ? AND deleted_at IS NULL AND moved_out IS NULL`,
    [oldContractId]);
  if (opts.leftOn) {
    for (const o of current.filter((x) => x.relation !== 'نفسه')) markOccupantLeft(db, o.id, opts.leftOn); // i18n-exempt: صلة مخزّنة
    current = current.filter((x) => x.relation === 'نفسه'); // i18n-exempt: صلة مخزّنة
  }
  const c = db.get<{ unit_id: string | null; start: string | null }>(
    `SELECT unit_id, start FROM contracts WHERE id = ?`, [newContractId]);
  db.transaction(() => {
    for (const o of current) {
      db.run(
        `INSERT INTO occupants (id, contract_id, unit_id, name, national_id, phone, relation, nationality, moved_in, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uid(), newContractId, c?.unit_id ?? o.unit_id, o.name, o.national_id, o.phone,
         o.relation, o.nationality, c?.start ?? o.moved_in, new Date().toISOString()]
      );
    }
    if (current.length) logAudit(db, 'الساكنون', 'create', 'انتقال مع التجديد', current.length + ' ساكن');
  });
  return current.length;
}

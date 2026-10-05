/**
 * نموذج الاستلام والتسليم · سياسة معتمدة من المالك:
 * نموذج واحد لكل عقد، يُنشأ تلقائياً من تفاصيل الوحدة عند توثيق العقد،
 * يُعبَّأ تدريجياً (خانتا الاستلام والتسليم)، وبعد إقفاله لا يُعدَّل.
 */
import type { DB } from '../../db/adapter';
import { uid } from '../ids';
import { today, dfmt } from '../dates';
import { buildHandoverSections, type HandoverSection } from './build';
import { logAudit } from '../audit';

export interface HandoverRow {
  id: string;
  contract_id: string | null;
  unit_id: string | null;
  type: string;
  employee_name: string;
  tenant_name: string;
  id_number: string;
  phone: string;
  address: string;
  unit_floor: string;
  contract_period: string;
  date: string;
  other_notes: string;
  tenant_sign: string;
  company_sign: string;
  sections_json: string;
  locked: number;
}

export class HandoverLocked extends Error {
  constructor() {
    super('النموذج مُقفل · لا يُعدَّل بعد الإقفال');
    this.name = 'HandoverLocked';
  }
}

export function getContractHandover(db: DB, contractId: string): HandoverRow | undefined {
  return db.get<HandoverRow>(
    `SELECT * FROM handovers WHERE contract_id = ? AND deleted_at IS NULL`,
    [contractId]
  );
}

/** الإنشاء التلقائي عند توثيق العقد · من غرف الوحدة وأقسام العقار */
export function createHandoverForContract(db: DB, contractId: string): string | null {
  if (getContractHandover(db, contractId)) return null; // نموذج واحد لكل عقد · لا يُكرَّر
  const c = db.get<{
    id: string; tenant_name: string; phone: string; unit_id: string | null;
    start: string | null; end: string | null; id_number: string;
  }>(`SELECT id, tenant_name, phone, unit_id, start, end, id_number FROM contracts WHERE id = ?`, [contractId]);
  if (!c) return null;
  const u = c.unit_id
    ? db.get<{ unit_no: string; property_id: string }>(`SELECT unit_no, property_id FROM units WHERE id = ?`, [c.unit_id])
    : undefined;
  const p = u ? db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [u.property_id]) : undefined;
  // لا قالب ولا تفاصيل للوحدة: لا نموذج فارغاً · ويظهر مكانه السبب ورابط إنشاء القالب (HandoverSheet)
  const sections = buildHandoverSections(db, c.unit_id, null);
  if (!sections.length) return null;
  const id = uid();
  db.run(
    `INSERT INTO handovers (id, contract_id, unit_id, type, tenant_name, id_number, phone, address,
      unit_floor, contract_period, date, sections_json, created_at)
     VALUES (?,?,?,'استلام',?,?,?,?,?,?,?,?,?)`,
    [id, contractId, c.unit_id, c.tenant_name, c.id_number || '', c.phone || '',
     p?.name ?? '', u?.unit_no ?? '',
     c.start && c.end ? dfmt(c.start) + ' · ' + dfmt(c.end) : '',
     today(), JSON.stringify(sections), new Date().toISOString()]
  );
  logAudit(db, 'نماذج الاستلام والتسليم', 'create', 'إنشاء تلقائي من تفاصيل الوحدة', c.tenant_name);
  return id;
}

/** إنشاء النماذج الناقصة لكل العقود الموثقة · يعمل عند الإقلاع، لا يكرِّر شيئاً */
export function backfillHandovers(db: DB): number {
  const rows = db.all<{ id: string }>(
    `SELECT c.id FROM contracts c
     WHERE c.deleted_at IS NULL AND c.status NOT IN ('مسودة','ملغى')
       AND NOT EXISTS (SELECT 1 FROM handovers h WHERE h.contract_id = c.id AND h.deleted_at IS NULL)`
  );
  for (const r of rows) createHandoverForContract(db, r.id);
  return rows.length;
}

export interface HandoverUpdate {
  employeeName: string;
  tenantName: string;
  idNumber: string;
  phone: string;
  address: string;
  unitFloor: string;
  contractPeriod: string;
  date: string;
  otherNotes: string;
  tenantSign: string;
  companySign: string;
  sections: HandoverSection[];
}

/** الحفظ · مرفوض بعد الإقفال */
export function updateHandover(db: DB, id: string, data: HandoverUpdate): void {
  const h = db.get<{ locked: number; tenant_name: string }>(`SELECT locked, tenant_name FROM handovers WHERE id = ?`, [id]);
  if (!h) throw new Error('تعذّر العثور على النموذج');
  if (Number(h.locked)) throw new HandoverLocked();
  db.transaction(() => {
    db.run(
      `UPDATE handovers SET employee_name=?, tenant_name=?, id_number=?, phone=?, address=?,
        unit_floor=?, contract_period=?, date=?, other_notes=?, tenant_sign=?, company_sign=?, sections_json=?
       WHERE id = ?`,
      [data.employeeName.trim(), data.tenantName.trim(), data.idNumber.trim(), data.phone.trim(),
       data.address.trim(), data.unitFloor.trim(), data.contractPeriod.trim(), data.date,
       data.otherNotes.trim(), data.tenantSign.trim(), data.companySign.trim(),
       JSON.stringify(data.sections), id]
    );
    logAudit(db, 'نماذج الاستلام والتسليم', 'update', 'تعبئة النموذج', data.tenantName.trim());
  });
}

/** الإقفال · بعده يصير النموذج وثيقة نهائية غير قابلة للتعديل */
export function lockHandover(db: DB, id: string): void {
  db.transaction(() => {
    const h = db.get<{ tenant_name: string }>(`SELECT tenant_name FROM handovers WHERE id = ?`, [id]);
    db.run(`UPDATE handovers SET locked = 1 WHERE id = ?`, [id]);
    if (h) logAudit(db, 'نماذج الاستلام والتسليم', 'update', 'إقفال النموذج', h.tenant_name);
  });
}

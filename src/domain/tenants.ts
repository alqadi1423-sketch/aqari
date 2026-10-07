/**
 * المستأجر كيانٌ لا نصّ · رقم الهوية مفتاح فريد يمنع التكرار بنيوياً:
 * عند إنشاء عقد يُبحث بالهوية أولاً · وُجد فيُربط، لم يوجد فيُنشأ؛
 * وتعديل الاسم لا يفصل المستأجر عن عقوده لأن الربط بالمعرّف.
 * المتشابهات تُجمع وتُعرض ليقرّر المستخدم دمجها · لا دمج صامت.
 */
import type { DB } from '../db/adapter';
import { uid } from './ids';
import { logAudit } from './audit';
import { INSTALLMENT_DISCOUNT_SQL } from './contracts/installments';
import { contractTotalSql } from './accounting/rentSplit';

export const normTenantName = (s: string): string => s.trim().replace(/\s+/g, ' ');

/** مفتاح تشابه: بلا مسافات ولا «ال» التعريف · للعرض على المستخدم لا للدمج الصامت */
const similarityKey = (name: string): string =>
  normTenantName(name).replace(/\s+/g, '').replace(/^ال/, '').replace(/ال(?=[؀-ۿ]{2,})/g, '');

/**
 * البحث بالهوية أولاً ثم بالاسم المطابق · وُجد فرُبط وحُدّثت بياناته الناقصة،
 * لم يوجد فأُنشئ. يعيد معرّف المستأجر.
 */
export function findOrCreateTenant(
  db: DB,
  info: { name: string; nationalId?: string; phone?: string }
): string {
  const name = normTenantName(info.name);
  const nat = (info.nationalId ?? '').trim();
  const phone = (info.phone ?? '').trim();
  let row = nat
    ? db.get<{ id: string; name: string; phone: string }>(
        `SELECT id, name, phone FROM tenants WHERE national_id = ? AND deleted_at IS NULL`, [nat])
    : undefined;
  if (!row) {
    row = db.get<{ id: string; name: string; phone: string; national_id: string }>(
      `SELECT id, name, phone, national_id FROM tenants
       WHERE TRIM(name) = ? AND deleted_at IS NULL`, [name]) as typeof row;
  }
  if (row) {
    // إكمال الناقص في مصدره · لا كتابة فوق قائم
    const natRow = db.get<{ national_id: string; phone: string }>(
      `SELECT national_id, phone FROM tenants WHERE id = ?`, [row.id])!;
    if (nat && !natRow.national_id.trim()) db.run(`UPDATE tenants SET national_id = ? WHERE id = ?`, [nat, row.id]);
    if (phone && !natRow.phone.trim()) db.run(`UPDATE tenants SET phone = ? WHERE id = ?`, [phone, row.id]);
    return row.id;
  }
  const id = uid();
  db.run(
    `INSERT INTO tenants (id, name, national_id, phone, created_at) VALUES (?,?,?,?,?)`,
    [id, name, nat, phone, new Date().toISOString()]
  );
  return id;
}

/** ربط عقد واحد بمستأجره (بحث/إنشاء) · يُستدعى بعد كل إنشاء عقد */
export function linkContractTenant(db: DB, contractId: string): void {
  const c = db.get<{ tenant_name: string; id_number: string; phone: string; tenant_id: string | null }>(
    `SELECT tenant_name, id_number, phone, tenant_id FROM contracts WHERE id = ?`, [contractId]);
  if (!c || c.tenant_id) return;
  const tid = findOrCreateTenant(db, { name: c.tenant_name, nationalId: c.id_number, phone: c.phone });
  db.run(`UPDATE contracts SET tenant_id = ? WHERE id = ?`, [tid, contractId]);
}

/** ربط كل العقود غير المربوطة · يجري عند الإقلاع فيغطي القديم والمعدَّل */
export function backfillTenantLinks(db: DB): number {
  const rows = db.all<{ id: string }>(
    `SELECT id FROM contracts WHERE tenant_id IS NULL AND deleted_at IS NULL ORDER BY created_at`
  );
  for (const r of rows) linkContractTenant(db, r.id);
  return rows.length;
}

export interface TenantProfile {
  tenant: { id: string; name: string; national_id: string; phone: string; notes: string };
  contracts: Array<{ id: string; contract_no: string | null; unit_label: string; start: string | null; end: string | null; value_halalas: number; total_halalas: number; services_halalas: number; parking_halalas: number; status: string }>;
  totals: { dueToDate: number; collected: number; outstanding: number };
  claims: { count: number; amountHalalas: number };
  /** نسبة الأقساط المسدَّدة في وقتها من المستحقة */
  onTimePct: number | null;
}

/** ملف المستأجر: كل عقوده وأرصدته ومطالباته وتقييمه · عبر عقاراته كلها */
export function tenantProfile(db: DB, tenantId: string, today: string): TenantProfile | null {
  const tenant = db.get<TenantProfile['tenant']>(
    `SELECT id, name, national_id, phone, notes FROM tenants WHERE id = ?`, [tenantId]);
  if (!tenant) return null;
  const contracts = db.all<TenantProfile['contracts'][number]>(
    `SELECT id, contract_no, unit_label, start, "end", value_halalas, ${contractTotalSql(db)} AS total_halalas,
            ${contractTotalSql(db) === 'value_halalas' ? '0 AS services_halalas, 0 AS parking_halalas' : 'services_halalas, parking_halalas'}, status FROM contracts
     WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY COALESCE(start,'') DESC`, [tenantId]);
  const inst = db.get<{ due: number; collected: number; total: number; paidOnTime: number; dueCount: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN i.due_date <= ? AND i.status != 'ملغية' THEN i.amount_halalas ELSE 0 END),0) AS due,
       COALESCE(SUM(CASE WHEN i.status != 'ملغية' THEN i.paid_halalas ELSE 0 END),0) AS collected,
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN i.due_date <= ? AND i.status != 'ملغية'
                          AND i.paid_halalas + ${INSTALLMENT_DISCOUNT_SQL} >= i.amount_halalas THEN 1 ELSE 0 END),0) AS paidOnTime,
       COALESCE(SUM(CASE WHEN i.due_date <= ? AND i.status != 'ملغية' THEN 1 ELSE 0 END),0) AS dueCount
     FROM contract_installments i JOIN contracts c ON c.id = i.contract_id
     WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.status NOT IN ('مسودة','ملغى')`,
    [today, today, today, tenantId])!;
  const claims = db.get<{ n: number; s: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(cl.amount_halalas),0) AS s
     FROM claims cl JOIN contracts c ON c.id = cl.contract_id
     WHERE c.tenant_id = ? AND cl.deleted_at IS NULL`, [tenantId])!;
  const due = Number(inst.due), collected = Number(inst.collected);
  return {
    tenant, contracts,
    totals: { dueToDate: due, collected, outstanding: Math.max(0, due - collected) },
    claims: { count: Number(claims.n), amountHalalas: Number(claims.s) },
    onTimePct: Number(inst.dueCount) ? Math.round((Number(inst.paidOnTime) / Number(inst.dueCount)) * 100) : null,
  };
}

export interface SimilarGroup { key: string; tenants: Array<{ id: string; name: string; national_id: string; contracts: number }> }

/** مجموعات الأسماء المتشابهة (بعد التطبيع) · تُعرض ليقرّر المستخدم · لا دمج صامت */
export function similarTenantGroups(db: DB): SimilarGroup[] {
  const all = db.all<{ id: string; name: string; national_id: string }>(
    `SELECT id, name, national_id FROM tenants WHERE deleted_at IS NULL`);
  const map = new Map<string, SimilarGroup['tenants']>();
  for (const t of all) {
    const k = similarityKey(t.name);
    if (!k) continue;
    const contracts = Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM contracts WHERE tenant_id = ? AND deleted_at IS NULL`, [t.id])!.n);
    const arr = map.get(k) ?? [];
    arr.push({ id: t.id, name: t.name, national_id: t.national_id, contracts });
    map.set(k, arr);
  }
  return [...map.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([key, tenants]) => ({ key, tenants }));
}

/** دمج مستأجرين في سجل واحد: العقود تُعاد للوجهة والمكرَّرون يُحذفون ناعماً */
export function mergeTenants(db: DB, keepId: string, dropIds: string[]): void {
  const keep = db.get<{ name: string; national_id: string; phone: string }>(
    `SELECT name, national_id, phone FROM tenants WHERE id = ?`, [keepId]);
  if (!keep) throw new Error('تعذّر العثور على المستأجر الوجهة');
  db.transaction(() => {
    for (const dropId of dropIds) {
      if (dropId === keepId) continue;
      const drop = db.get<{ national_id: string; phone: string }>(
        `SELECT national_id, phone FROM tenants WHERE id = ?`, [dropId]);
      db.run(`UPDATE contracts SET tenant_id = ?, tenant_name = ? WHERE tenant_id = ?`, [keepId, keep.name, dropId]);
      // إكمال الناقص من المدموج
      if (drop?.national_id && !keep.national_id) db.run(`UPDATE tenants SET national_id = ? WHERE id = ?`, [drop.national_id, keepId]);
      if (drop?.phone && !keep.phone) db.run(`UPDATE tenants SET phone = ? WHERE id = ?`, [drop.phone, keepId]);
      db.run(`UPDATE tenants SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), dropId]);
    }
    logAudit(db, 'العملاء', 'update', 'دمج مستأجرين', keep.name);
  });
}

/** تعديل اسم المستأجر في مصدره · عقوده تتبعه لأن الربط بالمعرّف */
export function renameTenant(db: DB, tenantId: string, newName: string): void {
  const name = normTenantName(newName);
  if (!name) throw new Error('اكتب اسماً');
  db.transaction(() => {
    db.run(`UPDATE tenants SET name = ? WHERE id = ?`, [name, tenantId]);
    db.run(`UPDATE contracts SET tenant_name = ? WHERE tenant_id = ?`, [name, tenantId]);
    logAudit(db, 'العملاء', 'update', 'تعديل اسم مستأجر', name);
  });
}

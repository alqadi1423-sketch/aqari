import type { DB } from '../db/adapter';
import { uid } from './ids';

/**
 * منفّذ العملية لسجل العمليات (توجيه المالك ٢٠٢٦-١٠-٠٥): العضو باسمه الكامل من بياناته، والمالك «المالك»،
 * والجهاز بلا حساب «مستخدم». يُقرأ من حالة المزامنة مباشرة فلا تعتمد طبقة المنطق على خدمات الجهاز.
 */
export function auditActor(db: DB): string {
  try {
    const get = (k: string) => db.get<{ v: string | null }>(`SELECT v FROM sync_state WHERE k = ?`, [k])?.v ?? null;
    const membership = get('membership');
    if (membership) {
      const m = JSON.parse(membership) as { profile?: { name?: string } };
      return (m.profile?.name || '').trim() || 'عضو';
    }
    const org = get('org');
    if (org && org === get('uid')) return 'المالك';
  } catch { /* قاعدة بلا جداول المزامنة · «مستخدم» */ }
  return 'مستخدم';
}

/** تسجيل عملية في سجل العمليات (غير قابل للتعديل) */
export function logAudit(
  db: DB,
  module: string,
  actionType: 'create' | 'update' | 'delete' | 'login',
  entityType: string,
  entityName: string,
  before?: unknown,
  after?: unknown
): void {
  db.run(
    `INSERT INTO audit_log (id, ts, user_name, module, action_type, entity_type, entity_name, before_json, after_json)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      uid(),
      new Date().toISOString().slice(0, 19),
      auditActor(db),
      module,
      actionType,
      entityType,
      entityName,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
    ]
  );
}

/**
 * كاتب سطر السجل من معرّفه لا من الاسم المكتوب فيه (قرار المالك 2026-10-15 «١٠»: «شاشة السجل تعرض الكاتب من معرّفه» · المراجعة
 * الخارجية ٧ · النتيجة ٢٢: العضو يكتب سطراً باسم عضوٍ آخر) · كاتبه من المزامنة (row_by) واسمه من الدليل، والمالك «المالك» ·
 * وسطر هذا الجهاز أو كاتبٌ لا يُعرف اسمه بالاسم المكتوب · mismatch: الاسم المكتوب غير اسم كاتبه
 */
export const AUDIT_WRITER_SQL = `LEFT JOIN row_by rb ON rb.tbl = 'audit_log' AND rb.pk = audit_log.id
  LEFT JOIN chat_people cp ON cp.uid = rb.uid`;
export function auditWriter(r: { user_name: string; writer_uid: string | null; writer_name: string | null }, ownerUid: string | null):
  { name: string; mismatch: boolean } {
  if (!r.writer_uid) return { name: r.user_name, mismatch: false };
  if (ownerUid && r.writer_uid === ownerUid) return { name: OWNER_NAME, mismatch: r.user_name !== OWNER_NAME };
  if (r.writer_name) return { name: r.writer_name, mismatch: r.user_name !== r.writer_name };
  return { name: r.user_name, mismatch: false };
}
const OWNER_NAME = 'المالك'; // i18n-exempt: فاعلٌ مخزَّن في سجل العمليات

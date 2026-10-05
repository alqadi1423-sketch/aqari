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

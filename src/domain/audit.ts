import type { DB } from '../db/adapter';
import { uid } from './ids';

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
      'مستخدم',
      module,
      actionType,
      entityType,
      entityName,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
    ]
  );
}

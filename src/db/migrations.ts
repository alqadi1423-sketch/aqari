import type { DB } from './adapter';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';
import { LEGACY_REPAIR_VERSION, repairLegacyInstallments } from '../domain/contracts/legacyRepair';

export class NewerSchemaError extends Error {
  constructor(public found: number, public supported: number) {
    super(
      `قاعدة البيانات هذه من إصدار أحدث (${found}) مما يدعمه هذا التطبيق (${supported}) · حدّث التطبيق أولاً ثم أعد المحاولة.`
    );
    this.name = 'NewerSchemaError';
  }
}

export function currentSchemaVersion(db: DB): number {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  return row ? Number(row.user_version) : 0;
}

/**
 * تطبيق الهجرات الناقصة. ترمي NewerSchemaError إن كانت القاعدة أحدث من التطبيق
 * (تُستخدم أيضاً على النسخة المؤقتة أثناء الاستعادة · «مخطط أقدم ← هجرة، أحدث ← رفض مؤدَّب»).
 */
export function migrate(db: DB): void {
  const found = currentSchemaVersion(db);
  if (found > SCHEMA_VERSION) throw new NewerSchemaError(found, SCHEMA_VERSION);
  if (found === SCHEMA_VERSION) return;
  // بعض الهجرات تعيد بناء جداول لها أبناء بمفاتيح أجنبية · نعطل الفحص أثناءها فقط
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (let v = found; v < SCHEMA_VERSION; v++) {
        db.exec(MIGRATIONS[v]);
      }
      // بيانات ما قبل إقفال القسم ٣ بنموذجها القديم · تُصلح مرة بقرارات المالك (legacyRepair)
      if (found < LEGACY_REPAIR_VERSION) repairLegacyInstallments(db);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  // user_version خارج المعاملة · بعض المحركات لا تسمح بها داخلها
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

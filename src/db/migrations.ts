import type { DB } from './adapter';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';

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
 *
 * الهجرات ورقم الإصدار في معاملة واحدة: إمّا القاعدة كلها بالإصدار الجديد، أو كما كانت.
 * وكان رقم الإصدار يُكتب بعد الالتزام، فإغلاقُ التطبيق بين الخطوتين يترك بنيةً جديدة برقم
 * قديم، فتُعاد الهجرة عند الفتح التالي وتفشل على عمود موجود ولا يفتح التطبيق بعدها.
 * و`PRAGMA user_version` تُكتب في ترويسة الملف ضمن المعاملة نفسها في SQLite.
 *
 * `afterStep` للاختبار وحده: يُنادى بعد كل هجرة داخل المعاملة لمحاكاة الإغلاق في منتصفها.
 */
export function migrate(db: DB, afterStep?: (version: number) => void): void {
  const found = currentSchemaVersion(db);
  if (found > SCHEMA_VERSION) throw new NewerSchemaError(found, SCHEMA_VERSION);
  if (found === SCHEMA_VERSION) return;
  // بعض الهجرات تعيد بناء جداول لها أبناء بمفاتيح أجنبية · نعطل الفحص أثناءها فقط
  // (والأمر لا أثر له داخل معاملة، فيُقدَّم عليها)
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (let v = found; v < SCHEMA_VERSION; v++) {
        db.exec(MIGRATIONS[v]);
        afterStep?.(v + 1);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

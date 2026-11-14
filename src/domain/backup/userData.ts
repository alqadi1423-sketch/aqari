/**
 * هل في القاعدة بيانات أدخلها المستخدم؟ · نُقلت من upgrade.ts كما هي (التوجيه الرابع ٣ · ٤) لتستعملها نسخة الأمان في create.ts بلا
 * استيرادٍ دائري، وupgrade.ts يعيد تصديرها
 */
import type { BackupEnv } from './types';

/** جداول تكتبها البذرة والإعداد لا المستخدم · وجود صفوفها وحدها لا يعني بيانات */
const SYSTEM_TABLES = new Set([
  'meta', 'settings', 'accounts', 'company', 'message_scripts', 'form_templates',
  'audit_log', 'scheduled_notifications',
  // كاتب كل صف (الهجرة ٤٢): بيانات الجهاز عن صفوفه لا صفوفٌ للمستخدم · ويُملأ بكل وارد فلا يجعل الجهاز الجديد «ذا بيانات»
  'row_by',
]);

/** في القاعدة بيانات أدخلها المستخدم؟ · أي صف في جدول غير جداول النظام والمزامنة */
export function hasUserData(db: BackupEnv['db']): boolean {
  const tables = db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).map((t) => t.name);
  for (const t of tables) {
    // المحادثة (chat_) وحدة مستقلة · رسائلها ليست بيانات المنشأة فلا تمنع دعوةً ولا تنضمّ بها
    if (SYSTEM_TABLES.has(t) || t.startsWith('sync_') || t.startsWith('chat_')) continue;
    // مركز «عام» تزرعه الهجرة ٢٨ على كل قاعدة · وما أضافه المستخدم بياناته
    if (t === 'cost_centers') {
      if (db.get(`SELECT 1 FROM cost_centers WHERE is_default = 0 LIMIT 1`)) return true;
      continue;
    }
    if (db.get(`SELECT 1 FROM "${t}" LIMIT 1`)) return true;
  }
  return false;
}

/**
 * «امسح كل البيانات» بنسخة أمان إلزامية: تُنشأ النسخة أولاً في مجلد دائم لا يُكنس،
 * وفشلُها يلغي المسح كله قبل أن يُمسّ صف واحد · ثم يُنقل كل شيء لسلة المحذوفات.
 */
import { makeSafetyBackup, ensureFreeSpace } from './backup/create';
import { logAudit } from './audit';
import type { BackupEnv } from './backup/types';

export const WIPE_TABLES = [
  'contracts', 'reservations', 'claims', 'key_money_deals', 'invoices', 'purchases',
  'bank_tx', 'banks', 'units', 'properties', 'tenants', 'suppliers', 'message_scripts',
  'handovers', 'company_docs', 'attachments',
] as const;

/**
 * يعيد مسار نسخة الأمان بعد نجاح المسح · وأي فشل في النسخة يوقف كل شيء
 * والبيانات كما هي (الاستثناء يحمل السبب).
 */
export async function wipeAllData(
  env: BackupEnv,
  onProgress?: (msg: string) => void
): Promise<string> {
  await ensureFreeSpace(env); // القرص يسع النسخة · وإلا فلا يبدأ المسح أصلاً
  // فشلها يرمي قبل أي مساس بالبيانات · وواحدة تبقى وما قبلها يُحذف
  const safetyPath = await makeSafetyBackup(env, 'pre-wipe', onProgress);

  onProgress?.('جاري نقل البيانات إلى سلة المحذوفات');
  const db = env.db;
  db.transaction(() => {
    const now = new Date().toISOString();
    for (const t of WIPE_TABLES) {
      db.run(`UPDATE "${t}" SET deleted_at = COALESCE(deleted_at, ?)`, [now]);
    }
    db.run(`UPDATE journal_entries SET deleted_at = COALESCE(deleted_at, ?)`, [now]);
    logAudit(db, 'الإعدادات', 'delete', 'مسح كل البيانات', 'نسخة الأمان: ' + safetyPath.split('/').pop());
  });
  return safetyPath;
}

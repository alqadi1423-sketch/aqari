/**
 * تفريغ الجهاز من بيانات الحساب كلها · لا سلة ولا نسخة أمان تبقى عليه:
 *  - «حذف حسابي» بعد حذف بياناته من السحابة.
 *  - «على هذا الجهاز بيانات حساب آخر» حين يختار صاحب الحساب الجديد حذفها.
 * القاعدة تُغلق ويُحذف ملفها، والمرفقات والمصغّرات والمؤقتات ونسخ الأمان ولقطة الودجت،
 * ثم تُفتح قاعدة جديدة بالهجرات والزرع، بهوية جهاز جديدة. وكلمة مرور النسخ تُمسح.
 */
import { File } from 'expo-file-system';
import type { AppDB } from '../db/expoAdapter';
import { joinPath } from '../files/fsAdapter';
import { appDataRoot, expoFs } from '../files/expoFs';
import { migrate } from '../db/migrations';
import { seed, ensureDeviceId } from '../db/seed';
import { clearBackupPassword } from './backupPassword';
import { disableLock } from './appLockService';

export async function resetDeviceData(db: AppDB): Promise<void> {
  const root = appDataRoot();
  const dbPath = db.databasePath;
  try { db.close(); } catch { /* مغلقة */ }
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try { const f = new File(p.startsWith('file://') ? p : 'file://' + p); if (f.exists) f.delete(); } catch { /* التالي */ }
  }
  for (const d of ['attachments', 'thumbs', 'tmp', 'backups', 'widget.json']) {
    try { expoFs.remove(joinPath(root, d)); } catch { /* التالي */ }
  }
  db.reopen();
  migrate(db);
  seed(db);
  ensureDeviceId(db);
  try { await clearBackupPassword(); } catch { /* لا كلمة */ }
  try { await disableLock(); } catch { /* لا قفل */ }
}

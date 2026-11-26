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
import { clearBackupSecretForReset } from './backupPassword';
import { slotDir } from './accountSlots';
import { getSyncState } from '../sync/engine';
import { disableLock } from './appLockService';
import { cancelAllNotifications } from './notifications';

export async function resetDeviceData(db: AppDB): Promise<void> {
  // سرّ نسخ الحساب الذي يُفرَّغ (لكل حسابٍ سرّه · المدقق الخارجي D١) · يُقرأ قبل أن تُحذف القاعدة
  let account: string | null = null;
  try { account = getSyncState(db, 'uid'); } catch { account = null; }
  await cancelAllNotifications();
  const root = appDataRoot();
  // حسابٌ آخر مركونٌ على الجهاز (accountSlots.ts) يبقى له سرّ الجهاز القديم (H٤) · وتعذّر الفحص يُبقيه
  let others = true;
  try {
    const dir = joinPath(root, 'accounts');
    const mine = account ? slotDir({ root }, account).split('/').pop() : null;
    others = expoFs.exists(dir) && expoFs.list(dir).some((n) => n !== mine && expoFs.exists(joinPath(dir, n, 'aqari.db')));
  } catch { others = true; }
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
  try { await clearBackupSecretForReset(account, !others); } catch { /* لا سرّ */ }
  try { await disableLock(); } catch { /* لا قفل */ }
}

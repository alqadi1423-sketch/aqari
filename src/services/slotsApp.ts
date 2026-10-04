/**
 * نُسخ الحسابات على الجهاز فوق القرص الحقيقي (src/services/accountSlots.ts)
 */
import type { AppDB } from '../db/expoAdapter';
import { appDataRoot, expoFs } from '../files/expoFs';
import { migrate } from '../db/migrations';
import { seed, ensureDeviceId } from '../db/seed';
import type { SlotEnv } from './accountSlots';

const plain = (p: string) => p.replace(/^file:\/\//, '');

export function appSlotEnv(db: AppDB): SlotEnv {
  return {
    fs: expoFs,
    root: appDataRoot(),
    dbFile: 'file://' + plain(db.databasePath),
    db: () => db,
    close: () => { try { db.close(); } catch { /* مغلقة */ } },
    // النسخة المركونة قد تكون بإصدار أقدم · تُرقّى عند فتحها
    reopen: () => { db.reopen(); migrate(db); },
    prepareFresh: (d) => { migrate(d); seed(d); ensureDeviceId(d); },
  };
}

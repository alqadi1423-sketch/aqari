/**
 * متى يُرحَّل الإهلاك الآلي (موجز الأصول §٣ب): على جهاز المالك وحده كسائر الإعمار الذي يكتب صفوفاً تُزامَن،
 * وبعد مزامنةٍ ليس عنده بعدها ما ينتظر الرفع · فجهازا المالك لا يرحّلان الشهر نفسه إلا نادراً، وإن وقع
 * ظهر التكرار في مراجعة الدفتر (duplicateDepreciation). وبلا مزامنةٍ مفعّلة يُرحَّل عند الإقلاع.
 */
import type { DB } from '../../db/adapter';
import { getSyncState, outboxCount } from '../../sync/engine';
import { runDepreciation } from './depreciation';

export function autoDepreciate(db: DB, today: string, opts: { owner: boolean; afterSync: boolean }): number {
  if (!opts.owner) return 0;
  const synced = !!getSyncState(db, 'uid');
  if (synced && (!opts.afterSync || outboxCount(db) > 0)) return 0;
  try { return runDepreciation(db, today); } catch { return 0; }
}

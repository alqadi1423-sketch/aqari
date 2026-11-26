/**
 * المراجعة الشاملة 2026-11-13 · A2.16 · منخفض · src/domain/assets/service.ts (requireOpenDate) · بيانات مصطنعة.
 *
 * ما كان: نقل الأصل أو استبعاده أو بيعه بتاريخٍ بعد اليوم يُقبل، فيرحّل depreciateAssetTo إهلاك ما بين اليوم والتاريخ المقبل (ومعه الشهر
 * الجاري كله) في قيدٍ واحد بالتاريخ المقبل، ثم يتخطاه التشغيل الشهري.
 * الإصلاح: رفض تاريخٍ بعد اليوم برسالة، ولا يُكتب شيء.
 * الأرقام الذهبية: مكيف ٨٤٠٫٠٠ (قسطه الشهري ١٠٫٠٠) اشتُري 2026-01-05، واليوم 2026-04-20 · عمليةٌ بتاريخ 2026-06-20 مرفوضة، وبتاريخ
 * اليوم تُقبل: إهلاك فبراير ومارس ٢٠٫٠٠ ثم أيام أبريل حتى العملية.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit } from './helpers/fixtures';
import { createPendingAsset, setAssetCost, transferAsset, disposeAsset, sellAsset } from '@/domain/assets/service';
import { integrityChecks } from '@/domain/accounting/integrity';
import { initI18n } from '@/i18n';
import type { DB } from '@/db/adapter';

beforeAll(() => { initI18n('ar'); });

const TODAY = '2026-04-20';
const FUTURE = '2026-06-20';
const writes = (db: DB) => Number(db.get<{ n: number }>(
  `SELECT (SELECT COUNT(*) FROM journal_entries) + (SELECT COUNT(*) FROM asset_events) AS n`)!.n);
function world() {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار أصل مقبل مصطنع' });
  const ua = addUnit(db, p, { unit_no: 'F-1' });
  const ub = addUnit(db, p, { unit_no: 'F-2' });
  const a = createPendingAsset(db, { name: 'مكيف مقبل مصطنع', category: '1410', unitId: ua });
  setAssetCost(db, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  return { db, a, ub };
}

test.each([
  ['النقل', (w: ReturnType<typeof world>, d: string) => transferAsset(w.db, w.a, { unitId: w.ub, date: d, today: TODAY })],
  ['الاستبعاد', (w: ReturnType<typeof world>, d: string) => disposeAsset(w.db, w.a, { date: d, reason: 'تلف مصطنع', today: TODAY })],
  ['البيع', (w: ReturnType<typeof world>, d: string) => sellAsset(w.db, w.a, { date: d, amountHalalas: 50000, method: 'cash', today: TODAY })],
])('A2.16 %s بتاريخٍ بعد اليوم مرفوض ولا يكتب شيئاً · وبتاريخ اليوم يُقبل', (_n, run) => {
  const w = world();
  const before = writes(w.db);
  expect(() => run(w, FUTURE)).toThrow(/بعد اليوم/);
  expect(writes(w.db)).toBe(before);
  run(w, TODAY);
  expect(writes(w.db)).toBeGreaterThan(before);
  expect(integrityChecks(w.db).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  w.db.close();
});

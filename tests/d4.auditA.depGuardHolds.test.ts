/**
 * اختبارات المدقق الخارجي أُبقيت حارساً بعد إصلاح ما أثبتته (التوجيه الرابع ٣ · الجولة الأولى) ·
 * مدقق خارجي (أ) · حارس الإهلاك: تسلسلاتٌ مشروعة يجب أن تُقبل (ما صمد) · بيانات مصطنعة.
 */
import { createPendingAsset, setAssetCost, transferAsset, disposeAsset } from '@/domain/assets/service';
import { runDepreciation } from '@/domain/assets/depreciation';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, has, reasonOf, srcAsMember } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار صمود أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار صمود ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'HD-A' });
  const ub = addUnit(p.owner, pa, { unit_no: 'HD-B' });
  const uc = addUnit(p.owner, pb, { unit_no: 'HD-C' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub, uc };
}
type S = Awaited<ReturnType<typeof setup>>;
async function pulls(owner: DB, r: MemoryRemote, n = 4) { for (let i = 0; i < n; i++) await sync(owner, r); }
async function costed(s: S, unit: string) {
  const a = createPendingAsset(s.dev, { name: 'جهاز صمود مصطنع', category: '1410', unitId: unit });
  setAssetCost(s.dev, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  await sync(s.dev, s.r);
  await pulls(s.owner, s.r);
  return a;
}
const ALL = /^(depreciation|asset_dep|asset_transfer|asset_dispose|asset_sell)$/;
const allAccepted = (s: S, ids: string[]) => ids.map((k) => [s.r.docs.get('journal_entries__' + k)?.d?.src_type, has(s.owner, k), reasonOf(s.owner, k)]);

describe('مدقق أ · حارس الإهلاك · ما صمد', () => {
  test('نقلان بتاريخين معكوسين في الشهر نفسه، ثم أشهرٌ بعدهما، يصلان معاً بترتيبٍ معكوس', async () => {
    const s = await setup();
    const a = await costed(s, s.ua);
    transferAsset(s.dev, a, { unitId: s.ub, date: '2026-05-10', today: '2026-05-12' });
    transferAsset(s.dev, a, { unitId: s.uc, date: '2026-05-05', today: '2026-05-12' });
    runDepreciation(s.dev, '2026-08-02');
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, ALL);
    // ترتيب الوارد معكوس: الأحدث أولاً
    const docs = ids.map((k) => s.r.docs.get('journal_entries__' + k)!);
    docs.forEach((d, i) => s.r.inject({ ...d, u: new Date(Date.UTC(2026, 0, 1) + (docs.length - i) * 1000).toISOString() }));
    await pulls(s.owner, s.r, 6);
    for (const x of allAccepted(s, ids)) expect(x.slice(1)).toEqual([true, '']);
    s.close();
  });

  test('نقلٌ بتاريخٍ مقبل ثم استبعادٌ قبله · والوارد على دفعات (كل قيدٍ في سحبٍ وحده بترتيب الرفع)', async () => {
    const s = await setup();
    const a = await costed(s, s.ua);
    transferAsset(s.dev, a, { unitId: s.uc, date: '2026-06-20', today: '2026-04-20' });
    runDepreciation(s.dev, '2026-06-02');
    disposeAsset(s.dev, a, { date: '2026-06-10', reason: 'تلف صمود مصطنع', today: '2026-06-12' });
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, ALL);
    const held = ids.map((k) => s.r.docs.get('journal_entries__' + k)!);
    for (const d of held) s.r.docs.delete(d.id);
    for (const d of held) { s.r.inject(d); await pulls(s.owner, s.r, 2); }
    await pulls(s.owner, s.r, 4);
    for (const x of allAccepted(s, ids)) expect(x.slice(1)).toEqual([true, '']);
    s.close();
  });
});

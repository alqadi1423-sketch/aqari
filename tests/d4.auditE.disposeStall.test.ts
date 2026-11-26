/**
 * مدقق خارجي (هـ) · الجولة الثالثة · الاستبعاد والبيع ينتظران «ما دام في الوارد نقلٌ أو حدث نقلٍ بلا قيدٍ هنا» (deriveSources.ts ·
 * asset_dispose/asset_sell · 1f21568) · بيانات مصطنعة.
 * الانتظار بلا شرط: لا يسأل هل النقل المنتظر مشهودٌ أو ممكن، ولا هل لحدث النقل قيدٌ سيصل · فقيد «نقلٍ» معلَّق بلا حدث (أو «عكس نقلٍ»
 * بلا أصل)، أو حدث نقلٍ يسمّي قيداً لا يصل، يحبس استبعاد الأصل المشروع:
 *  (١) قيد نقلٍ معلَّق بلا حدث كُتب بعد الاستبعاد: ينتظران معاً، ثم يُرفضان لطول الانتظار، ثم يُعادان على التجربة كل دورة بترتيب
 *      وقتهما فيرى الاستبعادُ النقلَ في الوارد دائماً · فلا يُطبَّق أبداً.
 *  (٢) حدث نقلٍ يسمّي قيداً لا يصل (transferOut): الاستبعاد ينتظر إلى الأبد.
 * وفي 381460e كان الانتظار «pending» لا يحبس قيداً طابق موضعه، فيُقبل الاستبعاد في السحب الأول.
 */
import { createPendingAsset, setAssetCost, disposeAsset } from '@/domain/assets/service';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, has, reasonOf, net, srcAsMember, forge, MEMBER } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار حبس هـ أ مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'DS-A' });
  const ub = addUnit(p.owner, pa, { unit_no: 'DS-B' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, ua, ub };
}
type S = Awaited<ReturnType<typeof setup>>;
async function pulls(owner: DB, r: MemoryRemote, n = 3) { for (let i = 0; i < n; i++) await sync(owner, r); }
const ASSET_SRC = /^(asset_cost|asset_catchup|depreciation|asset_dep|asset_transfer|asset_dispose)$/;
/** ثلاثون يوماً وعشرون محاولة لكل ما في الوارد (كما في review8.syncTimes وd4.auditC.bankTx) */
const monthPasses = (db: DB) => db.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);

/** أصلٌ في A بتكلفته يقبله المالك، ثم يستبعده العضو في A · يعيد معرّفه وقيد استبعاده */
async function costedThenDisposed(s: S) {
  const a = createPendingAsset(s.dev, { name: 'سخان حبس مصطنع', category: '1410', unitId: s.ua });
  setAssetCost(s.dev, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  await sync(s.dev, s.r);
  srcAsMember(s.r, ASSET_SRC);
  await pulls(s.owner, s.r);
  expect(net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, s.ua])).toBe(84000);
  disposeAsset(s.dev, a, { date: '2026-03-10', reason: 'تالف حبس مصطنع', today: '2026-03-10' });
  await sync(s.dev, s.r);
  srcAsMember(s.r, ASSET_SRC);
  const end = s.dev.get<{ e: string }>(`SELECT end_entry_id AS e FROM assets WHERE id = ?`, [a])!.e;
  return { a, end };
}

describe('مدقق هـ · الاستبعاد المحبوس', () => {
  test('(١) قيد نقلٍ معلَّق بلا حدث بعد الاستبعاد: يُطبَّق الاستبعاد المشروع بعد رفض المعلَّق', async () => {
    const s = await setup();
    const { a, end } = await costedThenDisposed(s);
    // قيدٌ «asset_transfer» معلَّق لا حدث له (لا يُقبل أبداً) · سطوره تكلفة الأصل من A إلى B
    const base = s.r.docs.get('journal_entries__' + end)!;
    const dim = (u: string) => ({ asset_id: a, unit_id: u, property_id: s.pa, contract_id: null, cost_center_id: null });
    const dangling = forge(base, { src_type: 'asset_transfer', lines: [
      { account_code: '1410', descr: 'مصطنع', debit_halalas: 84000, credit_halalas: 0, ...dim(s.ub) },
      { account_code: '1410', descr: 'مصطنع', debit_halalas: 0, credit_halalas: 84000, ...dim(s.ua) },
    ] as never });
    s.r.inject({ ...dangling, d: { ...dangling.d, src_id: a, date: '2026-03-12' } } as RemoteDoc);
    await pulls(s.owner, s.r);
    const before = { disposal: has(s.owner, end), waiting: !!s.owner.get(`SELECT 1 FROM sync_inbox WHERE pk = ?`, [end]) };
    // يمضي الشهر: يُرفض المعلَّق لطول انتظاره (وهو لا يصل أبداً) · ثم دوراتٌ عادية
    monthPasses(s.owner);
    await pulls(s.owner, s.r, 1);
    await pulls(s.owner, s.r, 4);
    const out = { before, disposal: has(s.owner, end), why: reasonOf(s.owner, end), dangling: [has(s.owner, dangling.k), reasonOf(s.owner, dangling.k)],
      unitA: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, s.ua]), memberUnitA: net(s.dev, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, s.ua]) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(has(s.owner, dangling.k)).toBe(false);
    // الاستبعاد مشروعٌ ومطابق: يُطبَّق، فلا تكلفة للمستبعَد في A كما عند العضو
    expect(out.disposal).toBe(true);
    expect(out.unitA).toBe(out.memberUnitA);
    s.close();
  });

  test('(٢) حدث نقلٍ يسمّي قيداً لا يصل: الاستبعاد المشروع يُطبَّق', async () => {
    const s = await setup();
    const { a, end } = await costedThenDisposed(s);
    const ev0 = [...s.r.docs.values()].find((d) => d.t === 'asset_events' && d.d?.asset_id === a)!;
    s.r.inject({ ...ev0, id: 'asset_events__ev-ghost-e', k: 'ev-ghost-e', by: MEMBER, op: 'assets',
      d: { ...ev0.d, id: 'ev-ghost-e', asset_id: a, kind: 'transfer', date: '2026-03-12', entry_id: 'ghost-entry-e', from_unit_id: s.ua, to_unit_id: s.ub, note: '' } } as RemoteDoc);
    await pulls(s.owner, s.r);
    monthPasses(s.owner);
    await pulls(s.owner, s.r, 5);
    const out = { disposal: has(s.owner, end), why: reasonOf(s.owner, end), inbox: !!s.owner.get(`SELECT 1 FROM sync_inbox WHERE pk = ?`, [end]),
      unitA: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, s.ua]) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(out.disposal).toBe(true);
    expect(out.unitA).toBe(0);
    s.close();
  });
});

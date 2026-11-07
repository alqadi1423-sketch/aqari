/**
 * مدقق خارجي (ج) · الجولة الثانية · فحص الأصل المنتهي في قيد النقل (deriveSources.ts · asset_transfer · ح٥ في 825f162) · بيانات مصطنعة.
 * الإصلاح يقبل النقل إن انتهى موضعه «بعد ما في الوارد من نقلٍ يشهد له حدثه» · والوارد لم يُفحص بعد، والحدث يكتبه العضو ولا يفحصه
 * جهاز المالك (لا فحص لـ asset_events في engine.ts) · فبعد تطبيق الاستبعاد:
 *  (١) نقلٌ B→C مع نقلٍ C→B «مشهود» يُرفض حين يأتي دوره: يُقبل الأول، فتكلفة أصلٍ مستبعَد تخرج من وحدة استبعاده إلى عقارٍ آخر وتبقى B سالبة.
 *  (٢) نقلان مشهودان B→C ثم C→B بعد الاستبعاد: يُقبلان معاً («نقلٌ بعد الاستبعاد يُرفض» في تعليق الحالة نفسها).
 */
import { createPendingAsset, setAssetCost, disposeAsset } from '@/domain/assets/service';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, has, reasonOf, net, srcAsMember, MEMBER } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار انتهاء أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار انتهاء ب مصطنع' });
  const ub = addUnit(p.owner, pa, { unit_no: 'EL-B' });
  const uc = addUnit(p.owner, pb, { unit_no: 'EL-C' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ub, uc };
}
type S = Awaited<ReturnType<typeof setup>>;
async function pulls(owner: DB, r: MemoryRemote, n = 3) {
  for (let i = 0; i < n; i++) await sync(owner, r);
}
const ASSET_SRC = /^(asset_cost|asset_catchup|depreciation|asset_dep|asset_transfer|asset_dispose)$/;

/** أصلٌ في B بتكلفته، ثم مستبعَدٌ في B · كلها من العضو ويقبلها المالك */
async function disposedAtB(s: S) {
  const a = createPendingAsset(s.dev, { name: 'مولد انتهاء مصطنع', category: '1410', unitId: s.ub });
  setAssetCost(s.dev, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  disposeAsset(s.dev, a, { date: '2026-03-10', reason: 'تالف مصطنع', today: '2026-03-10' });
  await sync(s.dev, s.r);
  srcAsMember(s.r, ASSET_SRC);
  await pulls(s.owner, s.r);
  const end = s.owner.get<{ e: string }>(`SELECT end_entry_id AS e FROM assets WHERE id = ?`, [a])!.e;
  expect(has(s.owner, end)).toBe(true);
  expect(net(s.owner, '1410', 'l.asset_id = ?', [a])).toBe(0);
  return { a, end };
}

/** قيد نقلٍ مزوَّر بشكل transferAsset وحدثه · المجمع ما رُحِّل هنا قبل الاستبعاد (ledgerOf: الاستبعاد لا يُحسب «قبل») */
function forgeTransfer(s: S, a: string, end: string, k: string, from: { u: string; p: string }, to: { u: string; p: string }, date: string,
  srcId = a): { entry: RemoteDoc; event: RemoteDoc } {
  const accum = -net(s.owner, '1490', 'l.asset_id = ? AND e.id != ?', [a, end]);
  const base = s.r.docs.get('journal_entries__' + end)!;
  const dim = (x: { u: string; p: string }) => ({ unit_id: x.u, property_id: x.p, contract_id: null, asset_id: a, cost_center_id: null });
  const lines = [
    { account_code: '1410', descr: 'مصطنع', debit_halalas: 84000, credit_halalas: 0, ...dim(to) },
    { account_code: '1410', descr: 'مصطنع', debit_halalas: 0, credit_halalas: 84000, ...dim(from) },
    { account_code: '1490', descr: 'مصطنع', debit_halalas: accum, credit_halalas: 0, ...dim(from) },
    { account_code: '1490', descr: 'مصطنع', debit_halalas: 0, credit_halalas: accum, ...dim(to) },
  ].map((l, i) => ({ ...l, id: k + '-l' + i, entry_id: k }));
  const entry = { ...base, id: 'journal_entries__' + k, k, by: MEMBER, u: new Date().toISOString(),
    d: { ...base.d, id: k, no: 'FT-' + k, src_type: 'asset_transfer', src_id: srcId, date, reversed_by: null, memo: 'نقل مصطنع' }, lines } as RemoteDoc;
  const ev0 = [...s.r.docs.values()].find((d) => d.t === 'asset_events' && d.d?.asset_id === a)!;
  const ek = 'ev-' + k;
  const event = { ...ev0, id: 'asset_events__' + ek, k: ek, by: MEMBER, op: 'assets',
    d: { ...ev0.d, id: ek, asset_id: a, kind: 'transfer', date, entry_id: k, from_unit_id: from.u, to_unit_id: to.u, note: '' } } as RemoteDoc;
  return { entry, event };
}

describe('مدقق ج · الأصل المنتهي', () => {
  test('(١) بعد تطبيق الاستبعاد في B: نقلٌ B→C ومعه نقلٌ C→B «مشهود» يُرفض بعده · تكلفة المستبعَد لا تخرج إلى C', async () => {
    const s = await setup();
    const { a, end } = await disposedAtB(s);
    const B = { u: s.ub, p: s.pa }, C = { u: s.uc, p: s.pb };
    const t1 = forgeTransfer(s, a, end, 'ft1-c', B, C, '2026-03-10');
    // الثاني يسمّي أصلاً آخر مصدراً (فيُرفض بـ noEntry حين يأتي دوره) وسطوره وحدثه للأصل نفسه
    const t2 = forgeTransfer(s, a, end, 'ft2-c', C, B, '2026-03-10', 'asset-other-c');
    for (const d of [t1.entry, t2.entry, t1.event, t2.event]) s.r.inject(d);
    await pulls(s.owner, s.r);
    const out = {
      t1: [has(s.owner, t1.entry.k), reasonOf(s.owner, t1.entry.k)], t2: [has(s.owner, t2.entry.k), reasonOf(s.owner, t2.entry.k)],
      atB: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, s.ub]),
      atC: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, s.uc]),
      propB: net(s.owner, '1410', 'l.asset_id = ? AND l.property_id = ?', [a, s.pb]),
      status: s.owner.get(`SELECT status, unit_id = ? AS atB FROM assets WHERE id = ?`, [s.ub, a]),
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    // الأصل مستبعَد في B: لا تكلفة له في أي وحدة
    expect(out.atC).toBe(0);
    expect(out.atB).toBe(0);
    s.close();
  });

  test('(٢) بعد تطبيق الاستبعاد في B: نقلان مشهودان B→C ثم C→B بتاريخٍ بعد الاستبعاد · لا يُقبل نقلٌ بعد الاستبعاد', async () => {
    const s = await setup();
    const { a, end } = await disposedAtB(s);
    const B = { u: s.ub, p: s.pa }, C = { u: s.uc, p: s.pb };
    const t1 = forgeTransfer(s, a, end, 'ft3-c', B, C, '2026-03-20');
    const t2 = forgeTransfer(s, a, end, 'ft4-c', C, B, '2026-03-25');
    for (const d of [t1.entry, t2.entry, t1.event, t2.event]) s.r.inject(d);
    await pulls(s.owner, s.r);
    const out = { t1: [has(s.owner, t1.entry.k), reasonOf(s.owner, t1.entry.k)], t2: [has(s.owner, t2.entry.k), reasonOf(s.owner, t2.entry.k)],
      cInMarch: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ? AND e.date <= ?', [a, s.uc, '2026-03-22']) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(has(s.owner, t1.entry.k)).toBe(false);
    expect(has(s.owner, t2.entry.k)).toBe(false);
    s.close();
  });
});

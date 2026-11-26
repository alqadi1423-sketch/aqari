/**
 * اختبارات المدقق الخارجي أُبقيت حارساً بعد إصلاح ما أثبتته (التوجيه الرابع ٣ · الجولة الأولى) ·
 * مدقق خارجي (أ) · حارس الإهلاك بعد 9143191 (depUnits: هنا وبعد الوارد معاً) · تسلسلاتٌ مشروعة تنتظر أو تُرفض، وتزويرٌ يمرّ ·
 * بيانات مصطنعة.
 */
import { createPendingAsset, setAssetCost, transferAsset, disposeAsset } from '@/domain/assets/service';
import { runDepreciation } from '@/domain/assets/depreciation';
import { addProperty, addUnit } from './helpers/fixtures';
import { MEMBER, pair, sync, has, reasonOf, net, srcAsMember, holdBack, forge } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار حارس أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار حارس ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'GD-A' });
  const ub = addUnit(p.owner, pa, { unit_no: 'GD-B' });
  const uc = addUnit(p.owner, pb, { unit_no: 'GD-C' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub, uc };
}
type S = Awaited<ReturnType<typeof setup>>;
async function pulls(owner: DB, r: MemoryRemote, n = 3) {
  for (let i = 0; i < n; i++) await sync(owner, r);
}
async function costed(s: S, unit: string) {
  const a = createPendingAsset(s.dev, { name: 'مكيف حارس مصطنع', category: '1410', unitId: unit });
  setAssetCost(s.dev, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  await sync(s.dev, s.r);
  await pulls(s.owner, s.r);
  return a;
}
const entryOf = (r: MemoryRemote, src: string, srcId: string, date?: string) => [...r.docs.values()].find((d) => d.t === 'journal_entries'
  && d.d?.src_type === src && d.d?.src_id === srcId && (!date || d.d?.date === date))!;
const DEPS = /^(depreciation|asset_dep|asset_transfer|asset_dispose)$/;

describe('مدقق أ · حارس الإهلاك', () => {
  test('رفعٌ على دفعات: قيد النقل وحده يتأخر عن إهلاك أبريل الشهري بوحدته الجديدة · لا يُرفض المشروع', async () => {
    const s = await setup();
    const a = await costed(s, s.ua);
    transferAsset(s.dev, a, { unitId: s.ub, date: '2026-04-16', today: '2026-04-20' });
    runDepreciation(s.dev, '2026-07-02');
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, DEPS);
    const tr = holdBack(s.r, (d) => d.t === 'journal_entries' && d.d?.src_type === 'asset_transfer');
    expect(tr.count).toBe(1);
    await pulls(s.owner, s.r);
    const apr = entryOf(s.r, 'depreciation', '2026-04').k;
    const early = reasonOf(s.owner, apr);
    tr.release();
    await pulls(s.owner, s.r);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ aprReasonBeforeTransfer: early, after: ids.map((k) => [s.r.docs.get('journal_entries__' + k)?.d?.src_type, has(s.owner, k), reasonOf(s.owner, k)]) }));
    expect(early).toBe('');
    for (const k of ids) expect([k, has(s.owner, k), reasonOf(s.owner, k)]).toEqual([k, true, '']);
    s.close();
  });

  test('تزوير · حدثُ نقلٍ مصطنع بلا قيد يُدخل إهلاكاً بوحدةٍ قديمة في عقارٍ آخر (والأصل في غيرها منذ أشهر)', async () => {
    const s = await setup();
    // الأصل في الوحدة C (العقار ب) ثم يُنقل إلى A (العقار أ) في أبريل · كلاهما مقبول عند المالك
    const a = await costed(s, s.uc);
    transferAsset(s.dev, a, { unitId: s.ua, date: '2026-04-16', today: '2026-04-20' });
    await sync(s.dev, s.r);
    srcAsMember(s.r, DEPS);
    await pulls(s.owner, s.r);
    expect(s.owner.get<{ u: string }>(`SELECT unit_id AS u FROM assets WHERE id = ?`, [a])!.u).toBe(s.ua);
    // تغيير غرفةٍ في الوحدة نفسها في يونيو (يرحّل إهلاك ما قبله بالوحدة A) · ثم يُزوَّر: القيد بوحدة C وعقارها، والحدث «من C»
    transferAsset(s.dev, a, { unitId: s.ua, room: 'غرفة مصطنعة', date: '2026-06-20', today: '2026-06-22' });
    await sync(s.dev, s.r);
    const dep = entryOf(s.r, 'asset_dep', a, '2026-06-20');
    const ev = [...s.r.docs.values()].find((d) => d.t === 'asset_events' && d.d?.date === '2026-06-20')!;
    srcAsMember(s.r, /^depreciation$/);
    s.r.inject({ ...ev, by: MEMBER, op: 'assets', d: { ...ev.d, from_unit_id: s.uc } } as RemoteDoc);
    s.r.inject({ ...dep, by: MEMBER, lines: dep.lines!.map((l) => ({ ...l, unit_id: s.uc, property_id: s.pb, contract_id: null })) });
    await pulls(s.owner, s.r);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ forgedAccepted: has(s.owner, dep.k), reason: reasonOf(s.owner, dep.k),
      depAtC_after_move: net(s.owner, '5600', 'l.unit_id = ? AND e.date > ?', [s.uc, '2026-04-16']) }));
    expect(has(s.owner, dep.k)).toBe(false);
    expect(net(s.owner, '5600', 'l.unit_id = ? AND e.date > ?', [s.uc, '2026-04-16'])).toBe(0);
    s.close();
  });

  test('تزوير · نقلٌ مزوَّر معلَّق (B إلى A) في الوارد يجعل الوحدة القديمة A «صحيحة بعد الوارد»: إهلاك أبريل المزوَّر بها يمرّ', async () => {
    const s = await setup();
    const a = await costed(s, s.ua);
    transferAsset(s.dev, a, { unitId: s.ub, date: '2026-04-16', today: '2026-04-20' });
    await sync(s.dev, s.r);
    runDepreciation(s.dev, '2026-05-02');
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^(depreciation|asset_dep|asset_transfer)$/);
    const tr = entryOf(s.r, 'asset_transfer', a);
    const apr = entryOf(s.r, 'depreciation', '2026-04');
    // إهلاك أبريل بوحدته القديمة A (كان الأصل في B طوال ما بعد 16 أبريل)
    s.r.inject({ ...apr, by: MEMBER, lines: apr.lines!.map((l) => ({ ...l, unit_id: s.ua, property_id: s.pa, contract_id: null })) });
    // نقلٌ مزوَّر من B إلى A بلا حدث: ينتظر حدثه فيبقى في الوارد
    const swap = (u: unknown) => (u === s.ua ? s.ub : u === s.ub ? s.ua : u);
    const back = forge(tr, { lines: tr.lines!.map((l) => ({ ...l, unit_id: swap(l.unit_id) as string })) });
    s.r.inject({ ...back, d: { ...back.d, date: '2026-05-20' } });
    // والنقل المشروع آخر ما يُطبَّق (كما في اختبار الإيداع نفسه)
    s.r.inject({ ...tr, u: '2026-12-31T00:00:00.000Z' });
    await pulls(s.owner, s.r);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ forgedAprAccepted: has(s.owner, apr.k), reason: reasonOf(s.owner, apr.k),
      backWaiting: s.owner.get(`SELECT last_error AS e FROM sync_inbox WHERE pk = ?`, [back.k]),
      depAtA_after: net(s.owner, '5600', 'l.unit_id = ? AND e.date > ?', [s.ua, '2026-04-16']) }));
    expect(has(s.owner, apr.k)).toBe(false);
    expect(net(s.owner, '5600', 'l.unit_id = ? AND e.date > ?', [s.ua, '2026-04-16'])).toBe(0);
    s.close();
  });

  test('تراجع · قيد نقلٍ معلَّق في الوارد (لا يُطبَّق ولا يُرفض قبل ٣٠ يوماً) يحبس إهلاك الأصل المشروع بوحدته الصحيحة', async () => {
    const s = await setup();
    const a = await costed(s, s.ua);
    runDepreciation(s.dev, '2026-03-02');
    await sync(s.dev, s.r);
    const feb = srcAsMember(s.r, /^depreciation$/);
    await pulls(s.owner, s.r);
    expect(feb.every((k) => has(s.owner, k))).toBe(true);
    // قيد نقلٍ من A إلى C بلا حدثٍ يسمّيه (عضوٌ عابث، أو حدثٌ لم يُرفع): ينتظر في الوارد
    const base = entryOf(s.r, 'depreciation', '2026-02');
    const cost = 84000;
    const dangling = forge(base, { src_type: 'asset_transfer', lines: [
      { account_code: '1410', debit_halalas: cost, credit_halalas: 0, asset_id: a, unit_id: s.uc, property_id: s.pb, contract_id: null },
      { account_code: '1410', debit_halalas: 0, credit_halalas: cost, asset_id: a, unit_id: s.ua, property_id: s.pa, contract_id: null },
    ] as never });
    s.r.inject({ ...dangling, d: { ...dangling.d, src_id: a, date: '2026-03-10' } });
    // إهلاك مارس المشروع بوحدة الأصل A (لم يتحرك الأصل)
    runDepreciation(s.dev, '2026-04-02');
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^depreciation$/);
    const mar = entryOf(s.r, 'depreciation', '2026-03').k;
    await pulls(s.owner, s.r);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ marchAccepted: has(s.owner, mar), marchInbox: s.owner.get(`SELECT last_error AS e, attempts AS n FROM sync_inbox WHERE pk = ?`, [mar]),
      danglingInbox: s.owner.get(`SELECT last_error AS e FROM sync_inbox WHERE pk = ?`, [dangling.k]) }));
    expect(has(s.owner, mar)).toBe(true);
    s.close();
  });
});

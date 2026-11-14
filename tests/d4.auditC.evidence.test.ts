/**
 * مدقق خارجي (ج) · الجولة الثانية · «النقل المشهود» (evidencedTransfer · placeOf ahead · fromOp في depUnits · 825f162) · بيانات مصطنعة.
 * إصلاحات ح١ وح٢ وح٣ تشترط لقيد النقل في الوارد حدثاً يسمّيه، أو لحدث النقل قيداً يشهد له · والشاهد كتابة عضوٍ أخرى لا يفحصها جهاز
 * المالك (asset_events بلا فحص في engine.ts)، وقيد النقل في الوارد لم يُفحص بعد · ثم إن الاستثناء لـ src_type = 'asset_transfer' وحده،
 * و'asset_transfer_rev' يُحسب في placeOf بلا شاهد. فهذه اختبارات المدقق (أ) نفسها بشاهدٍ مزوَّر أو بوسم العكس.
 */
import { createPendingAsset, setAssetCost, transferAsset } from '@/domain/assets/service';
import { runDepreciation } from '@/domain/assets/depreciation';
import { addProperty, addUnit } from './helpers/fixtures';
import { MEMBER, pair, sync, has, reasonOf, net, srcAsMember, forge } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار شاهد أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار شاهد ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'EV-A' });
  const ub = addUnit(p.owner, pa, { unit_no: 'EV-B' });
  const uc = addUnit(p.owner, pb, { unit_no: 'EV-C' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub, uc };
}
type S = Awaited<ReturnType<typeof setup>>;
async function pulls(owner: DB, r: MemoryRemote, n = 3) {
  for (let i = 0; i < n; i++) await sync(owner, r);
}
async function costed(s: S, unit: string) {
  const a = createPendingAsset(s.dev, { name: 'مكيف شاهد مصطنع', category: '1410', unitId: unit });
  setAssetCost(s.dev, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  await sync(s.dev, s.r);
  srcAsMember(s.r, /^(asset_cost|asset_catchup)$/);
  await pulls(s.owner, s.r);
  return a;
}
const entryOf = (r: MemoryRemote, src: string, srcId: string, date?: string) => [...r.docs.values()].find((d) => d.t === 'journal_entries'
  && d.d?.src_type === src && d.d?.src_id === srcId && (!date || d.d?.date === date))!;
/** حدث نقلٍ مزوَّر للأصل يسمّي قيداً · على مثال حدثٍ في الحساب */
function forgedEvent(r: MemoryRemote, a: string, k: string, entryId: string, from: string, to: string, date: string): RemoteDoc {
  const ev0 = [...r.docs.values()].find((d) => d.t === 'asset_events' && d.d?.asset_id === a)!;
  return { ...ev0, id: 'asset_events__' + k, k, by: MEMBER, op: 'assets',
    d: { ...ev0.d, id: k, asset_id: a, kind: 'transfer', date, entry_id: entryId, from_unit_id: from, to_unit_id: to, note: '' } } as RemoteDoc;
}

describe('مدقق ج · ح٢ بشاهدٍ مزوَّر: إهلاك أبريل بالوحدة القديمة A يمرّ', () => {
  async function scenario(label: 'event' | 'rev') {
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
    const swap = (u: unknown) => (u === s.ua ? s.ub : u === s.ub ? s.ua : u);
    if (label === 'event') {
      // نقلٌ مزوَّر B→A ومعه حدثٌ مزوَّر يسمّيه (الشاهد)
      const back = forge(tr, { lines: tr.lines!.map((l) => ({ ...l, unit_id: swap(l.unit_id) as string })) });
      s.r.inject({ ...back, d: { ...back.d, date: '2026-05-20' } });
      s.r.inject(forgedEvent(s.r, a, 'ev-back-c', back.k, s.ub, s.ua, '2026-05-20'));
    } else {
      // «عكس نقلٍ» مزوَّر B→A بلا حدث: الإصلاح يستثني src_type = 'asset_transfer' وحده
      const back = forge(tr, { src_type: 'asset_transfer_rev', lines: tr.lines!.map((l) => ({ ...l, unit_id: swap(l.unit_id) as string })) });
      s.r.inject({ ...back, d: { ...back.d, date: '2026-05-20' } });
    }
    // والنقل المشروع آخر ما يُطبَّق (كما في اختبار المدقق أ)
    s.r.inject({ ...tr, u: '2026-12-31T00:00:00.000Z' });
    await pulls(s.owner, s.r);
    const out = { label, forgedAprAccepted: has(s.owner, apr.k), reason: reasonOf(s.owner, apr.k),
      depAtA_after: net(s.owner, '5600', 'l.unit_id = ? AND e.date > ?', [s.ua, '2026-04-16']) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(has(s.owner, apr.k)).toBe(false);
    expect(out.depAtA_after).toBe(0);
    s.close();
  }
  test('نقلٌ مزوَّر B→A مع حدثٍ مزوَّر يشهد له', () => scenario('event'));
  test('«asset_transfer_rev» مزوَّر B→A بلا حدث', () => scenario('rev'));
});

describe('مدقق ج · ح٣ بقيدٍ يشهد للحدث المزوَّر: إهلاك العملية بوحدةٍ قديمة في عقارٍ آخر', () => {
  test('حدث نقلٍ «من C» يوم العملية ومعه قيد نقلٍ C→A يشهد له (يُرفض بعده) · إهلاك اليوم بوحدة C يمرّ', async () => {
    const s = await setup();
    // الأصل في C (العقار ب) ثم يُنقل إلى A (العقار أ) في أبريل · كلاهما مقبول عند المالك
    const a = await costed(s, s.uc);
    transferAsset(s.dev, a, { unitId: s.ua, date: '2026-04-16', today: '2026-04-20' });
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^(depreciation|asset_dep|asset_transfer)$/);
    await pulls(s.owner, s.r);
    expect(s.owner.get<{ u: string }>(`SELECT unit_id AS u FROM assets WHERE id = ?`, [a])!.u).toBe(s.ua);
    // تغيير غرفةٍ في الوحدة نفسها في يونيو (يرحّل إهلاك ما قبله بالوحدة A وحدثاً من A إلى A)
    transferAsset(s.dev, a, { unitId: s.ua, room: 'غرفة مصطنعة', date: '2026-06-20', today: '2026-06-22' });
    await sync(s.dev, s.r);
    const dep = entryOf(s.r, 'asset_dep', a, '2026-06-20');
    srcAsMember(s.r, /^depreciation$/);
    // التزوير: قيد نقلٍ C→A بتكلفة الأصل (يُرفض حين يأتي دوره: C لا تحمل التكلفة) وحدثٌ «من C» يسمّيه، وإهلاك اليوم بوحدة C وعقارها
    const tr = entryOf(s.r, 'asset_transfer', a);
    const fake = forge(tr, { lines: tr.lines! });
    s.r.inject({ ...fake, d: { ...fake.d, date: '2026-06-20' } });
    s.r.inject(forgedEvent(s.r, a, 'ev-fake-c', fake.k, s.uc, s.ua, '2026-06-20'));
    s.r.inject({ ...dep, by: MEMBER, lines: dep.lines!.map((l) => ({ ...l, unit_id: s.uc, property_id: s.pb, contract_id: null })) });
    await pulls(s.owner, s.r);
    const out = { forgedAccepted: has(s.owner, dep.k), reason: reasonOf(s.owner, dep.k), fake: [has(s.owner, fake.k), reasonOf(s.owner, fake.k)],
      depAtC_after_move: net(s.owner, '5600', 'l.unit_id = ? AND e.date > ?', [s.uc, '2026-04-16']) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(has(s.owner, dep.k)).toBe(false);
    expect(out.depAtC_after_move).toBe(0);
    s.close();
  });
});

describe('مدقق ج · ح١ بوسم العكس: «asset_transfer_rev» معلَّق يحبس إهلاك الأصل المشروع', () => {
  test('عكس نقلٍ مزوَّر بلا أصلٍ ولا حدث في الوارد: إهلاك مارس المشروع بوحدته يُقبل', async () => {
    const s = await setup();
    const a = await costed(s, s.ua);
    runDepreciation(s.dev, '2026-03-02');
    await sync(s.dev, s.r);
    const feb = srcAsMember(s.r, /^depreciation$/);
    await pulls(s.owner, s.r);
    expect(feb.every((k) => has(s.owner, k))).toBe(true);
    const base = entryOf(s.r, 'depreciation', '2026-02');
    const cost = 84000;
    const dangling = forge(base, { src_type: 'asset_transfer_rev', lines: [
      { account_code: '1410', debit_halalas: cost, credit_halalas: 0, asset_id: a, unit_id: s.uc, property_id: s.pb, contract_id: null },
      { account_code: '1410', debit_halalas: 0, credit_halalas: cost, asset_id: a, unit_id: s.ua, property_id: s.pa, contract_id: null },
    ] as never });
    s.r.inject({ ...dangling, d: { ...dangling.d, src_id: a, date: '2026-03-10' } });
    runDepreciation(s.dev, '2026-04-02');
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^depreciation$/);
    const mar = entryOf(s.r, 'depreciation', '2026-03').k;
    await pulls(s.owner, s.r);
    const out = { marchAccepted: has(s.owner, mar), marchInbox: s.owner.get(`SELECT last_error AS e, attempts AS n FROM sync_inbox WHERE pk = ?`, [mar]),
      danglingInbox: s.owner.get(`SELECT last_error AS e FROM sync_inbox WHERE pk = ?`, [dangling.k]) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(has(s.owner, mar)).toBe(true);
    s.close();
  });
});

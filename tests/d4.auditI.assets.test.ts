/**
 * مدقق خارجي (I) · الجولة الخامسة · إصلاحا O١ (originUnits) وR١ (memberReversalCheck) على 662e4ae · بيانات مصطنعة.
 *  - originUnits يقبل حدث النقل إن «شهد» له قيدٌ هنا أو في الوارد بسطور حساب الفئة ووحدتيه · ولا يسأل عن مصدر ذلك القيد ولا هل
 *    سيُطبَّق: قيدٌ مزوَّر في الوارد يُرفض بعد أن يُقبل به قيد التكلفة بأبعاد عقارٍ آخر.
 *  - حارس عكس النقل يسأل الوارد عن حدثٍ «deleted_at فيه فارغ» · وجدول asset_events لا عمود حذفٍ فيه: حدثٌ بحقل deleted_at مملوء
 *    يتخطى الحارس ثم يُطبَّق كاملاً (الحقل الزائد يُسقط).
 */
import { createPendingAsset, setAssetCost, transferAsset } from '@/domain/assets/service';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls, has, reasonOf, net, srcAsMember, forge, mirrorOf, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const p1 = addProperty(p.owner, { name: 'عقار العضو I مصطنع' });
  const p2 = addProperty(p.owner, { name: 'عقار آخر I مصطنع' });
  const ua = addUnit(p.owner, p1, { unit_no: 'IU-A' });
  const ux = addUnit(p.owner, p2, { unit_no: 'IU-X' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, p1, p2, ua, ux };
}
const allAsMember = (r: MemoryRemote) => {
  for (const d of [...r.docs.values()]) {
    if (d.by === MEMBER) continue;
    const { ts: _t, ...doc } = d as RemoteDoc & { ts: string };
    r.inject({ ...doc, by: MEMBER, op: 'assets' } as RemoteDoc);
  }
};

test('مدقق I · (O1b) تكلفة أصلٍ في A بأبعاد X وحدثُ نقلٍ من X يشهد له قيد نقلٍ مزوَّر في الوارد (يُرفض بعدها): يُقبل قيد التكلفة', async () => {
  const s = await setup();
  const a = createPendingAsset(s.dev, { name: 'مكيف شاهد I مصطنع', category: '1410', unitId: s.ua });
  await sync(s.dev, s.r);
  allAsMember(s.r);
  await ownerPulls(s.owner, s.r);
  setAssetCost(s.dev, a, { costHalalas: 120000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  await sync(s.dev, s.r);
  allAsMember(s.r);
  const cost = [...s.r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'asset_cost')!;
  // قيد التكلفة بأبعاد X (عقارٍ آخر)
  s.r.inject({ ...cost, lines: cost.lines!.map((l) => (l.asset_id ? { ...l, unit_id: s.ux, property_id: s.p2, contract_id: null } : l)) } as RemoteDoc);
  // «شاهد»: قيد نقلٍ مرحّل يخرج التكلفة من X ويدخلها A على حساب الفئة · مصدره أصلٌ آخر فيُرفض حين يُفحص (بعد قيد التكلفة)
  const lines = cost.lines!.filter((l) => l.account_code === '1410');
  const amount = Number(lines[0].debit_halalas);
  const fake = forge(cost, {
    k: 'zz-fake-transfer', src_type: 'asset_transfer', lines: [
      { ...lines[0], account_code: '1410', debit_halalas: 0, credit_halalas: amount, unit_id: s.ux, property_id: s.p2, contract_id: null },
      { ...lines[0], account_code: '1410', debit_halalas: amount, credit_halalas: 0, unit_id: s.ua, property_id: s.p1, contract_id: null },
    ],
  });
  s.r.inject({ ...fake, op: 'assets', d: { ...fake.d, src_id: 'another-asset-I', date: '2026-01-04' } } as RemoteDoc);
  // وحدث نقلٍ من X إلى A يسمّيه
  const ev0 = [...s.r.docs.values()].find((d) => d.t === 'asset_events' && d.d?.asset_id === a)!;
  s.r.inject({ ...ev0, id: 'asset_events__ev-i-o1b', k: 'ev-i-o1b', by: MEMBER, op: 'assets',
    d: { ...ev0.d, id: 'ev-i-o1b', asset_id: a, kind: 'transfer', date: '2026-01-04', entry_id: fake.k, from_unit_id: s.ux, to_unit_id: s.ua, note: '' } } as RemoteDoc);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const out = {
    cost: [has(s.owner, cost.k), reasonOf(s.owner, cost.k).slice(0, 60)], fake: [has(s.owner, fake.k), reasonOf(s.owner, fake.k).slice(0, 60)],
    inX: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, s.ux]), inA: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, s.ua]),
    p2Capital: net(s.owner, '3100', 'l.property_id = ?', [s.p2]),
    rowUnit: s.owner.get<{ u: string }>(`SELECT unit_id AS u FROM assets WHERE id = ?`, [a])?.u === s.ua,
  };
  // eslint-disable-next-line no-console
  console.log('O1b', JSON.stringify(out));
  // الأصل لم يكن في X قط: لا تكلفة له فيها، ولا رأس مال لعقار X
  expect(out.inX).toBe(0);
  s.close();
});

test('مدقق I · (R1b) نقلٌ وحدثه (بحقل deleted_at مملوء) وعاكسٌ مزوَّر يصلون معاً: يتخطى العاكسُ الحارسَ ويُطبَّق الحدث', async () => {
  const s = await pair();
  const pa = addProperty(s.owner, { name: 'عقار عكس I أ مصطنع' });
  const pb = addProperty(s.owner, { name: 'عقار عكس I ب مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'IR-A' });
  const ub = addUnit(s.owner, pb, { unit_no: 'IR-B' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const a = createPendingAsset(s.dev, { name: 'مكيف عكس I مصطنع', category: '1410', unitId: ua });
  setAssetCost(s.dev, a, { costHalalas: 120000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  await sync(s.dev, s.r);
  srcAsMember(s.r, /^asset_/);
  await ownerPulls(s.owner, s.r);
  expect(net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, ua])).toBe(120000);
  transferAsset(s.dev, a, { unitId: ub, date: '2026-04-16', today: '2026-04-20' });
  await sync(s.dev, s.r);
  srcAsMember(s.r, /^(asset_|depreciation)/);
  for (const d of [...s.r.docs.values()].filter((x) => x.t === 'asset_events' || x.t === 'assets')) {
    // الحدث بحقلٍ زائد deleted_at (لا عمود له في asset_events، فيُسقطه التطبيق)
    const extra = d.t === 'asset_events' && d.d?.kind === 'transfer' ? { deleted_at: '2026-04-16T00:00:00.000Z' } : {};
    s.r.inject({ ...d, by: MEMBER, op: 'assets', d: { ...d.d, ...extra } } as RemoteDoc);
  }
  const t = [...s.r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'asset_transfer')!;
  const rev = forge(t, { src_type: 'asset_transfer_rev', lines: mirrorOf(t.lines!) });
  s.r.inject({ ...rev, op: 'assets' } as RemoteDoc);
  await ownerPulls(s.owner, s.r);
  await ownerPulls(s.owner, s.r);
  const out = {
    transfer: has(s.owner, t.k), rev: [has(s.owner, rev.k), reasonOf(s.owner, rev.k).slice(0, 60)],
    event: !!s.owner.get(`SELECT 1 FROM asset_events WHERE entry_id = ?`, [t.k]), rowUnit: s.owner.get<{ u: string }>(`SELECT unit_id AS u FROM assets WHERE id = ?`, [a])?.u === ub,
    ledgerA: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, ua]), ledgerB: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, ub]),
  };
  // eslint-disable-next-line no-console
  console.log('R1b', JSON.stringify(out));
  expect(out.rev[0]).toBe(false);
  expect(out.ledgerB).toBe(120000);
  s.close();
});

/**
 * مدقق خارجي (G) · الجولة الرابعة · حارس عكس النقل (engine.ts · memberReversalCheck: «لا يعكس عضوٌ قيد نقل أصلٍ ما دام حدث نقله قائماً»)
 * · بيانات مصطنعة.
 * الحارس يسأل جدول asset_events المطبَّق وحده · وأحداث الأصل رتبتها بعد القيود في التطبيق (ASSET_SYNC_TABLES بعد journal_entries) ·
 * فإن وصل قيد النقل وحدثه وعاكسٌ مزوَّر له في سحبٍ واحد: يُطبَّق قيد النقل (حدثه في الوارد يشهد له)، ثم العاكس (الحدث لم يُطبَّق بعد)،
 * ثم الحدث (إنشاءٌ لا يمسّه القفل) · فتعود التكلفة في الدفتر إلى الوحدة القديمة وصفُّ الأصل وحدثه في الجديدة.
 */
import { createPendingAsset, setAssetCost, transferAsset } from '@/domain/assets/service';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls, has, reasonOf, net, srcAsMember, forge, mirrorOf, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';

test('مدقق G · (R1) نقلٌ وحدثه وعاكسٌ مزوَّر له يصلون معاً: يُرفض العاكس', async () => {
  const s = await pair();
  const pa = addProperty(s.owner, { name: 'عقار عكس G أ مصطنع' });
  const pb = addProperty(s.owner, { name: 'عقار عكس G ب مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'TR-A' });
  const ub = addUnit(s.owner, pb, { unit_no: 'TR-B' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const a = createPendingAsset(s.dev, { name: 'مكيف عكس G مصطنع', category: '1410', unitId: ua });
  setAssetCost(s.dev, a, { costHalalas: 120000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  await sync(s.dev, s.r);
  srcAsMember(s.r, /^asset_/);
  await ownerPulls(s.owner, s.r);
  expect(net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, ua])).toBe(120000);
  transferAsset(s.dev, a, { unitId: ub, date: '2026-04-16', today: '2026-04-20' });
  await sync(s.dev, s.r);
  srcAsMember(s.r, /^(asset_|depreciation)/);
  for (const d of [...s.r.docs.values()].filter((x) => x.t === 'asset_events' || x.t === 'assets')) s.r.inject({ ...d, by: MEMBER, op: 'assets' });
  const t = [...s.r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'asset_transfer')!;
  // العاكس المزوَّر يُرفع بعدها (وقت خادمٍ أحدث)
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
  console.log('R1', JSON.stringify(out));
  expect(out.rev[0]).toBe(false);
  expect(out.ledgerB).toBe(120000);
  s.close();
});

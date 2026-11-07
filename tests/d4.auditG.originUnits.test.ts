/**
 * مدقق خارجي (G) · الجولة الرابعة · originUnits (deriveSources.ts · asset_cost وpurchaseAssetForms · إصلاح هـ٦) · بيانات مصطنعة.
 * وحدات الأصل «يوم القيد» = وحدة صفّه + كل from_unit_id في أحداث نقلٍ لها entry_id · ولا يُسأل هل لذلك القيد وجود أو شاهد ·
 * وأحداث الأصل يكتبها العضو (القفل الجديد يمنع حذف القائم وتعديله، لا إنشاء جديد) · فحدثُ نقلٍ «شبح» يسمّي قيداً لا يصل يُجيز قيد
 * تكلفة الأصل (أو سطر أصل فاتورة الشراء) بأبعاد وحدةٍ في عقارٍ آخر لم يكن الأصل فيها قط.
 */
import { createPendingAsset, setAssetCost } from '@/domain/assets/service';
import { savePurchase, type PurchaseInput } from '@/domain/purchases';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls, has, reasonOf, net, MEMBER } from './helpers/rederive';
import type { RemoteDoc } from '@/sync/types';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const p1 = addProperty(p.owner, { name: 'عقار العضو G مصطنع' });
  const p2 = addProperty(p.owner, { name: 'عقار آخر G مصطنع' });
  const ua = addUnit(p.owner, p1, { unit_no: 'OU-A' });
  const ux = addUnit(p.owner, p2, { unit_no: 'OU-X' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, p1, p2, ua, ux };
}
const allAsMember = (r: MemoryRemote) => {
  for (const d of [...r.docs.values()]) {
    if (d.by === MEMBER) continue;
    const { ts: _t, ...doc } = d as RemoteDoc & { ts: string };
    r.inject({ ...doc, by: MEMBER, op: d.t === 'journal_entries' || d.t.startsWith('asset') ? 'assets' : 'purchases' } as RemoteDoc);
  }
};
/** حدث نقلٍ «شبح» من X إلى A يسمّي قيداً لا وجود له */
function ghost(r: MemoryRemote, assetId: string, from: string, to: string, k: string) {
  const ev0 = [...r.docs.values()].find((d) => d.t === 'asset_events' && d.d?.asset_id === assetId)!;
  r.inject({ ...ev0, id: 'asset_events__' + k, k, by: MEMBER, op: 'assets',
    d: { ...ev0.d, id: k, asset_id: assetId, kind: 'transfer', date: '2026-01-04', entry_id: 'ghost-entry-' + k, from_unit_id: from, to_unit_id: to, note: '' } } as RemoteDoc);
}
const toX = (s: Awaited<ReturnType<typeof setup>>) => (l: Record<string, unknown>) => (l.asset_id ? { ...l, unit_id: s.ux, property_id: s.p2, contract_id: null } : l);

describe('مدقق G · originUnits يقبل وحدةً من حدثٍ شبح', () => {
  test('(O1) تكلفة أصلٍ في A بأبعاد X (عقارٍ آخر) ومعها حدث نقلٍ شبح من X: يُرفض القيد', async () => {
    const s = await setup();
    const a = createPendingAsset(s.dev, { name: 'مكيف شبح G مصطنع', category: '1410', unitId: s.ua });
    await sync(s.dev, s.r);
    allAsMember(s.r);
    await ownerPulls(s.owner, s.r);
    setAssetCost(s.dev, a, { costHalalas: 120000, purchaseDate: '2026-01-05', today: '2026-02-01' });
    await sync(s.dev, s.r);
    allAsMember(s.r);
    const cost = [...s.r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'asset_cost')!;
    s.r.inject({ ...cost, lines: cost.lines!.map(toX(s) as never) } as RemoteDoc);
    ghost(s.r, a, s.ux, s.ua, 'ev-ghost-o1');
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    const out = { cost: [has(s.owner, cost.k), reasonOf(s.owner, cost.k).slice(0, 60)],
      inX: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, s.ux]), inA: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, s.ua]),
      p2Capital: net(s.owner, '3100', 'l.property_id = ?', [s.p2]),
      memberInA: net(s.dev, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, s.ua]) };
    // eslint-disable-next-line no-console
    console.log('O1', JSON.stringify(out));
    expect(out.inX).toBe(0);
    expect(has(s.owner, cost.k)).toBe(false);
    s.close();
  });

  test('(O2) فاتورة شراءٍ ببند أصلٍ في A وسطر أصله بأبعاد X ومعه حدثٌ شبح: يُرفض القيد', async () => {
    const s = await setup();
    s.dev.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
      ['SUP-OU', 'مورد شبح G مصطنع', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
    savePurchase(s.dev, {
      supplier: 'مورد شبح G مصطنع', date: '2026-10-05', due: '2026-11-05', category: 'صيانة', incorpItem: '', amortize: false,
      amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: s.ua, propertyId: null, meterId: null, meterReading: null,
      subtotalHalalas: 360000, taxHalalas: 0, totalHalalas: 360000,
      lines: [{ descr: 'مكيف فاتورة شبح مصطنع', qty: 1, amountHalalas: 360000, isAsset: true, category: '1410', unitId: s.ua, room: '' }],
    } as PurchaseInput);
    const a = s.dev.get<{ id: string }>(`SELECT id FROM assets`)!.id;
    await sync(s.dev, s.r);
    allAsMember(s.r);
    const pe = [...s.r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'purchase')!;
    s.r.inject({ ...pe, lines: pe.lines!.map(toX(s) as never) } as RemoteDoc);
    ghost(s.r, a, s.ux, s.ua, 'ev-ghost-o2');
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    const out = { purchase: [has(s.owner, pe.k), reasonOf(s.owner, pe.k).slice(0, 60)],
      inX: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, s.ux]), inA: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, s.ua]) };
    // eslint-disable-next-line no-console
    console.log('O2', JSON.stringify(out));
    expect(out.inX).toBe(0);
    s.close();
  });
});

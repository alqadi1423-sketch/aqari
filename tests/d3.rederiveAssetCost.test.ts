/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيد إثبات تكلفة أصلٍ بلا فاتورة (asset_cost) وقيد إهلاك ما فات لأصول فاتورة الشراء
 * (asset_catchup) من صفّ الأصل وجدول إهلاكه · قيدٌ كتبه عضو بضعف التكلفة، أو بإهلاك سنواتٍ سابقة منقولٍ إلى مصروف السنة، أو بأبعاد
 * وحدةٍ أخرى، أو لأصلٍ من فاتورة، يُرفض على جهاز المالك ولا يدخل الدفتر · وما يكتبه التطبيق يُقبل، ولو وصل إهلاك ما فات قبل قيد
 * فاتورته · بيانات مصطنعة.
 */
import { createPendingAsset, setAssetCost } from '@/domain/assets/service';
import { savePurchase, type PurchaseInput } from '@/domain/purchases';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, asMember, has, reasonOf, doubled, moved, otherDims, net, srcAsMember, holdBack, lastEntry, forge } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار تكلفة أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار تكلفة ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'AC-A' });
  const ub = addUnit(p.owner, pb, { unit_no: 'AC-B' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  p.dev.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['SUP-AC', 'مورد تكلفة مصطنع', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  return { ...p, pa, pb, ua, ub };
}
type S = Awaited<ReturnType<typeof setup>>;

async function pulls(owner: DB, r: MemoryRemote) {
  for (let i = 0; i < 3; i++) await sync(owner, r);
}

/** قطعةٌ قائمة اشتُريت في 2024 تُثبت تكلفتها في مارس 2026: إهلاك ما فات منه سنواتٌ سابقة على 3200 وشهران على 5600 */
function costOld(s: S) {
  const a = createPendingAsset(s.dev, { name: 'سخان قائم مصطنع', category: '1410', unitId: s.ua });
  setAssetCost(s.dev, a, { costHalalas: 120000, purchaseDate: '2024-06-15', today: '2026-03-10' });
  return a;
}

/** فاتورةٌ بتاريخٍ مضى ببند أصل: قيدها وإهلاك ما فات لأصلها بتاريخ اليوم */
const buyOld = (db: DB, unitId: string) => savePurchase(db, {
  supplier: 'مورد تكلفة مصطنع', date: '2025-06-15', due: '2025-07-15', category: 'صيانة', incorpItem: '', amortize: false,
  amortizeMonths: null, exempt: false, excludeFromVat: true, unitId, propertyId: null, meterId: null, meterReading: null,
  subtotalHalalas: 360000, taxHalalas: 0, totalHalalas: 360000,
  lines: [{ descr: 'مكيف قديم مصطنع', qty: 1, amountHalalas: 360000, isAsset: true, category: '1410', unitId, room: '' }],
} as PurchaseInput);

describe('إعادة اشتقاق قيدي إثبات التكلفة وإهلاك ما فات من صفّ الأصل', () => {
  test('سلبي · إثبات التكلفة بضعفها (متوازن): يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    costOld(s);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'asset_cost', doubled);
    await pulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/asset_cost/);
    expect(net(s.owner, '1410')).toBe(0);
    s.close();
  });

  test('سلبي · إهلاك السنوات السابقة منقولٌ إلى مصروف السنة، أو السطور بوحدةٍ أخرى: يُرفض', async () => {
    const s = await setup();
    costOld(s);
    await sync(s.dev, s.r);
    const k1 = asMember(s.r, 'asset_cost', moved('3200', '5600'));
    await pulls(s.owner, s.r);
    costOld(s);
    await sync(s.dev, s.r);
    const k2 = asMember(s.r, 'asset_cost', otherDims({ unit_id: s.ub, property_id: s.pb }));
    await pulls(s.owner, s.r);
    expect(has(s.owner, k1)).toBe(false);
    expect(reasonOf(s.owner, k1)).toMatch(/3200|5600/);
    expect(has(s.owner, k2)).toBe(false);
    expect(reasonOf(s.owner, k2)).toMatch(/بُعد/);
    s.close();
  });

  test('سلبي · إثبات تكلفةٍ لأصلٍ من فاتورة شراء (تكلفته في قيدها): يُرفض', async () => {
    const s = await setup();
    const pid = buyOld(s.dev, s.ua);
    await sync(s.dev, s.r);
    await pulls(s.owner, s.r);
    const asset = s.owner.get<{ id: string; cost_halalas: number }>(`SELECT id, cost_halalas FROM assets WHERE purchase_id = ?`, [pid])!;
    costOld(s);
    await sync(s.dev, s.r);
    const base = lastEntry(s.r, 'asset_cost');
    const f = forge(base, { lines: base.lines!.slice(0, 2).map((l) => ({ ...l, asset_id: asset.id })) });
    f.d = { ...f.d, src_id: asset.id };
    s.r.inject(f);
    await pulls(s.owner, s.r);
    expect(has(s.owner, f.k)).toBe(false);
    expect(reasonOf(s.owner, f.k)).toMatch(/لا يرحّل قيداً/);
    s.close();
  });

  test('سلبي · إهلاك ما فات لأصل الفاتورة بضعفه، أو بسنواته السابقة على مصروف السنة: يُرفض', async () => {
    const s = await setup();
    buyOld(s.dev, s.ua);
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^purchase$/);
    const k1 = asMember(s.r, 'asset_catchup', doubled);
    await pulls(s.owner, s.r);
    buyOld(s.dev, s.ua);
    await sync(s.dev, s.r);
    const k2 = asMember(s.r, 'asset_catchup', moved('3200', '5600'));
    await pulls(s.owner, s.r);
    expect(has(s.owner, k1)).toBe(false);
    expect(reasonOf(s.owner, k1)).toMatch(/asset_catchup/);
    expect(has(s.owner, k2)).toBe(false);
    expect(reasonOf(s.owner, k2)).toMatch(/3200|5600/);
    expect(net(s.owner, '1490')).toBe(0);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: إثبات التكلفة بإهلاك ما فات، وإهلاك ما فات لأصل فاتورةٍ وصل قبل قيدها', async () => {
    const s = await setup();
    const a = costOld(s);
    buyOld(s.dev, s.ua);
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, /^(asset_cost|asset_catchup|purchase)$/);
    expect(ids.length).toBe(3);
    const late = holdBack(s.r, (d) => d.t === 'journal_entries' && d.d?.src_type === 'purchase');
    await pulls(s.owner, s.r);
    const catchup = lastEntry(s.r, 'asset_catchup').k;
    expect(has(s.owner, catchup)).toBe(false);
    expect(reasonOf(s.owner, catchup)).toBe('');
    late.release();
    await pulls(s.owner, s.r);
    for (const k of ids) expect([k, has(s.owner, k), reasonOf(s.owner, k)]).toEqual([k, true, '']);
    // تكلفة القطعة 1200 ريال على 84 شهراً من يوليو 2024: 18 شهراً قبل 2026 وشهرا 2026
    expect(-net(s.owner, '1490', 'l.asset_id = ?', [a])).toBe(1428 * 20);
    expect(net(s.owner, '3200', 'l.asset_id = ?', [a])).toBe(1428 * 18);
    s.close();
  });
});

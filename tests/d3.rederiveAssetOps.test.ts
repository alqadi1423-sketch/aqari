/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيود نقل الأصل واستبعاده وبيعه (asset_transfer وasset_dispose وasset_sell) من حدثه وصفّه وما
 * رُحِّل له في الدفتر قبلها · قيدٌ كتبه عضو بضعف التكلفة والمجمع، أو بأبعاد وحدةٍ لم يُنقل إليها، أو بخسارةٍ منقولة، أو بنقدٍ وربحٍ
 * فوق مبلغ البيع، يُرفض على جهاز المالك ولا يدخل الدفتر · وما يكتبه التطبيق يُقبل، ولو وصل قبل إهلاك ما قبله · بيانات مصطنعة.
 */
import { createPendingAsset, setAssetCost, transferAsset, disposeAsset, sellAsset } from '@/domain/assets/service';
import { addProperty, addUnit, addBank } from './helpers/fixtures';
import { pair, sync, asMember, has, reasonOf, doubled, moved, otherDims, net, srcAsMember, holdBack, type Lines } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار عمليات أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار عمليات ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'AO-A' });
  const ub = addUnit(p.owner, pa, { unit_no: 'AO-B' });
  const uc = addUnit(p.owner, pb, { unit_no: 'AO-C' });
  const bank = addBank(p.owner, 'بنك عمليات مصطنع');
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub, uc, bank };
}
type S = Awaited<ReturnType<typeof setup>>;

async function pulls(owner: DB, r: MemoryRemote) {
  for (let i = 0; i < 3; i++) await sync(owner, r);
}

/** أصلٌ بتكلفة 840 ريالاً (قسطه ألف هللة) اشتُري في يناير، يعرفه جهاز المالك */
async function costed(s: S, name = 'مكيف عمليات مصطنع') {
  const a = createPendingAsset(s.dev, { name, category: '1410', unitId: s.ua });
  setAssetCost(s.dev, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  await sync(s.dev, s.r);
  await pulls(s.owner, s.r);
  return a;
}
const DEP = /^(depreciation|asset_dep)$/;
/** نقدٌ وربحٌ يزيدان بالمبلغ نفسه (القيد متوازن) */
const moreGain = (ls: Lines): Lines => ls.map((l) => (l.account_code === '1100' || l.account_code === '4400'
  ? { ...l, debit_halalas: Number(l.debit_halalas) ? Number(l.debit_halalas) + 50000 : 0, credit_halalas: Number(l.credit_halalas) ? Number(l.credit_halalas) + 50000 : 0 }
  : l));

describe('إعادة اشتقاق قيود نقل الأصل واستبعاده وبيعه', () => {
  test('سلبي · النقل بضعف التكلفة والمجمع (متوازن)، أو بأبعاد وحدةٍ لم يُنقل إليها: يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    const a = await costed(s);
    const b = await costed(s, 'ثلاجة عمليات مصطنعة');
    transferAsset(s.dev, a, { unitId: s.ub, date: '2026-04-16', today: '2026-04-20' });
    await sync(s.dev, s.r);
    srcAsMember(s.r, DEP);
    const k1 = asMember(s.r, 'asset_transfer', doubled);
    await pulls(s.owner, s.r);
    transferAsset(s.dev, b, { unitId: s.ub, date: '2026-04-18', today: '2026-04-20' });
    await sync(s.dev, s.r);
    srcAsMember(s.r, DEP);
    const k2 = asMember(s.r, 'asset_transfer', otherDims({ unit_id: s.uc, property_id: s.pb }));
    await pulls(s.owner, s.r);
    expect(has(s.owner, k1)).toBe(false);
    expect(reasonOf(s.owner, k1)).toMatch(/asset_transfer/);
    expect(has(s.owner, k2)).toBe(false);
    expect(reasonOf(s.owner, k2)).toMatch(/بُعد/);
    expect(net(s.owner, '1410', 'l.unit_id = ?', [s.ub])).toBe(0);
    s.close();
  });

  test('سلبي · الاستبعاد بضعفه، أو بخسارته منقولةً إلى مصروف الإهلاك: يُرفض', async () => {
    const s = await setup();
    const a = await costed(s);
    const b = await costed(s, 'غسالة عمليات مصطنعة');
    disposeAsset(s.dev, a, { date: '2026-04-16', reason: 'تلف مصطنع', today: '2026-04-20' });
    await sync(s.dev, s.r);
    srcAsMember(s.r, DEP);
    const k1 = asMember(s.r, 'asset_dispose', doubled);
    await pulls(s.owner, s.r);
    disposeAsset(s.dev, b, { date: '2026-04-18', reason: 'تلف مصطنع', today: '2026-04-20' });
    await sync(s.dev, s.r);
    srcAsMember(s.r, DEP);
    const k2 = asMember(s.r, 'asset_dispose', moved('5700', '5600'));
    await pulls(s.owner, s.r);
    expect(has(s.owner, k1)).toBe(false);
    expect(reasonOf(s.owner, k1)).toMatch(/asset_dispose/);
    expect(has(s.owner, k2)).toBe(false);
    expect(reasonOf(s.owner, k2)).toMatch(/5700|5600/);
    expect(net(s.owner, '5700')).toBe(0);
    s.close();
  });

  test('سلبي · البيع بضعفه، أو بنقدٍ وربحٍ فوق مبلغ بيعه: يُرفض', async () => {
    const s = await setup();
    const a = await costed(s);
    const b = await costed(s, 'شاشة عمليات مصطنعة');
    sellAsset(s.dev, a, { date: '2026-04-16', amountHalalas: 90000, method: 'cash', today: '2026-04-20' });
    await sync(s.dev, s.r);
    srcAsMember(s.r, DEP);
    const k1 = asMember(s.r, 'asset_sell', doubled);
    await pulls(s.owner, s.r);
    sellAsset(s.dev, b, { date: '2026-04-18', amountHalalas: 90000, method: 'bank', bankId: s.bank, today: '2026-04-20' });
    await sync(s.dev, s.r);
    srcAsMember(s.r, DEP);
    const k2 = asMember(s.r, 'asset_sell', moreGain);
    await pulls(s.owner, s.r);
    expect(has(s.owner, k1)).toBe(false);
    expect(reasonOf(s.owner, k1)).toMatch(/asset_sell/);
    expect(has(s.owner, k2)).toBe(false);
    expect(reasonOf(s.owner, k2)).toMatch(/1100|4400/);
    expect(net(s.owner, '4400')).toBe(0);
    s.close();
  });

  test('سلبي · البيع ببنكٍ حركتُه برقم قيده بغير مبلغ بيعه: يُرفض', async () => {
    const s = await setup();
    const a = await costed(s);
    sellAsset(s.dev, a, { date: '2026-04-16', amountHalalas: 90000, method: 'bank', bankId: s.bank, today: '2026-04-20' });
    await sync(s.dev, s.r);
    srcAsMember(s.r, DEP);
    const k = asMember(s.r, 'asset_sell');
    const no = s.r.docs.get('journal_entries__' + k)!.d!.no;
    const tx = [...s.r.docs.values()].find((d) => d.t === 'bank_tx' && d.d?.journal_no === no)!;
    s.r.inject({ ...tx, d: { ...tx.d, amount_halalas: 45000 } });
    await pulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/حركة البنك/);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: النقل ثم البيع ببنك، والاستبعاد · ولو وصل قبل إهلاك ما قبله', async () => {
    const s = await setup();
    const a = await costed(s);
    const b = await costed(s, 'سخان عمليات مصطنع');
    transferAsset(s.dev, a, { unitId: s.ub, date: '2026-04-16', today: '2026-04-20' });
    await sync(s.dev, s.r);
    sellAsset(s.dev, a, { date: '2026-05-10', amountHalalas: 80000, method: 'bank', bankId: s.bank, today: '2026-05-12' });
    disposeAsset(s.dev, b, { date: '2026-05-11', reason: 'تلف مصطنع', today: '2026-05-12' });
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, /^(depreciation|asset_dep|asset_transfer|asset_dispose|asset_sell)$/);
    // إهلاك ما قبل الاستبعاد يتأخر عن قيده
    const late = holdBack(s.r, (d) => d.t === 'journal_entries' && d.d?.src_type === 'asset_dep' && d.d?.src_id === b);
    expect(late.count).toBe(1);
    await pulls(s.owner, s.r);
    const disposed = ids.find((k) => s.r.docs.get('journal_entries__' + k)?.d?.src_type === 'asset_dispose')!;
    expect([has(s.owner, disposed), reasonOf(s.owner, disposed)]).toEqual([false, '']);
    late.release();
    await pulls(s.owner, s.r);
    for (const k of ids) expect([k, has(s.owner, k), reasonOf(s.owner, k)]).toEqual([k, true, '']);
    // الأصلان أُقفلا: لا تكلفة ولا مجمع
    expect(net(s.owner, '1410')).toBe(0);
    expect(net(s.owner, '1490')).toBe(0);
    s.close();
  });
});

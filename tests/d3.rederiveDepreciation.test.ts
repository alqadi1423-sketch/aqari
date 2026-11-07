/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيد الإهلاك الشهري (depreciation) وقيد إهلاك الأصل حتى تاريخ عمليته (asset_dep) من جدول
 * إهلاكه (expectedThrough) ناقصاً ما رُحِّل له قبله · قيدٌ كتبه عضو بضعف المستحق، أو بحسابٍ منقول، أو بأبعاد وحدةٍ لم يكن فيها
 * الأصل، أو من صفّ أصلٍ ضوعفت تكلفته فيه، يُرفض على جهاز المالك ولا يدخل الدفتر · وما يكتبه التطبيق يُقبل، ولو وصل بترتيبٍ غير ترتيب
 * ترحيله · بيانات مصطنعة.
 */
import { createPendingAsset, setAssetCost, transferAsset, disposeAsset } from '@/domain/assets/service';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, asMember, has, reasonOf, doubled, moved, otherDims, net, srcAsMember, holdBack } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار إهلاك أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار إهلاك ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'DP-A' });
  const ub = addUnit(p.owner, pa, { unit_no: 'DP-B' });
  const uc = addUnit(p.owner, pb, { unit_no: 'DP-C' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub, uc };
}
type S = Awaited<ReturnType<typeof setup>>;

/** يسحب المالك ثلاثاً: ما ينتظر قيداً قبله يُعاد في المرور التالي */
async function pulls(owner: DB, r: MemoryRemote) {
  for (let i = 0; i < 3; i++) await sync(owner, r);
}

/** مكيفٌ بتكلفة 840 ريالاً وعمر 84 شهراً (قسطه ألف هللة) اشتُري في يناير، يعرفه جهاز المالك */
async function costed(s: S, cost = 84000) {
  const a = createPendingAsset(s.dev, { name: 'مكيف إهلاك مصطنع', category: '1410', unitId: s.ua });
  setAssetCost(s.dev, a, { costHalalas: cost, purchaseDate: '2026-01-05', today: '2026-02-01' });
  await sync(s.dev, s.r);
  await pulls(s.owner, s.r);
  return a;
}

/** النقل في أبريل: إهلاك فبراير ومارس الشهري، ثم إهلاك 16 يوماً من أبريل حتى تاريخه (533 هللة) */
const moveApril = (s: S, a: string) => transferAsset(s.dev, a, { unitId: s.ub, date: '2026-04-16', today: '2026-04-20' });
const DEP = /^(depreciation|asset_dep)$/;
const accum = (db: DB) => -net(db, '1490') || 0;

describe('إعادة اشتقاق قيدي الإهلاك من جدول الأصل', () => {
  test('سلبي · الإهلاك الشهري بضعف المستحق (متوازن): يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    const a = await costed(s);
    moveApril(s, a);
    await sync(s.dev, s.r);
    srcAsMember(s.r, DEP);
    // إهلاك مارس بعينه (فبراير ومارس يُرفعان في اللحظة نفسها فلا يُعرف آخرهما)
    const mar = [...s.r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'depreciation' && d.d?.src_id === '2026-03')!;
    s.r.inject({ ...mar, lines: doubled(mar.lines!) });
    const k = mar.k;
    await pulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/depreciation/);
    // فبراير وحده، وإهلاك أبريل بعد مارس المرفوض لا يطابق فينتظره
    expect(accum(s.owner)).toBe(1000);
    s.close();
  });

  test('سلبي · إهلاك الأصل حتى تاريخ نقله بضعفه، أو بحسابٍ منقول إلى خسارة الاستبعاد: يُرفض', async () => {
    const s = await setup();
    const a = await costed(s);
    const b = createPendingAsset(s.dev, { name: 'ثلاجة إهلاك مصطنعة', category: '1410', unitId: s.ua });
    setAssetCost(s.dev, b, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
    await sync(s.dev, s.r);
    await pulls(s.owner, s.r);
    moveApril(s, a);
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^depreciation$/);
    const k1 = asMember(s.r, 'asset_dep', doubled);
    await pulls(s.owner, s.r);
    transferAsset(s.dev, b, { unitId: s.ub, date: '2026-04-18', today: '2026-04-20' });
    await sync(s.dev, s.r);
    const k2 = asMember(s.r, 'asset_dep', moved('5600', '5700'));
    await pulls(s.owner, s.r);
    expect(has(s.owner, k1)).toBe(false);
    expect(reasonOf(s.owner, k1)).toMatch(/asset_dep/);
    expect(has(s.owner, k2)).toBe(false);
    expect(reasonOf(s.owner, k2)).toMatch(/5700|5600/);
    expect(net(s.owner, '5700')).toBe(0);
    s.close();
  });

  test('سلبي · سطور الإهلاك بوحدةٍ وعقارٍ لم يكن فيهما الأصل: يُرفض', async () => {
    const s = await setup();
    const a = await costed(s);
    moveApril(s, a);
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^depreciation$/);
    const k = asMember(s.r, 'asset_dep', otherDims({ unit_id: s.uc, property_id: s.pb }));
    await pulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/بُعد/);
    s.close();
  });

  test('سلبي · صفّ الأصل بضعف تكلفته المرحّلة يضاعف إهلاكه متسقاً: يُرفض بأساسه', async () => {
    const s = await setup();
    const a = await costed(s);
    s.dev.run(`UPDATE assets SET cost_halalas = 168000 WHERE id = ?`, [a]);
    moveApril(s, a);
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, DEP);
    expect(ids.length).toBe(3);
    await pulls(s.owner, s.r);
    for (const k of ids) {
      expect(has(s.owner, k)).toBe(false);
      expect(reasonOf(s.owner, k)).toMatch(/تكلفة الأصل/);
    }
    expect(accum(s.owner)).toBe(0);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: الإهلاك الشهري، وإهلاك ما قبل النقل ثم ما قبل الاستبعاد بوحدته الجديدة', async () => {
    const s = await setup();
    const a = await costed(s);
    moveApril(s, a);
    await sync(s.dev, s.r);
    disposeAsset(s.dev, a, { date: '2026-05-10', reason: 'تلف مصطنع', today: '2026-05-12' });
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, DEP);
    // فبراير ومارس وأبريل، وإهلاك ما قبل النقل وما قبل الاستبعاد
    expect(ids.length).toBe(5);
    await pulls(s.owner, s.r);
    for (const k of ids) expect([k, has(s.owner, k), reasonOf(s.owner, k)]).toEqual([k, true, '']);
    // المجمع كله أُقفل بالاستبعاد · ومصروف الإهلاك حتى 10 مايو
    expect(net(s.owner, '5600')).toBe(3000 + Math.round(1000 * 10 / 31));
    s.close();
  });

  test('إيجابي · وصول إهلاك مارس وإهلاك النقل قبل فبراير (رفعٌ على دفعات): ينتظران ثم يُقبلان', async () => {
    const s = await setup();
    const a = await costed(s);
    moveApril(s, a);
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, DEP);
    const feb = holdBack(s.r, (d) => d.t === 'journal_entries' && d.d?.src_id === '2026-02');
    expect(feb.count).toBe(1);
    await pulls(s.owner, s.r);
    expect(ids.filter((k) => has(s.owner, k))).toEqual([]);
    expect(ids.map((k) => reasonOf(s.owner, k)).filter(Boolean)).toEqual([]);
    feb.release();
    await pulls(s.owner, s.r);
    for (const k of ids) expect([k, has(s.owner, k), reasonOf(s.owner, k)]).toEqual([k, true, '']);
    expect(accum(s.owner)).toBe(2533);
    s.close();
  });
});

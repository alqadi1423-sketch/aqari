/**
 * مدقق خارجي (G) · الجولة الرابعة · سلاسل أصولٍ مشروعة من عضو (deriveSources.ts · originUnits/placeOf/aheadOk وقفل asset_events في
 * engine.ts) · كل المستندات بكاتبها العضو (صفوف الأصل وأحداثه وقيوده) · بيانات مصطنعة.
 */
import { createPendingAsset, setAssetCost, transferAsset, disposeAsset, sellAsset } from '@/domain/assets/service';
import { runDepreciation } from '@/domain/assets/depreciation';
import { savePurchase, type PurchaseInput } from '@/domain/purchases';
import { addProperty, addUnit, addBank } from './helpers/fixtures';
import { pair, sync, has, reasonOf, net, MEMBER } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { MemoryRemote } from './helpers/memoryRemote';
import type { RemoteDoc } from '@/sync/types';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار سلسلة G أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار سلسلة G ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'GC-A' });
  const ub = addUnit(p.owner, pb, { unit_no: 'GC-B' });
  const bank = addBank(p.owner, 'بنك سلسلة G مصطنع', 0);
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  p.dev.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['SUP-GC', 'مورد سلسلة G مصطنع', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  return { ...p, pa, pb, ua, ub, bank, seen: new Set<string>() };
}
type S = Awaited<ReturnType<typeof setup>>;
async function pulls(owner: DB, r: MemoryRemote, n = 5) { for (let i = 0; i < n; i++) await sync(owner, r); }
/** كل ما رفعه الجهاز الثاني ولم يُعلَّم بعد: بكاتبه العضو وقسمه */
function allAsMember(r: MemoryRemote, seen: Set<string>): string[] {
  const ids: string[] = [];
  for (const d of [...r.docs.values()]) {
    if (seen.has(d.id + '|' + d.ts) || d.by === MEMBER) continue;
    const { ts: _t, ...doc } = d as RemoteDoc & { ts: string };
    r.inject({ ...doc, by: MEMBER, op: d.t === 'bank_tx' ? 'banks' : d.t === 'suppliers' || d.t.startsWith('purchase') ? 'purchases' : 'assets' } as RemoteDoc);
    seen.add(d.id + '|' + r.docs.get(d.id)!.ts);
    if (d.t === 'journal_entries') ids.push(d.k);
  }
  return ids;
}
const verdicts = (s: S, ids: string[]) => ids.map((k) => [s.r.docs.get('journal_entries__' + k)?.d?.src_type, has(s.owner, k), reasonOf(s.owner, k).slice(0, 80),
  s.owner.get<{ e: string }>(`SELECT last_error AS e FROM sync_inbox WHERE pk = ?`, [k])?.e ?? null]);
const ledger = (db: DB) => ['1100', '1410', '1490', '3100', '5600', '5700', '4400'].map((acc) => net(db, acc));
const byUnit = (db: DB, a: string, units: string[]) => units.map((u) => net(db, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, u]));

function expectSame(s: S, ids: string[], extra: Record<string, unknown> = {}) {
  const out = { v: verdicts(s, ids), owner: ledger(s.owner), member: ledger(s.dev), rejects: s.owner.all(`SELECT tbl, pk, reason FROM sync_rejects`), ...extra };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out));
  for (const x of out.v) expect(x.slice(1, 3)).toEqual([true, '']);
  expect(out.owner).toEqual(out.member);
  expect(out.rejects).toEqual([]);
}

describe('مدقق G · سلاسل أصول مشروعة من عضو', () => {
  test('(C1) تكلفة في A ← نقل إلى B ← نقل إلى A ← بيعٌ ببنك · في رفعٍ واحد', async () => {
    const s = await setup();
    const a = createPendingAsset(s.dev, { name: 'مكيف سلسلة C1 مصطنع', category: '1410', unitId: s.ua });
    setAssetCost(s.dev, a, { costHalalas: 120000, purchaseDate: '2026-01-05', today: '2026-02-01' });
    transferAsset(s.dev, a, { unitId: s.ub, date: '2026-04-16', today: '2026-04-20' });
    transferAsset(s.dev, a, { unitId: s.ua, date: '2026-06-10', today: '2026-06-12' });
    sellAsset(s.dev, a, { date: '2026-08-05', amountHalalas: 50000, method: 'bank', bankId: s.bank, today: '2026-08-05' });
    await sync(s.dev, s.r);
    const ids = allAsMember(s.r, s.seen);
    await pulls(s.owner, s.r);
    expectSame(s, ids, { units: byUnit(s.owner, a, [s.ua, s.ub]) });
    s.close();
  });

  test('(C2) فاتورةٌ ببندي أصلٍ في A ← نقل الأول إلى B ← استبعاده ← بيع الثاني نقداً', async () => {
    const s = await setup();
    savePurchase(s.dev, {
      supplier: 'مورد سلسلة G مصطنع', date: '2026-03-05', due: '2026-04-05', category: 'صيانة', incorpItem: '', amortize: false,
      amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: s.ua, propertyId: null, meterId: null, meterReading: null,
      subtotalHalalas: 300000, taxHalalas: 0, totalHalalas: 300000,
      lines: [
        { descr: 'مكيف أول مصطنع', qty: 1, amountHalalas: 180000, isAsset: true, category: '1410', unitId: s.ua, room: '' },
        { descr: 'مكيف ثانٍ مصطنع', qty: 1, amountHalalas: 120000, isAsset: true, category: '1410', unitId: s.ua, room: '' },
      ],
    } as PurchaseInput);
    const [a1, a2] = s.dev.all<{ id: string }>(`SELECT a.id FROM assets a JOIN purchase_lines l ON l.id = a.purchase_line_id ORDER BY l.sort`).map((x) => x.id);
    transferAsset(s.dev, a1, { unitId: s.ub, date: '2026-05-10', today: '2026-05-12' });
    disposeAsset(s.dev, a1, { date: '2026-06-20', reason: 'تالف C2 مصطنع', today: '2026-06-21' });
    sellAsset(s.dev, a2, { date: '2026-07-07', amountHalalas: 90000, method: 'cash', today: '2026-07-08' });
    await sync(s.dev, s.r);
    const ids = allAsMember(s.r, s.seen);
    await pulls(s.owner, s.r);
    expectSame(s, ids, { a1: byUnit(s.owner, a1, [s.ua, s.ub]), a2: byUnit(s.owner, a2, [s.ua, s.ub]) });
    s.close();
  });

  test('(C3) فاتورةٌ ببند أصلٍ كميته ٢ في A ← نقل أحدهما إلى B ثم الآخر إلى B ← إهلاك', async () => {
    const s = await setup();
    savePurchase(s.dev, {
      supplier: 'مورد سلسلة G مصطنع', date: '2026-03-05', due: '2026-04-05', category: 'صيانة', incorpItem: '', amortize: false,
      amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: s.ua, propertyId: null, meterId: null, meterReading: null,
      subtotalHalalas: 200001, taxHalalas: 0, totalHalalas: 200001,
      lines: [{ descr: 'مكيفان مصطنعان', qty: 2, amountHalalas: 200001, isAsset: true, category: '1410', unitId: s.ua, room: '' }],
    } as PurchaseInput);
    const [a1, a2] = s.dev.all<{ id: string }>(`SELECT id FROM assets ORDER BY rowid`).map((x) => x.id);
    transferAsset(s.dev, a2, { unitId: s.ub, date: '2026-05-10', today: '2026-05-12' });
    transferAsset(s.dev, a1, { unitId: s.ub, date: '2026-06-10', today: '2026-06-12' });
    runDepreciation(s.dev, '2026-08-02');
    await sync(s.dev, s.r);
    const ids = allAsMember(s.r, s.seen);
    await pulls(s.owner, s.r);
    expectSame(s, ids, { a1: byUnit(s.owner, a1, [s.ua, s.ub]), a2: byUnit(s.owner, a2, [s.ua, s.ub]) });
    s.close();
  });

  test('(C4) تكلفة في A ← نقل إلى B ← استبعاد · والمالك يسحب الاستبعاد قبل قيد النقل', async () => {
    const s = await setup();
    const a = createPendingAsset(s.dev, { name: 'سخان سلسلة C4 مصطنع', category: '1410', unitId: s.ua });
    setAssetCost(s.dev, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
    await sync(s.dev, s.r);
    allAsMember(s.r, s.seen);
    await pulls(s.owner, s.r, 2);
    transferAsset(s.dev, a, { unitId: s.ub, date: '2026-04-16', today: '2026-04-20' });
    disposeAsset(s.dev, a, { date: '2026-05-10', reason: 'تالف C4 مصطنع', today: '2026-05-10' });
    await sync(s.dev, s.r);
    const ids = allAsMember(s.r, s.seen);
    const tr = ids.find((k) => s.r.docs.get('journal_entries__' + k)?.d?.src_type === 'asset_transfer')!;
    const held = [...s.r.docs.values()].filter((d) => d.k === tr || (d.t === 'asset_events' && d.d?.entry_id === tr));
    for (const d of held) s.r.docs.delete(d.id);
    await pulls(s.owner, s.r, 2);
    for (const d of held) { const { ts: _t, ...doc } = d as RemoteDoc & { ts: string }; s.r.inject(doc as RemoteDoc); }
    await pulls(s.owner, s.r);
    expectSame(s, ids, { units: byUnit(s.owner, a, [s.ua, s.ub]) });
    s.close();
  });

  test('(C5) تغيير غرفةٍ في A ثم استبعادٌ في اليوم نفسه', async () => {
    const s = await setup();
    const a = createPendingAsset(s.dev, { name: 'ثلاجة سلسلة C5 مصطنعة', category: '1410', unitId: s.ua });
    setAssetCost(s.dev, a, { costHalalas: 96000, purchaseDate: '2026-01-05', today: '2026-02-01' });
    transferAsset(s.dev, a, { unitId: s.ua, room: 'غرفة C5', date: '2026-05-15', today: '2026-05-15' });
    disposeAsset(s.dev, a, { date: '2026-05-15', reason: 'تالف C5 مصطنع', today: '2026-05-15' });
    await sync(s.dev, s.r);
    const ids = allAsMember(s.r, s.seen);
    await pulls(s.owner, s.r);
    expectSame(s, ids, { units: byUnit(s.owner, a, [s.ua]) });
    s.close();
  });
});

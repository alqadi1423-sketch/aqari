/**
 * مدقق خارجي (ج) · الجولة الثانية · ما صمد: تسلسلاتٌ مشروعة يقبلها جهاز المالك بعد 825f162، وتطابقُ taken() القديم والجديد · بيانات مصطنعة.
 */
import { createPendingAsset, setAssetCost, transferAsset, disposeAsset, sellAsset } from '@/domain/assets/service';
import { addProperty, addUnit, addBank } from './helpers/fixtures';
import { pair, sync, has, reasonOf, net, srcAsMember } from './helpers/rederive';
import { memDb } from './helpers/testDb';
import { stageInbox } from '@/sync/engine';
import { bankBalance } from '@/domain/accounting/ledger';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار صمود ج أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار صمود ج ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'HC-A' });
  const ub = addUnit(p.owner, pa, { unit_no: 'HC-B' });
  const uc = addUnit(p.owner, pb, { unit_no: 'HC-C' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub, uc };
}
type S = Awaited<ReturnType<typeof setup>>;
async function pulls(owner: DB, r: MemoryRemote, n = 4) { for (let i = 0; i < n; i++) await sync(owner, r); }
const ALL = /^(asset_cost|asset_catchup|depreciation|asset_dep|asset_transfer|asset_dispose|asset_sell)$/;
const verdicts = (s: S, ids: string[]) => ids.map((k) => [s.r.docs.get('journal_entries__' + k)?.d?.src_type, has(s.owner, k), reasonOf(s.owner, k)]);

/** سلسلة A→B→C→A ثم انتهاءٌ في A · كلها من العضو ولم يرَ المالك منها شيئاً · بترتيب الرفع أو معكوساً */
async function chain(order: 'upload' | 'reversed', end: 'dispose' | 'sell') {
  const s = await setup();
  const bank = end === 'sell' ? addBank(s.owner, 'بنك صمود ج مصطنع') : null;
  if (bank) { await sync(s.owner, s.r); await sync(s.dev, s.r); }
  const a = createPendingAsset(s.dev, { name: 'سلسلة صمود مصطنعة', category: '1410', unitId: s.ua });
  setAssetCost(s.dev, a, { costHalalas: 120000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  transferAsset(s.dev, a, { unitId: s.ub, date: '2026-03-05', today: '2026-03-05' });
  transferAsset(s.dev, a, { unitId: s.uc, date: '2026-04-07', today: '2026-04-07' });
  transferAsset(s.dev, a, { unitId: s.ua, date: '2026-05-09', today: '2026-05-09' });
  if (end === 'dispose') disposeAsset(s.dev, a, { date: '2026-06-11', reason: 'تلف صمود ج', today: '2026-06-11' });
  else sellAsset(s.dev, a, { date: '2026-06-11', amountHalalas: 50000, method: 'bank', bankId: bank, today: '2026-06-11' });
  await sync(s.dev, s.r);
  const ids = srcAsMember(s.r, ALL);
  if (order === 'reversed') {
    const docs = ids.map((k) => s.r.docs.get('journal_entries__' + k)!);
    docs.forEach((d, i) => s.r.inject({ ...d, u: new Date(Date.UTC(2026, 0, 1) + (docs.length - i) * 1000).toISOString() }));
  }
  await pulls(s.owner, s.r, 6);
  const v = verdicts(s, ids);
  const out = { order, end, v, perUnit: [s.ua, s.ub, s.uc].map((u) => net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, u])),
    bank: bank ? [bankBalance(s.owner, bank), bankBalance(s.dev, bank)] : null };
  s.close();
  return out;
}

describe('مدقق ج · ما صمد', () => {
  for (const order of ['upload', 'reversed'] as const) {
    for (const end of ['dispose', 'sell'] as const) {
      test(`سلسلة A→B→C→A ثم ${end} في A · الترتيب ${order}: يُقبل كله ولا رصيد لوحدة`, async () => {
        const out = await chain(order, end);
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(out));
        for (const x of out.v) expect(x.slice(1)).toEqual([true, '']);
        expect(out.perUnit).toEqual([0, 0, 0]);
        if (out.bank) expect(out.bank[0]).toBe(out.bank[1]);
      });
    }
  }

  test('sync_inbox_lines يطابق مسح الحمولات بعد إدراجٍ وتحديثٍ (ON CONFLICT) وقلب del وحذف', () => {
    const db = memDb();
    const doc = (k: string, ids: string[], u: string, del = false): RemoteDoc => ({ id: 'journal_entries__' + k, t: 'journal_entries', k, del, u, dev: 'd',
      d: del ? undefined : { id: k, no: 'N-' + k, status: 'مسودة' }, lines: del ? undefined : ids.map((id) => ({ id, entry_id: k })) } as RemoteDoc);
    const scan = () => db.all<{ l: string; d: string }>(`SELECT json_extract(j.value, '$.id') AS l, i.doc AS d FROM sync_inbox i, json_each(i.payload, '$.lines') j
      WHERE i.tbl = 'journal_entries' AND i.del = 0 AND json_extract(j.value, '$.id') IS NOT NULL ORDER BY l, d`);
    const table = () => db.all<{ l: string; d: string }>(`SELECT line_id AS l, doc AS d FROM sync_inbox_lines ORDER BY l, d`);
    const steps: Array<() => void> = [
      () => stageInbox(db, [doc('e1', ['x1', 'x2'], '2026-01-01T00:00:01.000Z'), doc('e2', ['x3'], '2026-01-01T00:00:01.000Z')]),
      () => stageInbox(db, [doc('e1', ['x4'], '2026-01-01T00:00:02.000Z')]),
      () => stageInbox(db, [doc('e1', ['x9'], '2026-01-01T00:00:00.000Z')]), // أقدم: لا يغلب
      () => stageInbox(db, [doc('e2', [], '2026-01-01T00:00:03.000Z', true)]), // حذف
      () => stageInbox(db, [doc('e2', ['x5'], '2026-01-01T00:00:04.000Z')]), // يعود
      () => db.run(`DELETE FROM sync_inbox WHERE pk = 'e1'`),
    ];
    for (const st of steps) { st(); expect(table()).toEqual(scan()); }
    db.close();
  });
});

describe('مدقق ج · «قابلة للخصم» · ما صمد', () => {
  test('فاتورةٌ قُبلت قابلةً للخصم والمنشأة مسجّلة · ثم أُلغي التسجيل · فعدّلها العضو بوضعها: يقبلها المالك (كما يبقيها الحفظ المحلي)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { savePurchase, TS_DEDUCTIBLE } = require('@/domain/purchases') as typeof import('@/domain/purchases');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MEMBER } = require('./helpers/rederive') as typeof import('./helpers/rederive');
    const s = await pair();
    for (const db of [s.owner, s.dev]) {
      db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S-HC', 'مورد صمود ج مصطنع', '300000000000003', '2026-01-01T00:00:00.000Z')`);
    }
    s.owner.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    expect(s.dev.get<{ v: number }>(`SELECT vat_enabled AS v FROM company WHERE id = 1`)!.v).toBe(1);
    const input = (sub: number) => ({ supplier: 'مورد صمود ج مصطنع', date: '2026-10-01', due: '2026-10-31', category: 'صيانة', incorpItem: '', amortize: false,
      amortizeMonths: null, exempt: false, excludeFromVat: false, subtotalHalalas: sub, taxHalalas: (sub * 15) / 100, totalHalalas: sub + (sub * 15) / 100,
      taxStatus: TS_DEDUCTIBLE, notes: '' }) as never;
    const id = savePurchase(s.dev, input(100000));
    await sync(s.dev, s.r);
    const asMemberAll = () => { for (const d of [...s.r.docs.values()].filter((x) => x.t === 'purchases' || (x.t === 'journal_entries' && /^purchase/.test(String(x.d?.src_type))))) s.r.inject({ ...d, by: MEMBER, op: 'purchases' }); };
    asMemberAll();
    await sync(s.owner, s.r); await sync(s.owner, s.r);
    expect(s.owner.get<{ s: string }>(`SELECT tax_status AS s FROM purchases WHERE id = ?`, [id])!.s).toBe(TS_DEDUCTIBLE);
    s.owner.run(`UPDATE company SET vat_enabled = 0 WHERE id = 1`);
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    savePurchase(s.dev, input(200000), id);
    await sync(s.dev, s.r);
    asMemberAll();
    await sync(s.owner, s.r); await sync(s.owner, s.r); await sync(s.owner, s.r);
    const out = { st: s.owner.get(`SELECT tax_status AS s, subtotal_halalas AS n FROM purchases WHERE id = ?`, [id]),
      v1270: [net(s.owner, '1270'), net(s.dev, '1270')], rejects: s.owner.all(`SELECT tbl, reason FROM sync_rejects`) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(out.v1270[0]).toBe(out.v1270[1]);
    expect(out.rejects).toEqual([]);
    s.close();
  });
});

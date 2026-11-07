/**
 * مدقق خارجي (هـ) · الجولة الثالثة · فحص الأصل المنتهي في قيد النقل حين يصل الاستبعاد مع النقل (deriveSources.ts · asset_transfer ·
 * «place.pending && !end.here && endsAt(placeOf(..., ahead, mine))» · 1f21568) · بيانات مصطنعة.
 * إصلاح ج٢ يشترط «!end.here» للمسار المعتمد على الوارد · فإن وصل الاستبعاد في الدفعة نفسها (لم يُطبَّق بعد) عاد المسار القديم: نقلٌ
 * B→C ومعه «نقل» C→B مشهودٌ بحدثٍ يُرفض حين يأتي دوره (يسمّي أصلاً آخر مصدراً) · فيُقبل الأول بعد الاستبعاد، ثم يُرفض الثاني، ثم يبقى
 * حدثه بلا قيد فينتظر الاستبعادُ إلى الأبد (transferOut) · فتكلفة أصلٍ مستبعَد في عقارٍ آخر، والاستبعاد لا يدخل دفتر المالك.
 */
import { createPendingAsset, setAssetCost, disposeAsset } from '@/domain/assets/service';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, has, reasonOf, net, srcAsMember, MEMBER } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';
import type { MemoryRemote } from './helpers/memoryRemote';

async function pulls(owner: DB, r: MemoryRemote, n = 4) { for (let i = 0; i < n; i++) await sync(owner, r); }

describe('مدقق هـ · الأصل المنتهي والاستبعاد في الوارد', () => {
  test('الاستبعاد في B ونقلٌ B→C بعده ونقلٌ C→B «مشهود» يُرفض · كلها في دفعةٍ واحدة: لا تخرج تكلفة المستبعَد إلى C', async () => {
    const s = await pair();
    const pa = addProperty(s.owner, { name: 'عقار انتهاء هـ أ مصطنع' });
    const pb = addProperty(s.owner, { name: 'عقار انتهاء هـ ب مصطنع' });
    const ub = addUnit(s.owner, pa, { unit_no: 'EE-B' });
    const uc = addUnit(s.owner, pb, { unit_no: 'EE-C' });
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    const a = createPendingAsset(s.dev, { name: 'مولد انتهاء هـ مصطنع', category: '1410', unitId: ub });
    setAssetCost(s.dev, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^(asset_cost|asset_catchup)$/);
    await pulls(s.owner, s.r);
    expect(net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, ub])).toBe(84000);
    disposeAsset(s.dev, a, { date: '2026-03-10', reason: 'تالف مصطنع', today: '2026-03-10' });
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^(depreciation|asset_dep|asset_dispose)$/);
    const end = s.dev.get<{ e: string }>(`SELECT end_entry_id AS e FROM assets WHERE id = ?`, [a])!.e;
    // المجمع حتى الاستبعاد (قبل قيده) كما يحسبه ledgerOf
    const accum = -net(s.dev, '1490', 'l.asset_id = ? AND e.id != ?', [a, end]);
    const base = s.r.docs.get('journal_entries__' + end)!;
    const ev0 = [...s.r.docs.values()].find((d) => d.t === 'asset_events' && d.d?.asset_id === a)!;
    const mk = (k: string, from: { u: string; p: string }, to: { u: string; p: string }, date: string, srcId: string) => {
      const dim = (x: { u: string; p: string }) => ({ unit_id: x.u, property_id: x.p, contract_id: null, asset_id: a, cost_center_id: null });
      const lines = [
        { account_code: '1410', descr: 'مصطنع', debit_halalas: 84000, credit_halalas: 0, ...dim(to) },
        { account_code: '1410', descr: 'مصطنع', debit_halalas: 0, credit_halalas: 84000, ...dim(from) },
        { account_code: '1490', descr: 'مصطنع', debit_halalas: accum, credit_halalas: 0, ...dim(from) },
        { account_code: '1490', descr: 'مصطنع', debit_halalas: 0, credit_halalas: accum, ...dim(to) },
      ].map((l, i) => ({ ...l, id: k + '-l' + i, entry_id: k }));
      s.r.inject({ ...base, id: 'journal_entries__' + k, k, by: MEMBER, d: { ...base.d, id: k, no: 'FE-' + k, src_type: 'asset_transfer', src_id: srcId, date,
        reversed_by: null, memo: 'نقل مصطنع' }, lines } as RemoteDoc);
      s.r.inject({ ...ev0, id: 'asset_events__ev-' + k, k: 'ev-' + k, by: MEMBER, op: 'assets',
        d: { ...ev0.d, id: 'ev-' + k, asset_id: a, kind: 'transfer', date, entry_id: k, from_unit_id: from.u, to_unit_id: to.u, note: '' } } as RemoteDoc);
    };
    const B = { u: ub, p: pa }, C = { u: uc, p: pb };
    mk('fe1', B, C, '2026-03-10', a);
    mk('fe2', C, B, '2026-03-10', 'asset-other-e');
    await pulls(s.owner, s.r);
    const out = { fe1: [has(s.owner, 'fe1'), reasonOf(s.owner, 'fe1').slice(0, 60)], fe2: [has(s.owner, 'fe2'), reasonOf(s.owner, 'fe2').slice(0, 60)],
      disposal: [has(s.owner, end), !!s.owner.get(`SELECT 1 FROM sync_inbox WHERE pk = ?`, [end])],
      atB: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, ub]), atC: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, uc]),
      memberAll: net(s.dev, '1410', 'l.asset_id = ?', [a]) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(has(s.owner, 'fe1')).toBe(false);
    expect(out.atC).toBe(0);
    s.close();
  });
});

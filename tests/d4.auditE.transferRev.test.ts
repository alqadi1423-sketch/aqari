/**
 * مدقق خارجي (هـ) · الجولة الثالثة · «لا يعكس عضوٌ قيد نقل أصلٍ ما دام حدث نقله قائماً» (engine.ts · memberReversalCheck · 1f21568) ·
 * بيانات مصطنعة.
 * الحارس يسأل عن صفّ asset_events القائم وقت فحص العكس · والعضو بقسم الأصول يملك asset_events فيحذفها (firestore.rules: asset_events
 * ليست في قائمة ما لا يحذفه العضو)، وجهاز المالك يطبّق حذفها بلا فحص، وشواهد الحذف تُطبَّق قبل الصفوف في المرور نفسه · فحذف الحدث مع
 * العكس في دفعةٍ واحدة يجعل النقل «يتيماً» فيُعكس، وصفّ الأصل باقٍ في B · ثم يُقبل إهلاكٌ بالوحدة القديمة A (ما أراد الإصلاح منعه).
 */
import { createPendingAsset, setAssetCost, transferAsset } from '@/domain/assets/service';
import { runDepreciation } from '@/domain/assets/depreciation';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, has, reasonOf, net, srcAsMember, forge, mirrorOf, MEMBER } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';
import type { MemoryRemote } from './helpers/memoryRemote';

async function pulls(owner: DB, r: MemoryRemote, n = 3) { for (let i = 0; i < n; i++) await sync(owner, r); }
const entryOf = (r: MemoryRemote, src: string, srcId: string) => [...r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === src && d.d?.src_id === srcId)!;

describe('مدقق هـ · عكس النقل بعد حذف حدثه', () => {
  async function scenario(dropEvent: boolean) {
    const s = await pair();
    const pa = addProperty(s.owner, { name: 'عقار عكس هـ أ مصطنع' });
    const pb = addProperty(s.owner, { name: 'عقار عكس هـ ب مصطنع' });
    const ua = addUnit(s.owner, pa, { unit_no: 'TR-A' });
    const ub = addUnit(s.owner, pb, { unit_no: 'TR-B' });
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    const a = createPendingAsset(s.dev, { name: 'مكيف عكس مصطنع', category: '1410', unitId: ua });
    setAssetCost(s.dev, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
    // التكلفة يسحبها المالك قبل النقل (auditE.costThenMove: وإلا رُفض قيدها)
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^(asset_cost|asset_catchup)$/);
    await pulls(s.owner, s.r);
    transferAsset(s.dev, a, { unitId: ub, date: '2026-04-16', today: '2026-04-20' });
    runDepreciation(s.dev, '2026-05-02');
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^(asset_cost|asset_catchup|depreciation|asset_dep|asset_transfer)$/);
    await pulls(s.owner, s.r);
    const tr = entryOf(s.r, 'asset_transfer', a);
    expect(has(s.owner, tr.k)).toBe(true);
    expect(s.owner.get<{ u: string }>(`SELECT unit_id AS u FROM assets WHERE id = ?`, [a])!.u).toBe(ub);
    // العضو: يحذف حدث النقل (شاهد حذفٍ بحاذفه) ويعكس قيده (مرآته) · وإهلاك مايو بالوحدة القديمة A
    const ev = [...s.r.docs.values()].find((d) => d.t === 'asset_events' && d.d?.entry_id === tr.k)!;
    if (dropEvent) s.r.inject({ id: ev.id, t: 'asset_events', k: ev.k, u: new Date().toISOString(), dev: 'dev-m', del: true, d: null, dby: MEMBER, op: 'assets', by: ev.by } as unknown as RemoteDoc);
    const rev = forge(tr, { src_type: 'asset_transfer_rev', lines: mirrorOf(tr.lines!) });
    s.r.inject({ ...rev, op: 'ledger', d: { ...rev.d, src_id: a, date: '2026-05-20' } } as RemoteDoc);
    runDepreciation(s.dev, '2026-06-02');
    await sync(s.dev, s.r);
    const realMay = entryOf(s.r, 'depreciation', '2026-05');
    s.r.inject({ ...realMay, by: MEMBER, lines: realMay.lines!.map((l) => ({ ...l, unit_id: ua, property_id: pa, contract_id: null })) });
    await pulls(s.owner, s.r);
    const out = { dropEvent, rev: [has(s.owner, rev.k), reasonOf(s.owner, rev.k)], mayAtA: [has(s.owner, realMay.k), reasonOf(s.owner, realMay.k)],
      eventLeft: !!s.owner.get(`SELECT 1 FROM asset_events WHERE entry_id = ?`, [tr.k]),
      rowUnit: s.owner.get<{ u: string }>(`SELECT unit_id AS u FROM assets WHERE id = ?`, [a])!.u === ub ? 'B' : 'A',
      costA: net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, ua]), depPropA_afterMove: net(s.owner, '5600', 'l.property_id = ? AND e.date > ?', [pa, '2026-04-16']) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    expect(has(s.owner, rev.k)).toBe(false);
    expect(out.depPropA_afterMove).toBe(0);
    s.close();
  }
  test('ضابط · العكس وحده (الحدث قائم): يُرفض «transferLive»', () => scenario(false));
  test('حذف حدث النقل وعكس قيده معاً: يُرفض العكس، ولا يُقبل إهلاكٌ بالوحدة القديمة', () => scenario(true));
});

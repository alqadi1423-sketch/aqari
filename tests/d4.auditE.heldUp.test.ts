/**
 * مدقق خارجي (هـ) · الجولة الثالثة · ما صمد: تسلسلاتٌ مشروعة بتواريخ غير مرتّبة وبترتيب وصولٍ معكوس وعلى دفعات · يقبلها جهاز المالك
 * كلها بعد 1f21568 ودفتره كدفتر العضو · بيانات مصطنعة.
 */
import { createPendingAsset, setAssetCost, transferAsset, disposeAsset, sellAsset } from '@/domain/assets/service';
import { runDepreciation } from '@/domain/assets/depreciation';
import { addProperty, addUnit, addBank } from './helpers/fixtures';
import { pair, sync, has, reasonOf, net, srcAsMember, holdBack, MEMBER } from './helpers/rederive';
import { bankBalance } from '@/domain/accounting/ledger';
import type { DB } from '@/db/adapter';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار صمود هـ أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار صمود هـ ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'HE-A' });
  const ub = addUnit(p.owner, pa, { unit_no: 'HE-B' });
  const uc = addUnit(p.owner, pb, { unit_no: 'HE-C' });
  const bank = addBank(p.owner, 'بنك صمود هـ مصطنع');
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub, uc, bank };
}
type S = Awaited<ReturnType<typeof setup>>;
async function pulls(owner: DB, r: MemoryRemote, n = 6) { for (let i = 0; i < n; i++) await sync(owner, r); }
const ALL = /^(asset_cost|asset_catchup|depreciation|asset_dep|asset_transfer|asset_dispose|asset_sell)$/;
const ledger = (db: DB, a: string, units: string[]) => units.map((u) => ['1410', '1490'].map((acc) => net(db, acc, 'l.asset_id = ? AND l.unit_id = ?', [a, u])));

async function costed(s: S) {
  const a = createPendingAsset(s.dev, { name: 'أصل صمود هـ مصطنع', category: '1410', unitId: s.ua });
  setAssetCost(s.dev, a, { costHalalas: 120000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  await sync(s.dev, s.r);
  srcAsMember(s.r, /^(asset_cost|asset_catchup)$/);
  await pulls(s.owner, s.r, 2);
  return a;
}

describe('مدقق هـ · ما صمد', () => {
  for (const order of ['upload', 'reversed', 'batches'] as const) {
    for (const end of ['dispose', 'sell'] as const) {
      test(`تواريخ غير مرتّبة: A→B (05-20) ثم B→C (05-12) ثم ${end} (05-15) مع إهلاك أبريل · الترتيب ${order}`, async () => {
        const s = await setup();
        const a = await costed(s);
        runDepreciation(s.dev, '2026-05-02');
        transferAsset(s.dev, a, { unitId: s.ub, date: '2026-05-20', today: '2026-05-21' });
        transferAsset(s.dev, a, { unitId: s.uc, date: '2026-05-12', today: '2026-05-21' });
        if (end === 'dispose') disposeAsset(s.dev, a, { date: '2026-05-15', reason: 'تلف صمود هـ', today: '2026-05-21' });
        else sellAsset(s.dev, a, { date: '2026-05-15', amountHalalas: 50000, method: 'bank', bankId: s.bank, today: '2026-05-21' });
        await sync(s.dev, s.r);
        const ids = srcAsMember(s.r, ALL);
        for (const d of [...s.r.docs.values()].filter((x) => x.t === 'bank_tx')) s.r.inject({ ...d, by: MEMBER, op: 'assets' });
        if (order === 'reversed') {
          const docs = ids.map((k) => s.r.docs.get('journal_entries__' + k)!);
          docs.forEach((d, i) => s.r.inject({ ...d, u: new Date(Date.UTC(2026, 0, 1) + (docs.length - i) * 1000).toISOString() }));
        }
        if (order === 'batches') {
          // الأصل وأحداثه وحركة البنك في دفعةٍ لاحقة
          const later = holdBack(s.r, (d) => d.t === 'assets' || d.t === 'asset_events' || d.t === 'bank_tx');
          await pulls(s.owner, s.r, 2);
          later.release();
        }
        await pulls(s.owner, s.r);
        const v = ids.map((k) => [s.r.docs.get('journal_entries__' + k)?.d?.src_type, has(s.owner, k), reasonOf(s.owner, k).slice(0, 60)]);
        const out = { v, owner: ledger(s.owner, a, [s.ua, s.ub, s.uc]), member: ledger(s.dev, a, [s.ua, s.ub, s.uc]),
          bank: [bankBalance(s.owner, s.bank), bankBalance(s.dev, s.bank)] };
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(out));
        for (const x of v) expect(x.slice(1)).toEqual([true, '']);
        expect(out.owner).toEqual(out.member);
        expect(out.bank[0]).toBe(out.bank[1]);
        s.close();
      });
    }
  }
});

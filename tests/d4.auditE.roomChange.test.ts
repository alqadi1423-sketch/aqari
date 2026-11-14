/**
 * مدقق خارجي (هـ) · الجولة الثالثة · تغيير الغرفة ثم النقل قبل أن يسحب المالك (deriveSources.ts · asset_dep · depUnits) · بيانات مصطنعة.
 * تغيير الغرفة في الوحدة نفسها (transferAsset بالوحدة نفسها) يرحّل إهلاك ما قبله (asset_dep بتاريخه) ولا قيد نقل · فإن نُقل الأصل بعده
 * إلى وحدةٍ أخرى بتاريخٍ لاحق ووصلا معاً: إهلاك الغرفة بوحدته الصحيحة A مقبولٌ «هنا» ({A}) لا «بعد الوارد» (سلسلة النقل المصدَّقة إلى B،
 * و opFrom لا يجد نقلاً بتاريخه) فينتظر النقل · والنقل ينتظره (مجمعه يشمل إهلاكه: led.pending/short) · فيتوقفان، ثم يُرفضان لطول
 * الانتظار ومعهما كل ما بعدهما للأصل · ودفتر العضو فيه كل ذلك.
 */
import { createPendingAsset, setAssetCost, transferAsset } from '@/domain/assets/service';
import { runDepreciation } from '@/domain/assets/depreciation';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, has, reasonOf, net, srcAsMember } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { MemoryRemote } from './helpers/memoryRemote';

async function pulls(owner: DB, r: MemoryRemote, n = 6) { for (let i = 0; i < n; i++) await sync(owner, r); }

test('مدقق هـ · تغيير غرفةٍ في A (06-15) ثم نقلٌ إلى B (06-20) ثم إهلاك يونيو · يقبلها المالك ودفتره كدفتر العضو', async () => {
  const s = await pair();
  const pa = addProperty(s.owner, { name: 'عقار غرفة هـ أ مصطنع' });
  const pb = addProperty(s.owner, { name: 'عقار غرفة هـ ب مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'RC-A' });
  const ub = addUnit(s.owner, pb, { unit_no: 'RC-B' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const a = createPendingAsset(s.dev, { name: 'مكيف غرفة مصطنع', category: '1410', unitId: ua });
  setAssetCost(s.dev, a, { costHalalas: 120000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  runDepreciation(s.dev, '2026-06-02');
  await sync(s.dev, s.r);
  srcAsMember(s.r, /^(asset_cost|asset_catchup|depreciation)$/);
  await pulls(s.owner, s.r, 2);
  expect(net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, ua])).toBe(120000);
  // الجلسة التالية للعضو: تغيير غرفة ثم نقل ثم إهلاك يونيو
  transferAsset(s.dev, a, { unitId: ua, room: 'غرفة مصطنعة', date: '2026-06-15', today: '2026-06-16' });
  transferAsset(s.dev, a, { unitId: ub, date: '2026-06-20', today: '2026-06-21' });
  runDepreciation(s.dev, '2026-07-02');
  await sync(s.dev, s.r);
  const ids = srcAsMember(s.r, /^(depreciation|asset_dep|asset_transfer)$/).filter((k) => !has(s.owner, k));
  await pulls(s.owner, s.r);
  const v = () => ids.map((k) => [s.r.docs.get('journal_entries__' + k)?.d?.src_type, s.r.docs.get('journal_entries__' + k)?.d?.date, has(s.owner, k),
    reasonOf(s.owner, k).slice(0, 40), s.owner.get<{ e: string }>(`SELECT last_error AS e FROM sync_inbox WHERE pk = ?`, [k])?.e ?? null]);
  const before = v();
  // ويمضي الشهر
  s.owner.run(`UPDATE sync_inbox SET waiting_since = '2020-01-01T00:00:00.000Z', attempts = 50`);
  await pulls(s.owner, s.r, 3);
  const out = { before, after: v(), owner: [ua, ub].map((u) => net(s.owner, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, u])),
    member: [ua, ub].map((u) => net(s.dev, '1410', 'l.asset_id = ? AND l.unit_id = ?', [a, u])) };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out));
  for (const k of ids) expect(has(s.owner, k)).toBe(true);
  expect(out.owner).toEqual(out.member);
  s.close();
});

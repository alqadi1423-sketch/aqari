/**
 * اختبارات المدقق الخارجي أُبقيت حارساً بعد إصلاح ما أثبتته (التوجيه الرابع ٣ · الجولة الأولى) ·
 * مدقق خارجي (أ) · أصلٌ يُنقل ذهاباً وإياباً ثم يُستبعد أو يُباع، ويرفعه العضو في مزامنةٍ واحدة بترتيبه الطبيعي · بيانات مصطنعة.
 */
import { createPendingAsset, setAssetCost, transferAsset, disposeAsset, sellAsset } from '@/domain/assets/service';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, has, reasonOf, srcAsMember } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { MemoryRemote } from './helpers/memoryRemote';

async function pulls(owner: DB, r: MemoryRemote, n = 6) { for (let i = 0; i < n; i++) await sync(owner, r); }

test.each([['sell', 'back'], ['dispose', 'back'], ['dispose', 'onward']])('نقلان ثم %s (%s): قيود العضو المشروعة كلها تُقبل على جهاز المالك', async (end, route) => {
  const s = await pair();
  const pa = addProperty(s.owner, { name: 'عقار ذهاب مصطنع' });
  const pb = addProperty(s.owner, { name: 'عقار إياب مصطنع' });
  const ua = addUnit(s.owner, pa, { unit_no: 'RT-A' });
  const uc = addUnit(s.owner, pb, { unit_no: 'RT-C' });
  const ub = addUnit(s.owner, pa, { unit_no: 'RT-B' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const a = createPendingAsset(s.dev, { name: 'ثلاجة ذهاب مصطنعة', category: '1420', unitId: ua });
  setAssetCost(s.dev, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
  await sync(s.dev, s.r);
  await pulls(s.owner, s.r);
  // العضو بلا اتصالٍ بالمالك بين العمليات: نقلٌ إلى C ثم عودةٌ إلى A ثم إنهاء
  transferAsset(s.dev, a, { unitId: uc, date: '2026-03-10', today: '2026-03-12' });
  transferAsset(s.dev, a, { unitId: route === 'back' ? ua : ub, date: '2026-05-20', today: '2026-05-22' });
  if (end === 'sell') sellAsset(s.dev, a, { date: '2026-07-15', amountHalalas: 50000, method: 'cash', today: '2026-07-16' });
  else disposeAsset(s.dev, a, { date: '2026-07-15', reason: 'تلف ذهاب مصطنع', today: '2026-07-16' });
  await sync(s.dev, s.r);
  const ids = srcAsMember(s.r, /^(depreciation|asset_dep|asset_transfer|asset_dispose|asset_sell)$/);
  await pulls(s.owner, s.r);
  const state = ids.map((k) => { const d = s.r.docs.get('journal_entries__' + k)!.d!; return [d.src_type, d.date, has(s.owner, k), reasonOf(s.owner, k), s.owner.get<{ e: string }>(`SELECT last_error AS e FROM sync_inbox WHERE pk = ?`, [k])?.e ?? '']; });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(state));
  expect(state.filter((x) => !x[2])).toEqual([]);
  s.close();
});

/**
 * مدقق خارجي (هـ) · الجولة الثالثة · أصلٌ تُثبت تكلفته ثم يُنقل قبل أن يسحب المالك (deriveSources.ts · asset_cost · purchaseAssetForms) ·
 * بيانات مصطنعة.
 * قيد إثبات التكلفة (وسطور أصول فاتورة الشراء) يُشتق بُعده من وحدة صفّ الأصل «كما سيُطبَّق» (r.asset / r.rows: أحدث نسخةٍ في الوارد) ·
 * والعضو ينقل الأصل بعد إثبات تكلفته، فيصل الصفّ بوحدته الجديدة B مع القيد الذي رُحِّل بوحدته القديمة A · فيُرفض القيد المشروع رفضاً
 * نهائياً «بُعد سطر الحساب»، وكل ما بعده للأصل (الإهلاك والنقل) ينتظر تكلفةً لا تصل ثم يُرفض لطول انتظاره · ودفتر العضو فيه كل ذلك.
 */
import { createPendingAsset, setAssetCost, transferAsset } from '@/domain/assets/service';
import { runDepreciation } from '@/domain/assets/depreciation';
import { savePurchase, type PurchaseInput } from '@/domain/purchases';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, has, reasonOf, net, srcAsMember } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار نقل مبكر أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار نقل مبكر ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'CM-A' });
  const ub = addUnit(p.owner, pb, { unit_no: 'CM-B' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  p.dev.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['SUP-CM', 'مورد نقل مبكر مصطنع', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  return { ...p, pa, pb, ua, ub };
}
type S = Awaited<ReturnType<typeof setup>>;
async function pulls(owner: DB, r: MemoryRemote, n = 4) { for (let i = 0; i < n; i++) await sync(owner, r); }
const ALL = /^(purchase|asset_cost|asset_catchup|depreciation|asset_dep|asset_transfer)$/;
const verdicts = (s: S, ids: string[]) => ids.map((k) => [s.r.docs.get('journal_entries__' + k)?.d?.src_type, has(s.owner, k), reasonOf(s.owner, k).slice(0, 70)]);
const ledger = (db: DB) => ['1410', '1490', '3100', '5600'].map((acc) => net(db, acc));

describe('مدقق هـ · إثبات التكلفة ثم النقل قبل سحب المالك', () => {
  test('(أ) أصلٌ بلا فاتورة: تكلفته في A ثم نقله إلى B وإهلاكه · كلها من العضو: يقبلها المالك ودفتره كدفتر العضو', async () => {
    const s = await setup();
    const a = createPendingAsset(s.dev, { name: 'مكيف نقل مبكر مصطنع', category: '1410', unitId: s.ua });
    setAssetCost(s.dev, a, { costHalalas: 84000, purchaseDate: '2026-01-05', today: '2026-02-01' });
    transferAsset(s.dev, a, { unitId: s.ub, date: '2026-04-16', today: '2026-04-20' });
    runDepreciation(s.dev, '2026-05-02');
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, ALL);
    await pulls(s.owner, s.r);
    const out = { v: verdicts(s, ids), owner: ledger(s.owner), member: ledger(s.dev) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    for (const x of out.v) expect(x.slice(1)).toEqual([true, '']);
    expect(out.owner).toEqual(out.member);
    s.close();
  });

  test('(ب) فاتورة شراءٍ ببند أصلٍ في A ثم نقل الأصل إلى B · كلها من العضو: يقبلها المالك ودفتره كدفتر العضو', async () => {
    const s = await setup();
    savePurchase(s.dev, {
      supplier: 'مورد نقل مبكر مصطنع', date: '2026-10-05', due: '2026-11-05', category: 'صيانة', incorpItem: '', amortize: false,
      amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: s.ua, propertyId: null, meterId: null, meterReading: null,
      subtotalHalalas: 360000, taxHalalas: 0, totalHalalas: 360000,
      lines: [{ descr: 'مكيف فاتورة مصطنع', qty: 1, amountHalalas: 360000, isAsset: true, category: '1410', unitId: s.ua, room: '' }],
    } as PurchaseInput);
    const a = s.dev.get<{ id: string }>(`SELECT id FROM assets`)!.id;
    transferAsset(s.dev, a, { unitId: s.ub, date: '2026-10-20', today: '2026-10-20' });
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, ALL);
    // وصفوف الفاتورة وأصلها يكتبها العضو كذلك
    await pulls(s.owner, s.r);
    const out = { v: verdicts(s, ids), owner: ledger(s.owner), member: ledger(s.dev) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out));
    for (const x of out.v) expect(x.slice(1)).toEqual([true, '']);
    expect(out.owner).toEqual(out.member);
    s.close();
  });
});

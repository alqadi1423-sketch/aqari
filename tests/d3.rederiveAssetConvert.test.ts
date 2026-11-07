/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيد تحويل فاتورة الشراء القديمة إلى أصول (asset_convert) من بنودها وأصولها، وإهلاك ما فات
 * لأصولها المحوّلة (asset_catchup) · قيدٌ كتبه عضو بضعف المبلغ، أو بفئةٍ غير فئة البند، أو بأبعاد وحدةٍ أخرى، أو بما يتجاوز ما صُرف
 * في الفاتورة، يُرفض على جهاز المالك ولا يدخل الدفتر · وما يكتبه التطبيق يُقبل، ولو وصل إهلاك ما فات قبل قيد التحويل · بيانات مصطنعة.
 */
import { savePurchase, type PurchaseInput } from '@/domain/purchases';
import { convertPurchase } from '@/domain/assets/convert';
import { purchaseExpenseAccount } from '@/domain/accounting/post';
import type { PurchaseLineInput } from '@/domain/assets/purchaseLines';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, asMember, has, reasonOf, doubled, moved, otherDims, net, srcAsMember, holdBack, lastEntry } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار تحويل أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار تحويل ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'CV-A' });
  const ub = addUnit(p.owner, pb, { unit_no: 'CV-B' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  p.dev.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['SUP-CV', 'مورد تحويل مصطنع', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  return { ...p, pa, pb, ua, ub };
}
type S = Awaited<ReturnType<typeof setup>>;

async function pulls(owner: DB, r: MemoryRemote) {
  for (let i = 0; i < 3; i++) await sync(owner, r);
}

/** فاتورةٌ قديمة مسجّلة مصروفاً بلا بنود، يعرفها جهاز المالك */
async function oldInvoice(s: S) {
  const id = savePurchase(s.dev, {
    supplier: 'مورد تحويل مصطنع', date: '2025-06-15', due: '2025-07-15', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: true, unitId: s.ua, propertyId: null, meterId: null, meterReading: null,
    subtotalHalalas: 300000, taxHalalas: 0, totalHalalas: 300000,
  } as PurchaseInput);
  await sync(s.dev, s.r);
  await pulls(s.owner, s.r);
  return id;
}
/** مكيفان بمبلغٍ واحد (هللته الباقية على الأول)، ورسومٌ تبقى مصروفاً */
const lines = (unitId: string): PurchaseLineInput[] => [
  { descr: 'مكيف محوّل مصطنع', qty: 2, amountHalalas: 200001, isAsset: true, category: '1410', unitId, room: '' },
  { descr: 'رسوم محوّلة مصطنعة', qty: 1, amountHalalas: 99999, isAsset: false },
];

describe('إعادة اشتقاق قيد تحويل الفاتورة القديمة إلى أصول', () => {
  test('سلبي · التحويل بضعف مبلغه (متوازن)، أو بفئةٍ غير فئة البند: يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    const a = await oldInvoice(s);
    const b = await oldInvoice(s);
    convertPurchase(s.dev, a, lines(s.ua), '2026-03-10');
    await sync(s.dev, s.r);
    const k1 = asMember(s.r, 'asset_convert', doubled);
    await pulls(s.owner, s.r);
    convertPurchase(s.dev, b, lines(s.ua), '2026-03-10');
    await sync(s.dev, s.r);
    const k2 = asMember(s.r, 'asset_convert', moved('1410', '1420'));
    await pulls(s.owner, s.r);
    expect(has(s.owner, k1)).toBe(false);
    expect(reasonOf(s.owner, k1)).toMatch(/asset_convert/);
    expect(has(s.owner, k2)).toBe(false);
    expect(reasonOf(s.owner, k2)).toMatch(/1420|1410/);
    expect(net(s.owner, '1420')).toBe(0);
    s.close();
  });

  test('سلبي · أصول التحويل بأبعاد وحدةٍ أخرى: يُرفض', async () => {
    const s = await setup();
    const a = await oldInvoice(s);
    convertPurchase(s.dev, a, lines(s.ua), '2026-03-10');
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'asset_convert', otherDims({ unit_id: s.ub, property_id: s.pb }));
    await pulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/بُعد/);
    s.close();
  });

  test('سلبي · فاتورةٌ صافيها دون ما حُوِّل منها: يُرفض', async () => {
    const s = await setup();
    const a = await oldInvoice(s);
    convertPurchase(s.dev, a, lines(s.ua), '2026-03-10');
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'asset_convert');
    const doc = s.r.docs.get('purchases__' + a)!;
    s.r.inject({ ...doc, d: { ...doc.d, subtotal_halalas: 150000, total_halalas: 150000 } });
    await pulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/يتجاوز ما صُرف/);
    s.close();
  });

  test('سلبي · إهلاك ما فات لأصول التحويل بضعفه: يُرفض', async () => {
    const s = await setup();
    const a = await oldInvoice(s);
    convertPurchase(s.dev, a, lines(s.ua), '2026-03-10');
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^asset_convert$/);
    const k = asMember(s.r, 'asset_catchup', doubled);
    await pulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/asset_catchup/);
    expect(net(s.owner, '1490')).toBe(0);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: التحويل وإهلاك ما فات لأصوله، ولو وصل الإهلاك قبل قيد التحويل', async () => {
    const s = await setup();
    const a = await oldInvoice(s);
    convertPurchase(s.dev, a, lines(s.ua), '2026-03-10');
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, /^(asset_convert|asset_catchup)$/);
    expect(ids.length).toBe(2);
    const late = holdBack(s.r, (d) => d.t === 'journal_entries' && d.d?.src_type === 'asset_convert');
    await pulls(s.owner, s.r);
    const catchup = lastEntry(s.r, 'asset_catchup').k;
    expect([has(s.owner, catchup), reasonOf(s.owner, catchup)]).toEqual([false, '']);
    late.release();
    await pulls(s.owner, s.r);
    for (const k of ids) expect([k, has(s.owner, k), reasonOf(s.owner, k)]).toEqual([k, true, '']);
    expect(net(s.owner, '1410')).toBe(200001);
    // ويبقى مصروفاً ما لم يُحوَّل
    expect(net(s.owner, purchaseExpenseAccount('صيانة'))).toBe(99999);
    s.close();
  });
});

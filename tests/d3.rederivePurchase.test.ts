/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيد فاتورة الشراء وقيد سدادها (purchase وpurchase_pay) من الفاتورة · قيدٌ كتبه عضو بمبلغٍ
 * غير مبلغها، أو بضريبة مدخلاتٍ منقولة إلى المصروف، أو بأصلٍ منقول إلى المصروف، أو بأبعاد وحدةٍ أخرى، يُرفض على جهاز المالك ولا يدخل
 * الدفتر · وما يكتبه التطبيق يُقبل: المستبعدة والقابلة للخصم وذات الأصول، وتعديلها في مزامنةٍ واحدة، وسدادها، وحذفها واستعادتها ·
 * بيانات مصطنعة.
 */
import { savePurchase, payPurchase, deletePurchase, restorePurchase, type PurchaseInput } from '@/domain/purchases';
import { ownerCashIn } from '@/domain/cashOps';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, reasonOf, doubled, moved, otherDims, net, srcAsMember, holdBack } from './helpers/rederive';
import type { DB } from '@/db/adapter';

const DEDUCTIBLE = 'فاتورة ضريبية · قابلة للخصم'; // i18n-exempt: حالة مخزّنة

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار شراء أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار شراء ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'PU-A' });
  const ub = addUnit(p.owner, pb, { unit_no: 'PU-B' });
  ownerCashIn(p.owner, { amountHalalas: 5000000, date: '2026-10-01' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  p.dev.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['SUP-RD', 'مورد شراء مصطنع', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  return { ...p, pa, pb, ua, ub };
}

const input = (unitId: string | null, over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد شراء مصطنع', date: '2026-10-15', due: '2026-11-15', category: 'صيانة', incorpItem: '', amortize: false,
  amortizeMonths: null, exempt: false, excludeFromVat: false, unitId, propertyId: null, meterId: null, meterReading: null,
  subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000, ...over,
});
const buy = (db: DB, unitId: string | null, over: Partial<PurchaseInput> = {}, id?: string) => savePurchase(db, input(unitId, over), id);
const withAsset = (unitId: string): Partial<PurchaseInput> => ({
  excludeFromVat: true, subtotalHalalas: 400000, taxHalalas: 0, totalHalalas: 400000,
  lines: [
    { descr: 'مكيف مصطنع', qty: 2, amountHalalas: 300001, isAsset: true, category: '1410', unitId, room: '' },
    { descr: 'تركيب مصطنع', qty: 1, amountHalalas: 99999, isAsset: false },
  ],
});

describe('إعادة اشتقاق قيدي فاتورة الشراء وسدادها من الفاتورة', () => {
  test('سلبي · الفاتورة بضعف مبلغها (متوازن): يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    buy(s.dev, s.ua);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'purchase', doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/purchase/);
    expect(net(s.owner, '2100')).toBe(0);
    s.close();
  });

  test('سلبي · ضريبة المدخلات القابلة للخصم منقولةٌ إلى المصروف 5300: يُرفض', async () => {
    const s = await setup();
    buy(s.dev, s.ua, { taxStatus: DEDUCTIBLE });
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'purchase', moved('1270', '5300'));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/5300|1270/);
    s.close();
  });

  test('سلبي · تكلفة الأصل منقولةٌ إلى المصروف (أصلٌ بلا قيد تكلفته): يُرفض', async () => {
    const s = await setup();
    buy(s.dev, s.ua, withAsset(s.ua));
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'purchase', moved('1410', '5300'));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/5300|1410/);
    s.close();
  });

  test('سلبي · سطور الفاتورة بوحدةٍ وعقارٍ غير وحدتها: يُرفض', async () => {
    const s = await setup();
    buy(s.dev, s.ua);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'purchase', otherDims({ unit_id: s.ub, property_id: s.pb }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/بُعد/);
    s.close();
  });

  test('سلبي · السداد بضعف الإجمالي، أو بأبعاد وحدةٍ أخرى: يُرفض', async () => {
    const s = await setup();
    const a = buy(s.dev, s.ua);
    const b = buy(s.dev, s.ua);
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^purchase$/);
    await ownerPulls(s.owner, s.r);
    payPurchase(s.dev, a, 'cash', null, '2026-10-20');
    await sync(s.dev, s.r);
    const k1 = asMember(s.r, 'purchase_pay', doubled);
    await ownerPulls(s.owner, s.r);
    payPurchase(s.dev, b, 'cash', null, '2026-10-21');
    await sync(s.dev, s.r);
    const k2 = asMember(s.r, 'purchase_pay', otherDims({ unit_id: s.ub, property_id: s.pb }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k1)).toBe(false);
    expect(reasonOf(s.owner, k1)).toMatch(/purchase_pay/);
    expect(has(s.owner, k2)).toBe(false);
    expect(reasonOf(s.owner, k2)).toMatch(/بُعد/);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: المستبعدة، والقابلة للخصم، وذات الأصول بأبعاد كل أصل، وسدادها', async () => {
    const s = await setup();
    const a = buy(s.dev, s.ua);
    buy(s.dev, null, { taxStatus: DEDUCTIBLE });
    // الفاتورة بلا وحدة، وأصولها بوحدتها: سطر كل أصلٍ بأصله ووحدته وعقاره
    buy(s.dev, null, withAsset(s.ub));
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, /^purchase$/);
    expect(ids.length).toBe(3);
    await ownerPulls(s.owner, s.r);
    payPurchase(s.dev, a, 'cash', null, '2026-10-20');
    await sync(s.dev, s.r);
    ids.push(asMember(s.r, 'purchase_pay'));
    await ownerPulls(s.owner, s.r);
    for (const k of ids) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    expect(net(s.owner, '1410')).toBe(300001);
    expect(net(s.owner, '1270')).toBe(15000);
    expect(net(s.owner, '2100')).toBe(-(115000 + 400000));
    s.close();
  });

  test('إيجابي · تعديل الفاتورة في مزامنةٍ واحدة، ثم حذفها واستعادتها: القيود والعواكس تُقبل والذمة بقيمها الأخيرة', async () => {
    const s = await setup();
    const id = buy(s.dev, s.ua);
    buy(s.dev, s.ub, { subtotalHalalas: 200000, taxHalalas: 30000, totalHalalas: 230000 }, id);
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, /^purchase(_rev)?$/);
    expect(ids.length).toBe(3);
    await ownerPulls(s.owner, s.r);
    deletePurchase(s.dev, id);
    restorePurchase(s.dev, id);
    await sync(s.dev, s.r);
    const all = srcAsMember(s.r, /^purchase(_rev)?$/);
    expect(all.length).toBe(5);
    await ownerPulls(s.owner, s.r);
    for (const k of all) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    expect(net(s.owner, '2100')).toBe(-230000);
    s.close();
  });
  test('إيجابي · قيد فاتورةٍ وصل قبل بعض بنودها (رفع العضو على دفعات) يُنتظر ثم يُقبل حين تصل', async () => {
    const s = await setup();
    // غير قابلة للخصم: ضريبتها موزّعةٌ على البنود بأساس كلٍّ منها، فبندٌ لم يصل يغيّر نصيب الأصل منها
    const id = buy(s.dev, s.ua, { ...withAsset(s.ua), excludeFromVat: false, taxHalalas: 60000, totalHalalas: 460000 });
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'purchase');
    const late = [...s.r.docs.values()].filter((d) => d.t === 'purchase_lines' && d.d?.purchase_id === id && !d.d?.is_asset);
    expect(late.length).toBe(1);
    for (const d of late) s.r.docs.delete(d.id);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toBe('');
    for (const d of late) s.r.inject(d);
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, k)).toBe(true);
    s.close();
  });

  test('إيجابي · قيد فاتورةٍ وصل قبل بند أصلها وحده، أو قبل بنودها كلها، يُنتظر ثم يُقبل حين تصل (المتحقق المستقل)', async () => {
    const s = await setup();
    const a = buy(s.dev, s.ua, withAsset(s.ua));
    const b = buy(s.dev, s.ua, withAsset(s.ua));
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, /^purchase$/);
    expect(ids.length).toBe(2);
    // فاتورةٌ وصل بندها العادي دون بند أصلها، وأخرى لم يصل من بنودها شيء
    const late = holdBack(s.r, (d) => d.t === 'purchase_lines' && (d.d?.purchase_id === b || (d.d?.purchase_id === a && !!Number(d.d?.is_asset))));
    expect(late.count).toBe(3);
    await ownerPulls(s.owner, s.r);
    for (const k of ids) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(false);
    }
    late.release();
    await ownerPulls(s.owner, s.r);
    for (const k of ids) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    expect(net(s.owner, '1410')).toBe(2 * 300001);
    s.close();
  });
});

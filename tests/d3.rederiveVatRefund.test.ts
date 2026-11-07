/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيد استرداد ضريبة المدخلات أو رفضه (vat_refund) من فاتورة الشراء · قيدٌ كتبه عضو بضعف
 * الضريبة، أو باستردادٍ منقولٍ إلى المصروف، أو بأبعادٍ لا يشتقها مصدره، أو على فاتورةٍ غير قابلة للخصم، يُرفض على جهاز المالك ولا
 * يدخل الدفتر · وما يكتبه التطبيق يُقبل: الاسترداد، والرفض، وإلغاء الاسترداد ثم رفضه · بيانات مصطنعة.
 */
import { savePurchase, markVatRefunded, markVatRejected, type PurchaseInput } from '@/domain/purchases';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, reasonOf, doubled, moved, otherDims, net, srcAsMember, forge, lastEntry } from './helpers/rederive';
import type { DB } from '@/db/adapter';

const DEDUCTIBLE = 'فاتورة ضريبية · قابلة للخصم'; // i18n-exempt: حالة مخزّنة

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار استرداد مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'VR-A' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  p.dev.run(`INSERT INTO suppliers (id, name, vat, category, default_category, created_at) VALUES (?,?,?,?,?,?)`,
    ['SUP-VR', 'مورد استرداد مصطنع', '310999999900003', 'صيانة', 'صيانة', new Date().toISOString()]);
  return { ...p, pa, ua };
}
const buy = (db: DB, over: Partial<PurchaseInput> = {}) => savePurchase(db, {
  supplier: 'مورد استرداد مصطنع', date: '2026-10-05', due: '2026-11-05', category: 'صيانة', incorpItem: '', amortize: false,
  amortizeMonths: null, exempt: false, excludeFromVat: false, unitId: null, propertyId: null, meterId: null, meterReading: null,
  taxStatus: DEDUCTIBLE, subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000, ...over,
});

/** فاتورتان قابلتان للخصم على جهاز العضو، يعرفهما جهاز المالك */
async function bought(s: Awaited<ReturnType<typeof setup>>) {
  const a = buy(s.dev);
  const b = buy(s.dev);
  await sync(s.dev, s.r);
  srcAsMember(s.r, /^purchase$/);
  await ownerPulls(s.owner, s.r);
  return { a, b };
}

describe('إعادة اشتقاق قيد استرداد ضريبة المدخلات من فاتورته', () => {
  test('سلبي · الاسترداد بضعف الضريبة (متوازن): يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    const { a } = await bought(s);
    markVatRefunded(s.dev, a, '2026-10-20');
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'vat_refund', doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/vat_refund/);
    expect(net(s.owner, '1270')).toBe(2 * 15000);
    s.close();
  });

  test('سلبي · الاسترداد النقدي منقولٌ إلى المصروف 5300 (والفاتورة «مسترَدة»)، أو بأبعاد وحدة: يُرفض', async () => {
    const s = await setup();
    const { a, b } = await bought(s);
    markVatRefunded(s.dev, a, '2026-10-20');
    await sync(s.dev, s.r);
    const k1 = asMember(s.r, 'vat_refund', moved('1100', '5300'));
    await ownerPulls(s.owner, s.r);
    markVatRefunded(s.dev, b, '2026-10-21');
    await sync(s.dev, s.r);
    const k2 = asMember(s.r, 'vat_refund', otherDims({ unit_id: s.ua, property_id: s.pa }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k1)).toBe(false);
    expect(reasonOf(s.owner, k1)).toMatch(/5300|1100/);
    expect(has(s.owner, k2)).toBe(false);
    expect(reasonOf(s.owner, k2)).toMatch(/بُعد/);
    s.close();
  });

  test('سلبي · قيد استردادٍ على فاتورةٍ غير قابلة للخصم (لا 1270 لها): يُرفض', async () => {
    const s = await setup();
    const { a } = await bought(s);
    const x = buy(s.dev, { taxStatus: 'غير قابلة للخصم', excludeReason: 'باسم المالك مصطنع' }); // i18n-exempt: حالة مخزّنة
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^purchase$/);
    await ownerPulls(s.owner, s.r);
    markVatRefunded(s.dev, a, '2026-10-20');
    await sync(s.dev, s.r);
    const o = lastEntry(s.r, 'vat_refund');
    const f = forge({ ...o, d: { ...o.d, src_id: x } }, { lines: o.lines! });
    s.r.inject(f);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, f.k)).toBe(false);
    expect(reasonOf(s.owner, f.k)).toMatch(/vat_refund/);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: الاسترداد، والرفض بأي تاريخ، وإلغاء الاسترداد ثم رفضه · و1270 يُقفل', async () => {
    const s = await setup();
    const { a, b } = await bought(s);
    markVatRefunded(s.dev, a, '2026-10-20');
    markVatRejected(s.dev, b, '2026-10-25');
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, /^vat_refund$/);
    expect(ids.length).toBe(2);
    await ownerPulls(s.owner, s.r);
    const k = ids.find((id) => s.owner.get(`SELECT 1 FROM journal_lines WHERE entry_id = ? AND account_code = '1100'`, [id]))!;
    const op = entrySourceAction(s.dev, k);
    if (op?.kind !== 'op') throw new Error('op'); // i18n-exempt: رسالة اختبار
    op.run('2026-10-26', 'إلغاء مصطنع');
    markVatRejected(s.dev, a, '2026-10-27');
    await sync(s.dev, s.r);
    const all = srcAsMember(s.r, /^vat_refund(_rev)?$/);
    expect(all.length).toBe(4);
    await ownerPulls(s.owner, s.r);
    for (const id of all) {
      expect(reasonOf(s.owner, id)).toBe('');
      expect(has(s.owner, id)).toBe(true);
    }
    expect(net(s.owner, '1270')).toBe(0);
    expect(net(s.owner, '5300')).toBe(2 * 115000);
    s.close();
  });
});

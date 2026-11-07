/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيد عمولة التقبيل (key_money) من صفقته · قيدٌ كتبه عضو بمبلغٍ غير العمولة، أو بضريبتها في
 * الإيراد والمنشأة مسجّلة، أو بأبعاد وحدةٍ أخرى، يُرفض على جهاز المالك ولا يدخل الدفتر · وما يكتبه التطبيق يُقبل (بلا تسجيلٍ في
 * الضريبة ومعه) · بيانات مصطنعة.
 */
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, reasonOf, doubled, moved, otherDims, net } from './helpers/rederive';
import type { DB } from '@/db/adapter';

const SRC = 'key_money';

async function setup(vat = false) {
  const p = await pair();
  if (vat) for (const db of [p.owner, p.dev]) db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
  const pa = addProperty(p.owner, { name: 'عقار تقبيل أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار تقبيل ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'KM-A' });
  const ub = addUnit(p.owner, pb, { unit_no: 'KM-B' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub };
}
const deal = (db: DB, unit: string, n: number) => recordKeyMoneyDeal(db, { unitId: unit, contractId: null,
  outgoing: 'متنازل مصطنع ' + n, incoming: 'متنازل له مصطنع ' + n, amountHalalas: 5000000, date: '2026-11-01',
  commissionHalalas: 230000, method: 'cash', notes: '' });

describe('إعادة اشتقاق قيد عمولة التقبيل من صفقته', () => {
  test('سلبي · العمولة بضعفها (متوازن): يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    deal(s.dev, s.ua, 1);
    await sync(s.dev, s.r);
    const k = asMember(s.r, SRC, doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/key_money/);
    s.close();
  });

  test('سلبي · المنشأة مسجّلة وضريبة العمولة منقولةٌ إلى الإيراد 4300: يُرفض', async () => {
    const s = await setup(true);
    deal(s.dev, s.ua, 2);
    await sync(s.dev, s.r);
    const k = asMember(s.r, SRC, moved('2200', '4300'));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/4300|2200/);
    s.close();
  });

  test('سلبي · سطوره بوحدةٍ وعقارٍ غير وحدة الصفقة: يُرفض', async () => {
    const s = await setup();
    deal(s.dev, s.ua, 3);
    await sync(s.dev, s.r);
    const k = asMember(s.r, SRC, otherDims({ unit_id: s.ub, property_id: s.pb }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/بُعد/);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: بلا تسجيلٍ في الضريبة، وبأبعاد صفقته إن مُلئت', async () => {
    const s = await setup();
    deal(s.dev, s.ua, 4);
    await sync(s.dev, s.r);
    const k1 = asMember(s.r, SRC);
    await ownerPulls(s.owner, s.r);
    deal(s.dev, s.ub, 5);
    await sync(s.dev, s.r);
    const k2 = asMember(s.r, SRC, otherDims({ unit_id: s.ub, property_id: s.pb }));
    await ownerPulls(s.owner, s.r);
    for (const k of [k1, k2]) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    s.close();
  });

  test('إيجابي · والمنشأة مسجّلة: صافي العمولة في 4300 وضريبتها في 2200 يُقبل', async () => {
    const s = await setup(true);
    deal(s.dev, s.ua, 6);
    await sync(s.dev, s.r);
    const k = asMember(s.r, SRC);
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, k)).toBe(true);
    expect(s.owner.get(`SELECT credit_halalas AS c FROM journal_lines WHERE entry_id = ? AND account_code = '2200'`, [k])).toEqual({ c: 30000 });
    s.close();
  });

  test('إيجابي · إلغاء التقبيل من الجهاز الثاني يصل جهاز المالك ويُقبل عاكسه (بأبعاد أصله كما هي) فيرجع إيراده صفراً', async () => {
    const s = await setup();
    deal(s.dev, s.ua, 7);
    await sync(s.dev, s.r);
    const k = asMember(s.r, SRC);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(true);
    const a = entrySourceAction(s.dev, k);
    if (a?.kind !== 'op') throw new Error('op'); // i18n-exempt: رسالة اختبار
    a.run('2026-11-02', 'إلغاء مصطنع');
    await sync(s.dev, s.r);
    const rev = asMember(s.r, SRC + '_rev');
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, rev)).toBe('');
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, rev)).toBe(true);
    expect(s.owner.get(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [k])).toEqual({ r: rev });
    expect(net(s.owner, '4300')).toBe(0);
    s.close();
  });
});

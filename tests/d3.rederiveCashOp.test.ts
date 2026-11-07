/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيد العملية النقدية (cash_op) · لا صفّ يحمل مبلغها إلا حركة البنك اليدوية المربوطة برقم قيدها
 * (الرسوم والوارد الآخر)، فتُشتق منها نوعاً ومبلغاً وتاريخاً · وبلا حركة: المصروف النثري وإيداع المالك ومسحوباته بأطرافها الثابتة ·
 * قيدٌ كتبه عضو بضعف حركة بنكه، أو بضريبة مخرجاتٍ على الوارد اليدوي (المراجعة الشاملة · البند ١١)، أو برسومٍ قُيّدت مسحوباتٍ للمالك،
 * أو بحسابٍ خارج أطرافها، أو بأبعاد عقار، يُرفض على جهاز المالك ولا يدخل الدفتر · وما يكتبه التطبيق يُقبل، ومنه إلغاء العملية ·
 * بيانات مصطنعة.
 */
import { pettyCashExpense, ownerCashIn, ownerCashOut, recordManualBankTx } from '@/domain/cashOps';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { addProperty, addBank } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, reasonOf, doubled, moved, otherDims, net, srcAsMember, type Lines } from './helpers/rederive';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار نقد مصطنع' });
  const bank = addBank(p.owner, 'بنك نقد مصطنع', 1000000);
  ownerCashIn(p.owner, { amountHalalas: 500000, date: '2026-10-01' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, bank };
}
const income = (s: Awaited<ReturnType<typeof setup>>, amount = 11500) =>
  recordManualBankTx(s.dev, { kind: 'income', bankId: s.bank, amountHalalas: amount, date: '2026-10-10', descr: 'وارد مصطنع' });
const fee = (s: Awaited<ReturnType<typeof setup>>) =>
  recordManualBankTx(s.dev, { kind: 'fee', bankId: s.bank, amountHalalas: 2500, date: '2026-10-11', descr: 'رسوم مصطنعة' });
/** ضريبة مخرجاتٍ ١٥٪ تُقتطع من الوارد إلى 2200 (القيد يبقى متوازناً) */
const withOutputVat = (ls: Lines): Lines => ls.flatMap((l) => (l.account_code === '4300'
  ? [{ ...l, credit_halalas: 10000 }, { ...l, id: String(l.id) + '-vat', account_code: '2200', credit_halalas: 1500 }]
  : [l]));

describe('إعادة اشتقاق قيد العملية النقدية من حركة بنكه أو أطرافه', () => {
  test('سلبي · الوارد البنكي اليدوي بضعف حركته (متوازن): يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    income(s);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'cash_op', doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/cash_op/);
    expect(net(s.owner, '4300')).toBe(0);
    s.close();
  });

  test('سلبي · البند ١١: ضريبة مخرجاتٍ على الوارد اليدوي إلى 2200: يُرفض', async () => {
    const s = await setup();
    income(s);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'cash_op', withOutputVat);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/2200|4300/);
    expect(net(s.owner, '2200')).toBe(0);
    s.close();
  });

  test('سلبي · رسوم البنك مقيّدةً مسحوباتٍ للمالك 3100 (وحركتها رسوم): يُرفض', async () => {
    const s = await setup();
    fee(s);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'cash_op', moved('5400', '3100'));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/3100|5400/);
    s.close();
  });

  test('سلبي · المصروف النثري على إيراد الإيجار 4100، أو إيداع المالك بأبعاد عقار: يُرفض', async () => {
    const s = await setup();
    pettyCashExpense(s.dev, { amountHalalas: 3000, descr: 'نثرية مصطنعة', date: '2026-10-12' });
    await sync(s.dev, s.r);
    const k1 = asMember(s.r, 'cash_op', moved('5400', '4100'));
    await ownerPulls(s.owner, s.r);
    ownerCashIn(s.dev, { amountHalalas: 7000, date: '2026-10-13' });
    await sync(s.dev, s.r);
    const k2 = asMember(s.r, 'cash_op', otherDims({ property_id: s.pa }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k1)).toBe(false);
    expect(reasonOf(s.owner, k1)).toMatch(/4100|5400/);
    expect(has(s.owner, k2)).toBe(false);
    expect(reasonOf(s.owner, k2)).toMatch(/بُعد/);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: النثرية، وإيداع المالك ومسحوباته، والرسوم، والوارد بلا ضريبة، وإلغاء الوارد', async () => {
    const s = await setup();
    pettyCashExpense(s.dev, { amountHalalas: 3000, descr: 'نثرية مصطنعة', date: '2026-10-12' });
    ownerCashIn(s.dev, { amountHalalas: 7000, date: '2026-10-13' });
    ownerCashOut(s.dev, { amountHalalas: 4000, date: '2026-10-14' });
    fee(s);
    income(s);
    await sync(s.dev, s.r);
    const ids = srcAsMember(s.r, /^cash_op$/);
    await ownerPulls(s.owner, s.r);
    const inc = ids.find((id) => s.owner.get(`SELECT 1 FROM journal_lines WHERE entry_id = ? AND account_code = '4300'`, [id]))!;
    const op = entrySourceAction(s.dev, inc);
    if (op?.kind !== 'op') throw new Error('op'); // i18n-exempt: رسالة اختبار
    op.run('2026-10-15', 'إلغاء مصطنع');
    await sync(s.dev, s.r);
    const all = srcAsMember(s.r, /^cash_op(_rev)?$/);
    await ownerPulls(s.owner, s.r);
    // ستٌّ كتبها الجهاز الثاني، وإيداع المالك في التهيئة قائمٌ على جهازه
    expect(new Set(all).size).toBe(7);
    for (const k of all) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    expect(net(s.owner, '4300')).toBe(0);
    expect(net(s.owner, '5400')).toBe(3000 + 2500);
    s.close();
  });
});

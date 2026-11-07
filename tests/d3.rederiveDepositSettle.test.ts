/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيود تسوية التأمين (deposit_deduct وdeposit_deduct_move وdeposit_refund) من صفّ التسوية وعقده ·
 * قيدٌ كتبه عضو بمبلغٍ أو حسابٍ أو بُعدٍ يخالف ما تشتقه التسوية (المخصوم والمردود، وجهة القبض، ووجهة المخصوم لدى المنصة) يُرفض على
 * جهاز المالك ولا يدخل الدفتر · والمطابق يُقبل، ومنه تعديل التسوية (يعكس القديم ويرحّل الجديد) واصلاً بعد مزامنةٍ أو معها · بيانات
 * مصطنعة.
 */
import { confirmContract, saveDepositSettlement } from '@/domain/contracts/service';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, reasonOf, doubled, moved, otherDims, MEMBER } from './helpers/rederive';
import type { DB } from '@/db/adapter';
import type { MemoryRemote } from './helpers/memoryRemote';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار تسوية أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار تسوية ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'DS-A' });
  const ub = addUnit(p.owner, pb, { unit_no: 'DS-B' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub };
}
/** عقدٌ منتهٍ بتأمين ٣٠٠٠ ريال لدى الجهة · على الجهاز الثاني ثم في الحساب وعلى جهاز المالك */
async function ended(s: Awaited<ReturnType<typeof setup>>, unit: string, n: number, holder = 'المكتب') {
  const id = confirmContract(s.dev, { ...contractInput(unit, { tenant: 'مستأجر تسوية مصطنع ' + n, idNumber: '10000022' + String(n).padStart(2, '0'),
    phone: '05000002' + String(n).padStart(2, '0'), start: '2026-01-01', end: '2026-06-30', depositHalalas: 300000 }), depositHolder: holder } as never);
  await sync(s.dev, s.r);
  await ownerPulls(s.owner, s.r);
  return id;
}
const settle = (db: DB, c: string, deduction: number, refund: number, dest?: string) =>
  saveDepositSettlement(db, c, { date: '2026-07-05', deductionHalalas: deduction, deductionReason: 'إصلاح مصطنع', refundHalalas: refund,
    notes: '', deductDestination: dest } as never);
/** كل قيود التسوية في الحساب بكاتبها العضو */
function allAsMember(r: MemoryRemote): string[] {
  const ids: string[] = [];
  for (const d of [...r.docs.values()]) {
    if (d.t !== 'journal_entries' || !/^deposit_(deduct|deduct_move|refund)(_rev)?$/.test(String(d.d?.src_type))) continue;
    r.inject({ ...d, by: MEMBER });
    ids.push(d.k);
  }
  return ids;
}

describe('إعادة اشتقاق قيود تسوية التأمين من صفّ التسوية', () => {
  test('سلبي · قيد الخصم بضعف المخصوم (متوازن): يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    const c = await ended(s, s.ua, 1);
    settle(s.dev, c, 100000, 200000);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'deposit_deduct', doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/deposit_deduct/);
    s.close();
  });

  test('سلبي · الرد منقولٌ من النقد إلى محفظة إيجار: يُرفض', async () => {
    const s = await setup();
    const c = await ended(s, s.ua, 2);
    settle(s.dev, c, 100000, 200000);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'deposit_refund', moved('1100', '1265'));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/1265/);
    s.close();
  });

  test('سلبي · استقرار المخصوم لدى المنصة بأبعاد عقدٍ آخر ووحدته وعقاره: يُرفض', async () => {
    const s = await setup();
    const other = await ended(s, s.ub, 3);
    const c = await ended(s, s.ua, 4, 'منصة إيجار');
    settle(s.dev, c, 100000, 200000, 'حسابنا');
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'deposit_deduct_move', otherDims({ contract_id: other, unit_id: s.ub, property_id: s.pb }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/بُعد/);
    s.close();
  });

  test('سلبي · استقرار المخصوم إلى النقد وصفّ التسوية يقول محفظة إيجار: يُرفض', async () => {
    const s = await setup();
    const c = await ended(s, s.ua, 5, 'منصة إيجار');
    settle(s.dev, c, 100000, 200000);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'deposit_deduct_move', moved('1265', '1100'));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: لدى المكتب، ولدى المنصة إلى حسابنا، ولدى طرف آخر وصل مخصومه', async () => {
    const s = await setup();
    const a = await ended(s, s.ua, 6);
    const b = await ended(s, s.ub, 7, 'منصة إيجار');
    settle(s.dev, a, 100000, 200000);
    settle(s.dev, b, 120000, 180000, 'حسابنا');
    const t = confirmContract(s.dev, { ...contractInput(s.ua, { tenant: 'مستأجر تسوية مصطنع 8', idNumber: '1000002208',
      phone: '0500000228', start: '2025-01-01', end: '2025-06-30', depositHalalas: 300000 }), depositHolder: 'طرف آخر', depositHolderName: 'جهة مصطنعة' } as never);
    saveDepositSettlement(s.dev, t, { date: '2026-07-05', deductionHalalas: 50000, deductionReason: 'إصلاح مصطنع', refundHalalas: 250000,
      notes: '', deductReceived: true } as never);
    await sync(s.dev, s.r);
    const ids = allAsMember(s.r);
    expect(ids.length).toBe(6);
    await ownerPulls(s.owner, s.r);
    for (const k of ids) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    s.close();
  });

  test('إيجابي · تعديل التسوية: بعد مزامنة الأولى، ومعها في مزامنةٍ واحدة (القيد القديم يصل معكوساً) · يُقبل كله', async () => {
    const s = await setup();
    const a = await ended(s, s.ua, 9);
    settle(s.dev, a, 100000, 200000);
    await sync(s.dev, s.r);
    allAsMember(s.r);
    await ownerPulls(s.owner, s.r);
    settle(s.dev, a, 50000, 250000);
    await sync(s.dev, s.r);
    const b = await ended(s, s.ub, 10);
    settle(s.dev, b, 100000, 200000);
    settle(s.dev, b, 30000, 270000);
    await sync(s.dev, s.r);
    const ids = allAsMember(s.r);
    await ownerPulls(s.owner, s.r);
    for (const k of ids) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    const live = (c: string) => s.owner.get(`SELECT SUM(l.debit_halalas - l.credit_halalas) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.src_id = ? AND e.src_type LIKE 'deposit_%' AND l.account_code = '4300'`, [c]);
    expect(live(a)).toEqual({ n: -50000 });
    expect(live(b)).toEqual({ n: -30000 });
    s.close();
  });

  test('سلبي · صفّ تسويةٍ ردُّه ضعفه وقيد ردٍّ يطابقه (التسوية تتجاوز التأمين): يُرفض', async () => {
    const s = await setup();
    const c = await ended(s, s.ua, 12);
    settle(s.dev, c, 100000, 200000);
    await sync(s.dev, s.r);
    const row = [...s.r.docs.values()].find((d) => d.t === 'deposit_settlements' && d.k === c)!;
    s.r.inject({ ...row, by: MEMBER, d: { ...row.d, refund_halalas: 400000 } });
    const k = asMember(s.r, 'deposit_refund', doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/توزّع/);
    s.close();
  });

  test('سلبي · قيدٌ وصل معكوساً ومبلغه مضاعف وعاكسه بمبلغ التطبيق: يُرفض', async () => {
    const s = await setup();
    const a = await ended(s, s.ua, 11);
    settle(s.dev, a, 100000, 200000);
    settle(s.dev, a, 50000, 250000);
    await sync(s.dev, s.r);
    allAsMember(s.r);
    const first = [...s.r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'deposit_deduct' && d.d?.reversed_by)!;
    s.r.inject({ ...first, lines: doubled(first.lines!) });
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, first.k)).toBe(false);
    expect(reasonOf(s.owner, first.k)).toMatch(/معكوس/);
    s.close();
  });
});

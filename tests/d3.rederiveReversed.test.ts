/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق (تتمة · المتحقق المستقل): القيد الواصل معكوساً من عضو لا يُقبل إلا بعاكسٍ سيُقبل بعده فعلاً ·
 * عاكسٌ مرآةٌ بسطوره كلها (الصفري منها) كما يفحصه memberReversalCheck، لم يُربط بأصلٍ آخر هنا أو في الوارد، ولم يُطبَّق قبله · بيانات
 * مصطنعة.
 */
import { confirmContract, saveDepositSettlement } from '@/domain/contracts/service';
import { saveClaim } from '@/domain/claims';
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, reasonOf, lastEntry, forge, mirrorOf, net, srcAsMember, type Lines } from './helpers/rederive';
import type { DB } from '@/db/adapter';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار عكس أ مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'RV-A' });
  const ub = addUnit(p.owner, pa, { unit_no: 'RV-B' });
  const a = confirmContract(p.owner, contractInput(ua, { tenant: 'مستأجر عكس أ مصطنع', idNumber: '1000002601', phone: '0500002601', depositHalalas: 0 }));
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, ua, ub, a };
}
const scaled = (ls: Lines, n: number): Lines =>
  ls.map((l) => ({ ...l, debit_halalas: Number(l.debit_halalas) * n, credit_halalas: Number(l.credit_halalas) * n }));
const claim = (db: DB, contractId: string, amount = 80000, id?: string) =>
  saveClaim(db, { contractId, amountHalalas: amount, reason: 'إصلاح مصطنع', date: '2026-10-01' }, id);
const cancelOp = (db: DB, entryId: string, date: string) => {
  const a = entrySourceAction(db, entryId);
  if (a?.kind !== 'op') throw new Error('op'); // i18n-exempt: رسالة اختبار
  a.run(date, 'إلغاء مصطنع');
};

describe('القيد الواصل معكوساً من عضو: عاكسه سيُقبل بعده فعلاً', () => {
  test('سلبي · مطالبة بـ٩٩٩ ألف ريال معكوسة بعاكسٍ فيه سطرٌ صفري زائد (يُرفض بعدها): لا يدخل الدفتر', async () => {
    const s = await setup();
    claim(s.dev, s.a);
    await sync(s.dev, s.r);
    await ownerPulls(s.owner, s.r);
    const before = net(s.owner, '4300');
    const o = lastEntry(s.r, 'claim');
    const big = scaled(o.lines!, 99900000 / 80000);
    const rk = 'forged-rev-zero';
    const f = forge(o, { reversed_by: rk, lines: big });
    const rf = forge(o, { k: rk, src_type: 'claim_rev', lines: [...mirrorOf(big), { ...big[0], account_code: '1100', debit_halalas: 0, credit_halalas: 0 }] });
    s.r.inject(f);
    s.r.inject(rf);
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, f.k)).toBe(false);
    expect(net(s.owner, '4300')).toBe(before);
    s.close();
  });

  test('سلبي · عاكسٌ برقم قيدٍ قائم (يُرفض بتفرّد الرقم بعدها): لا يدخل القيد المعكوس به', async () => {
    const s = await setup();
    claim(s.dev, s.a);
    await sync(s.dev, s.r);
    await ownerPulls(s.owner, s.r);
    const before = net(s.owner, '4300');
    const o = lastEntry(s.r, 'claim');
    const big = scaled(o.lines!, 50);
    const rk = 'forged-rev-no';
    const f = forge(o, { reversed_by: rk, lines: big });
    const rf = forge(o, { k: rk, src_type: 'claim_rev', no: String(o.d!.no), lines: mirrorOf(big) });
    s.r.inject(f);
    s.r.inject(rf);
    await ownerPulls(s.owner, s.r);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, f.k)).toBe(false);
    expect(net(s.owner, '4300')).toBe(before);
    s.close();
  });

  test('سلبي · المطالبة: نسخةٌ من القيد القديم بعد تعديلها معكوسةٌ بعاكسه المربوط به: يُرفض', async () => {
    const s = await setup();
    const id = claim(s.dev, s.a);
    claim(s.dev, s.a, 95000, id);
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^claim(_rev)?$/);
    await ownerPulls(s.owner, s.r);
    expect(net(s.owner, '1250')).toBe(95000);
    const old = [...s.r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'claim' && d.d?.reversed_by)!;
    const f = forge(old, { reversed_by: String(old.d!.reversed_by), lines: old.lines! });
    s.r.inject(f);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, f.k)).toBe(false);
    expect(reasonOf(s.owner, f.k)).toMatch(/claim/);
    expect(net(s.owner, '1250')).toBe(95000);
    s.close();
  });

  test('سلبي · تسوية التأمين: نسخةٌ من الخصم القديم بعد تعديلها معكوسةٌ بعاكسه: يُرفض', async () => {
    const s = await setup();
    const c = confirmContract(s.dev, { ...contractInput(s.ub, { tenant: 'مستأجر عكس ب مصطنع', idNumber: '1000002602', phone: '0500002602',
      start: '2026-01-01', end: '2026-06-30', depositHalalas: 300000 }), depositHolder: 'المكتب' } as never);
    await sync(s.dev, s.r);
    await ownerPulls(s.owner, s.r);
    const settle = (d: number, r: number) => saveDepositSettlement(s.dev, c, { date: '2026-07-05', deductionHalalas: d,
      deductionReason: 'إصلاح مصطنع', refundHalalas: r, notes: '' });
    settle(100000, 200000);
    settle(50000, 250000);
    await sync(s.dev, s.r);
    srcAsMember(s.r, /^deposit_(deduct|refund)(_rev)?$/);
    await ownerPulls(s.owner, s.r);
    const live = () => net(s.owner, '4300', `e.src_id = ? AND e.src_type LIKE 'deposit_%'`, [c]);
    expect(live()).toBe(-50000);
    const old = [...s.r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'deposit_deduct' && d.d?.reversed_by)!;
    const f = forge(old, { reversed_by: String(old.d!.reversed_by), lines: old.lines! });
    s.r.inject(f);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, f.k)).toBe(false);
    expect(live()).toBe(-50000);
    s.close();
  });

  test('سلبي · التقبيل: بعد إلغائه على جهاز المالك نسخةٌ من قيده معكوسةٌ بعاكس المالك: يُرفض', async () => {
    const s = await setup();
    recordKeyMoneyDeal(s.dev, { unitId: s.ua, contractId: null, outgoing: 'متنازل مصطنع', incoming: 'متنازل له مصطنع',
      amountHalalas: 5000000, date: '2026-11-01', commissionHalalas: 50000, method: 'cash', notes: '' });
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'key_money');
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(true);
    cancelOp(s.owner, k, '2026-11-02');
    await sync(s.owner, s.r);
    expect(net(s.owner, '4300')).toBe(0);
    const kr = s.owner.get<{ r: string }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [k])!.r;
    const o = [...s.r.docs.values()].find((d) => d.k === k)!;
    // مرآة عاكس المالك بأبعاده
    const f = forge(o, { reversed_by: kr, lines: mirrorOf([...s.r.docs.values()].find((d) => d.k === kr)!.lines!) });
    s.r.inject(f);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, f.k)).toBe(false);
    expect(net(s.owner, '4300')).toBe(0);
    s.close();
  });
});

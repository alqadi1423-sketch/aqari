/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيد المطالبة وقيد تحصيلها (claim وclaim_collect) من المطالبة · قيدٌ كتبه عضو بمبلغٍ غير مبلغها،
 * أو بحسابٍ منقول، أو بأبعاد عقدٍ آخر، يُرفض على جهاز المالك ولا يدخل الدفتر · وما يكتبه التطبيق يُقبل، ومنه تعديل المطالبة المفتوحة
 * (يعكس القديم ويرحّل الجديد) في مزامنةٍ واحدة · بيانات مصطنعة.
 */
import { confirmContract, saveDepositSettlement } from '@/domain/contracts/service';
import { saveClaim, collectClaim } from '@/domain/claims';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, reasonOf, doubled, moved, otherDims, MEMBER } from './helpers/rederive';
import type { DB } from '@/db/adapter';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار مطالبة أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار مطالبة ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'CL-A' });
  const ub = addUnit(p.owner, pb, { unit_no: 'CL-B' });
  const a = confirmContract(p.owner, contractInput(ua, { tenant: 'مستأجر مطالبة أ مصطنع', idNumber: '1000002501', phone: '0500002501', depositHalalas: 0 }));
  const b = confirmContract(p.owner, contractInput(ub, { tenant: 'مستأجر مطالبة ب مصطنع', idNumber: '1000002502', phone: '0500002502', depositHalalas: 0 }));
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub, a, b };
}
const claim = (db: DB, contractId: string, amount = 80000, id?: string) =>
  saveClaim(db, { contractId, amountHalalas: amount, reason: 'إصلاح مصطنع', date: '2026-10-01' }, id);

describe('إعادة اشتقاق قيدي المطالبة وتحصيلها من المطالبة', () => {
  test('سلبي · المطالبة بضعف مبلغها (متوازن): يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    claim(s.dev, s.a);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'claim', doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/claim/);
    s.close();
  });

  test('سلبي · إيراد المطالبة منقولٌ إلى إيراد الإيجار 4200: يُرفض', async () => {
    const s = await setup();
    claim(s.dev, s.a);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'claim', moved('4300', '4200'));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/4200/);
    s.close();
  });

  test('سلبي · تحصيل المطالبة بأبعاد عقد مستأجرٍ آخر ووحدته وعقاره: يُرفض', async () => {
    const s = await setup();
    const id = claim(s.dev, s.a);
    await sync(s.dev, s.r);
    await ownerPulls(s.owner, s.r);
    collectClaim(s.dev, id, '2026-10-10');
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'claim_collect', otherDims({ contract_id: s.b, unit_id: s.ub, property_id: s.pb }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/بُعد/);
    s.close();
  });

  test('سلبي · تحصيلٌ بضعف المطالبة (يُدخل نقداً ويُقفل ذمةً ليست لها): يُرفض', async () => {
    const s = await setup();
    const id = claim(s.dev, s.a);
    await sync(s.dev, s.r);
    await ownerPulls(s.owner, s.r);
    collectClaim(s.dev, id, '2026-10-10');
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'claim_collect', doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: المطالبة، وتعديلها في مزامنةٍ واحدة، وتحصيلها', async () => {
    const s = await setup();
    const id = claim(s.dev, s.a);
    claim(s.dev, s.b, 95000, id);
    await sync(s.dev, s.r);
    const ids: string[] = [];
    for (const d of [...s.r.docs.values()]) {
      if (d.t === 'journal_entries' && /^claim/.test(String(d.d?.src_type))) { s.r.inject({ ...d, by: MEMBER }); ids.push(d.k); }
    }
    expect(ids.length).toBe(3);
    await ownerPulls(s.owner, s.r);
    collectClaim(s.dev, id, '2026-10-10');
    await sync(s.dev, s.r);
    ids.push(asMember(s.r, 'claim_collect'));
    await ownerPulls(s.owner, s.r);
    for (const k of ids) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    expect(s.owner.get(`SELECT SUM(l.debit_halalas - l.credit_halalas) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.src_id = ? AND l.account_code = '1250'`, [id])).toEqual({ n: 0 });
    s.close();
  });

  test('إيجابي · مطالبة زيادة التسوية على التأمين من قسم التأمين تُقبل', async () => {
    const s = await setup();
    const c = confirmContract(s.dev, contractInput(s.ub, { tenant: 'مستأجر مطالبة ج مصطنع', idNumber: '1000002503', phone: '0500002503',
      start: '2025-01-01', end: '2025-06-30', depositHalalas: 100000 }));
    saveDepositSettlement(s.dev, c, { date: '2026-07-05', deductionHalalas: 130000, deductionReason: 'إصلاح مصطنع', refundHalalas: 0, notes: '' });
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'claim');
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, k)).toBe(true);
    expect(s.owner.get(`SELECT SUM(debit_halalas) AS n FROM journal_lines WHERE entry_id = ?`, [k])).toEqual({ n: 30000 });
    s.close();
  });
});

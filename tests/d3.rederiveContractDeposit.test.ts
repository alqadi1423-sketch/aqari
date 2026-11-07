/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيد استلام التأمين (contract_deposit) من عقده · قيدٌ كتبه عضو بمبلغٍ أو حسابٍ أو بُعدٍ يخالف
 * ما يشتقه عقده (تأمينه وجهة قبضه، وفي التجديد زيادته على المرحَّل) يُرفض على جهاز المالك ولا يدخل الدفتر · والمطابق يُقبل · وما
 * لم يصل عقده يُنتظر · وما كتبه المالك لا يُعاد · بيانات مصطنعة.
 */
import { confirmContract, renewContract } from '@/domain/contracts/service';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, lastEntry, has, reasonOf, doubled, moved, otherDims, MEMBER } from './helpers/rederive';
import type { DB } from '@/db/adapter';

const SRC = 'contract_deposit';

/** عقارا العقدين على جهاز المالك ثم على الثاني */
async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار تأمين أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار تأمين ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'CD-A' });
  const ub = addUnit(p.owner, pb, { unit_no: 'CD-B' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub };
}
const confirm = (db: DB, unit: string, n: number, over: Record<string, unknown> = {}) =>
  confirmContract(db, { ...contractInput(unit, { tenant: 'مستأجر تأمين مصطنع ' + n, idNumber: '100000210' + n, phone: '050000021' + n,
    start: '2026-01-01', end: '2026-06-30', depositHalalas: 300000 }), ...over } as never);

describe('إعادة اشتقاق قيد استلام التأمين من عقده', () => {
  test('سلبي · قيد التأمين بضعف تأمين العقد (متوازن): يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    confirm(s.dev, s.ua, 1);
    await sync(s.dev, s.r);
    const k = asMember(s.r, SRC, doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/contract_deposit/);
    expect(reasonOf(s.owner, k)).toMatch(/2400|1100/);
    s.close();
  });

  test('سلبي · النقد منقولٌ إلى محتجزات المنصة والتأمين لدى المكتب: يُرفض', async () => {
    const s = await setup();
    confirm(s.dev, s.ua, 2);
    await sync(s.dev, s.r);
    const k = asMember(s.r, SRC, moved('1100', '1260'));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/1260/);
    s.close();
  });

  test('سلبي · سطوره بعقدٍ آخر ووحدته وعقاره: يُرفض', async () => {
    const s = await setup();
    const other = confirm(s.owner, s.ub, 3, { depositHalalas: 0 });
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    confirm(s.dev, s.ua, 4);
    await sync(s.dev, s.r);
    const k = asMember(s.r, SRC, otherDims({ contract_id: other, unit_id: s.ub, property_id: s.pb }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/بُعد/);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: لدى المكتب، ولدى المنصة، وزيادة التأمين في التجديد بعد ترحيله', async () => {
    const s = await setup();
    const a = confirm(s.dev, s.ua, 5);
    await sync(s.dev, s.r);
    const k1 = asMember(s.r, SRC);
    await ownerPulls(s.owner, s.r);
    confirm(s.dev, s.ub, 6, { depositHolder: 'منصة إيجار' });
    await sync(s.dev, s.r);
    const k2 = asMember(s.r, SRC);
    await ownerPulls(s.owner, s.r);
    renewContract(s.dev, a, { start: '2026-07-01', end: '2026-12-31', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
      extraDepositHalalas: 50000, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
    await sync(s.dev, s.r);
    const k3 = asMember(s.r, SRC);
    await ownerPulls(s.owner, s.r);
    for (const k of [k1, k2, k3]) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    expect(s.owner.get(`SELECT SUM(credit_halalas) AS n FROM journal_lines WHERE entry_id = ?`, [k3])).toEqual({ n: 50000 });
    s.close();
  });

  test('سلبي · التجديد: قيد التأمين بكامل تأمين العقد الجديد مع ترحيل السابق إليه (يضاعف المرحَّل): يُرفض', async () => {
    const s = await setup();
    const a = confirm(s.dev, s.ua, 7);
    await sync(s.dev, s.r);
    await ownerPulls(s.owner, s.r);
    renewContract(s.dev, a, { start: '2026-07-01', end: '2026-12-31', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
      extraDepositHalalas: 50000, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
    await sync(s.dev, s.r);
    const k = asMember(s.r, SRC, (ls) => ls.map((l) => ({ ...l,
      debit_halalas: Number(l.debit_halalas) ? 350000 : 0, credit_halalas: Number(l.credit_halalas) ? 350000 : 0 })));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/2400|1100/);
    s.close();
  });

  test('قيدٌ لم يصل عقده يُنتظر ولا يُرفض · ثم يُقبل حين يصل', async () => {
    const s = await setup();
    const a = confirm(s.dev, s.ua, 8);
    await sync(s.dev, s.r);
    const k = asMember(s.r, SRC);
    const held = [...s.r.docs.entries()].filter(([, d]) => (d.t === 'contracts' && d.k === a) || d.d?.contract_id === a);
    for (const [id] of held) s.r.docs.delete(id);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).not.toMatch(/مرفوض/);
    for (const [, d] of held) s.r.inject(d);
    await ownerPulls(s.owner, s.r);
    expect(reasonOf(s.owner, k)).toBe('');
    expect(has(s.owner, k)).toBe(true);
    s.close();
  });

  test('وما كتبه المالك من جهازه الآخر لا يُعاد اشتقاقه', async () => {
    const s = await setup();
    confirm(s.dev, s.ua, 9);
    await sync(s.dev, s.r);
    const o = lastEntry(s.r, SRC);
    expect(o.by === MEMBER).toBe(false);
    s.r.inject({ ...o, lines: doubled(o.lines!) });
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, o.k)).toBe(true);
    s.close();
  });
});

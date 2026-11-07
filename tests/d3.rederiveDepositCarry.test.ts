/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيد ترحيل التأمين عند التجديد (deposit_carry) من العقد المجدَّد وسابقه · قيدٌ كتبه عضو بمبلغٍ
 * غير تأمين العقد السابق، أو بحسابٍ غير 2400، أو بسطر إقفالٍ على عقدٍ غير السابق، أو لعقدٍ لا يتسع تأمينه للمرحَّل، يُرفض على
 * جهاز المالك ولا يدخل الدفتر · وما يكتبه التطبيق يُقبل · بيانات مصطنعة.
 */
import { confirmContract, renewContract } from '@/domain/contracts/service';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, has, reasonOf, doubled, MEMBER, type Lines } from './helpers/rederive';
import type { DB } from '@/db/adapter';

const SRC = 'deposit_carry';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار ترحيل أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار ترحيل ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'CR-A' });
  const ub = addUnit(p.owner, pb, { unit_no: 'CR-B' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub };
}
const confirm = (db: DB, unit: string, n: number) =>
  confirmContract(db, contractInput(unit, { tenant: 'مستأجر ترحيل مصطنع ' + n, idNumber: '10000023' + String(n).padStart(2, '0'),
    phone: '05000003' + String(n).padStart(2, '0'), start: '2026-01-01', end: '2026-06-30', depositHalalas: 300000 }));
const renew = (db: DB, c: string, extra = 0) => renewContract(db, c, { start: '2026-07-01', end: '2026-12-31', valueHalalas: 600000,
  cycle: 'شهرية', carryDeposit: true, extraDepositHalalas: extra, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
/** العقد على الجهاز الثاني ثم عند المالك، ثم يُجدَّد على الثاني ويُرفع */
async function renewed(s: Awaited<ReturnType<typeof setup>>, n: number, extra = 0) {
  const c = confirm(s.dev, s.ua, n);
  await sync(s.dev, s.r);
  await ownerPulls(s.owner, s.r);
  const next = renew(s.dev, c, extra);
  await sync(s.dev, s.r);
  return { c, next };
}

describe('إعادة اشتقاق قيد ترحيل التأمين من العقد المجدَّد وسابقه', () => {
  test('سلبي · الترحيل بضعف تأمين العقد السابق (متوازن): يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    await renewed(s, 1);
    const k = asMember(s.r, SRC, doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/deposit_carry/);
    s.close();
  });

  test('سلبي · سطر التزام الجديد منقولٌ إلى النقد (يُخرج التأمين نقداً): يُرفض', async () => {
    const s = await setup();
    await renewed(s, 2);
    const k = asMember(s.r, SRC, (ls: Lines) => ls.map((l) => (Number(l.credit_halalas) ? { ...l, account_code: '1100' } : l)));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/1100/);
    s.close();
  });

  test('سلبي · سطر الإقفال على عقد مستأجرٍ آخر لا على العقد السابق: يُرفض', async () => {
    const s = await setup();
    const other = confirm(s.owner, s.ub, 3);
    await sync(s.owner, s.r);
    await sync(s.dev, s.r);
    await renewed(s, 4);
    const k = asMember(s.r, SRC, (ls: Lines) => ls.map((l) => (Number(l.debit_halalas) ? { ...l, contract_id: other } : l)));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/بُعد/);
    s.close();
  });

  test('سلبي · عقدٌ جديد تأمينه أقل من المرحَّل إليه: يُرفض الترحيل', async () => {
    const s = await setup();
    const { next } = await renewed(s, 5);
    const doc = [...s.r.docs.values()].find((d) => d.t === 'contracts' && d.k === next)!;
    s.r.inject({ ...doc, by: MEMBER, d: { ...doc.d, deposit_halalas: 100000 } });
    const k = asMember(s.r, SRC);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/أقل من المرحَّل/);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: ترحيلٌ وحده، وترحيلٌ مع زيادة', async () => {
    const s = await setup();
    await renewed(s, 6);
    const k1 = asMember(s.r, SRC);
    await ownerPulls(s.owner, s.r);
    const c2 = confirm(s.dev, s.ub, 7);
    await sync(s.dev, s.r);
    await ownerPulls(s.owner, s.r);
    renew(s.dev, c2, 40000);
    await sync(s.dev, s.r);
    const k2 = asMember(s.r, SRC);
    const k3 = asMember(s.r, 'contract_deposit');
    await ownerPulls(s.owner, s.r);
    for (const k of [k1, k2, k3]) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    s.close();
  });
});

/**
 * التوجيه الثالث · ١ · إعادة الاشتقاق: قيود العربون (reservation وreservation_forfeit وreservation_refund) من الحجز · قيدٌ كتبه عضو
 * بمبلغٍ غير العربون، أو بحسابٍ منقول، أو بأبعاد وحدةٍ أخرى، أو بمآلٍ غير مآل الحجز المخزَّن (مصادرةٌ لعربونٍ مردود) يُرفض على جهاز
 * المالك ولا يدخل الدفتر · وما يكتبه التطبيق يُقبل · بيانات مصطنعة.
 */
import { createReservation, cancelReservation } from '@/domain/reservations';
import { addProperty, addUnit } from './helpers/fixtures';
import { pair, sync, ownerPulls, asMember, lastEntry, has, reasonOf, doubled, moved, otherDims, MEMBER, type Lines } from './helpers/rederive';
import type { DB } from '@/db/adapter';

async function setup() {
  const p = await pair();
  const pa = addProperty(p.owner, { name: 'عقار حجز أ مصطنع' });
  const pb = addProperty(p.owner, { name: 'عقار حجز ب مصطنع' });
  const ua = addUnit(p.owner, pa, { unit_no: 'RV-A' });
  const ub = addUnit(p.owner, pb, { unit_no: 'RV-B' });
  await sync(p.owner, p.r);
  await sync(p.dev, p.r);
  return { ...p, pa, pb, ua, ub };
}
const reserve = (db: DB, unit: string, n: number) => createReservation(db, { unitId: unit, name: 'صاحب حجز مصطنع ' + n,
  phone: '05000004' + String(n).padStart(2, '0'), depositHalalas: 150000, expiryDate: '2026-12-31' });

describe('إعادة اشتقاق قيود العربون من الحجز', () => {
  test('سلبي · قبض العربون بضعفه (متوازن): يُرفض ولا يدخل الدفتر', async () => {
    const s = await setup();
    reserve(s.dev, s.ua, 1);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'reservation', doubled);
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/reservation/);
    s.close();
  });

  test('سلبي · المصادرة منقولةٌ من 4300 إلى إيراد الإيجار 4200: يُرفض', async () => {
    const s = await setup();
    const id = reserve(s.dev, s.ua, 2);
    await sync(s.dev, s.r);
    await ownerPulls(s.owner, s.r);
    cancelReservation(s.dev, id, true);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'reservation_forfeit', moved('4300', '4200'));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/4200/);
    s.close();
  });

  test('سلبي · ردّ العربون بأبعاد وحدةٍ وعقارٍ آخرين: يُرفض', async () => {
    const s = await setup();
    const id = reserve(s.dev, s.ua, 3);
    await sync(s.dev, s.r);
    await ownerPulls(s.owner, s.r);
    cancelReservation(s.dev, id, false);
    await sync(s.dev, s.r);
    const k = asMember(s.r, 'reservation_refund', otherDims({ unit_id: s.ub, property_id: s.pb }));
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, k)).toBe(false);
    expect(reasonOf(s.owner, k)).toMatch(/بُعد/);
    s.close();
  });

  test('سلبي · قيد ردٍّ جُعل مصادرةً والحجز مآله «مردود»: يُرفض', async () => {
    const s = await setup();
    const id = reserve(s.dev, s.ua, 4);
    await sync(s.dev, s.r);
    await ownerPulls(s.owner, s.r);
    cancelReservation(s.dev, id, false);
    await sync(s.dev, s.r);
    const o = lastEntry(s.r, 'reservation_refund');
    s.r.inject({ ...o, by: MEMBER, d: { ...o.d, src_type: 'reservation_forfeit' }, lines: moved('1100', '4300')(o.lines as Lines) });
    await ownerPulls(s.owner, s.r);
    expect(has(s.owner, o.k)).toBe(false);
    expect(reasonOf(s.owner, o.k)).toMatch(/لا يرحّل/);
    s.close();
  });

  test('إيجابي · ما يكتبه التطبيق يُقبل: قبض العربون، ومصادرته، وردّه', async () => {
    const s = await setup();
    const a = reserve(s.dev, s.ua, 5);
    const b = reserve(s.dev, s.ub, 6);
    await sync(s.dev, s.r);
    const ka = [...s.r.docs.values()].filter((d) => d.t === 'journal_entries' && d.d?.src_type === 'reservation').map((d) => d.k);
    for (const d of [...s.r.docs.values()]) if (ka.includes(d.k) && d.t === 'journal_entries') s.r.inject({ ...d, by: MEMBER });
    await ownerPulls(s.owner, s.r);
    cancelReservation(s.dev, a, true);
    cancelReservation(s.dev, b, false);
    await sync(s.dev, s.r);
    const kf = asMember(s.r, 'reservation_forfeit');
    const kr = asMember(s.r, 'reservation_refund');
    await ownerPulls(s.owner, s.r);
    for (const k of [...ka, kf, kr]) {
      expect(reasonOf(s.owner, k)).toBe('');
      expect(has(s.owner, k)).toBe(true);
    }
    expect(ka.length).toBe(2);
    s.close();
  });
});

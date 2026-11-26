/**
 * A1-7 · بقية الإصلاح بعد اختبارات المراجع (review9.A1.negativeInputs): الرسالة تسمّي الحقل وقيمته، والخدمات والمواقف والعمولة،
 * وفحص المطابقة للبيانات القائمة، وخانة المال بلا إشارة السالب، وحارس جهاز المالك لصفّ عضوٍ بمبلغ سالب. بيانات مصطنعة كلها.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { confirmContract, renewContract, renewWarnings, RuleViolation } from '@/domain/contracts/service';
import { createReservation } from '@/domain/reservations';
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { integrityChecks, negativeMoneyCounts } from '@/domain/accounting/integrity';
import { moneyInputText, toHalalas } from '@/domain/money';
import { ownerCashIn } from '@/domain/cashOps';
import { docId } from '@/sync/engine';

const msgOf = (f: () => unknown): string => { try { f(); } catch (e) { return (e as Error).message; } return ''; };

test('A1-7 قيمة العقد السالبة تُرفض بجملةٍ تسمّي الحقل وقيمته، لا برسالة المحفّز', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار سالب مصطنع' }), { unit_no: 'N-1' });
  let err: unknown = null;
  try { confirmContract(db, contractInput(u, { valueHalalas: -1200000, idNumber: '1000000984' })); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(RuleViolation);
  expect((err as RuleViolation).field).toBe('value');
  expect((err as Error).message).toBe('السالب لا يُقبل في قيمة العقد، والمكتوب -12,000.00 · اكتبه بلا إشارة السالب');
  expect(db.get(`SELECT 1 FROM contracts`)).toBeFalsy();
  db.close();
});

test('A1-7 التأمين والخدمات والمواقف السالبة تُرفض قبل أي كتابة', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار سالب مصطنع' }), { unit_no: 'N-2' });
  expect(msgOf(() => confirmContract(db, contractInput(u, { depositHalalas: -100000 }))))
    .toBe('السالب لا يُقبل في مبلغ التأمين، والمكتوب -1,000.00 · اكتبه بلا إشارة السالب');
  // كانت الخدمات السالبة تُصفَّر بصمت
  expect(msgOf(() => confirmContract(db, { ...contractInput(u), servicesHalalas: -30000 })))
    .toMatch(/^السالب لا يُقبل في مبلغ الخدمات، والمكتوب -300\.00/);
  expect(msgOf(() => confirmContract(db, { ...contractInput(u), parkingHalalas: -1 })))
    .toMatch(/^السالب لا يُقبل في مبلغ المواقف، والمكتوب -0\.01/);
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contracts`)!.n)).toBe(0);
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n)).toBe(0);
  db.close();
});

test('A1-7 التجديد: التأمين الإضافي السالب تحذيرٌ يمنع التأكيد، ولا عقد جديد ولا ترحيل', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار سالب مصطنع' }), { unit_no: 'N-3' });
  const a = confirmContract(db, contractInput(u, { depositHalalas: 100000, idNumber: '1000000992' }));
  const input = { start: '2027-01-01', end: '2027-12-31', valueHalalas: 1200000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: -40000, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' };
  expect(renewWarnings(db, a, input)).toContain('السالب لا يُقبل في التأمين الإضافي، والمكتوب -400.00 · اكتبه بلا إشارة السالب');
  expect(() => renewContract(db, a, input)).toThrow(RuleViolation);
  expect(() => renewContract(db, a, { ...input, extraDepositHalalas: 0, valueHalalas: -1200000 })).toThrow(/السالب لا يُقبل في قيمة العقد/);
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contracts`)!.n)).toBe(1);
  // والتجديد الصحيح بعدها يمضي: ترحيل ١٬٠٠٠ وإضافي ٤٠٠ = ١٤٠٠٠٠ هللة
  const b = renewContract(db, a, { ...input, extraDepositHalalas: 40000 });
  expect(Number(db.get<{ d: number }>(`SELECT deposit_halalas AS d FROM contracts WHERE id = ?`, [b])!.d)).toBe(140000);
  db.close();
});

test('A1-7 العربون السالب يُرفض بجملةٍ تسمّيه، ولا حجز', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار سالب مصطنع' }), { unit_no: 'N-4' });
  expect(msgOf(() => createReservation(db, { unitId: u, name: 'حاجز مصطنع', phone: '', depositHalalas: -50000, expiryDate: '2027-01-01' })))
    .toBe('السالب لا يُقبل في العربون، والمكتوب -500.00 · اكتبه بلا إشارة السالب');
  expect(db.get(`SELECT 1 FROM reservations`)).toBeFalsy();
  db.close();
});

test('A1-7 التقبيل: المبلغ والعمولة غير سالبين، والعمولة لا تتجاوز مبلغ التقبيل', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 100000, date: '2026-01-01' });
  const u = addUnit(db, addProperty(db, { name: 'عقار تقبيل مصطنع' }), { unit_no: 'N-5' });
  const deal = (amountHalalas: number, commissionHalalas: number) => () => recordKeyMoneyDeal(db, { unitId: u, outgoing: 'مغادر مصطنع',
    incoming: 'قادم مصطنع', amountHalalas, date: '2026-02-01', commissionHalalas, method: 'cash', notes: '' });
  expect(msgOf(deal(-900000, 0))).toMatch(/^السالب لا يُقبل في مبلغ التقبيل، والمكتوب -9,000\.00/);
  expect(msgOf(deal(900000, -6000))).toMatch(/^السالب لا يُقبل في العمولة، والمكتوب -60\.00/);
  expect(msgOf(deal(900000, 900001))).toBe('العمولة (9,000.01) أكبر من مبلغ التقبيل نفسه (9,000.00)');
  expect(db.get(`SELECT 1 FROM key_money_deals`)).toBeFalsy();
  // والعمولة مساويةٌ للمبلغ مقبولة
  expect(deal(900000, 900000)()).toBeTruthy();
  db.close();
});

test('A1-7 البيانات القائمة: السالب منها يُعرض في فحص المطابقة بعدده', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار قائم مصطنع' }), { unit_no: 'N-6' });
  const u2 = addUnit(db, addProperty(db, { name: 'عقار قائم مصطنع ٢' }), { unit_no: 'N-7' });
  const name = 'لا مبلغ سالب في العقود والحجوزات وصفقات التقبيل';
  expect(integrityChecks(db).find((c) => c.name === name)).toEqual({ name, ok: true, value: '0 عقد · 0 حجز · 0 صفقة تقبيل' });
  // كما حفظها إصدارٌ قبل المنع: عقدٌ بتأمين −١٬٠٠٠ وحجزٌ بعربون −٥٠٠، بلا قيد
  const c = confirmContract(db, contractInput(u, { depositHalalas: 0 }));
  db.run(`UPDATE contracts SET deposit_halalas = -100000 WHERE id = ?`, [c]);
  db.run(`INSERT INTO reservations (id, unit_id, name, phone, deposit_halalas, expiry_date, created_date, status)
          VALUES ('rsv-neg', ?, 'حاجز مصطنع', '', -50000, '2027-01-01', '2026-01-01', 'نشط')`, [u2]);
  expect(negativeMoneyCounts(db)).toEqual({ contracts: 1, reservations: 1, deals: 0 });
  const chk = integrityChecks(db).find((x) => x.name === name)!;
  expect(chk.ok).toBe(false);
  expect(chk.value).toMatch(/^1 عقد · 1 حجز · 0 صفقة تقبيل · مبالغ سالبة دخلت قبل منعها/);
  db.close();
});

test('A1-7 خانة المال لا تقبل إشارة السالب، فلا يصل السالب من الشاشة', () => {
  expect(moneyInputText('-1000')).toBe('1000');
  expect(moneyInputText('−1,000.50')).toBe('1,000.50'); // علامة الطرح الرياضية
  expect(moneyInputText('+٥٠٠')).toBe('٥٠٠');
  expect(toHalalas(moneyInputText('-400'))).toBe(40000);
  expect(moneyInputText('2500.75')).toBe('2500.75');
});

test('A1-7 جهاز المالك يرفض صفّ عضوٍ بعربونٍ سالب (إصدارٌ قبل المنع)، ويقبل الصحيح', async () => {
  const s = await pair();
  const u = addUnit(s.owner, addProperty(s.owner, { name: 'عقار مزامنة مصطنع' }), { unit_no: 'N-8' });
  const u2 = addUnit(s.owner, addProperty(s.owner, { name: 'عقار مزامنة مصطنع ٢' }), { unit_no: 'N-9' });
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  const ok = createReservation(s.dev, { unitId: u, name: 'حاجز مصطنع', phone: '', depositHalalas: 150000, expiryDate: '2027-01-01' });
  await sync(s.dev, s.r);
  // صفٌّ بعربون −٥٠٠ بلا قيد، كما يكتبه جهاز عضوٍ بإصدارٍ قديم
  const base = s.r.docs.get(docId('reservations', ok))!;
  const k = 'rsv-member-neg';
  s.r.inject({ ...base, id: docId('reservations', k), k, by: MEMBER, d: { ...base.d, id: k, unit_id: u2, deposit_halalas: -50000 } });
  s.r.inject({ ...base, by: MEMBER });
  await ownerPulls(s.owner, s.r);
  expect(s.owner.get(`SELECT 1 FROM reservations WHERE id = ?`, [k])).toBeFalsy();
  expect(s.owner.get<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE pk = ?`, [k])!.reason)
    .toBe('مبلغ سالب من جهاز عضو (العربون -500.00) · لا يُطبَّق');
  expect(Number(s.owner.get<{ d: number }>(`SELECT deposit_halalas AS d FROM reservations WHERE id = ?`, [ok])!.d)).toBe(150000);
  s.close();
});

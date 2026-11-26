/**
 * المراجعة الشاملة 2026-11-13 · A1-9 · منخفض · src/domain/contracts/service.ts (renewContract و renewWarnings) · بيانات مصطنعة كلها.
 *
 * ما كان: التجديد يولّد الأقساط بالدالة دائماً بلا جدول ملف إيجار ولا وسم «محسوبة» مع أن نافذته تطلب «رقم إيجار»، ولا يفحص نشاط العقار
 * وفئته (القاعدة ١) ولا الحجز النشط لغير المستأجر (القاعدة ٤).
 * القرار (2026-10-05): تواريخ أقساط عقود إيجار من جدول الدفعات في ملفها دائماً، وإلا تنبيه «محسوبة لا مقروءة».
 *
 * الأرقام الذهبية: تجديدٌ من 2027-01-01 إلى 2027-12-31 بـ١٢٬٠٠٠٫٠٠ ربع سنوي، وجدول الملف أربع دفعات ٣٬٠٠٠٫٠٠ في الخامس من
 * يناير وأبريل ويوليو وأكتوبر · المحسوب بالدالة يبدأ 2027-01-01، فالتاريخ الأول يفرّق بينهما.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, renewContract, renewWarnings, RuleViolation } from '@/domain/contracts/service';
import { createReservation } from '@/domain/reservations';
import { addDays, today } from '@/domain/dates';
import { integrityChecks } from '@/domain/accounting/integrity';
import { initI18n } from '@/i18n';
import type { DB } from '@/db/adapter';

beforeAll(() => { initI18n('ar'); });

const base = (over: Record<string, unknown> = {}) => ({
  start: '2027-01-01', end: '2027-12-31', valueHalalas: 1200000, cycle: 'ربع سنوية', carryDeposit: false, extraDepositHalalas: 0,
  services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '', ...over,
});
const insts = (db: DB, id: string) => db.all<{ d: string; a: number }>(
  `SELECT due_date AS d, amount_halalas AS a FROM contract_installments WHERE contract_id = ? ORDER BY sort`, [id])
  .map((r) => [r.d, Number(r.a)]);
const source = (db: DB, id: string) => db.get<{ s: string | null }>(`SELECT installments_source AS s FROM contracts WHERE id = ?`, [id])!.s;
const red = (db: DB) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name);

function world(unitOver: Record<string, string> = {}, propOver: Record<string, string> = {}) {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار تجديد مصطنع ٩', ...propOver });
  const u = addUnit(db, p, { unit_no: 'R9-1', ...unitOver });
  const c = confirmContract(db, contractInput(u, { tenant: 'مستأجر تجديد مصطنع ٩', idNumber: '1000000991',
    valueHalalas: 1200000, start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  return { db, p, u, c };
}

test('A1-9 تجديدٌ بجدول ملف إيجار: الأقساط بتواريخ الملف ومبالغه، ويوسم «ملف»', () => {
  const { db, c } = world();
  const schedule = [
    { dueDate: '2027-01-05', amountHalalas: 300000 }, { dueDate: '2027-04-05', amountHalalas: 300000 },
    { dueDate: '2027-07-05', amountHalalas: 300000 }, { dueDate: '2027-10-05', deadline: '2027-10-20', amountHalalas: 300000 },
  ];
  const input = base({ ejarNo: '20270001', schedule, fromEjarFile: true });
  const n = renewContract(db, c, input);
  expect(insts(db, n)).toEqual([['2027-01-05', 300000], ['2027-04-05', 300000], ['2027-07-05', 300000], ['2027-10-05', 300000]]);
  expect(db.get<{ g: string | null }>(`SELECT grace_until AS g FROM contract_installments WHERE contract_id = ? AND sort = 3`, [n])!.g).toBe('2027-10-20');
  expect(source(db, n)).toBe('ملف');
  expect(red(db)).toEqual([]);
  db.close();
});

test('A1-9 جدول الملف يخالف إجمالي العقد: يُرفض التجديد بالفرق ولا يُكتب شيء', () => {
  const { db, c } = world();
  const schedule = [{ dueDate: '2027-01-05', amountHalalas: 600000 }, { dueDate: '2027-07-05', amountHalalas: 500000 }];
  const before = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contracts`)!.n);
  expect(() => renewContract(db, c, base({ ejarNo: '20270002', schedule, fromEjarFile: true }))).toThrow(/١١٬٠٠٠|11,000|11٬000/);
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contracts`)!.n)).toBe(before);
  db.close();
});

test('A1-9 تجديدٌ برقم إيجار بلا جدولٍ مقروء: الأقساط محسوبة وتوسم «محسوبة» فيظهر تنبيهها', () => {
  const { db, c } = world();
  const n = renewContract(db, c, base({ ejarNo: '20270003' }));
  expect(insts(db, n)[0]).toEqual(['2027-01-01', 300000]);
  expect(source(db, n)).toBe('محسوبة');
  db.close();
});

test('A1-9 تجديدٌ بلا رقم إيجار ولا ملف: محسوبٌ بلا وسم كما كان', () => {
  const { db, c } = world();
  const n = renewContract(db, c, base());
  expect(source(db, n)).toBeNull();
  db.close();
});

test('A1-9 القاعدة ١: وحدةٌ صار نوعها يخالف نشاط العقار لا تُجدَّد', () => {
  const { db, c, u } = world({}, { activity_type: 'سكني' });
  db.run(`UPDATE units SET type = 'تجاري' WHERE id = ?`, [u]);
  expect(renewWarnings(db, c, base()).some((w) => w.includes('مخصَّص لنشاط'))).toBe(true);
  expect(() => renewContract(db, c, base())).toThrow(RuleViolation);
  db.close();
});

test('A1-9 القاعدة ١ب: فئة الوحدة تخالف فئة العقار المخصَّصة', () => {
  const { db, c, p } = world({ subtype: 'شقة' });
  db.run(`UPDATE properties SET activity_subtype = 'فيلا' WHERE id = ?`, [p]);
  expect(() => renewContract(db, c, base())).toThrow(/مخصَّص لفئة/);
  db.close();
});

test('A1-9 القاعدة ٤: الوحدة محجوزة بعربون لغير المستأجر فلا تُجدَّد له', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار تجديد مصطنع ٩ب' }), { unit_no: 'R9-2' });
  // عقدٌ انتهى قبل اليوم، فالوحدة شاغرة وحُجزت لمستأجرٍ قادم
  const c = confirmContract(db, contractInput(u, { tenant: 'مستأجر سابق مصطنع', idNumber: '1000000992',
    valueHalalas: 1200000, start: '2025-01-01', end: '2025-12-31', depositHalalas: 0 }));
  createReservation(db, { unitId: u, name: 'حاجز قادم مصطنع', phone: '', depositHalalas: 0, expiryDate: addDays(today(), 30) });
  const input = base({ start: '2026-01-01', end: '2026-12-31' });
  expect(renewWarnings(db, c, input).some((w) => w.includes('حاجز قادم مصطنع'))).toBe(true);
  expect(() => renewContract(db, c, input)).toThrow(/حاجز قادم مصطنع/);
  db.close();
});

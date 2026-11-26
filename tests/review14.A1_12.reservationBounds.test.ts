/**
 * المراجعة الشاملة 2026-11-13 · A1-12 · منخفض · src/domain/reservations.ts (createReservation) · src/ui/unitSheets.tsx · بيانات مصطنعة.
 *
 * ما كان:
 *  - لا حجز لوحدةٍ عقدها الحالي يقترب من نهايته، فلا يُحجز لمستأجرٍ قادم قبل خروج الحالي.
 *  - تاريخ الحجز وقيد عربونه «اليوم» دائماً، فالعربون المسجَّل متأخراً يُؤرَّخ خطأً.
 *  - تاريخ انتهاءٍ مضى يُقبل، فينتهي الحجز عند أول فحص وعربونه محتجز.
 *  - زر «مصادرة العربون» بلا التقاط خطأ، فرفضٌ منه يسقط بلا رسالة سبب.
 * الإصلاح (بلا هجرة): الحجز يبدأ بعد نهاية العقد الحالي (أو اليوم للشاغرة) ويُفحص بتعارضه مع العقود حتى انتهائه، ويُقبل ما دام ينتهي
 * بعد خروج الحالي · وخانة تاريخ القبض (لا بعد اليوم ولا في ربعٍ مقدَّم) يُؤرَّخ بها الحجز وقيده وحركة بنكه · والانتهاء لا يسبق اليوم.
 * الأرقام الذهبية: عربون ٥٠٠٫٠٠ → مدين 1100 أو البنك ٥٠٠٫٠٠ / دائن 2450 ٥٠٠٫٠٠ بتاريخ القبض.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { createReservation } from '@/domain/reservations';
import { confirmContract } from '@/domain/contracts/service';
import { addDays, today } from '@/domain/dates';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { initI18n } from '@/i18n';
import type { DB } from '@/db/adapter';

beforeAll(() => { initI18n('ar'); });

const T = today();
const red = (db: DB) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name);
function rented(endIn = 20) {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار حجز مصطنع' }), { unit_no: 'H-12' });
  const c = confirmContract(db, contractInput(u, { tenant: 'مستأجر حالي مصطنع', idNumber: '1000001012', valueHalalas: 1200000,
    start: addDays(T, -200), end: addDays(T, endIn), depositHalalas: 0 }));
  return { db, u, c };
}
const rsvInput = (u: string, over: Record<string, unknown> = {}) =>
  ({ unitId: u, name: 'حاجز قادم مصطنع', phone: '', depositHalalas: 50000, expiryDate: addDays(T, 45), ...over });

test('A1-12 وحدةٌ عقدها ينتهي بعد ٢٠ يوماً تُحجز لمستأجرٍ قادم بحجزٍ ينتهي بعد خروجه', () => {
  const { db, u } = rented();
  const id = createReservation(db, rsvInput(u));
  expect(db.get<{ s: string }>(`SELECT status AS s FROM reservations WHERE id = ?`, [id])!.s).toBe('نشط');
  expect(accountBalance(db, '2450')).toBe(50000);
  expect(red(db)).toEqual([]);
  db.close();
});

test('A1-12 حجزٌ ينتهي قبل خروج المستأجر الحالي يُرفض بسببه', () => {
  const { db, u } = rented();
  expect(() => createReservation(db, rsvInput(u, { expiryDate: addDays(T, 10) }))).toThrow(/ينتهي/);
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM reservations`)!.n)).toBe(0);
  db.close();
});

test('A1-12 عقدٌ يلي الحالي في مدة الحجز يمنعه (تعارض)', () => {
  const { db, u } = rented();
  confirmContract(db, contractInput(u, { tenant: 'مستأجر لاحق مصطنع', idNumber: '1000001013', valueHalalas: 1200000,
    start: addDays(T, 21), end: addDays(T, 385), depositHalalas: 0 }));
  expect(() => createReservation(db, rsvInput(u))).toThrow(/تتعارض|يتعارض/);
  db.close();
});

test('A1-12 بعد الحجز: لا عقد لغير صاحبه بعد خروج الحالي، وصاحبه يُوثَّق له بتحويل الحجز', () => {
  const { db, u } = rented();
  const rid = createReservation(db, rsvInput(u));
  const next = (tenant: string, id: string) => contractInput(u, { tenant, idNumber: id, valueHalalas: 1200000,
    start: addDays(T, 21), end: addDays(T, 385), depositHalalas: 0 });
  expect(() => confirmContract(db, next('غريب مصطنع', '1000001014'))).toThrow(/محجوزة/);
  confirmContract(db, { ...next('حاجز قادم مصطنع', '1000001015'), reservationId: rid });
  expect(db.get<{ s: string }>(`SELECT status AS s FROM reservations WHERE id = ?`, [rid])!.s).toBe('محوَّل لعقد');
  expect(red(db)).toEqual([]);
  db.close();
});

test('A1-12 تاريخ القبض: الحجز وقيده وحركة بنكه بتاريخ القبض لا اليوم', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار حجز مصطنع ٢' }), { unit_no: 'H-13' });
  const bank = addBank(db, 'بنك حجز مصطنع');
  const paidOn = addDays(T, -3);
  const id = createReservation(db, { ...rsvInput(u), date: paidOn, bankId: bank } as Parameters<typeof createReservation>[1]);
  expect(db.get<{ d: string }>(`SELECT created_date AS d FROM reservations WHERE id = ?`, [id])!.d).toBe(paidOn);
  expect(db.get<{ d: string }>(`SELECT date AS d FROM journal_entries WHERE src_type = 'reservation' AND src_id = ?`, [id])!.d).toBe(paidOn);
  expect(db.get<{ d: string; a: number }>(`SELECT date AS d, amount_halalas AS a FROM bank_tx WHERE bank_id = ?`, [bank])).toEqual({ d: paidOn, a: 50000 });
  expect(red(db)).toEqual([]);
  db.close();
});

test('A1-12 قبضٌ بتاريخٍ مقبل، وانتهاءٌ مضى أو يسبق القبض: مرفوضة', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار حجز مصطنع ٣' }), { unit_no: 'H-14' });
  expect(() => createReservation(db, { ...rsvInput(u), date: addDays(T, 2) } as Parameters<typeof createReservation>[1])).toThrow();
  expect(() => createReservation(db, rsvInput(u, { expiryDate: addDays(T, -1) }))).toThrow(/انتهاء/);
  expect(() => createReservation(db, rsvInput(u, { expiryDate: '2026-13-40' }))).toThrow();
  expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM reservations`)!.n)).toBe(0);
  db.close();
});

test('A1-12 زر المصادرة يلتقط الرفض كزر الرد، وزر الحجز يظهر للمؤجَّرة أيضاً', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ui', 'unitSheets.tsx'), 'utf8');
  const at = src.indexOf("label: `مصادرة العربون");
  expect(at).toBeGreaterThan(0);
  const press = src.slice(at, src.indexOf('}] : [])', at));
  expect(press).toMatch(/try\s*\{[\s\S]*cancelReservation\(db, rsv\.id, true\)[\s\S]*catch/);
  expect(src).not.toMatch(/data\.st\.key === 'vacant' && rsvPerm\.add/);
  const sheet = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ui', 'ReservationSheet.tsx'), 'utf8');
  expect(sheet).toMatch(/date: paidOn/);
});

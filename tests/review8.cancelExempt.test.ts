/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ١٠: إلغاء دفعة إيجار كان يُسقطها من بند المبيعات المعفاة في ربعها الأصلي (فيتغير
 * المقدَّم) بدل أن يُخصم في ربع الإلغاء · الآن تبقى في ربعها ويُضاف صفٌّ سالب بتاريخ إلغائها كصفوف الفائض · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { cancelPayment, planCancelPayment, defaultCancelDate } from '@/domain/contracts/cancelPayment';
import { vatReturnData, quarterRange } from '@/domain/vatReturn';
import { fileVatReturn, filedDiff } from '@/domain/vatFilings';
import { dfmt, today, addDays } from '@/domain/dates';
import { t } from '@/i18n';

const item5 = (db: ReturnType<typeof memDb>, q: 1 | 2) => vatReturnData(db, 2026, q).items.find((x) => x.no === '5')!.amountHalalas;

function world(shop = false) {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'X-1' });
  if (shop) db.run(`UPDATE units SET type = 'محل' WHERE id = ?`, [u]);
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '1000000611', phone: '0500000611', start: '2026-01-01', depositHalalas: 0 }));
  const i = db.get<{ id: string; amount_halalas: number }>(`SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  const amount = Number(i.amount_halalas);
  const pay = recordRentPayment(db, cid, { installmentId: i.id, period: 'الأول', date: '2026-02-05', lines: [{ method: 'cash', amountHalalas: amount }], discountHalalas: 0, notes: '' });
  return { db, pay, amount };
}

test('١٠ الدفعة الملغاة في الربع التالي تبقى في ربعها · وتُخصم في ربع الإلغاء · والمقدَّم لا يتغير', () => {
  const { db, pay, amount } = world();
  fileVatReturn(db, 2026, 1, '2026-04-15');
  cancelPayment(db, pay, { date: '2026-04-10', reason: 'إلغاء مصطنع' });
  expect(item5(db, 1)).toBe(amount);
  expect(item5(db, 2)).toBe(-amount);
  expect(filedDiff(db, 2026, 1)).toEqual([]);
  const rows = vatReturnData(db, 2026, 2).schedules.exemptSales;
  expect(rows.map((r) => [r.date, r.net])).toEqual([['2026-04-10', -amount]]);
  db.close();
});

test('١٠ والإلغاء في الربع نفسه صافيه صفر', () => {
  const { db, pay } = world();
  cancelPayment(db, pay, { date: '2026-03-10', reason: 'إلغاء مصطنع' });
  expect(item5(db, 1)).toBe(0);
  expect(item5(db, 2)).toBe(0);
  db.close();
});

test('١٠ والإيجار التجاري كذلك: الملغى في ربعٍ تالٍ يُخصم فيه لا من ربعه', () => {
  const { db, pay, amount } = world(true);
  cancelPayment(db, pay, { date: '2026-04-10', reason: 'إلغاء مصطنع' });
  expect(vatReturnData(db, 2026, 1).commercialRentHalalas).toBe(amount);
  expect(vatReturnData(db, 2026, 2).commercialRentHalalas).toBe(-amount);
  db.close();
});

test('١٠ (التحقق المستقل) إيجار تجاري محصَّل في ربعٍ مع إلغاء دفعةٍ من ربعٍ سابق بالمبلغ نفسه: تقديم الإقرار يبقى ممنوعاً', () => {
  const { db, pay, amount } = world(true);
  cancelPayment(db, pay, { date: '2026-04-10', reason: 'إلغاء مصطنع' });
  const cid = db.get<{ c: string }>(`SELECT contract_id AS c FROM contract_payments WHERE id = ?`, [pay])!.c;
  const i = db.all<{ id: string; amount_halalas: number }>(`SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid])[3];
  recordRentPayment(db, cid, { installmentId: i.id, period: 'الرابع', date: '2026-05-05', lines: [{ method: 'cash', amountHalalas: Number(i.amount_halalas) }], discountHalalas: 0, notes: '' });
  expect(Number(i.amount_halalas)).toBe(amount);
  expect(vatReturnData(db, 2026, 2).commercialRentHalalas).toBe(0);
  expect(() => fileVatReturn(db, 2026, 2, '2026-07-15')).toThrow();
  db.close();
});

/* ═══════════ تتمة · المراجعة الأخيرة: لا إلغاء بتاريخٍ قبل تاريخ الدفعة نفسها ═══════════ */

/** صافي الإيراد في الدفتر (42xx) في الربع · ما يقابل البند ٥ للإيجار السكني */
const ledger42 = (db: ReturnType<typeof memDb>, q: 1 | 2 | 3) => {
  const { from, to } = quarterRange(2026, q);
  return Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_code LIKE '42%' AND e.status = 'مرحّل' AND e.deleted_at IS NULL AND e.date >= ? AND e.date <= ?`, [from, to])!.s); // i18n-exempt: حالة القيد المخزّنة
};
const box5 = (db: ReturnType<typeof memDb>, q: 1 | 2 | 3) => vatReturnData(db, 2026, q).items.find((x) => x.no === '5')!.amountHalalas;

/** دفعةٌ سكنية مصطنعة بتاريخ ٢ أبريل (شيكٌ مؤجَّل سُجّل بتاريخه) على القسط الثاني */
function aprilPayment() {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'X-2' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '1000000629', phone: '0500000629', start: '2026-01-01', depositHalalas: 0 }));
  const i = db.all<{ id: string; amount_halalas: number }>(`SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid])[1];
  const amount = Number(i.amount_halalas);
  const pay = recordRentPayment(db, cid, { installmentId: i.id, period: 'الثاني', date: '2026-04-02', lines: [{ method: 'cash', amountHalalas: amount }], discountHalalas: 0, notes: '' });
  return { db, pay, amount };
}

test('١٠ تتمة: إلغاء دفعةٍ بتاريخٍ قبل تاريخها مرفوض بسببه · فلا يتغيّر الإقرار المقدَّم والبند ٥ يطابق الدفتر في الربعين', () => {
  const { db, pay, amount } = aprilPayment();
  fileVatReturn(db, 2026, 2, '2026-07-15');
  const why = t('payment.cancelBeforePayment', { date: dfmt('2026-04-02') });
  let thrown = '';
  try { cancelPayment(db, pay, { date: '2026-03-30', reason: 'إلغاء مصطنع' }); } catch (e) { thrown = (e as Error).message; }
  // قبل الإصلاح: يُلغى فيخرج من البند ٥ في الربعين والدفتر يتحرك، ويتغيّر الربع الثاني المقدَّم
  expect([box5(db, 1), box5(db, 2)]).toEqual([ledger42(db, 1), ledger42(db, 2)]);
  expect(filedDiff(db, 2026, 2)).toEqual([]);
  expect(thrown).toBe(why);
  expect(planCancelPayment(db, pay, '2026-03-30').dateError).toBe(why);
  expect(db.get(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [pay])).toEqual({ c: null });
  expect([box5(db, 1), box5(db, 2)]).toEqual([0, amount]);
  // والإلغاء بتاريخٍ جائز (الربع الثالث المفتوح) يُخصم فيه · والبند ٥ يطابق الدفتر في الأرباع الثلاثة
  expect(planCancelPayment(db, pay, '2026-07-20').dateError).toBeNull();
  cancelPayment(db, pay, { date: '2026-07-20', reason: 'إلغاء مصطنع' });
  expect([box5(db, 1), box5(db, 2), box5(db, 3)]).toEqual([ledger42(db, 1), ledger42(db, 2), ledger42(db, 3)]);
  expect([box5(db, 2), box5(db, 3)]).toEqual([amount, -amount]);
  expect(filedDiff(db, 2026, 2)).toEqual([]);
  db.close();
});

test('١٠ تتمة: وتاريخ الدفعة نفسه جائز · وتاريخ الإلغاء الافتراضي لا يسبقها (الأكبر من اليوم وتاريخها)', () => {
  const { db, pay } = aprilPayment();
  expect(planCancelPayment(db, pay, '2026-04-02').dateError).toBeNull();
  expect(defaultCancelDate(db, pay)).toBe(today() > '2026-04-02' ? today() : '2026-04-02');
  // دفعةٌ بتاريخٍ بعد اليوم (شيكٌ مؤجَّل): الافتراضي تاريخها، والمعاينة به بلا منع
  const later = addDays(today(), 10);
  db.run(`UPDATE contract_payments SET date = ? WHERE id = ?`, [later, pay]);
  expect(defaultCancelDate(db, pay)).toBe(later);
  expect(planCancelPayment(db, pay).dateError).toBeNull();
  expect(planCancelPayment(db, pay).date).toBe(later);
  expect(planCancelPayment(db, pay, today()).dateError).not.toBeNull();
  db.close();
});

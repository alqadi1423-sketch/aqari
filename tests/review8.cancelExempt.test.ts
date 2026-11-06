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
import { reverseEntryById } from '@/domain/accounting/post';
import { recomputeInstallments } from '@/domain/contracts/paid';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import { MemoryRemote } from './helpers/memoryRemote';
import { t } from '@/i18n';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';

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
function aprilPayment(db = memDb()) {
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

/* ═══════════ تتمة · المتحقق المستقل: الإلغاء بتاريخٍ قبل الدفعة من جهاز عضوٍ بنسخة قديمة ═══════════ */

const UID = 'owner-p10';
const MEMBER = 'member-p10';
const REASON = 'إلغاء مصطنع';
const sync = (db: DB, r: MemoryRemote) => syncOnce(db, r, getMeta(db, 'device_id')!);
const reasonOf = (db: DB, pk: string) => db.get<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE pk = ? ORDER BY id DESC`, [pk])?.reason ?? '';
const cancelledAt = (db: DB, id: string) => db.get<{ c: string | null }>(`SELECT cancelled_at AS c FROM contract_payments WHERE id = ?`, [id])!.c;
const entryOf = (db: DB, pid: string) => db.get<{ j: string }>(`SELECT journal_entry_id AS j FROM contract_payments WHERE id = ?`, [pid])!.j;
const docOf = (r: MemoryRemote, t: string, k: string) => ([...r.docs.values()] as RemoteDoc[]).find((d) => d.t === t && d.k === k)!;

/** ما كان cancelPayment يكتبه قبل حماية التاريخ حرفياً: عكس قيد الدفعة بتاريخ الإلغاء، ووسم الدفعة، والمسدَّد · يعيد العاكس */
function legacyCancel(db: DB, pid: string, date: string): string {
  const rev = reverseEntryById(db, entryOf(db, pid), 'إلغاء دفعة · ' + REASON, date)!;
  db.run(`UPDATE contract_payments SET cancelled_at = ?, cancel_reason = ?, cancel_entry_id = ? WHERE id = ?`, [date, REASON, rev.id, pid]);
  recomputeInstallments(db);
  return rev.id;
}
/** كتابة العضو كما تصل السحابة: «op» قسم العملية تشترطه القواعد على كل كتابة عضو، و«by» كاتب الصف الجديد */
const asMember = (r: MemoryRemote, rev: string, pay: string) => {
  r.inject({ ...docOf(r, 'journal_entries', rev), by: MEMBER, op: 'ledger' });
  r.inject({ ...docOf(r, 'contract_payments', pay), op: 'collect' });
};

/** جهاز المالك: دفعة ٢ أبريل والربع الثاني مقدَّم بتاريخ ١٥ يوليو (إلا بـ filed: false) · وجهازٌ ثانٍ بنسخةٍ قديمة يلغيها بتاريخ date ويرفع */
async function cancelledElsewhere(date: string, member: boolean, filed = true) {
  const r = new MemoryRemote();
  const owner = memDb();
  const dev = memDb();
  enableSync(owner, UID);
  enableSync(dev, UID);
  const x = aprilPayment(owner);
  if (filed) fileVatReturn(owner, 2026, 2, '2026-07-15');
  await sync(owner, r);
  await sync(dev, r);
  const rev = legacyCancel(dev, x.pay, date);
  await sync(dev, r);
  if (member) asMember(r, rev, x.pay);
  await sync(owner, r);
  await sync(owner, r);
  return { ...x, r, owner, dev, rev };
}

describe('البند ١٠ (تتمة · المتحقق المستقل): الإلغاء بتاريخٍ قبل الدفعة من جهازٍ بنسخة قديمة', () => {
  test('١٠ تتمة: إلغاء العضو بتاريخٍ قبل الدفعة يُرفض على جهاز المالك · عاكسه ووسمه · فلا يتغيّر المقدَّم والبند ٥ يطابق الدفتر في الربعين', async () => {
    const { owner, dev, pay, amount, rev } = await cancelledElsewhere('2026-03-30', true);
    const why = t('payment.cancelBeforePayment', { date: dfmt('2026-04-02'), lng: 'ar' });
    // قبل الإصلاح: «owner cancelled_at 2026-03-30 box5 [0,0] ledger [-200000,200000]» والربع الثاني المقدَّم يتغيّر في البندين ٥ و٦
    expect([box5(owner, 1), box5(owner, 2)]).toEqual([ledger42(owner, 1), ledger42(owner, 2)]);
    expect(filedDiff(owner, 2026, 2)).toEqual([]);
    expect(cancelledAt(owner, pay)).toBeNull();
    expect(owner.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [rev])).toBeFalsy();
    expect([box5(owner, 1), box5(owner, 2)]).toEqual([0, amount]);
    expect(reasonOf(owner, pay)).toContain(why);
    expect(reasonOf(owner, rev)).toContain(why);
    owner.close(); dev.close();
  });

  test('١٠ تتمة: وعاكس العضو وحده يُرفض قبل وصول وسم الدفعة · ثم الوسم حين يصل · فلا يبقى في الدفتر عكسٌ لدفعةٍ حيّة', async () => {
    const r = new MemoryRemote();
    const owner = memDb();
    const dev = memDb();
    enableSync(owner, UID);
    enableSync(dev, UID);
    const { pay, amount } = aprilPayment(owner);
    fileVatReturn(owner, 2026, 2, '2026-07-15');
    await sync(owner, r);
    await sync(dev, r);
    const before = docOf(r, 'contract_payments', pay);
    const rev = legacyCancel(dev, pay, '2026-03-30');
    await sync(dev, r);
    const cancelled = docOf(r, 'contract_payments', pay);
    // الوسم لم يصل السحابة بعد: العاكس وحده
    r.docs.set(cancelled.id, { ...before, ts: (cancelled as RemoteDoc & { ts: string }).ts });
    r.inject({ ...docOf(r, 'journal_entries', rev), by: MEMBER, op: 'ledger' });
    await sync(owner, r);
    expect(owner.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [rev])).toBeFalsy();
    expect(reasonOf(owner, rev)).toContain(t('payment.cancelBeforePayment', { date: dfmt('2026-04-02'), lng: 'ar' }));
    // ثم يصل الوسم
    r.inject({ ...cancelled, op: 'collect' });
    await sync(owner, r);
    await sync(owner, r);
    expect(cancelledAt(owner, pay)).toBeNull();
    expect([box5(owner, 1), box5(owner, 2)]).toEqual([0, amount]);
    expect([box5(owner, 1), box5(owner, 2)]).toEqual([ledger42(owner, 1), ledger42(owner, 2)]);
    expect(filedDiff(owner, 2026, 2)).toEqual([]);
    owner.close(); dev.close();
  });

  test('١٠ تتمة: وإلغاء العضو بتاريخ الدفعة أو بعده يُقبل كما كان · ويُخصم في ربع إلغائه', async () => {
    // تاريخ الدفعة نفسه (والربع الثاني مفتوح): صافي ربعها صفر · وبعده في الربع الثالث المفتوح والثاني مقدَّم: يُخصم فيه
    for (const [date, filed, want] of [['2026-04-02', false, [0, 0, 0]], ['2026-07-20', true, [0, 1, -1]]] as const) {
      const { owner, dev, pay, amount, rev } = await cancelledElsewhere(date, true, filed);
      expect(cancelledAt(owner, pay)).toBe(date);
      expect(owner.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [rev])).toBeTruthy();
      expect([box5(owner, 1), box5(owner, 2), box5(owner, 3)]).toEqual([ledger42(owner, 1), ledger42(owner, 2), ledger42(owner, 3)]);
      expect([box5(owner, 1), box5(owner, 2), box5(owner, 3)]).toEqual(want.map((k) => k * amount));
      if (filed) expect(filedDiff(owner, 2026, 2)).toEqual([]);
      owner.close(); dev.close();
    }
  });

  test('١٠ تتمة: وإلغاء المالك من جهازه الآخر يُقبل كما كتبه · فلا تفترق أجهزته (نظير البند ٢٧)', async () => {
    const { owner, dev, pay } = await cancelledElsewhere('2026-03-30', false);
    expect(cancelledAt(owner, pay)).toBe('2026-03-30');
    expect(cancelledAt(dev, pay)).toBe('2026-03-30');
    owner.close(); dev.close();
  });
});

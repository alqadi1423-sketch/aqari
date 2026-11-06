/**
 * المراجعة الشاملة ٨ · البند ١١: عمولة الخلو (التقبيل) خدمةٌ خاضعة للمنشأة المسجّلة · بيانات مصطنعة.
 * الخيار (أ): العمولة المقبوضة شاملة الضريبة تُقسم صافياً إلى 4300 وضريبةً إلى 2200 بنسبة ١٥٪ (الصافي = round(المبلغ × 100 ÷ 115)
 * والضريبة الباقي)، وتدخل البند ١ في فترة تاريخ الصفقة، وعكسها ينقصه في فترة العكس، والدفتر يطابق الإقرار بالهللة.
 * والمنشأة غير المسجّلة كما كانت، وحركة البنك بالمبلغ المقبوض كاملاً، والوارد البنكي اليدوي بلا ضريبة تلقائية.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, addBank } from './helpers/fixtures';
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { restoreFromTrash, restoreIntoFiledPeriod } from '@/domain/trash';
import { accountBalance } from '@/domain/accounting/ledger';
import { vatReturnData, quarterRange } from '@/domain/vatReturn';
import { fileVatReturn, filedDiff } from '@/domain/vatFilings';
import { recordManualBankTx } from '@/domain/cashOps';
import { postClaim, postDepositDeduct, postReservationForfeit } from '@/domain/accounting/post';
import type { DB } from '@/db/adapter';

type Q = 1 | 2 | 3 | 4;
const register = (db: DB) => db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
const box = (db: DB, q: Q, no: string) => {
  const it = vatReturnData(db, 2026, q).items.find((x) => x.no === no)!;
  return [it.amountHalalas, it.taxHalalas];
};
/** صافي الدائن على حسابٍ في ربعٍ من الدفتر المرحّل */
const ledgerIn = (db: DB, q: Q, acct: string) => {
  const { from, to } = quarterRange(2026, q);
  return Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL AND l.account_code = ? AND e.date >= ? AND e.date <= ?`, [acct, from, to])!.s);
};
const box1TaxAllYear = (db: DB) => ([1, 2, 3, 4] as Q[]).reduce((s, q) => s + box(db, q, '1')[1], 0);
const deal = (db: DB, commission: number, date: string, bankId: string | null) =>
  recordKeyMoneyDeal(db, {
    unitId: addUnit(db, addProperty(db, { name: 'عقار تقبيل مصطنع' })), outgoing: 'متنازل مصطنع', incoming: 'متنازل له مصطنع',
    amountHalalas: 3000000, date, commissionHalalas: commission, method: bankId ? 'bank' : 'cash', bankId, notes: '',
  });
const cancelDeal = (db: DB, dealId: string, date: string) => {
  const a = entrySourceAction(db, entryOf(db, dealId).id);
  if (a?.kind !== 'op') throw new Error('op');
  a.run(date, 'سبب إلغاء مصطنع');
};
const inTrash = (db: DB, dealId: string) =>
  !!db.get(`SELECT 1 FROM key_money_deals WHERE id = ? AND deleted_at IS NOT NULL`, [dealId]);
const entryOf = (db: DB, dealId: string) =>
  db.get<{ id: string; no: string }>(`SELECT id, no FROM journal_entries WHERE src_type = 'key_money' AND src_id = ? ORDER BY rowid LIMIT 1`, [dealId])!;
const linesOf = (db: DB, entryId: string) => db.all<{ a: string; d: number; c: number }>(
  `SELECT account_code AS a, debit_halalas AS d, credit_halalas AS c FROM journal_lines WHERE entry_id = ? ORDER BY account_code`, [entryId])
  .map((l) => [l.a, Number(l.d), Number(l.c)]);

test('١١ عمولة تقبيل لمنشأة مسجّلة: صافيها في 4300 وضريبتها في 2200 · والبند ١ يطابق الدفتر بالهللة · والبنك بالمقبوض كاملاً', () => {
  const db = memDb();
  register(db);
  const bank = addBank(db, 'بنك تقبيل مصطنع');
  // 10001 × 100 ÷ 115 = 8696.52 ← صافٍ 8697 وضريبة 1304
  const id = deal(db, 10001, '2026-02-10', bank);
  const e = entryOf(db, id);
  expect(linesOf(db, e.id)).toEqual([['1100', 10001, 0], ['2200', 0, 1304], ['4300', 0, 8697]]);
  expect(accountBalance(db, '4300')).toBe(8697);
  expect(accountBalance(db, '2200')).toBe(1304);
  expect(box(db, 1, '1')).toEqual([8697, 1304]);
  expect(box(db, 1, '1')[1]).toBe(accountBalance(db, '2200'));
  expect(box(db, 1, '6')).toEqual([8697, 1304]);
  expect(box(db, 1, '13')[1]).toBe(1304);
  expect(db.all<{ a: number }>(`SELECT amount_halalas AS a FROM bank_tx WHERE bank_id = ?`, [bank]).map((r) => Number(r.a))).toEqual([10001]);
  expect(Number(db.get<{ c: number }>(`SELECT commission_halalas AS c FROM key_money_deals WHERE id = ?`, [id])!.c)).toBe(10001);
  db.close();
});

test('١١ منشأة غير مسجّلة: العمولة كلها في 4300 كما كانت ولا شيء في البند ١', () => {
  const db = memDb();
  const id = deal(db, 10001, '2026-02-10', null);
  expect(linesOf(db, entryOf(db, id).id)).toEqual([['1100', 10001, 0], ['4300', 0, 10001]]);
  expect(accountBalance(db, '2200')).toBe(0);
  expect(box(db, 1, '1')).toEqual([0, 0]);
  db.close();
});

test('١١ إلغاء التقبيل في فترة لاحقة ينقص البند ١ في فترة الإلغاء كما يعكس الدفتر · والاستعادة تعيده · والبنك بالمبلغ كاملاً', () => {
  const db = memDb();
  register(db);
  const bank = addBank(db, 'بنك إلغاء مصطنع');
  const id = deal(db, 23000, '2026-02-10', bank); // صافٍ 20000 وضريبة 3000
  const a = entrySourceAction(db, entryOf(db, id).id);
  if (a?.kind !== 'op') throw new Error('op');
  a.run('2026-04-15', 'سبب إلغاء مصطنع');
  expect(box(db, 1, '1')).toEqual([20000, 3000]);
  expect(box(db, 2, '1')).toEqual([-20000, -3000]);
  for (const q of [1, 2] as Q[]) {
    expect(box(db, q, '1')).toEqual([ledgerIn(db, q, '4300'), ledgerIn(db, q, '2200')]);
  }
  expect(accountBalance(db, '2200')).toBe(0);
  expect(box1TaxAllYear(db)).toBe(accountBalance(db, '2200'));
  expect(db.all<{ a: number }>(`SELECT amount_halalas AS a FROM bank_tx WHERE bank_id = ? ORDER BY rowid`, [bank]).map((r) => Number(r.a)))
    .toEqual([23000, -23000]);
  // الاستعادة من السلة: نسخة القيد بتاريخ عكسه فيرجع البند ١ في فترة العكس صفراً ويبقى الأصل في فترته
  restoreFromTrash(db, 'key_money_deals', id);
  expect(box(db, 1, '1')).toEqual([20000, 3000]);
  expect(box(db, 2, '1')).toEqual([0, 0]);
  expect(accountBalance(db, '2200')).toBe(3000);
  expect(box1TaxAllYear(db)).toBe(accountBalance(db, '2200'));
  db.close();
});

test('١١ لا عمولة تقبيل بتاريخٍ في فترةٍ قُدِّم إقرارها · وفي الفترة المفتوحة تُسجَّل', () => {
  const db = memDb();
  register(db);
  fileVatReturn(db, 2026, 1, '2026-04-20');
  expect(() => deal(db, 11500, '2026-03-01', null)).toThrow();
  expect(db.get(`SELECT 1 FROM key_money_deals`)).toBeFalsy();
  expect(box(db, 1, '1')).toEqual([0, 0]);
  deal(db, 11500, '2026-04-25', null);
  expect(box(db, 2, '1')).toEqual([10000, 1500]);
  db.close();
});

test('١١ الوارد البنكي اليدوي لمنشأة مسجّلة يبقى إيراداً بلا ضريبة مخرجات تلقائية (قد يكون عائداً معفى)', () => {
  const db = memDb();
  register(db);
  const bank = addBank(db, 'بنك وارد مصطنع');
  recordManualBankTx(db, { kind: 'income', bankId: bank, amountHalalas: 11500, date: '2026-02-12', descr: 'عائد مصطنع' });
  expect(accountBalance(db, '4300')).toBe(11500);
  expect(accountBalance(db, '2200')).toBe(0);
  expect(box(db, 1, '1')).toEqual([0, 0]);
  db.close();
});

test('١١ لا تُستعاد صفقة التقبيل إلى فترةٍ قُدِّم إقرارها بعد إلغائها · فيبقى الإقرار المقدَّم كما قُدِّم · وتُستعاد إن كانت فترة العكس مفتوحة', () => {
  // الإلغاء في الربع نفسه ثم تقديم إقراره: نسخة الاستعادة بتاريخ العكس تقع في الربع المقدَّم
  const db = memDb();
  register(db);
  const id = deal(db, 23000, '2026-02-10', addBank(db, 'بنك سلة مصطنع'));
  cancelDeal(db, id, '2026-03-01');
  fileVatReturn(db, 2026, 1, '2026-04-20');
  expect(() => restoreFromTrash(db, 'key_money_deals', id)).toThrow(/قُدِّم إقرارها/);
  expect(inTrash(db, id)).toBe(true);
  expect(box(db, 1, '1')).toEqual([0, 0]);
  expect(filedDiff(db, 2026, 1)).toEqual([]);
  expect(accountBalance(db, '2200')).toBe(0);
  expect(db.all(`SELECT 1 FROM journal_entries WHERE src_type = 'key_money' AND src_id = ?`, [id])).toHaveLength(1);
  // فلا يظهر زرّ استعادتها في السلة
  expect(restoreIntoFiledPeriod(db, 'key_money_deals', id)).toBe(true);
  db.close();

  // الإلغاء في ربعٍ لاحق ثم تقديم إقراره: لا يعود البند ١ فيه إلى الصفر بعد تقديمه
  const db2 = memDb();
  register(db2);
  const id2 = deal(db2, 23000, '2026-02-10', null);
  cancelDeal(db2, id2, '2026-04-15');
  fileVatReturn(db2, 2026, 2, '2026-07-20');
  expect(() => restoreFromTrash(db2, 'key_money_deals', id2)).toThrow(/قُدِّم إقرارها/);
  expect(box(db2, 2, '1')).toEqual([-20000, -3000]);
  expect(filedDiff(db2, 2026, 2)).toEqual([]);
  db2.close();

  // الأصل في ربعٍ مقدَّم والعكس في ربعٍ مفتوح: تُستعاد، والنسخة بتاريخ العكس، فلا يتغيّر المقدَّم
  const db3 = memDb();
  register(db3);
  const id3 = deal(db3, 23000, '2026-02-10', null);
  fileVatReturn(db3, 2026, 1, '2026-04-05');
  cancelDeal(db3, id3, '2026-04-15');
  expect(restoreIntoFiledPeriod(db3, 'key_money_deals', id3)).toBe(false);
  restoreFromTrash(db3, 'key_money_deals', id3);
  expect(inTrash(db3, id3)).toBe(false);
  expect(box(db3, 2, '1')).toEqual([0, 0]);
  expect(filedDiff(db3, 2026, 1)).toEqual([]);
  expect(accountBalance(db3, '2200')).toBe(3000);
  db3.close();
});

test('١١ لا يُلغى التقبيل بتاريخٍ قبل تاريخ الصفقة · وبتاريخها يُلغى', () => {
  const db = memDb();
  register(db);
  const id = deal(db, 23000, '2026-04-10', addBank(db, 'بنك تاريخ مصطنع'));
  expect(() => cancelDeal(db, id, '2026-03-01')).toThrow(/قبل تاريخ القيد الأصلي/);
  expect(inTrash(db, id)).toBe(false);
  expect(db.get(`SELECT 1 FROM journal_entries WHERE src_type = 'key_money_rev'`)).toBeFalsy();
  expect(box(db, 1, '1')).toEqual([0, 0]);
  expect(box(db, 2, '1')).toEqual([20000, 3000]);
  cancelDeal(db, id, '2026-04-10');
  expect(box(db, 2, '1')).toEqual([0, 0]);
  db.close();
});

test('١١ قيد عمولة تقبيلٍ غاب مستنده لا يُعكس «بلا مستند» بتاريخٍ قبل تاريخه · وبعده يُعكس', () => {
  const db = memDb();
  register(db);
  const id = deal(db, 23000, '2026-04-10', null);
  const e = entryOf(db, id);
  db.run(`DELETE FROM key_money_deals WHERE id = ?`, [id]);
  const a = entrySourceAction(db, e.id);
  if (a?.kind !== 'op') throw new Error('op');
  expect(() => a.run('2026-03-01', 'سبب عكس مصطنع')).toThrow(/قبل تاريخ القيد الأصلي/);
  expect(box(db, 1, '1')).toEqual([0, 0]);
  expect(db.get(`SELECT 1 FROM journal_entries WHERE src_type = 'key_money_rev'`)).toBeFalsy();
  a.run('2026-04-12', 'سبب عكس مصطنع');
  expect(box(db, 2, '1')).toEqual([0, 0]);
  db.close();
});

test('١١ مصادر 4300 الأخرى لمنشأة مسجّلة تبقى بلا ضريبة مخرجات تلقائية: خصم التأمين ومصادرة العربون والمطالبة (قرارٌ مسبَّب)', () => {
  const db = memDb();
  register(db);
  postDepositDeduct(db, { id: 'عقد-مصطنع-1', contract_no: 'ع-1' }, 11500, '2026-02-11');
  postDepositDeduct(db, { id: 'عقد-مصطنع-2', contract_no: 'ع-2', holder: 'طرف آخر', received: true }, 11500, '2026-02-12');
  postReservationForfeit(db, { id: 'حجز-مصطنع', name: 'حاجز مصطنع', deposit: 11500, date: '2026-02-13' });
  postClaim(db, { id: 'مطالبة-مصطنعة', amount: 11500, reason: 'تلف مصطنع', date: '2026-02-14' });
  expect(accountBalance(db, '4300')).toBe(46000);
  expect(accountBalance(db, '2200')).toBe(0);
  expect(box(db, 1, '1')).toEqual([0, 0]);
  db.close();
});

test('١١ منشأة غير مسجّلة اليوم: لا عمولة تقبيل بتاريخٍ في فترةٍ قُدِّم إقرارها (قرار المالك «٦» عامٌّ للعملية النقدية) · وفي المفتوحة كلها في 4300', () => {
  const db = memDb();
  fileVatReturn(db, 2026, 1, '2026-04-20');
  expect(() => deal(db, 11500, '2026-03-01', null)).toThrow(/قُدِّم إقرارها/);
  expect(db.get(`SELECT 1 FROM key_money_deals`)).toBeFalsy();
  deal(db, 11500, '2026-04-25', null);
  expect(accountBalance(db, '4300')).toBe(11500);
  expect(box(db, 2, '1')).toEqual([0, 0]);
  db.close();
});

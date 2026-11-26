/**
 * A2.8 (الباقي) · متوسط · العكس والإلغاء يفحصان الرصيد الحالي · قرار المالك س١٩ (2026-11-13: «ولا يصير النقد سالباً أبداً» في أي يومٍ
 * مضى أيضاً) · src/domain/cashGuard.ts وكل مسار عكسٍ أو إلغاءٍ يُخرج نقداً أو مالاً من بنك.
 *
 * السيناريو (بيانات مصطنعة): «إيداع المالك» ١٬٠٠٠٫٠٠ يوم 2026-01-10، ثم مصروف نثري ٨٠٠٫٠٠ يوم 2026-01-20، ثم إيداعٌ آخر ١٬٥٠٠٫٠٠ يوم
 * 2026-06-01: المحفظة الآن ١٬٧٠٠٫٠٠ تكفي عكس الإيداع الأول (١٬٠٠٠٫٠٠)، لكن عكسه بتاريخه يجعلها من ٢٠ يناير إلى آخر مايو −٨٠٠٫٠٠ ·
 * فكان يُقبل لأن العكس يقرأ الرصيد الآن. ومثله عكس تحصيلٍ أو إلغاء دفعةٍ أو حذف إيداعٍ في البنك بتاريخه.
 * السلوك الصحيح: كل عكسٍ أو إلغاءٍ يُخرج من المحفظة أو من بنك يُفحص بأدنى رصيدٍ جارٍ من تاريخه النافذ (تاريخ العاكس) إلى اليوم، برسالة
 * A2.8 نفسها التي تذكر اليوم · ويُقبل بتاريخٍ يكفي فيه كل يومٍ بعده.
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { ownerCashIn, pettyCashExpense, depositCashToBank, withdrawCashFromBank, transferBetweenBanks } from '@/domain/cashOps';
import { CashShortfallError, walletLowFrom, bankLowFrom } from '@/domain/cashGuard';
import { postManualEntry } from '@/domain/accounting/post';
import { reverseFromJournal } from '@/domain/accounting/journalReversal';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { saveInvoice, payInvoice, setInvoiceStatus, collectionBankShortages } from '@/domain/invoices';
import { confirmContract, recordRentPayment, cancelContract } from '@/domain/contracts/service';
import { planCancelPayment, cancelPayment } from '@/domain/contracts/cancelPayment';
import { deleteBankTx } from '@/domain/bankTx';
import { restoreFromTrash } from '@/domain/trash';
import { savePurchase, payPurchase, deletePurchase, TS_EXCLUDED, type PurchaseInput } from '@/domain/purchases';
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { createReservation, cancelReservation } from '@/domain/reservations';
import { walletCashBalance, bankBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';
import { pair, sync, ownerPulls, MEMBER, reasonOf } from './helpers/rederive';

const red = (db: DB) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')');
const entryCount = (db: DB) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_entries`)!.n);
const L = (account: string, debit: number, credit: number) => ({ account, debit, credit });

/** إيداع ١٬٠٠٠٫٠٠ يوم 01-10 ثم نثري ٨٠٠٫٠٠ يوم 01-20 ثم إيداع ١٬٥٠٠٫٠٠ يوم 06-01: الآن ١٬٧٠٠٫٠٠ وأدناه من 01-10 هو ٢٠٠٫٠٠ يوم 01-20 */
function walletStory(db: DB, first: () => void): void {
  first();
  pettyCashExpense(db, { amountHalalas: 80000, descr: 'نثري مصطنع', date: '2026-01-20' });
  ownerCashIn(db, { amountHalalas: 150000, date: '2026-06-01' });
  expect(walletCashBalance(db)).toBe(170000);
  expect(walletLowFrom(db, '2026-01-10')).toEqual({ low: 20000, at: '2026-01-20' });
}

test('A2.8ب عكس قيدٍ يدوي أدخل نقداً: يُفحص بأدنى رصيد المحفظة من تاريخ العاكس · فيُرفض برسالةٍ تذكر اليوم، ويُقبل حين يكفي كل يوم', () => {
  const db = memDb();
  let id = '';
  walletStory(db, () => {
    id = postManualEntry(db, { date: '2026-01-10', memo: 'إيداع يدوي مصطنع', lines: [L('1100', 100000, 0), L('3100', 0, 100000)] })!.id;
  });
  const before = entryCount(db);
  let err: unknown;
  try { reverseFromJournal(db, id); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(CashShortfallError);
  expect((err as Error).message).toContain('20/01/2026');
  expect([walletCashBalance(db), entryCount(db)]).toEqual([170000, before]);
  // إيداعٌ ٨٠٠٫٠٠ يوم 01-15 يجعل أدنى الرصيد من 01-10: ١٬٠٠٠ (01-10) ثم ١٬٨٠٠ ثم ١٬٠٠٠ (01-20) ثم ٢٬٥٠٠ = ١٬٠٠٠٫٠٠ فيكفي
  ownerCashIn(db, { amountHalalas: 80000, date: '2026-01-15' });
  reverseFromJournal(db, id);
  expect(walletCashBalance(db)).toBe(250000 - 100000);
  expect(walletLowFrom(db, '2026-01-01').low).toBe(0);
  expect(red(db)).toEqual([]);
  db.close();
});

test('A2.8ب عكس قيدٍ يدوي أدخل البنك (خانة البنك · A2.10): بأدنى رصيد البنك من تاريخ العاكس', () => {
  const db = memDb();
  const bank = addBank(db, 'بنك يدوي مصطنع');
  const other = addBank(db, 'بنك آخر مصطنع');
  const e = postManualEntry(db, { date: '2026-01-10', memo: 'قرض مصطنع', lines: [L('1100', 100000, 0), L('2100', 0, 100000)], bankId: bank })!;
  transferBetweenBanks(db, { fromBankId: bank, toBankId: other, amountHalalas: 80000, date: '2026-01-20' });
  transferBetweenBanks(db, { fromBankId: other, toBankId: bank, amountHalalas: 80000, date: '2026-06-01' });
  expect(bankBalance(db, bank)).toBe(100000);
  expect(bankLowFrom(db, bank, '2026-01-10')).toEqual({ low: 20000, at: '2026-01-20' });
  expect(() => reverseFromJournal(db, e.id)).toThrow(/20\/01\/2026/);
  expect(bankBalance(db, bank)).toBe(100000);
  db.close();
});

test('A2.8ب «إلغاء العملية» (إيداع المالك) من مصدره: بتاريخ الإلغاء الذي يختاره المستخدم · المانع تحت التاريخ والتنفيذ يرفضه', () => {
  const db = memDb();
  walletStory(db, () => ownerCashIn(db, { amountHalalas: 100000, date: '2026-01-10' }));
  const id = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'cash_op' AND date = '2026-01-10'`)!.id;
  const act = entrySourceAction(db, id);
  if (act?.kind !== 'op') throw new Error('لا عملية إلغاء'); // i18n-exempt: رسالة اختبار
  // الرصيد الآن يكفي فلا مانع عام · والمانع بتاريخ الإلغاء
  expect(act.blockers).toEqual([]);
  expect(act.dateBlock('2026-01-10')).toContain('20/01/2026');
  expect(() => act.run('2026-01-10', 'سبب مصطنع')).toThrow(/20\/01\/2026/);
  expect(walletCashBalance(db)).toBe(170000);
  // وبتاريخٍ يكفي فيه كل يومٍ بعده (06-01: ١٬٧٠٠٫٠٠)
  expect(act.dateBlock('2026-06-01')).toBe('');
  act.run('2026-06-01', 'سبب مصطنع');
  expect(walletCashBalance(db)).toBe(70000);
  expect(red(db)).toEqual([]);
  db.close();
});

test('A2.8ب «إلغاء التقبيل» إلى بنك: بأدنى رصيد البنك من تاريخ الإلغاء', () => {
  const db = memDb();
  const b1 = addBank(db, 'بنك تقبيل مصطنع');
  const b2 = addBank(db, 'بنك ثانٍ مصطنع');
  const u = addUnit(db, addProperty(db, { name: 'عقار تقبيل مصطنع' }));
  const k = recordKeyMoneyDeal(db, {
    unitId: u, outgoing: 'متنازل مصطنع', incoming: 'متنازل له مصطنع', amountHalalas: 5000000, date: '2026-10-01',
    commissionHalalas: 300000, method: 'bank', bankId: b1, notes: '',
  });
  transferBetweenBanks(db, { fromBankId: b1, toBankId: b2, amountHalalas: 300000, date: '2026-10-02' });
  transferBetweenBanks(db, { fromBankId: b2, toBankId: b1, amountHalalas: 300000, date: '2026-10-10' });
  const entryId = db.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [k])!.id;
  const act = entrySourceAction(db, entryId);
  if (act?.kind !== 'op') throw new Error('لا عملية إلغاء'); // i18n-exempt: رسالة اختبار
  expect(act.blockers).toEqual([]);
  expect(act.dateBlock('2026-10-01')).toContain('02/10/2026');
  expect(() => act.run('2026-10-01', 'سبب مصطنع')).toThrow(/02\/10\/2026/);
  expect(bankBalance(db, b1)).toBe(300000);
  act.run('2026-10-10', 'سبب مصطنع');
  expect(bankBalance(db, b1)).toBe(0);
  db.close();
});

describe('A2.8ب عكس تحصيل الفاتورة بتاريخ عاكسه (تاريخ التحصيل)', () => {
  const inv = (db: DB) => saveInvoice(db, {
    customer: 'عميل مصطنع', customerVat: '', issue: '2026-10-01', due: '2026-10-30', notes: '',
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100000, taxPct: 15 }],
  }, 'مستحقة');

  test('نقداً: ١٬١٥٠٫٠٠ حُصّلت 10-05 وصُرف منها ١٬٠٠٠٫٠٠ يوم 10-06: لا تعود «مستحقة» ولو كفت المحفظة الآن', () => {
    const db = memDb();
    const id = inv(db);
    payInvoice(db, id, { method: 'cash', bankId: null, date: '2026-10-05' });
    pettyCashExpense(db, { amountHalalas: 100000, descr: 'نثري مصطنع', date: '2026-10-06' });
    ownerCashIn(db, { amountHalalas: 200000, date: '2026-11-01' });
    expect(walletCashBalance(db)).toBe(215000);
    expect(() => setInvoiceStatus(db, id, 'مستحقة')).toThrow(/06\/10\/2026/);
    expect(walletCashBalance(db)).toBe(215000);
    expect(db.get<{ s: string }>(`SELECT status AS s FROM invoices WHERE id = ?`, [id])!.s).toBe('مدفوعة');
    db.close();
  });

  test('بنكاً: البنك فرغ يوم 10-06 ثم عاد ١٬١٥٠٫٠٠ يوم 11-01: السبب يذكر اليوم، والرجوع مرفوض', () => {
    const db = memDb();
    const b1 = addBank(db, 'بنك تحصيل مصطنع');
    const b2 = addBank(db, 'بنك مصطنع ب');
    const id = inv(db);
    payInvoice(db, id, { method: 'bank', bankId: b1, date: '2026-10-05' });
    transferBetweenBanks(db, { fromBankId: b1, toBankId: b2, amountHalalas: 115000, date: '2026-10-06' });
    transferBetweenBanks(db, { fromBankId: b2, toBankId: b1, amountHalalas: 115000, date: '2026-11-01' });
    expect(bankBalance(db, b1)).toBe(115000);
    expect(collectionBankShortages(db, id).join(' ')).toContain('06/10/2026');
    expect(() => setInvoiceStatus(db, id, 'مستحقة')).toThrow(/06\/10\/2026/);
    expect(bankBalance(db, b1)).toBe(115000);
    db.close();
  });
});

describe('A2.8ب «إلغاء الدفعة» بتاريخ الإلغاء', () => {
  function rent(db: DB, method: 'cash' | 'bank', bank?: string) {
    const u = addUnit(db, addProperty(db, { name: 'عقار دفعة مصطنع' }), { unit_no: 'R-1' });
    const c = confirmContract(db, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '', valueHalalas: 1200000, cycle: 'شهرية',
      start: '2026-10-01', end: '2027-09-30', depositHalalas: 0 }));
    const inst = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!.id;
    return recordRentPayment(db, c, { installmentId: inst, period: 'أكتوبر', date: '2026-10-05',
      lines: [method === 'cash' ? { method: 'cash', amountHalalas: 100000 } : { method: 'bank', bankId: bank!, amountHalalas: 100000 }],
      discountHalalas: 0, notes: '' });
  }

  test('نقداً: ١٬٠٠٠٫٠٠ قُبضت 10-05 وصُرف ٩٠٠٫٠٠ يوم 10-06 · الإلغاء بتاريخ 10-05 مانعه تحت التاريخ، وبتاريخ 11-01 يُقبل', () => {
    const db = memDb();
    const pay = rent(db, 'cash');
    pettyCashExpense(db, { amountHalalas: 90000, descr: 'نثري مصطنع', date: '2026-10-06' });
    ownerCashIn(db, { amountHalalas: 100000, date: '2026-11-01' });
    expect(walletCashBalance(db)).toBe(110000);
    const plan = planCancelPayment(db, pay, '2026-10-05');
    expect(plan.blockers).toEqual([]);
    expect(plan.dateError).toContain('06/10/2026');
    expect(() => cancelPayment(db, pay, { date: '2026-10-05', reason: 'سبب مصطنع' })).toThrow(/06\/10\/2026/);
    expect(walletCashBalance(db)).toBe(110000);
    expect(planCancelPayment(db, pay, '2026-11-01').dateError).toBeNull();
    cancelPayment(db, pay, { date: '2026-11-01', reason: 'سبب مصطنع' });
    expect(walletCashBalance(db)).toBe(10000);
    expect(red(db)).toEqual([]);
    db.close();
  });

  test('بنكاً: البنك فرغ يوم 10-06 ثم عاد ١٬٠٠٠٫٠٠ يوم 11-01', () => {
    const db = memDb();
    const b1 = addBank(db, 'بنك دفعة مصطنع');
    const b2 = addBank(db, 'بنك مصطنع ب');
    const pay = rent(db, 'bank', b1);
    transferBetweenBanks(db, { fromBankId: b1, toBankId: b2, amountHalalas: 100000, date: '2026-10-06' });
    transferBetweenBanks(db, { fromBankId: b2, toBankId: b1, amountHalalas: 100000, date: '2026-11-01' });
    const plan = planCancelPayment(db, pay, '2026-10-05');
    expect(plan.blockers).toEqual([]);
    expect(plan.dateError).toContain('06/10/2026');
    expect(() => cancelPayment(db, pay, { date: '2026-10-05', reason: 'سبب مصطنع' })).toThrow(/06\/10\/2026/);
    expect(bankBalance(db, b1)).toBe(100000);
    cancelPayment(db, pay, { date: '2026-11-01', reason: 'سبب مصطنع' });
    expect(bankBalance(db, b1)).toBe(0);
    db.close();
  });
});

test('A2.8ب حذف حركة البنك بلا قيد (التراجع عن إيداعٍ أو سحب) واستعادتها: بتاريخ الحركة', () => {
  const db = memDb();
  const bank = addBank(db, 'بنك إيداع مصطنع');
  ownerCashIn(db, { amountHalalas: 100000, date: '2026-01-01' });
  depositCashToBank(db, { bankId: bank, amountHalalas: 100000, date: '2026-01-10' });
  withdrawCashFromBank(db, { bankId: bank, amountHalalas: 80000, date: '2026-01-20' });
  pettyCashExpense(db, { amountHalalas: 50000, descr: 'نثري مصطنع', date: '2026-02-01' });
  ownerCashIn(db, { amountHalalas: 200000, date: '2026-06-01' });
  depositCashToBank(db, { bankId: bank, amountHalalas: 150000, date: '2026-06-01' });
  // البنك الآن ١٬٧٠٠٫٠٠ (١٬٠٠٠ − ٨٠٠ + ١٬٥٠٠) والمحفظة ٨٠٠٫٠٠ (١٬٠٠٠ − ١٬٠٠٠ + ٨٠٠ − ٥٠٠ + ٢٬٠٠٠ − ١٬٥٠٠)
  expect([bankBalance(db, bank), walletCashBalance(db)]).toEqual([170000, 80000]);
  const tx = (date: string, amount: number) => db.get<{ id: string }>(
    `SELECT id FROM bank_tx WHERE date = ? AND amount_halalas = ? AND deleted_at IS NULL`, [date, amount])!.id;
  // حذف إيداع 01-10 (١٬٠٠٠٫٠٠): البنك يكفيه الآن، لكنه من 01-20 إلى آخر مايو ٢٠٠٫٠٠ فيصير −٨٠٠٫٠٠
  expect(() => deleteBankTx(db, tx('2026-01-10', 100000))).toThrow(/20\/01\/2026/);
  // حذف سحب 01-20 (٨٠٠٫٠٠ دخلت المحفظة): المحفظة الآن ٨٠٠٫٠٠ تكفيه، لكنها يوم 02-01 كانت ٣٠٠٫٠٠
  expect(() => deleteBankTx(db, tx('2026-01-20', -80000))).toThrow(CashShortfallError);
  expect(() => deleteBankTx(db, tx('2026-01-20', -80000))).toThrow(/01\/02\/2026/);
  expect([bankBalance(db, bank), walletCashBalance(db)]).toEqual([170000, 80000]);
  // وإيداع 06-01 يُحذف (البنك من 06-01 ١٬٧٠٠٫٠٠) ثم استعادته بتاريخه تكفيها المحفظة (٢٬٣٠٠٫٠٠ من 06-01)
  const late = tx('2026-06-01', 150000);
  deleteBankTx(db, late);
  expect([bankBalance(db, bank), walletCashBalance(db)]).toEqual([20000, 230000]);
  // ونثريٌّ ٢٬٠٠٠٫٠٠ يوم 06-02 يترك المحفظة من 06-02 ٣٠٠٫٠٠: الاستعادة (١٬٥٠٠٫٠٠ تخرج من المحفظة يوم 06-01) تُرفض ولو أُودع بعدها
  pettyCashExpense(db, { amountHalalas: 200000, descr: 'نثري مصطنع', date: '2026-06-02' });
  ownerCashIn(db, { amountHalalas: 200000, date: '2026-07-01' });
  expect(walletCashBalance(db)).toBe(230000);
  expect(() => restoreFromTrash(db, 'bank_tx', late)).toThrow(/02\/06\/2026/);
  expect([bankBalance(db, bank), walletCashBalance(db)]).toEqual([20000, 230000]);
  db.close();
});

test('A2.8ب استعادة فاتورة شراءٍ سُدّدت نقداً: إعادة صرفها بتاريخ سدادها', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 100000, date: '2026-01-01' });
  const id = savePurchase(db, {
    supplier: 'مورد مصطنع', date: '2026-01-10', due: '2026-01-10', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: true, taxStatus: TS_EXCLUDED,
    subtotalHalalas: 30000, taxHalalas: 4500, totalHalalas: 34500,
  } as PurchaseInput);
  payPurchase(db, id, 'cash', null, '2026-01-10');
  deletePurchase(db, id);
  pettyCashExpense(db, { amountHalalas: 80000, descr: 'نثري مصطنع', date: '2026-01-15' });
  ownerCashIn(db, { amountHalalas: 100000, date: '2026-06-01' });
  // الآن ١٬٢٠٠٫٠٠ تكفي ٣٤٥٫٠٠، لكن يوم 01-15 كانت ٢٠٠٫٠٠
  expect(walletCashBalance(db)).toBe(120000);
  expect(() => restoreFromTrash(db, 'purchases', id)).toThrow(/15\/01\/2026/);
  expect(walletCashBalance(db)).toBe(120000);
  db.close();
});

test('A2.8ب ردّ العربون تحويلاً عند إلغاء الحجز: بأدنى رصيد البنك من تاريخ الرد', () => {
  const db = memDb();
  const bank = addBank(db, 'بنك عربون مصطنع');
  const other = addBank(db, 'بنك آخر مصطنع');
  const u = addUnit(db, addProperty(db, { name: 'عقار حجز مصطنع' }));
  const r = createReservation(db, { unitId: u, name: 'حاجز مصطنع', phone: '', depositHalalas: 50000, expiryDate: '2027-01-01', bankId: bank, date: '2026-03-01' });
  transferBetweenBanks(db, { fromBankId: bank, toBankId: other, amountHalalas: 50000, date: '2026-03-05' });
  transferBetweenBanks(db, { fromBankId: other, toBankId: bank, amountHalalas: 50000, date: '2026-06-01' });
  expect(() => cancelReservation(db, r, false, '2026-03-10', bank)).toThrow(/10\/03\/2026/);
  expect(bankBalance(db, bank)).toBe(50000);
  cancelReservation(db, r, false, '2026-06-01', bank);
  expect(bankBalance(db, bank)).toBe(0);
  db.close();
});

test('A2.8ب ردّ الإيجار المقدَّم نقداً عند الإنهاء: بأدنى رصيد المحفظة من تاريخ الإنهاء', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار إنهاء مصطنع' }), { unit_no: 'P-9' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر إنهاء مصطنع', idNumber: '', valueHalalas: 1200000, cycle: 'سنوية',
    start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  const inst = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ?`, [cid])!.id;
  recordRentPayment(db, cid, { installmentId: inst, period: '', date: '2026-01-01', lines: [{ method: 'cash', amountHalalas: 1200000 }], discountHalalas: 0, notes: '' });
  pettyCashExpense(db, { amountHalalas: 1000000, descr: 'نثري مصطنع', date: '2026-01-05' });
  ownerCashIn(db, { amountHalalas: 900000, date: '2026-06-01' });
  // الآن ١١٬٠٠٠٫٠٠ تكفي ردّ ٩٬٠٤١٫١٠ (المقدَّم بعد 03-31)، لكن المحفظة يوم 03-31 كانت ٢٬٠٠٠٫٠٠
  expect(walletCashBalance(db)).toBe(1100000);
  const cancel = { date: '2026-03-31', reason: 'غادر المستأجر', installmentsFate: 'cancel' as const, settle: false,
    deductionHalalas: 0, refundHalalas: 0, deductionReason: '', prepaidRefund: { amountHalalas: 904110, method: 'cash' as const } };
  expect(() => cancelContract(db, cid, cancel)).toThrow(/31\/03\/2026/);
  expect(walletCashBalance(db)).toBe(1100000);
  db.close();
});

describe('A2.8ب جهاز المالك على إلغاء العضو بتاريخٍ سابق (الحارس القائم memberBankOutCheck بتاريخ العاكس)', () => {
  for (const forged of [false, true]) {
    test((forged ? 'سلبي · إلغاء دفعةٍ بنكية بتاريخها والبنك فرغ بعدها (مزوَّر): يُرفض ولا ينزل البنك' : 'إيجابي · إلغاؤها بتاريخٍ يكفي: يُقبل'), async () => {
      const s = await pair();
      const b1 = addBank(s.owner, 'بنك عضو مصطنع');
      const b2 = addBank(s.owner, 'بنك مصطنع ب');
      const u = addUnit(s.owner, addProperty(s.owner, { name: 'عقار عضو مصطنع' }), { unit_no: 'M-1' });
      const c = confirmContract(s.owner, contractInput(u, { tenant: 'مستأجر عضو مصطنع', idNumber: '', valueHalalas: 1200000, cycle: 'شهرية',
        start: '2026-10-01', end: '2027-09-30', depositHalalas: 0 }));
      const inst = s.owner.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!.id;
      const pay = recordRentPayment(s.owner, c, { installmentId: inst, period: 'أكتوبر', date: '2026-10-05',
        lines: [{ method: 'bank', bankId: b1, amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
      transferBetweenBanks(s.owner, { fromBankId: b1, toBankId: b2, amountHalalas: 100000, date: '2026-10-06' });
      transferBetweenBanks(s.owner, { fromBankId: b2, toBankId: b1, amountHalalas: 100000, date: '2026-11-01' });
      await sync(s.owner, s.r);
      await sync(s.dev, s.r);
      // العضو يلغي بتاريخٍ يكفي (تطبيقه يرفض غيره) · والمزوَّر يُرجع تاريخ العاكس وحركته إلى يوم الدفعة
      cancelPayment(s.dev, pay, { date: '2026-11-02', reason: 'شيك مرتجع مصطنع' });
      await sync(s.dev, s.r);
      const on = '2026-10-05';
      const rev = [...s.r.docs.values()].find((d) => d.t === 'journal_entries' && d.d?.src_type === 'rent_rev')!;
      for (const d of [...s.r.docs.values()]) {
        const mine = (d.t === 'journal_entries' && d.k === rev.k) || (d.t === 'bank_tx' && d.d?.journal_no === rev.d!.no)
          || (d.t === 'contract_payments' && d.k === pay);
        if (!mine) continue;
        const field = d.t === 'contract_payments' ? 'cancelled_at' : 'date';
        s.r.inject({ ...d, by: MEMBER, op: 'collect', d: forged ? { ...d.d, [field]: on } : d.d } as RemoteDoc);
      }
      await ownerPulls(s.owner, s.r);
      expect(!!s.owner.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [rev.k])).toBe(!forged);
      expect(bankBalance(s.owner, b1)).toBe(forged ? 100000 : 0);
      if (forged) expect(reasonOf(s.owner, rev.k)).toContain('06/10/2026');
      s.close();
    });
  }
});

/**
 * كفاية النقد (قرار المالك ٢٠٢٦-١٠-٠٥): كل مسار يُخرج نقداً من المحفظة يُرفض حين لا يكفي النقد،
 * ولا يصير النقد سالباً أبداً. جردُ المسارات من سلوك التطبيق، كلٌّ بحالته، وبيانات مصطنعة.
 * في كل حالة يُفرَّغ النقد بمسحوبات المالك ثم يُجرَّب الصرف.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { walletCashBalance } from '@/domain/accounting/ledger';
import { ownerCashIn, ownerCashOut } from '@/domain/cashOps';
import { cashShortfall } from '@/domain/cashGuard';
import type { DB } from '@/db/adapter';

const T = '2026-05-10';
const SHORT = /لا يكفي: .* · ينقصه /;
/** يفرّغ المحفظة كلها بمسحوبات المالك */
const emptyWallet = (db: DB) => { const w = walletCashBalance(db); if (w > 0) ownerCashOut(db, { amountHalalas: w, date: T }); };
const purchaseInput = (total: number) => ({
  supplier: 'مورد مصطنع', date: '2026-05-01', due: '2026-05-31', category: 'صيانة', incorpItem: '',
  amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false,
  subtotalHalalas: total, taxHalalas: 0, totalHalalas: total,
});

describe('جرد مسارات الصرف النقدي · كلها تُرفض بلا نقد كافٍ', () => {
  afterEach(() => { /* كل حالة بقاعدتها */ });

  test('سداد فاتورة شراء نقداً (طريقة واحدة ومقسَّمة)', async () => {
    const { savePurchase, payPurchase, payPurchaseSplit } = await import('@/domain/purchases');
    const db = memDb();
    const id = savePurchase(db, purchaseInput(5000));
    expect(() => payPurchase(db, id, 'cash', null, T)).toThrow(SHORT);
    expect(() => payPurchaseSplit(db, id, [{ method: 'cash', amountHalalas: 5000 }], T)).toThrow(SHORT);
    ownerCashIn(db, { amountHalalas: 5000, date: T });
    payPurchase(db, id, 'cash', null, T);
    expect(walletCashBalance(db)).toBe(0);
  });

  test('ردّ العربون', async () => {
    const { createReservation, cancelReservation } = await import('@/domain/reservations');
    const { addDays, today } = await import('@/domain/dates');
    const db = memDb();
    const rid = createReservation(db, { unitId: addUnit(db, addProperty(db)), name: 'حاجز مصطنع', phone: '', depositHalalas: 30000, expiryDate: addDays(today(), 10) });
    emptyWallet(db);
    expect(() => cancelReservation(db, rid, false, T)).toThrow(SHORT);
    expect(walletCashBalance(db)).toBe(0);
  });

  test('ردّ التأمين: في تسويته بعد انتهاء العقد وعند إلغاء العقد', async () => {
    const { confirmContract, saveDepositSettlement, cancelContract } = await import('@/domain/contracts/service');
    const db = memDb();
    const u1 = addUnit(db, addProperty(db), { unit_no: 'D-1' });
    const ended = confirmContract(db, contractInput(u1, { tenant: 'مستأجر منتهٍ', start: '2025-01-01', end: '2025-12-31', depositHalalas: 40000 }));
    const u2 = addUnit(db, addProperty(db, { name: 'عقار آخر' }), { unit_no: 'D-2' });
    const live = confirmContract(db, contractInput(u2, { tenant: 'مستأجر قائم', start: '2026-01-01', end: '2026-12-31', depositHalalas: 20000 }));
    emptyWallet(db);
    expect(() => saveDepositSettlement(db, ended, { date: T, deductionHalalas: 0, deductionReason: '', refundHalalas: 40000, notes: '' })).toThrow(SHORT);
    expect(() => cancelContract(db, live, { date: T, reason: 'مغادرة', installmentsFate: 'cancel', settle: true, deductionHalalas: 0, refundHalalas: 20000, deductionReason: '' })).toThrow(SHORT);
    expect(walletCashBalance(db)).toBe(0);
  });

  test('إلغاء دفعة إيجار نقدية', async () => {
    const { confirmContract, recordRentPayment } = await import('@/domain/contracts/service');
    const { planCancelPayment, cancelPayment } = await import('@/domain/contracts/cancelPayment');
    const db = memDb();
    const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db)), { start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
    const i1 = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
    const pid = recordRentPayment(db, cid, { installmentId: i1, period: 'يناير', date: T, lines: [{ method: 'cash', amountHalalas: 10000 }], discountHalalas: 0, notes: '' });
    emptyWallet(db);
    expect(planCancelPayment(db, pid).blockers.join(' ')).toMatch(SHORT);
    expect(() => cancelPayment(db, pid, { reason: 'خطأ', date: T })).toThrow(SHORT);
  });

  test('الرجوع عن تحصيل فاتورة نقدي · وحذفها مقفلٌ لأنها صادرة (قرار المالك على #30)', async () => {
    const { saveInvoice, payInvoice, setInvoiceStatus, deleteInvoice } = await import('@/domain/invoices');
    const db = memDb();
    const id = saveInvoice(db, { customer: 'عميل مصطنع', customerVat: '', issue: T, due: T, notes: '', lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 7000, taxPct: 0 }] }, 'مستحقة');
    payInvoice(db, id, { method: 'cash', bankId: null, date: T });
    emptyWallet(db);
    expect(() => setInvoiceStatus(db, id, 'مستحقة')).toThrow(SHORT);
    expect(() => deleteInvoice(db, id)).toThrow();
  });

  test('الإلغاء من المستند لقيدٍ أدخل نقداً (عمولة تقبيل نقدية)', async () => {
    const { recordKeyMoneyDeal } = await import('@/domain/keymoney');
    const { entrySourceAction } = await import('@/domain/accounting/sourceCancel');
    const db = memDb();
    const id = recordKeyMoneyDeal(db, { unitId: addUnit(db, addProperty(db)), outgoing: 'مغادر', incoming: 'قادم', amountHalalas: 100000, date: T, commissionHalalas: 6000, method: 'cash', notes: '' });
    emptyWallet(db);
    const e = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'key_money' AND src_id = ?`, [id])!;
    const op = entrySourceAction(db, e.id);
    if (!op || op.kind !== 'op') throw new Error('لا إجراء إلغاء');
    expect(op.blockers.join(' ')).toMatch(SHORT);
    expect(() => op.run(T, 'خطأ')).toThrow(SHORT);
  });

  test('القيد اليدوي: إنشاؤه دائناً للنقد وعكس قيد أدخل نقداً', async () => {
    const { postManualEntry } = await import('@/domain/accounting/post');
    const { reverseFromJournal } = await import('@/domain/accounting/journalReversal');
    const db = memDb();
    expect(() => postManualEntry(db, { date: T, memo: 'صرف', lines: [{ account: '5400', debit: 100, credit: 0 }, { account: '1100', debit: 0, credit: 100 }] })).toThrow(SHORT);
    const inEntry = postManualEntry(db, { date: T, memo: 'إيداع', lines: [{ account: '1100', debit: 900, credit: 0 }, { account: '3100', debit: 0, credit: 900 }] })!;
    emptyWallet(db);
    expect(() => reverseFromJournal(db, inEntry.id)).toThrow(SHORT);
  });

  test('الاستعادة من السلة لفاتورة سُدّدت نقداً', async () => {
    const { savePurchase, payPurchase, deletePurchase } = await import('@/domain/purchases');
    const { restoreFromTrash } = await import('@/domain/trash');
    const db = memDb();
    ownerCashIn(db, { amountHalalas: 8000, date: T });
    const id = savePurchase(db, purchaseInput(8000));
    payPurchase(db, id, 'cash', null, T);
    deletePurchase(db, id); // يعود النقد
    emptyWallet(db);
    expect(() => restoreFromTrash(db, 'purchases', id)).toThrow(/لا يكفي/);
    expect(walletCashBalance(db)).toBe(0);
  });

  test('الناقص يُحسب بدقة للرابط «إيداع المالك»', () => {
    const db = memDb();
    ownerCashIn(db, { amountHalalas: 2500, date: T });
    expect(cashShortfall(db, 4000)).toBe(1500);
    expect(cashShortfall(db, 2000)).toBe(0);
  });
});

test('ما تُخرجه الاستعادة من السلة يُحسب لزرّها', async () => {
  const { savePurchase, payPurchase, deletePurchase } = await import('@/domain/purchases');
  const { restoreCashOut } = await import('@/domain/trash');
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 8000, date: T });
  const id = savePurchase(db, purchaseInput(8000));
  payPurchase(db, id, 'cash', null, T);
  deletePurchase(db, id);
  expect(restoreCashOut(db, 'purchases', id)).toBe(8000);
  const unpaid = savePurchase(db, purchaseInput(1000));
  deletePurchase(db, unpaid);
  expect(restoreCashOut(db, 'purchases', unpaid)).toBe(0);
});

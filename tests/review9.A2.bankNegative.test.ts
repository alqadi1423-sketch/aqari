/**
 * A2.2 · عالٍ · src/domain/invoices.ts:259 (reverseInvoicePayment، ومنه setInvoiceStatus:299 وpayInvoice:246)
 *         و src/domain/accounting/sourceCancel.ts:137 (إلغاء التقبيل) و src/domain/accounting/repost.ts:20 (repostBlockers)
 *
 * السيناريو (بيانات مصطنعة): حسابٌ بنكي افتتاحيه صفر.
 *  (أ) فاتورة مبيعات ١٬١٥٠٫٠٠ تُحصَّل تحويلاً إلى البنك، ثم يُحوَّل المبلغ إلى بنكٍ آخر، ثم تُعاد الفاتورة «مستحقة» (عكس التحصيل):
 *      رصيد البنك الأول يصير −١٬١٥٠٫٠٠.
 *  (ب) عمولة تقبيل ٣٬٠٠٠٫٠٠ تُقبض في البنك، ثم تُسحب نقداً إلى المحفظة، ثم «إلغاء التقبيل» من الدفتر: البنك −٣٬٠٠٠٫٠٠ والمحفظة
 *      ما زالت تُظهر ٣٬٠٠٠٫٠٠، ولا مانع في لوحة الإلغاء.
 *  (ج) فاتورة شراء ١٬١٥٠٫٠٠ مسدَّدة من بنكٍ افتتاحيه ٢٬٠٠٠٫٠٠ تُحذف إلى السلة (فيعود المبلغ)، ثم يُسحب رصيد البنك كله، ثم تُستعاد:
 *      البنك −١٬١٥٠٫٠٠.
 *
 * لماذا يهم: قرار المالك (سجل القرارات، أ · ٥٥): «السداد من حسابٍ بنكي لا يُنزل رصيده تحت الصفر في كل المسارات» · وجهاز المالك
 * «ينتظر حركة القيد السالبة حتى يكفيها رصيد البنك»، فالعكس نفسه من جهاز عضوٍ يعلق عنده. والمحفظة تُظهر نقداً ليس في اليد.
 * السلوك الصحيح: كل مسارٍ يُخرج من بنكٍ (عكس قبضٍ بنكي، أو إعادة صرفٍ بنكي) يُرفض قبل أي كتابة إن لم يكفِه رصيد البنك، برسالة
 * الرصيد كما في سداد فاتورة الشراء (bankTx.bankShort)، ولا يتغيّر شيء.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, addBank } from './helpers/fixtures';
import { saveInvoice, payInvoice, setInvoiceStatus } from '@/domain/invoices';
import { bankBalance } from '@/domain/accounting/ledger';
import { transferBetweenBanks, withdrawCashFromBank } from '@/domain/cashOps';
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { savePurchase, payPurchase, deletePurchase, restorePurchase } from '@/domain/purchases';

test('A2.2 (أ) عكس تحصيل فاتورةٍ دخلت بنكاً لا يُنزل البنك تحت الصفر', () => {
  const db = memDb();
  const b1 = addBank(db, 'بنك مصطنع أ', 0);
  const b2 = addBank(db, 'بنك مصطنع ب', 0);
  const id = saveInvoice(db, {
    customer: 'عميل مصطنع', customerVat: '', issue: '2026-10-01', due: '2026-10-30', notes: '',
    lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 100000, taxPct: 15 }],
  }, 'مستحقة');
  payInvoice(db, id, { method: 'bank', bankId: b1, date: '2026-10-05' });
  expect(bankBalance(db, b1)).toBe(115000);
  transferBetweenBanks(db, { fromBankId: b1, toBankId: b2, amountHalalas: 115000, date: '2026-10-06' });
  expect(bankBalance(db, b1)).toBe(0);
  // الصحيح: يُرفض لأن البنك لا يكفي، ويبقى الرصيد صفراً
  expect(() => setInvoiceStatus(db, id, 'مستحقة')).toThrow();
  expect(bankBalance(db, b1)).toBe(0);
  db.close();
});

test('A2.2 (ب) إلغاء عمولة تقبيلٍ قُبضت في بنكٍ فارغ الآن: لوحة الإلغاء تمنعه', () => {
  const db = memDb();
  const b1 = addBank(db, 'بنك مصطنع', 0);
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }));
  const k = recordKeyMoneyDeal(db, {
    unitId: u, outgoing: 'متنازل مصطنع', incoming: 'متنازل له مصطنع', amountHalalas: 5000000, date: '2026-10-01',
    commissionHalalas: 300000, method: 'bank', bankId: b1, notes: '',
  });
  withdrawCashFromBank(db, { bankId: b1, amountHalalas: 300000, date: '2026-10-02' });
  const entryId = db.get<{ id: string }>(`SELECT journal_entry_id AS id FROM key_money_deals WHERE id = ?`, [k])!.id;
  const act = entrySourceAction(db, entryId);
  expect(act && act.kind).toBe('op');
  // الصحيح: مانعٌ برصيد البنك (كإلغاء العملية النقدية الواردة إلى بنك في المسار نفسه)
  expect(act && act.kind === 'op' ? act.blockers.length : 0).toBeGreaterThan(0);
  if (act && act.kind === 'op') {
    try { act.run('2026-10-03', 'سبب مصطنع'); } catch { /* المتوقع أن يُرفض */ }
  }
  expect(bankBalance(db, b1)).toBe(0);
  db.close();
});

test('A2.2 (ج) استعادة فاتورة شراءٍ مسدَّدة من بنكٍ لم يعد يكفي: تُرفض', () => {
  const db = memDb();
  const b = addBank(db, 'بنك مصطنع', 200000);
  const id = savePurchase(db, {
    supplier: 'مورد مصطنع', date: '2026-10-01', due: '2026-10-01', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: true, subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000,
  });
  payPurchase(db, id, 'bank', b, '2026-10-02');
  deletePurchase(db, id);
  expect(bankBalance(db, b)).toBe(200000);
  withdrawCashFromBank(db, { bankId: b, amountHalalas: 200000, date: '2026-10-03' });
  expect(() => restorePurchase(db, id)).toThrow();
  expect(bankBalance(db, b)).toBe(0);
  db.close();
});

// وأشار المراجع A2 إلى المسار نفسه في إلغاء دفعة الإيجار المحصَّلة بتحويل (contracts/cancelPayment.ts) · يُصلح معه
test('A2.2 (د) إلغاء دفعة إيجارٍ حُصّلت تحويلاً إلى بنكٍ فارغ الآن: المعاينة تمنعه، والإلغاء يُرفض', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { confirmContract, recordRentPayment } = require('@/domain/contracts/service');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { planCancelPayment, cancelPayment } = require('@/domain/contracts/cancelPayment');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { contractInput } = require('./helpers/fixtures');
  const db = memDb();
  const b1 = addBank(db, 'بنك مصطنع أ', 0);
  const b2 = addBank(db, 'بنك مصطنع ب', 0);
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }));
  const c = confirmContract(db, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '1000009201', start: '2026-10-01', end: '2027-09-30',
    valueHalalas: 1200000, depositHalalas: 0 }));
  const inst = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [c])!.id;
  const pid = recordRentPayment(db, c, { installmentId: inst, period: 'أكتوبر', date: '2026-10-05',
    lines: [{ method: 'bank', bankId: b1, amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  transferBetweenBanks(db, { fromBankId: b1, toBankId: b2, amountHalalas: 100000, date: '2026-10-06' });
  expect(planCancelPayment(db, pid).blockers.length).toBeGreaterThan(0);
  expect(() => cancelPayment(db, pid, { reason: 'سبب مصطنع' })).toThrow();
  expect(bankBalance(db, b1)).toBe(0);
  db.close();
});

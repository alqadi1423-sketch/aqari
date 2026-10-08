/**
 * مراجعة التثبيت #32 و#33 · بيانات مصطنعة:
 *  - #32: الضريبة المسترَدة أو المرفوض استردادها تقفل فاتورة الشراء: لا حذف ولا تعديل، ولا يُسترد المرفوض ولا يُرفض المسترَد،
 *    حتى يُلغى قيد الاسترداد أو الرفض من الدفتر.
 *  - #33: الحركة البنكية اليدوية بنوعها وقيدها وكفايتها (قرار المالك 2026-10-05: «كل صرف نقدي يتحقق من رصيد النقد، ولا
 *    يصير النقد سالباً أبداً») · وحذف حركةٍ يدوية قديمة لا يُنزل المحفظة أو البنك تحت الصفر.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { savePurchase, deletePurchase, markVatRefunded, markVatRejected, TS_DEDUCTIBLE, type PurchaseInput } from '@/domain/purchases';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { recordManualBankTx, ownerCashIn } from '@/domain/cashOps';
import { deleteBankTx } from '@/domain/bankTx';
import { accountBalance, walletCashBalance, bankBalance } from '@/domain/accounting/ledger';
import { uid } from '@/domain/ids';

const pur = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد ضريبي مصطنع', date: '2026-02-10', due: '2026-03-10', category: 'صيانة', incorpItem: '', amortize: false,
  amortizeMonths: null, exempt: false, excludeFromVat: false, taxStatus: TS_DEDUCTIBLE,
  subtotalHalalas: 10000, taxHalalas: 1500, totalHalalas: 11500, ...over,
} as PurchaseInput);

test('#32 المسترَدة ضريبتها لا تُحذف ولا تُعدَّل ولا تُرفض · وبعد إلغاء قيد الاسترداد تُحذف', () => {
  const db = memDb();
  db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S1', 'مورد ضريبي مصطنع', '300000000000003', '2026-01-01')`);
  const id = savePurchase(db, pur());
  markVatRefunded(db, id, '2026-04-20');
  expect(() => markVatRejected(db, id, '2026-04-21')).toThrow();
  expect(() => deletePurchase(db, id)).toThrow();
  expect(() => savePurchase(db, pur({ subtotalHalalas: 20000, taxHalalas: 3000, totalHalalas: 23000 }), id)).toThrow();
  expect(accountBalance(db, '1270')).toBe(0);
  const e = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'vat_refund' AND src_id = ?`, [id])!.id;
  const a = entrySourceAction(db, e);
  if (a?.kind !== 'op') throw new Error('op');
  a.run('2026-04-22', 'إلغاء مصطنع');
  deletePurchase(db, id);
  expect(accountBalance(db, '1270')).toBe(0);
  db.close();
});

test('#32 المرفوض استرداده لا يُسترد', () => {
  const db = memDb();
  db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S1', 'مورد ضريبي مصطنع', '300000000000003', '2026-01-01')`);
  const id = savePurchase(db, pur());
  markVatRejected(db, id, '2026-04-20');
  expect(() => markVatRefunded(db, id, '2026-04-21')).toThrow();
  expect(() => markVatRejected(db, id, '2026-04-21')).toThrow();
  expect(accountBalance(db, '1270')).toBe(0);
  db.close();
});

test('#33 الحركة اليدوية بنوعها وقيدها وكفايتها · والمحفظة والبنك لا يصيران سالبين', () => {
  const db = memDb();
  const bank = addBank(db, 'بنك يدوي مصطنع');
  // من المحفظة إلى البنك بلا نقد: يُرفض
  expect(() => recordManualBankTx(db, { kind: 'deposit', bankId: bank, amountHalalas: 5000, date: '2026-03-01', descr: 'إيداع مصطنع' })).toThrow();
  ownerCashIn(db, { amountHalalas: 10000, date: '2026-03-01' });
  recordManualBankTx(db, { kind: 'deposit', bankId: bank, amountHalalas: 6000, date: '2026-03-02', descr: 'إيداع مصطنع' });
  expect([walletCashBalance(db), bankBalance(db, bank)]).toEqual([4000, 6000]);
  // رسوم بنكية: مصروف بقيدٍ مرتبط، والمحفظة كما هي · وأكبر من رصيد البنك تُرفض
  recordManualBankTx(db, { kind: 'fee', bankId: bank, amountHalalas: 500, date: '2026-03-03', descr: 'رسوم مصطنعة' });
  expect([walletCashBalance(db), bankBalance(db, bank), accountBalance(db, '5400')]).toEqual([4000, 5500, 500]);
  expect(db.get<{ j: string }>(`SELECT journal_no AS j FROM bank_tx WHERE amount_halalas = -500`)!.j).not.toBe('');
  expect(() => recordManualBankTx(db, { kind: 'fee', bankId: bank, amountHalalas: 9000, date: '2026-03-03', descr: 'رسوم مصطنعة' })).toThrow();
  // وارد آخر: إيراد بقيدٍ مرتبط
  recordManualBankTx(db, { kind: 'income', bankId: bank, amountHalalas: 700, date: '2026-03-04', descr: 'عائد مصطنع' });
  expect([walletCashBalance(db), bankBalance(db, bank), accountBalance(db, '4300')]).toEqual([4000, 6200, 700]);
  // سحب إلى المحفظة بأكثر من رصيد البنك: يُرفض
  expect(() => recordManualBankTx(db, { kind: 'withdraw', bankId: bank, amountHalalas: 9000, date: '2026-03-05', descr: 'سحب مصطنع' })).toThrow();
  db.close();
});

test('#33 حذف حركةٍ يدوية قديمة بلا قيد لا يُنزل المحفظة أو البنك تحت الصفر', () => {
  const db = memDb();
  const bank = addBank(db, 'بنك قديم مصطنع');
  // حركتان يدويتان من نسخة سابقة: سحبٌ إلى المحفظة، ووارد
  const out = uid(), inn = uid();
  db.run(`INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, source, created_at) VALUES (?,?,?,?,?,0,'',?)`,
    [inn, bank, '2026-01-01', 'وارد قديم مصطنع', 3000, '2026-01-01']);
  db.run(`INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, source, created_at) VALUES (?,?,?,?,?,0,'',?)`,
    [out, bank, '2026-01-02', 'سحب قديم مصطنع', -3000, '2026-01-02']);
  // المحفظة 0 والبنك 0: حذف السحب يُنزل المحفظة إلى السالب، وحذف الوارد يُنزل البنك
  expect([walletCashBalance(db), bankBalance(db, bank)]).toEqual([0, 0]);
  expect(() => deleteBankTx(db, out)).toThrow();
  expect(() => deleteBankTx(db, inn)).toThrow();
  db.close();
});

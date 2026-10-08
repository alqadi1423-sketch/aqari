/**
 * مراجعة التثبيت #30 · قرار المالك 2026-10-07: «الفاتورة الضريبية بعد إصدارها: تُقفل، والتصحيح بإشعار دائن مرتبط بها،
 * وإقرار الفترة المقدَّمة يُجمَّد.» · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import {
  saveInvoice, setInvoiceStatus, deleteInvoice, payInvoice, saveCreditNote, invoiceRemaining, type InvoiceInput,
} from '@/domain/invoices';
import { savePurchase, type PurchaseInput } from '@/domain/purchases';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { vatReturnData } from '@/domain/vatReturn';
import { fileVatReturn, filedReturn, filedDiff } from '@/domain/vatFilings';
import { buildInvoiceDoc } from '@/domain/printDocs';
import { fmt } from '@/domain/money';
import { ownerCashOut } from '@/domain/cashOps';

const inv = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
  customer: 'عميل مصطنع', customerVat: '', issue: '2026-02-10', due: '2026-03-10', notes: '',
  lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 100000, taxPct: 15 }], ...over,
});
const arOk = (db: ReturnType<typeof memDb>) =>
  integrityChecks(db).find((c) => c.name.startsWith('ذمم الفواتير'))!.ok;

test('#30 الصادرة لا تُعدَّل ولا تعود مسودة ولا تُحذف · والمسودة تُعدَّل وتُحذف', () => {
  const db = memDb();
  const id = saveInvoice(db, inv(), 'مستحقة');
  expect(() => saveInvoice(db, inv({ customer: 'عميل آخر مصطنع' }), 'مستحقة', id)).toThrow();
  expect(() => setInvoiceStatus(db, id, 'مسودة')).toThrow();
  expect(() => deleteInvoice(db, id)).toThrow();
  expect(db.get(`SELECT customer_name AS c, status AS s, deleted_at AS d FROM invoices WHERE id = ?`, [id]))
    .toEqual({ c: 'عميل مصطنع', s: 'مستحقة', d: null });
  const draft = saveInvoice(db, inv(), 'مسودة');
  saveInvoice(db, inv({ customer: 'عميل معدَّل مصطنع' }), 'مسودة', draft);
  deleteInvoice(db, draft);
  expect(db.get<{ d: string | null }>(`SELECT deleted_at AS d FROM invoices WHERE id = ?`, [draft])!.d).not.toBeNull();
  db.close();
});

test('#30 الإشعار الدائن: مرتبط بفاتورته، بضريبتها، ينقص الذمة والإقرار، والتحصيل بالمتبقي', () => {
  const db = memDb();
  const id = saveInvoice(db, inv(), 'مستحقة');
  expect(accountBalance(db, '1200')).toBe(115000);
  const cn = saveCreditNote(db, id, { date: '2026-02-20', reason: 'خصم مصطنع', subtotalHalalas: 40000 });
  expect(db.get(`SELECT kind, ref_invoice_id AS r, subtotal_halalas AS s, tax_halalas AS t, total_halalas AS tot FROM invoices WHERE id = ?`, [cn]))
    .toEqual({ kind: 'credit_note', r: id, s: -40000, t: -6000, tot: -46000 });
  expect([accountBalance(db, '1200'), accountBalance(db, '2200')]).toEqual([69000, 9000]);
  expect(invoiceRemaining(db, id)).toBe(69000);
  expect(arOk(db)).toBe(true);
  // لا يزيد على المتبقي · ولا على المسودة · ولا يُحصَّل الإشعار
  expect(() => saveCreditNote(db, id, { date: '2026-02-21', reason: 'زائد مصطنع', subtotalHalalas: 70000 })).toThrow();
  expect(() => saveCreditNote(db, saveInvoice(db, inv(), 'مسودة'), { date: '2026-02-21', reason: 'مسودة', subtotalHalalas: 1000 })).toThrow();
  expect(() => payInvoice(db, cn, { method: 'cash', bankId: null, date: '2026-02-22' })).toThrow();
  // الإقرار: البند ١ صافي الفاتورة والإشعار
  const i1 = vatReturnData(db, 2026, 1).items.find((x) => x.no === '1')!;
  expect([i1.amountHalalas, i1.taxHalalas]).toEqual([60000, 9000]);
  // التحصيل بالمتبقي · والذمة صفر · والفحص سليم
  payInvoice(db, id, { method: 'cash', bankId: null, date: '2026-02-25' });
  expect([accountBalance(db, '1200'), accountBalance(db, '1100')]).toEqual([0, 69000]);
  expect(arOk(db)).toBe(true);
  // المحصّلة لا يُصدر عليها إشعار حتى يُعكس تحصيلها
  expect(() => saveCreditNote(db, id, { date: '2026-02-26', reason: 'بعد التحصيل', subtotalHalalas: 1000 })).toThrow();
  db.close();
});

test('#30 الإقرار المقدَّم يُجمَّد بلقطته · وما تغيّر بعده يظهر فرقاً', () => {
  const db = memDb();
  saveInvoice(db, inv(), 'مستحقة');
  fileVatReturn(db, 2026, 1, '2026-04-15');
  const snap = filedReturn(db, 2026, 1)!;
  expect(snap.items.find((x) => x.no === '1')!.taxHalalas).toBe(15000);
  expect(() => fileVatReturn(db, 2026, 1)).toThrow();
  // شراءٌ أُدخل بعد التقديم بتاريخٍ في فترته: اللقطة كما هي، والفرق ظاهر في البند ٧
  savePurchase(db, {
    supplier: 'مورد مصطنع', date: '2026-03-01', due: '2026-03-30', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: false, subtotalHalalas: 5000, taxHalalas: 0, totalHalalas: 5000,
    taxStatus: 'خاضعة بنسبة صفرية',
  } as PurchaseInput);
  expect(filedReturn(db, 2026, 1)!.items).toEqual(snap.items);
  expect(filedDiff(db, 2026, 1).map((d) => d.no)).toEqual(expect.arrayContaining(['10', '12']));
  db.close();
});

test('#30 الإشعار الدائن يُطبع بعنوانه ورقم فاتورته وسببه وبمبالغ موجبة', () => {
  const co = { name: 'منشأة مصطنعة', vatno: '300000000000003', vatEnabled: true } as never;
  const html = buildInvoiceDoc(co, {
    no: 'INV-2026-0002', customerName: 'عميل مصطنع', customerVat: '', issue: '2026-02-20', due: '2026-02-20', notes: '',
    subtotalHalalas: -40000, taxHalalas: -6000, totalHalalas: -46000,
    lines: [{ descr: 'خصم مصطنع', qty: 1, priceHalalas: -40000, taxPct: 15 }],
    credit: { refNo: 'INV-2026-0001', reason: 'خصم مصطنع' },
  }, '2026-02-20');
  expect(html).toContain('إشعار دائن');
  expect(html).toContain('INV-2026-0001');
  expect(html).not.toContain(fmt(-46000));
  expect(html).toContain(fmt(46000));
});

test('#30 (التحقق المستقل) لا إشعار في فترةٍ قُدِّم إقرارها ولا قبل تاريخ فاتورته', () => {
  const db = memDb();
  const id = saveInvoice(db, inv({ issue: '2026-02-10' }), 'مستحقة');
  expect(() => saveCreditNote(db, id, { date: '2026-01-05', reason: 'قبل الفاتورة', subtotalHalalas: 1000 })).toThrow();
  fileVatReturn(db, 2026, 1, '2026-04-15');
  expect(() => saveCreditNote(db, id, { date: '2026-03-15', reason: 'في فترة مقدَّمة', subtotalHalalas: 1000 })).toThrow();
  expect(filedDiff(db, 2026, 1)).toEqual([]);
  saveCreditNote(db, id, { date: '2026-04-16', reason: 'في فترة مفتوحة', subtotalHalalas: 1000 });
  db.close();
});

test('#30 (التحقق المستقل) إشعاراتٌ صغيرة كثيرة لا تتجاوز صافي الفاتورة · وآخرها يأخذ ما بقي من ضريبتها', () => {
  const db = memDb();
  const id = saveInvoice(db, inv({ lines: [{ descr: 'خدمة صغيرة', qty: 1, priceHalalas: 100, taxPct: 15 }] }), 'مستحقة');
  let n = 0;
  for (;;) {
    try { saveCreditNote(db, id, { date: '2026-02-20', reason: 'جزء ' + n, subtotalHalalas: 3 }); n++; } catch { break; }
    if (n > 60) break;
  }
  const c = db.get<{ s: number; t: number }>(
    `SELECT COALESCE(SUM(subtotal_halalas), 0) AS s, COALESCE(SUM(tax_halalas), 0) AS t FROM invoices WHERE ref_invoice_id = ?`, [id])!;
  expect(-Number(c.s)).toBeLessThanOrEqual(100);
  // ما بقي من الصافي يُشعَر به كله مع ما بقي من الضريبة
  const leftSub = 100 + Number(c.s);
  if (leftSub > 0) saveCreditNote(db, id, { date: '2026-02-21', reason: 'الباقي', subtotalHalalas: leftSub });
  expect([invoiceRemaining(db, id), accountBalance(db, '2200'), accountBalance(db, '1200')]).toEqual([0, 0, 0]);
  db.close();
});

test('#30 (التحقق المستقل) إعادة تحصيلٍ قائم تعكس تحصيله النقدي بكفاية النقد', () => {
  const db = memDb();
  const id = saveInvoice(db, inv(), 'مستحقة');
  payInvoice(db, id, { method: 'cash', bankId: null, date: '2026-02-12' });
  ownerCashOut(db, { amountHalalas: 115000, date: '2026-02-13' });
  expect(() => payInvoice(db, id, { method: 'cash', bankId: null, date: '2026-02-14' })).toThrow();
  expect(accountBalance(db, '1100')).toBe(0);
  db.close();
});


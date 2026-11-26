/**
 * المراجعة الشاملة 2026-11-13 · A2.12 · منخفض · src/domain/vatReturn.ts (invoiceSales) · بيانات مصطنعة.
 *
 * ما كان: سطور الفواتير الخاضعة (S) تُسقط كلها من البند ١ والبند ٦ إن لم تكن المنشأة مسجّلة **الآن**، فإلغاء التسجيل يغيّر إقرار ربعٍ
 * سابق ويفارق الدفتر (2200 فيه الضريبة)، بينما عمولة التقبيل تُقرأ من سطور قيدها.
 * الإصلاح: الخاضع يُقرأ من قيد الفاتورة نفسه: الفاتورة (أو الإشعار الدائن) التي حمل قيدها سطر 2200 خاضعةٌ في فترتها أيّاً كان التسجيل
 * اليوم (والمنشأة التي سُجّلت يوماً يبقى لها رقمها الضريبي) · والصفري رمزٌ لُقط يوم الإصدار · والتي لم تُسجَّل قط بلا مبيعات خاضعة كما كانت.
 * الأرقام الذهبية: منشأة مسجّلة، فاتورة 2026-02-10 بـ١٠٬٠٠٠٫٠٠ + ١٬٥٠٠٫٠٠، وفاتورة صفرية 2026-02-12 بـ٢٬٠٠٠٫٠٠، ثم أُلغي التسجيل ·
 * الربع الأول: البند ١ = ١٠٬٠٠٠٫٠٠ / ١٬٥٠٠٫٠٠ = حركة 2200، والبند ٣ = ٢٬٠٠٠٫٠٠، والبند ٦ = ١٢٬٠٠٠٫٠٠ / ١٬٥٠٠٫٠٠.
 */
import { memDb } from './helpers/testDb';
import { saveInvoice, saveCreditNote, type InvoiceInput } from '@/domain/invoices';
import { vatReturnData } from '@/domain/vatReturn';
import { fileVatReturn, filedDiff } from '@/domain/vatFilings';
import { accountMovement } from '@/domain/accounting/ledger';
import { initI18n } from '@/i18n';
import type { DB } from '@/db/adapter';

beforeAll(() => { initI18n('ar'); });

const inv = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
  customer: 'عميل مصطنع', customerVat: '', issue: '2026-02-10', due: '2026-03-10', notes: '',
  lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 1000000, taxPct: 15 }], ...over,
});
const item = (db: DB, q: 1 | 2, no: string) => { const r = vatReturnData(db, 2026, q).items.find((i) => i.no === no)!; return [r.amountHalalas, r.taxHalalas]; };
const vat2200 = (db: DB, from: string, to: string) => { const m = accountMovement(db, '2200', from, to); return m.credit - m.debit; };

test('A2.12 إلغاء التسجيل لا يُسقط مبيعات ربعٍ سابق خاضعة يوم إصدارها', () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1, vatno = '300000000000003' WHERE id = 1`);
  saveInvoice(db, inv(), 'مستحقة');
  saveInvoice(db, inv({ issue: '2026-02-12', lines: [{ descr: 'تصدير خدمة مصطنع', qty: 1, priceHalalas: 200000, taxPct: 0, taxCode: 'Z' }] }), 'مستحقة');
  const before = [item(db, 1, '1'), item(db, 1, '3'), item(db, 1, '6')];
  expect(before).toEqual([[1000000, 150000], [200000, 0], [1200000, 150000]]);
  db.run(`UPDATE company SET vat_enabled = 0 WHERE id = 1`);
  expect([item(db, 1, '1'), item(db, 1, '3'), item(db, 1, '6')]).toEqual(before);
  expect(item(db, 1, '1')[1]).toBe(vat2200(db, '2026-01-01', '2026-03-31'));
  db.close();
});

test('A2.12 إقرارٌ قُدِّم ثم أُلغي التسجيل: لا فرق يظهر عليه', () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1, vatno = '300000000000003' WHERE id = 1`);
  saveInvoice(db, inv(), 'مستحقة');
  fileVatReturn(db, 2026, 1, '2026-04-15');
  db.run(`UPDATE company SET vat_enabled = 0 WHERE id = 1`);
  expect(filedDiff(db, 2026, 1)).toEqual([]);
  db.close();
});

test('A2.12 إشعارٌ دائن بعد إلغاء التسجيل على فاتورةٍ خاضعة: ينقص البند ١ في فترته كما ينقص 2200', () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1, vatno = '300000000000003' WHERE id = 1`);
  const id = saveInvoice(db, inv({ issue: '2026-03-10', due: '2026-05-10' }), 'مستحقة');
  db.run(`UPDATE company SET vat_enabled = 0 WHERE id = 1`);
  saveCreditNote(db, id, { date: '2026-04-05', reason: 'خصم مصطنع', subtotalHalalas: 200000 });
  expect(item(db, 2, '1')).toEqual([-200000, -30000]);
  expect(item(db, 2, '1')[1]).toBe(vat2200(db, '2026-04-01', '2026-06-30'));
  db.close();
});

test('A2.12 منشأةٌ غير مسجّلة يوم الفاتورة: سطورها المعفاة في البند ٥ ولا شيء في البند ١، ولو سُجّلت بعدها', () => {
  const db = memDb();
  saveInvoice(db, inv({ lines: [{ descr: 'خدمة معفاة مصطنعة', qty: 1, priceHalalas: 300000, taxPct: 0, taxCode: 'E' }] }), 'مستحقة');
  db.run(`UPDATE company SET vat_enabled = 1, vatno = '300000000000003' WHERE id = 1`);
  expect([item(db, 1, '1'), item(db, 1, '5')]).toEqual([[0, 0], [300000, 0]]);
  db.close();
});

test('A2.12 منشأةٌ لم تُسجَّل قط وفاتورتها القديمة بالنسبة الافتراضية: لا شيء في البند ١ (دراسة القائم)', () => {
  const db = memDb();
  saveInvoice(db, inv(), 'مستحقة');
  expect(item(db, 1, '1')).toEqual([0, 0]);
  db.close();
});

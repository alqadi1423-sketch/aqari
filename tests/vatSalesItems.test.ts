/**
 * دراسة القائم (2026-10-09) · إصلاحات فورية بقرار المالك: «البند ١ يجمع المعفى وغير المسجّل، والصفري مخلوط بالمعفى، والبند ٥
 * يجمع التجاري مع السكني، ومستندات جديدة في فترة مقدَّمة.» · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { saveInvoice, type InvoiceInput } from '@/domain/invoices';
import { savePurchase, type PurchaseInput } from '@/domain/purchases';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { vatReturnData } from '@/domain/vatReturn';
import { fileVatReturn } from '@/domain/vatFilings';

const item = (d: ReturnType<typeof vatReturnData>, no: string) => d.items.find((x) => x.no === no)!;
const register = (db: ReturnType<typeof memDb>) => db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
const inv = (lines: InvoiceInput['lines'], issue = '2026-02-10'): InvoiceInput =>
  ({ customer: 'عميل مصطنع', customerVat: '', issue, due: issue, notes: '', lines });

test('البند ١ من سطور الفاتورة الخاضعة وحدها · والصفري في البند ٣ · والمعفى في البند ٥', () => {
  const db = memDb();
  register(db);
  saveInvoice(db, inv([
    { descr: 'خاضع مصطنع', qty: 1, priceHalalas: 10000, taxPct: 15, taxCode: 'S' },
    { descr: 'معفى مصطنع', qty: 1, priceHalalas: 50000, taxPct: 0, taxCode: 'E' },
    { descr: 'صفري مصطنع', qty: 1, priceHalalas: 20000, taxPct: 0, taxCode: 'Z' },
  ]), 'مستحقة');
  const d = vatReturnData(db, 2026, 1);
  expect([item(d, '1').amountHalalas, item(d, '1').taxHalalas]).toEqual([10000, 1500]);
  expect(item(d, '3').amountHalalas).toBe(20000);
  expect(item(d, '5').amountHalalas).toBe(50000);
  expect(item(d, '6').amountHalalas).toBe(80000);
  db.close();
});

test('منشأة غير مسجّلة في الضريبة: لا شيء من فواتيرها في البند ١', () => {
  const db = memDb();
  saveInvoice(db, inv([{ descr: 'خاضع مصطنع', qty: 1, priceHalalas: 10000, taxPct: 15, taxCode: 'S' }]), 'مستحقة');
  expect(item(vatReturnData(db, 2026, 1), '1').amountHalalas).toBe(0);
  db.close();
});

test('البند ٥ للإيجار السكني وحده · والتجاري خارجه في سطر رقابة', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار مختلط مصطنع' });
  const res = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'R-1' }), { tenant: 'مستأجر سكني مصطنع', idNumber: '1000000701', phone: '0500000701', start: '2026-01-01', depositHalalas: 0 }));
  const shop = addUnit(db, p, { unit_no: 'S-1' });
  db.run(`UPDATE units SET type = 'محل' WHERE id = ?`, [shop]);
  const com = confirmContract(db, contractInput(shop, { tenant: 'مستأجر تجاري مصطنع', idNumber: '1000000719', phone: '0500000702', start: '2026-01-01', depositHalalas: 0 }));
  const pay = (cid: string) => {
    const i = db.get<{ id: string; amount_halalas: number }>(`SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
    recordRentPayment(db, cid, { installmentId: i.id, period: 'الأول', date: '2026-01-05', lines: [{ method: 'cash', amountHalalas: Number(i.amount_halalas) }], discountHalalas: 0, notes: '' });
    return Number(i.amount_halalas);
  };
  const r = pay(res);
  const c = pay(com);
  const d = vatReturnData(db, 2026, 1);
  expect(item(d, '5').amountHalalas).toBe(r);
  expect(d.commercialRentHalalas).toBe(c);
  db.close();
});

test('لا فاتورة تصدر ولا شراء يُسجَّل بتاريخٍ في فترةٍ قُدِّم إقرارها', () => {
  const db = memDb();
  register(db);
  fileVatReturn(db, 2026, 1, '2026-04-15');
  expect(() => saveInvoice(db, inv([{ descr: 'خاضع', qty: 1, priceHalalas: 1000, taxPct: 15, taxCode: 'S' }], '2026-03-01'), 'مستحقة')).toThrow();
  expect(() => savePurchase(db, {
    supplier: 'مورد مصطنع', date: '2026-03-01', due: '2026-03-30', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: true, subtotalHalalas: 1000, taxHalalas: 0, totalHalalas: 1000,
  } as PurchaseInput)).toThrow();
  // والمسودة بتاريخها تُحفظ، ولا تصدر فيها
  saveInvoice(db, inv([{ descr: 'خاضع', qty: 1, priceHalalas: 1000, taxPct: 15, taxCode: 'S' }], '2026-03-01'), 'مسودة');
  db.close();
});

/**
 * المراجعة الشاملة 2026-11-13 · A2.13 · منخفض · src/domain/vatReturn.ts (exemptSalesRows والبند ٥) · بيانات مصطنعة.
 *
 * ما كان: البند ٥ = الإيجار السكني المحصَّل + سطور الفواتير المعفاة، والكشف المساند ٣ صفوف الإيجار وحدها، فمجموعه أقل من البند.
 * الإصلاح: صفوف الفواتير المعفاة (وإشعاراتها الدائنة سالبةً) في الكشف ٣ برقمها وعميلها.
 * الأرقام الذهبية (الربع الأول 2026): دفعة إيجار سكني ٢٬٠٠٠٫٠٠ + فاتورة معفاة ٣٬٠٠٠٫٠٠ − إشعار دائن عليها ٥٠٠٫٠٠ → البند ٥ =
 * ٤٬٥٠٠٫٠٠ = مجموع الكشف ٣ (ثلاثة صفوف).
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { saveInvoice, saveCreditNote, type InvoiceInput } from '@/domain/invoices';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { vatReturnData } from '@/domain/vatReturn';
import { initI18n } from '@/i18n';

beforeAll(() => { initI18n('ar'); });

const inv = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
  customer: 'عميل معفى مصطنع', customerVat: '', issue: '2026-02-10', due: '2026-03-10', notes: '',
  lines: [{ descr: 'خدمة معفاة مصطنعة', qty: 1, priceHalalas: 300000, taxPct: 0, taxCode: 'E' }], ...over,
});

test('A2.13 الكشف المساند ٣ يضمّ الفواتير المعفاة فيساوي مجموعُه البند ٥', () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1, vatno = '300000000000003' WHERE id = 1`);
  const u = addUnit(db, addProperty(db, { name: 'عقار معفى مصطنع' }), { unit_no: 'E-13' });
  const c = confirmContract(db, contractInput(u, { tenant: 'مستأجر سكني مصطنع', idNumber: '1000001017', valueHalalas: 2400000,
    start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  const iid = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY sort LIMIT 1`, [c])!.id;
  recordRentPayment(db, c, { installmentId: iid, period: '2026-01', date: '2026-01-05', lines: [{ method: 'cash', amountHalalas: 200000 }],
    discountHalalas: 0, notes: '' });
  const id = saveInvoice(db, inv(), 'مستحقة');
  saveCreditNote(db, id, { date: '2026-02-20', reason: 'خصم مصطنع', subtotalHalalas: 50000 });
  const d = vatReturnData(db, 2026, 1);
  const i5 = d.items.find((x) => x.no === '5')!.amountHalalas;
  const rows = d.schedules.exemptSales;
  expect(i5).toBe(450000);
  expect(rows.reduce((s, r) => s + Number(r.net), 0)).toBe(i5);
  const no = db.get<{ no: string }>(`SELECT no FROM invoices WHERE id = ?`, [id])!.no;
  expect(rows.map((r) => [r.date, r.tenant, Number(r.net)])).toEqual([
    ['2026-01-05', 'مستأجر سكني مصطنع', 200000],
    ['2026-02-10', 'عميل معفى مصطنع', 300000],
    ['2026-02-20', 'عميل معفى مصطنع', -50000],
  ]);
  expect(rows[1].contractNo).toBe(no);
  db.close();
});

test('A2.13 الفاتورة المختلطة: سطرها المعفى وحده في الكشف', () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1, vatno = '300000000000003' WHERE id = 1`);
  saveInvoice(db, inv({ lines: [
    { descr: 'خاضع مصطنع', qty: 1, priceHalalas: 100000, taxPct: 15, taxCode: 'S' },
    { descr: 'معفى مصطنع', qty: 2, priceHalalas: 25000, taxPct: 0, taxCode: 'E' },
  ] }), 'مستحقة');
  const d = vatReturnData(db, 2026, 1);
  expect(d.items.find((x) => x.no === '5')!.amountHalalas).toBe(50000);
  expect(d.schedules.exemptSales.map((r) => Number(r.net))).toEqual([50000]);
  db.close();
});

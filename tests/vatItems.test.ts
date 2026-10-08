/**
 * مراجعة التثبيت #31 · بنود الإقرار من الحالة الضريبية لا من الفئة · بيانات مصطنعة:
 *  - البند ١٠ (المشتريات بالنسبة الصفرية) من فواتير الشراء «خاضعة بنسبة صفرية»، وكان صفراً ثابتاً.
 *  - البند ١١ (المشتريات المعفاة) من «معفاة من الضريبة»، وكان من فئة «إيجار» أياً كانت حالتها.
 *  - البند ٥ (المبيعات المعفاة) صافي التحصيل بلا فائضه الذي صار رصيداً دائناً للمستأجر (التزامٌ لا توريد).
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordBulkRentPayment } from '@/domain/contracts/service';
import { savePurchase, TS_ZERO, TS_EXEMPT, type PurchaseInput } from '@/domain/purchases';
import { vatReturnData } from '@/domain/vatReturn';

const pur = (over: Partial<PurchaseInput>): PurchaseInput => ({
  supplier: 'مورد مصطنع', date: '2026-02-10', due: '2026-03-10', category: 'صيانة', incorpItem: '', amortize: false,
  amortizeMonths: null, exempt: false, excludeFromVat: false, subtotalHalalas: 10000, taxHalalas: 0, totalHalalas: 10000, ...over,
} as PurchaseInput);
const item = (d: ReturnType<typeof vatReturnData>, no: string) => d.items.find((x) => x.no === no)!;

test('#31 البندان ١٠ و١١ من الحالة الضريبية · والبند ١٢ مجموعها', () => {
  const db = memDb();
  savePurchase(db, pur({ taxStatus: TS_ZERO, subtotalHalalas: 10000, totalHalalas: 10000 }));
  savePurchase(db, pur({ taxStatus: TS_EXEMPT, category: 'كهرباء', subtotalHalalas: 20000, totalHalalas: 20000 }));
  // فئة «إيجار» بفاتورةٍ غير قابلة للخصم: ليست معفاة
  savePurchase(db, pur({ category: 'إيجار', subtotalHalalas: 30000, totalHalalas: 30000 }));
  const d = vatReturnData(db, 2026, 1);
  expect(item(d, '10').amountHalalas).toBe(10000);
  expect(item(d, '11').amountHalalas).toBe(20000);
  expect(item(d, '12').amountHalalas).toBe(item(d, '7').amountHalalas + 10000 + 20000);
  db.close();
});

test('#31 البند ٥ بلا فائض التحصيل الذي صار رصيداً دائناً', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار إقرار مصطنع' }), { unit_no: 'V-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر إقرار مصطنع', idNumber: '1000000401', phone: '0500000401',
    start: '2026-01-01', depositHalalas: 0 }));
  const first = db.get<{ id: string; amount_halalas: number }>(
    `SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  recordBulkRentPayment(db, cid, { installmentIds: [first.id], date: '2026-01-05',
    lines: [{ method: 'cash', amountHalalas: Number(first.amount_halalas) + 50000 }], notes: '' });
  expect(item(vatReturnData(db, 2026, 1), '5').amountHalalas).toBe(Number(first.amount_halalas));
  db.close();
});

/**
 * دراسة القائم · الإصلاحات الصغيرة (قرار المالك 2026-10-09 أولاً ٨) · بيانات مصطنعة:
 *  تقرير المورد بالاسم: تعديل اسمه لا يُسقط فواتيره من تقريره · وقيد مورد الغاز (قرار 2026-10-07: «عداد الغاز: يُضاف نوعاً
 *  للعدادات» · والمورد نوعاً للخدمة معه، الهجرة ٤٠)
 */
import { memDb } from './helpers/testDb';
import { saveSupplier } from '@/domain/suppliers';
import { isUtilityKind } from '@/domain/meters';
import { supplierReportData } from '@/domain/reportData';

const base = { vat: '', phone: '', category: '', amountHalalas: null, utility: '' };

test('تعديل اسم المورد يتبعه في فواتير شرائه · فلا يسقط تاريخه من تقريره', () => {
  const db = memDb();
  const id = saveSupplier(db, null, { ...base, name: 'مورد قديم مصطنع' });
  db.run(`INSERT INTO purchases (id, no, supplier_name, date, due, category, subtotal_halalas, total_halalas, created_at)
          VALUES ('PU1', 'PUR-1', 'مورد قديم مصطنع', '2026-03-01', '2026-03-01', 'صيانة', 10000, 10000, '2026-03-01')`);
  saveSupplier(db, id, { ...base, name: 'مورد جديد مصطنع' });
  expect(db.get(`SELECT supplier_name AS n FROM purchases WHERE id = 'PU1'`)).toEqual({ n: 'مورد جديد مصطنع' });
  expect(supplierReportData(db, id, null)!.purchases.map((p) => p.no)).toEqual(['PUR-1']);
  // والاسم المكرر يُرفض كما كان
  saveSupplier(db, null, { ...base, name: 'مورد آخر مصطنع' });
  expect(() => saveSupplier(db, id, { ...base, name: 'مورد آخر مصطنع' })).toThrow();
  db.close();
});

test('مورد الغاز نوعاً للخدمة', () => {
  const db = memDb();
  expect(isUtilityKind('غاز')).toBe(true);
  const id = saveSupplier(db, null, { ...base, name: 'مورد غاز مصطنع', utility: 'غاز' });
  expect(db.get(`SELECT utility_type AS u FROM suppliers WHERE id = ?`, [id])).toEqual({ u: 'غاز' });
  db.close();
});

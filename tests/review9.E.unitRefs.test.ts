/**
 * E-8 · متوسط · src/domain/refs.ts:40-46 (مرتبطات الوحدة لا تعدّ الأصول ولا فواتير المبيعات ولا سطور القيود بأبعادها)
 *        مع src/domain/propertiesService.ts:163-170 (deleteUnit) و src/domain/trash.ts:216-224 (الكنس بعد مهلة السلة)
 *
 * السيناريو (بيانات مصطنعة): وحدة خالية بلا عقد، فيها أصلٌ حيّ (مكيف بتكلفة 3,000 ريال) وفاتورة مبيعات مربوطة بها.
 *   الواقع: «حذف الوحدة» يمرّ بلا رفض، فتدخل السلة، وبعد مهلتها يحذفها الكنس نهائياً (لا عقد يمنعه)، ويبقى الأصل والفاتورة
 *   وسطور الإهلاك تشير إلى وحدةٍ لا وجود لها.
 *
 * لماذا يهم: القاعدة الملزمة ٦ من المالك «لا حذف لمرتبط: أرشفة» و refs.ts نفسه: «لا يُحذف شيء مرتبط بغيره».
 *
 * السلوك الصحيح: deleteUnit يرمي LinkedRefsError ويسمّي الأصل والفاتورة، فيُعرض «أرشِفها» بدل الحذف.
 *
 *   TZ=Asia/Riyadh npx jest tests/review9.E.unitRefs
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit } from './helpers/fixtures';
import { deleteUnit } from '@/domain/propertiesService';
import { LinkedRefsError, linkedRefs } from '@/domain/refs';

describe('E-8 · [متوسط] وحدةٌ فيها أصلٌ أو فاتورة تُحذف كأنها خالية', () => {
  test.failing('وحدة بأصلٍ حيّ: الحذف مرفوض بمرتبطاته', () => {
    const db = memDb();
    const p = addProperty(db);
    const u = addUnit(db, p);
    db.run(`INSERT INTO assets (id, name, category, property_id, unit_id, life_months, cost_halalas, purchase_date, created_at)
            VALUES ('A-E8', 'مكيف مصطنع', '1430', ?, ?, 60, 300000, '2026-01-01', ?)`, [p, u, new Date().toISOString()]);
    // (الواقع: [] ولا رفض)
    expect(linkedRefs(db, 'unit', u).length).toBeGreaterThan(0);
    expect(() => deleteUnit(db, u)).toThrow(LinkedRefsError);
  });

  test.failing('وحدة بفاتورة مبيعات مربوطة بها: الحذف مرفوض', () => {
    const db = memDb();
    const p = addProperty(db);
    const u = addUnit(db, p);
    db.run(`INSERT INTO invoices (id, no, customer_name, issue, due, status, subtotal_halalas, total_halalas, unit_id, property_id, created_at)
            VALUES ('I-E8', 'INV-2026-9001', 'عميل مصطنع', '2026-01-01', '2026-01-01', 'مستحقة', 1000, 1000, ?, ?, ?)`, [u, p, new Date().toISOString()]);
    expect(() => deleteUnit(db, u)).toThrow(LinkedRefsError);
  });
});

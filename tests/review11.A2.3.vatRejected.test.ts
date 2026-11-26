/**
 * مدقق مستقل على إصلاح A2.3 · src/domain/stats.ts (computeTopPerformers) · بيانات مصطنعة.
 *
 * السيناريو (منشأة مسجّلة في الضريبة): العقار الأول ووحدته عليهما فاتورة شراء «قابلة للخصم» ١٬٠٠٠٫٠٠ + ضريبة ١٥٠٫٠٠، ثم رُفض
 * استرداد ضريبتها (markVatRejected) فصارت الضريبة جزءاً من التكلفة: قيدٌ مدين مصروف الفئة ١٥٠٫٠٠ / دائن 1270. والعقار الثاني
 * ووحدته عليهما فاتورة شراء معفاة ١٬١٠٠٫٠٠.
 * الحساب باليد: صرف الأول ١٠٠٠٠٠ + ١٥٠٠٠ = ١١٥٠٠٠ هللة، وصرف الثاني ١١٠٠٠٠ هللة · فالأكثر صرفاً الأول ووحدته بـ١١٥٠٠٠.
 * وبفترة أبريل وحدها (تاريخ الرفض): الأول ووحدته بـ١٥٠٠٠.
 *
 * الخطأ: قيد الرفض مصدره vat_refund، وdimsFromSource لا يشتق له أبعاداً (وderiveSources يشترطه بلا أبعاد)، فسطر المصروف بلا عقار
 * ولا وحدة، والاستعلام الجديد يشترط بُعداً على السطر فيُسقطه · فتُظهر البطاقة الثاني بـ١١٠٠٠٠ (وكانت المستندات قبل الإصلاح تُظهر
 * الأول بـ١١٥٠٠٠ صحيحاً). ولا تملؤه أداة «أبعاد القيود القديمة» لأن سطوره تحمل مركز التكلفة «عام» فلا تراها الخطة أصلاً.
 *
 * السلوك الصحيح: سطر قيد vat_refund (وعاكسه vat_refund_rev) بلا أبعاد يُنسب إلى عقار فاتورة الشراء ووحدتها (src_id معرّفها).
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit } from './helpers/fixtures';
import { savePurchase, markVatRejected, TS_DEDUCTIBLE, type PurchaseInput } from '@/domain/purchases';
import { computeTopPerformers } from '@/domain/stats';

test('A2.3 · الضريبة المرفوض استردادها صرفٌ على عقار فاتورتها ووحدتها', () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`);
  db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S-R11', 'مورد مصطنع', '300000000000003', '2026-01-01')`);
  const p1 = addProperty(db, { name: 'عقار مصطنع أول' });
  const u1 = addUnit(db, p1, { unit_no: 'R11-A' });
  const p2 = addProperty(db, { name: 'عقار مصطنع ثانٍ' });
  const u2 = addUnit(db, p2, { unit_no: 'R11-B' });
  const base = {
    supplier: 'مورد مصطنع', due: '2026-03-31', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, excludeFromVat: false,
  };
  const deductible = savePurchase(db, { ...base, date: '2026-02-10', exempt: false, taxStatus: TS_DEDUCTIBLE,
    subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000, propertyId: p1, unitId: u1 } as PurchaseInput);
  savePurchase(db, { ...base, date: '2026-02-10', exempt: true,
    subtotalHalalas: 110000, taxHalalas: 0, totalHalalas: 110000, propertyId: p2, unitId: u2 } as PurchaseInput);
  markVatRejected(db, deductible, '2026-04-01');

  const top = computeTopPerformers(db);
  expect(top.topPropExpense).toEqual({ id: p1, amount: 115000 });
  expect(top.topUnitExpense).toEqual({ id: u1, amount: 115000 });

  const apr = computeTopPerformers(db, '2026-04-01', '2026-04-30');
  expect(apr.topPropExpense).toEqual({ id: p1, amount: 15000 });
  expect(apr.topUnitExpense).toEqual({ id: u1, amount: 15000 });
  db.close();
});

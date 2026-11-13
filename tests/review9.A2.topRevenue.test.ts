/**
 * A2.3 · عالٍ · src/domain/stats.ts:518-560 (computeTopPerformers) · تعرضه app/(tabs)/properties.tsx:182 وapp/units.tsx:174
 *
 * السيناريو (بيانات مصطنعة): عقاران. الأول عليه عقد إيجار حُصّل قسطه ٢٬٠٠٠٫٠٠ (الإيراد الحقيقي في الدفتر)، والثاني ليس عليه
 * إلا مسودة فاتورة مبيعات لم تصدر بمبلغ ١١٥٫٠٠.
 * الخطأ: «العقار الأعلى دخلاً» يُحسب من جدول الفواتير وحده (ومنها المسودات)، ولا يرى الإيجار، فيُظهر العقار الثاني بمبلغ ١١٥٫٠٠.
 * و«الأكثر صرفاً» من إجمالي فواتير الشراء (ومعه ضريبة المدخلات القابلة للاسترداد وما رُسمل أصولاً).
 *
 * لماذا يهم: الإيجار هو دخل المالك كله تقريباً، فالبطاقة تُظهر عقاراً خاطئاً ومبلغاً خاطئاً في الاستعمال العادي.
 * السلوك الصحيح: الدخل والصرف لكل عقار ووحدة من سطور الدفتر بأبعادها (property_id/unit_id) لحسابات الإيراد والمصروف، والقيود
 * المرحّلة وحدها · فالأعلى دخلاً العقار الأول بـ٢٬٠٠٠٫٠٠.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { saveInvoice } from '@/domain/invoices';
import { computeTopPerformers } from '@/domain/stats';

test.failing('A2.3 العقار الأعلى دخلاً يرى الإيجار المحصَّل ولا يعدّ مسودة فاتورة', () => {
  const db = memDb();
  const p1 = addProperty(db, { name: 'عقار مصطنع أول' });
  const u1 = addUnit(db, p1, { unit_no: 'R9-A' });
  const p2 = addProperty(db, { name: 'عقار مصطنع ثانٍ' });
  const u2 = addUnit(db, p2, { unit_no: 'R9-B' });
  const cid = confirmContract(db, contractInput(u1, {
    tenant: 'مستأجر مصطنع', idNumber: '1000009301', phone: '0500009301', start: '2026-01-01', depositHalalas: 0,
  }));
  const i = db.get<{ id: string; amount_halalas: number }>(
    `SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  expect(Number(i.amount_halalas)).toBe(200000);
  recordRentPayment(db, cid, {
    installmentId: i.id, period: 'الأول', date: '2026-01-05',
    lines: [{ method: 'cash', amountHalalas: 200000 }], discountHalalas: 0, notes: '',
  });
  saveInvoice(db, {
    customer: 'عميل مصطنع', customerVat: '', issue: '2026-10-01', due: '2026-10-01', notes: '', unitId: u2, propertyId: p2,
    lines: [{ descr: 'خدمة', qty: 1, priceHalalas: 10000, taxPct: 15 }],
  }, 'مسودة');
  const top = computeTopPerformers(db);
  expect(top.topPropRevenue).toEqual({ id: p1, amount: 200000 });
  expect(top.topUnitRevenue).toEqual({ id: u1, amount: 200000 });
  db.close();
});

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
import { savePurchase, TS_DEDUCTIBLE, type PurchaseInput } from '@/domain/purchases';
import { computeTopPerformers } from '@/domain/stats';

test('A2.3 العقار الأعلى دخلاً يرى الإيجار المحصَّل ولا يعدّ مسودة فاتورة', () => {
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

/**
 * الصرف من الدفتر لا من إجمالي فاتورة الشراء · الأول: شراء قابل للخصم ١٠٠٫٠٠ + ضريبة ١٥٫٠٠ = ١١٥٫٠٠ (الضريبة في 1270 لا في المصروف)
 * فصرفه ١٠٠٫٠٠. الثاني: شراء معفى لوحدته ١١٠٫٠٠ فصرفه ١١٠٫٠٠ · فالأكثر صرفاً الثاني بـ١١٠٫٠٠ (المستندات كانت تقول الأول بـ١١٥٫٠٠).
 * وبالفترة: فبراير وحده فيه شراء الأول فقط ← الأول بـ١٠٠٫٠٠.
 */
test('A2.3 العقار والوحدة الأكثر صرفاً بلا ضريبة المدخلات القابلة للخصم · وبالفترة', () => {
  const db = memDb();
  db.run(`UPDATE company SET vat_enabled = 1 WHERE id = 1`); // «قابلة للخصم» للمنشأة المسجّلة وحدها
  db.run(`INSERT INTO suppliers (id, name, vat, created_at) VALUES ('S-R9', 'مورد مصطنع', '300000000000003', '2026-01-01')`);
  const p1 = addProperty(db, { name: 'عقار مصطنع أول' });
  const p2 = addProperty(db, { name: 'عقار مصطنع ثانٍ' });
  const u2 = addUnit(db, p2, { unit_no: 'R9-C' });
  const base = {
    supplier: 'مورد مصطنع', due: '2026-03-31', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, excludeFromVat: false,
  };
  savePurchase(db, { ...base, date: '2026-02-10', exempt: false, taxStatus: TS_DEDUCTIBLE,
    subtotalHalalas: 10000, taxHalalas: 1500, totalHalalas: 11500, propertyId: p1 } as PurchaseInput);
  savePurchase(db, { ...base, date: '2026-03-10', exempt: true,
    subtotalHalalas: 11000, taxHalalas: 0, totalHalalas: 11000, propertyId: p2, unitId: u2 } as PurchaseInput);
  const top = computeTopPerformers(db);
  expect(top.topPropExpense).toEqual({ id: p2, amount: 11000 });
  expect(top.topUnitExpense).toEqual({ id: u2, amount: 11000 });
  expect(top.topPropRevenue).toBeNull();
  const feb = computeTopPerformers(db, '2026-02-01', '2026-02-28');
  expect(feb.topPropExpense).toEqual({ id: p1, amount: 10000 });
  expect(feb.topUnitExpense).toBeNull();
  db.close();
});

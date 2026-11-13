/**
 * E-7 · متوسط · src/domain/purchases.ts:264-266 (قراءة العداد تُكتب عند إنشاء الفاتورة وحده) و:503-521 (deletePurchase لا يمسّها)
 *        مع src/ui/MeterSheet.tsx:26 («إجمالي الفواتير» = مجموع meter_readings)
 *
 * السيناريو (بيانات مصطنعة): فاتورة كهرباء لعدّاد وحدة بمبلغ 500 ريال وقراءة 1200، ثم تُعدَّل إلى 300 ريال وقراءة 1100، ثم تُحذف.
 *   الواقع: بعد التعديل يبقى في سجل العداد 500 ريال وقراءة 1200، وبعد الحذف يبقى السطر نفسه، فيعرض العدّاد «إجمالي الفواتير 500»
 *   لفاتورةٍ محذوفة، وتقترح الفاتورة التالية «القراءة السابقة 1200» (app/purchases.tsx:337).
 *
 * لماذا يهم: قرار المالك «اتح الاطلاع على فواتير كل عداد عند الضغط عليه» (2026-08-19): ما يُعرض رقمٌ خاطئ ولا يُفتح على فاتورةٍ موجودة.
 *
 * السلوك الصحيح: سطر العداد يتبع فاتورته: التعديل يحدّث المبلغ والقراءة والتاريخ، والحذف يُخفيه (والاستعادة تعيده).
 *
 *   TZ=Asia/Riyadh npx jest tests/review9.E.meterReadings
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit } from './helpers/fixtures';
import { replaceMeters, meterReadings } from '@/domain/meters';
import { savePurchase, deletePurchase, type PurchaseInput } from '@/domain/purchases';

describe('E-7 · [متوسط] سجل العداد لا يتبع فاتورته بعد التعديل والحذف', () => {
  const setup = () => {
    const db = memDb();
    const u = addUnit(db, addProperty(db));
    db.run(`INSERT INTO suppliers (id, name, utility_type, created_at) VALUES ('S-E7', 'مزوّد كهرباء مصطنع', 'كهرباء', ?)`, [new Date().toISOString()]);
    replaceMeters(db, 'unit', u, [{ id: 'M-E7', kind: 'كهرباء', number: '900001', supplierId: 'S-E7' }]);
    const input: PurchaseInput = {
      supplier: 'مزوّد كهرباء مصطنع', date: '2026-05-01', due: '2026-05-31', category: 'كهرباء', incorpItem: '',
      amortize: false, amortizeMonths: null, exempt: false, excludeFromVat: false,
      subtotalHalalas: 50000, taxHalalas: 0, totalHalalas: 50000, meterId: 'M-E7', meterReading: 1200, unitId: u,
    };
    return { db, input };
  };

  test.failing('تعديل الفاتورة يحدّث مبلغ سطر العداد وقراءته', () => {
    const { db, input } = setup();
    const id = savePurchase(db, input);
    savePurchase(db, { ...input, subtotalHalalas: 30000, totalHalalas: 30000, meterReading: 1100 }, id);
    // (الواقع: [{ amount_halalas: 50000, reading: 1200 }])
    expect(meterReadings(db, 'M-E7').map((r) => ({ amount_halalas: Number(r.amount_halalas), reading: r.reading })))
      .toEqual([{ amount_halalas: 30000, reading: 1100 }]);
  });

  test.failing('حذف الفاتورة يُخرج سطرها من سجل العداد وإجماليه', () => {
    const { db, input } = setup();
    const id = savePurchase(db, input);
    deletePurchase(db, id);
    // (الواقع: سطرٌ واحد بـ 50000 هللة لفاتورةٍ في السلة)
    expect(meterReadings(db, 'M-E7')).toEqual([]);
  });
});

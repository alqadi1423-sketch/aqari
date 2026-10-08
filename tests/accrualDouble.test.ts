/**
 * مراجعة التثبيت #11 · أساس الاستحقاق (الافتراضي في الرئيسية) لا يحسب مبلغاً مرتين · بيانات مصطنعة:
 *  (أ) العربون المحوَّل إلى عقد: قيد تحويله إيراد، وتوزيع العقد يعدّ قيمته كاملة
 *  (ب) بنود الشراء التي صارت أصولاً: ليست مصروفاً، وإهلاكها يأتي من الدفتر
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { createReservation } from '@/domain/reservations';
import { savePurchase, type PurchaseInput } from '@/domain/purchases';
import { periodRevenueAccrual, periodExpenseAccrual } from '@/domain/accrual';
import { periodRevenueExpense } from '@/domain/accounting/ledger';

test('(أ) العربون المحوَّل لا يُحسب مرتين: إيراد سنة العقد بالاستحقاق قيمته وحدها', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار عربون مصطنع' }), { unit_no: 'R-1' });
  const rid = createReservation(db, { unitId: u, name: 'حاجز مصطنع', phone: '', depositHalalas: 30000, expiryDate: '2099-01-01' });
  confirmContract(db, { ...contractInput(u, { tenant: 'مستأجر عربون مصطنع', idNumber: '1000000082', phone: '0500000041',
    valueHalalas: 1200000, start: '2026-01-01', depositHalalas: 0 }), reservationId: rid } as never);
  expect(periodRevenueAccrual(db, '2026-01-01', '2026-12-31')).toBe(1200000);
  db.close();
});

test('(ب) بند الشراء الذي صار أصلاً ليس مصروفاً: مصروف السنة بالاستحقاق كما في الدفتر', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار أصول مصطنع' }), { unit_no: 'A-1' });
  const input: PurchaseInput = {
    supplier: 'مورد مصطنع', date: '2026-03-15', due: '2026-04-15', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
    exempt: false, excludeFromVat: true, subtotalHalalas: 400000, taxHalalas: 0, totalHalalas: 400000,
    lines: [
      { descr: 'مكيف مصطنع', qty: 1, amountHalalas: 300000, isAsset: true, category: '1410', unitId: u, room: '' },
      { descr: 'تركيب مصطنع', qty: 1, amountHalalas: 100000, isAsset: false },
    ],
  };
  savePurchase(db, input);
  const ledger = periodRevenueExpense(db, '2026-01-01', '2026-12-31').expense;
  // الدفتر: التركيب وإهلاك ما فات من المكيف · لا ثمن المكيف
  expect(ledger).toBeLessThan(300000);
  expect(periodExpenseAccrual(db, '2026-01-01', '2026-12-31')).toBe(ledger);
  db.close();
});

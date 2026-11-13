/**
 * المراجعة الشاملة 2026-11-13 · المراجع A1 (دورة الإيجار) · بيانات مصطنعة كلها.
 *
 * A1-4 · متوسط · src/domain/accrual.ts:196-209 (contractAccrualWindow) و41-42 (RENT_SOURCES)
 *   السيناريو أ: عقد ١٢٬٠٠٠ ريال لسنة 2026 بأقساط شهرية، سدّد المستأجر يناير إلى يونيو (٦٬٠٠٠) وغادر في 2026-06-15، فأُلغي
 *   العقد بتاريخه وأُلغيت الدفعات بعده · المالك أبقى ما قبضه.
 *   السيناريو ب: عقد سنوي ١٢٬٠٠٠ دُفع كاملاً مقدماً في 2026-01-01، وغادر المستأجر في 2026-03-31 بلا ردّ (شرط العقد).
 *   النتيجة اليوم: الاستحقاق يتوقف يوم الإلغاء بمقام المدة كاملة، والدفعات مستثناة من جانب الدفتر، فإيراد العقد بالاستحقاق
 *   عبر كل الزمن ٥٬٤٥٧٫٥٣ في (أ) و٢٬٩٥٨٫٩٠ في (ب)، والمقبوض المحتفَظ به ٦٬٠٠٠ و١٢٬٠٠٠ · الفرق لا يظهر إيراداً ولا التزاماً
 *   في أي فترة · وموجز الأساس المحاسبي المعتمد (القسم ٣) يرث ذلك: يبقى الفرق في 2460 «إيرادات مقدَّمة» إلى الأبد.
 *   لماذا يهم: الرئيسية بالاستحقاق (الافتراضية) تُبخس دخل كل عقد أُنهي مبكراً، ولا مسار لردّ الإيجار المقدَّم إن قرّر المالك ردّه.
 *   السلوك الصحيح: مجموع الاستحقاق عبر عمر العقد = إيراد الإيجار المحتفَظ به في الدفتر · فالمحتفَظ به بعد الإنهاء إيرادٌ يوم الإنهاء
 *   (أو يُردّ بقيدٍ فينقص المحتفَظ به) · والاختيار بينهما قرار المالك.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, cancelContract, recordRentPayment } from '@/domain/contracts/service';
import { periodRevenueAccrual } from '@/domain/accrual';
import { accountBalance } from '@/domain/accounting/ledger';

const cancel = (date: string) => ({ date, reason: 'غادر المستأجر', installmentsFate: 'cancel' as const, settle: false,
  deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });

function payAll(db: ReturnType<typeof memDb>, cid: string, upTo: string) {
  for (const i of db.all<{ id: string; due_date: string; amount_halalas: number }>(
    `SELECT id, due_date, amount_halalas FROM contract_installments WHERE contract_id = ? AND due_date <= ? ORDER BY due_date`, [cid, upTo])) {
    recordRentPayment(db, cid, { installmentId: i.id, period: '', date: i.due_date,
      lines: [{ method: 'cash', amountHalalas: Number(i.amount_halalas) }], discountHalalas: 0, notes: '' });
  }
}

test.failing('A1-4 (أ) شهري أُنهي في منتصف يونيو: الاستحقاق عبر العمر يساوي المحتفَظ به', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار إنهاء مصطنع' }), { unit_no: 'E-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر إنهاء مصطنع', idNumber: '1000000935',
    valueHalalas: 1200000, cycle: 'شهرية', start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  payAll(db, cid, '2026-06-01');
  cancelContract(db, cid, cancel('2026-06-15'));
  const kept = accountBalance(db, '4200');
  expect(kept).toBe(600000);
  // اليوم: ١٢٠٠٠٠٠ × ١٦٦ ÷ ٣٦٥ = ٥٤٥٧٥٣ ثم لا شيء
  expect(periodRevenueAccrual(db, '2026-01-01', '2030-12-31')).toBe(kept);
  db.close();
});

test.failing('A1-4 (ب) سنوي مدفوع مقدماً أُنهي بعد ربعه: الاستحقاق عبر العمر يساوي المحتفَظ به', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار إنهاء مصطنع' }), { unit_no: 'E-2' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر إنهاء مصطنع', idNumber: '1000000943',
    valueHalalas: 1200000, cycle: 'سنوية', start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  payAll(db, cid, '2026-01-01');
  cancelContract(db, cid, cancel('2026-03-31'));
  const kept = accountBalance(db, '4200');
  expect(kept).toBe(1200000);
  // اليوم: ١٢٠٠٠٠٠ × ٩٠ ÷ ٣٦٥ = ٢٩٥٨٩٠ ثم لا شيء
  expect(periodRevenueAccrual(db, '2026-01-01', '2030-12-31')).toBe(kept);
  db.close();
});

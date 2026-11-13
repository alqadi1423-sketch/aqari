/**
 * المراجعة الشاملة 2026-11-13 · المراجع A1 (دورة الإيجار) · بيانات مصطنعة كلها.
 *
 * A1-2 · عالٍ · src/domain/contracts/service.ts:756-828 (applyDepositSettlement) · src/domain/accounting/post.ts:363-375
 *        (depositDeductLines) · src/domain/accrual.ts:411-416
 *   السيناريو: عقد ١٢٬٠٠٠ ريال (2025-11-01 إلى 2026-10-31) بأقساط شهرية ١٬٠٠٠ وتأمين ١٬٠٠٠ لدى المكتب · سدّد المستأجر
 *   أحد عشر قسطاً وغادر ولم يدفع قسط أكتوبر 2026 · فسوّى المالك التأمين بخصمه كاملاً «إيجار أكتوبر غير المدفوع» وردّ صفر.
 *   النتيجة اليوم:
 *     - الخصم يذهب إلى 4300 «إيراد من خصم التأمين»، وقسط أكتوبر يبقى مفتوحاً: ملف المستأجر يقول «متأخرات ١٬٠٠٠»،
 *       وشاشة التحصيل والتنبيهات ورسائل المطالبة تطالبه بها، وهي مدفوعة من تأمينه.
 *     - إيراد الاستحقاق في الرئيسية للسنة ١٣٬٠٠٠ لا ١٢٬٠٠٠: قيمة العقد كاملة (ومنها أكتوبر) + الخصم في 4300 مرة ثانية.
 *     - ولو زاد الخصم على التأمين لصار الزائد مطالبةً فوق الأقساط المفتوحة نفسها، فيُطالَب بالمبلغ مرتين.
 *   لماذا يهم: أشيع حالة في نهاية العقود (المستأجر يغادر وعليه آخر شهر)، والمالك يرى ديناً ليس له ويرسل مطالبة خاطئة.
 *   السلوك الصحيح: الخصم الذي يغطي متأخرات الإيجار يُسدّد به القسط المفتوح (دفعةٌ «من التأمين» مدين 2400 / دائن إيراد
 *   الإيجار بتقسيمه)، فيصير المتبقي صفراً والإيراد ١٢٬٠٠٠ مرة واحدة · وخصم الأضرار يبقى 4300.
 *   (اسم الخيار coverArrears في الاختبار اقتراح؛ ما يُختبر هو الأثر لا الاسم)
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, saveDepositSettlement, recordRentPayment } from '@/domain/contracts/service';
import { tenantProfile } from '@/domain/tenants';
import { periodRevenueAccrual } from '@/domain/accrual';
import { accountBalance } from '@/domain/accounting/ledger';

test.failing('A1-2 خصم التأمين مقابل قسطٍ لم يُدفع يسدّد القسط ولا يُحسب إيراداً مرتين', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار متأخرات مصطنع' }), { unit_no: 'M-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر متأخرات مصطنع', idNumber: '1000000927',
    valueHalalas: 1200000, cycle: 'شهرية', start: '2025-11-01', end: '2026-10-31', depositHalalas: 100000 }));
  const insts = db.all<{ id: string; due_date: string; amount_halalas: number }>(
    `SELECT id, due_date, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  expect(insts).toHaveLength(12);
  for (const i of insts.slice(0, 11)) {
    recordRentPayment(db, cid, { installmentId: i.id, period: '', date: i.due_date,
      lines: [{ method: 'cash', amountHalalas: Number(i.amount_halalas) }], discountHalalas: 0, notes: '' });
  }
  // التسوية: التأمين كله مقابل إيجار أكتوبر غير المدفوع
  saveDepositSettlement(db, cid, { date: '2026-11-05', deductionHalalas: 100000, deductionReason: 'إيجار أكتوبر غير المدفوع',
    refundHalalas: 0, notes: '', coverArrears: true } as never);

  const tid = db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [cid])!.t;
  // لا دين على المستأجر بعد أن سُدّد أكتوبر من تأمينه (اليوم: ١٬٠٠٠)
  expect(tenantProfile(db, tid, '2026-11-13')!.totals.outstanding).toBe(0);
  // الإيراد بالأساس النقدي ١٢٬٠٠٠ مرة واحدة · وبالاستحقاق كذلك (اليوم: ١٣٬٠٠٠)
  const cashRevenue = accountBalance(db, '4200') + accountBalance(db, '4300');
  expect(cashRevenue).toBe(1200000);
  expect(periodRevenueAccrual(db, '2025-11-01', '2026-11-30')).toBe(1200000);
  db.close();
});

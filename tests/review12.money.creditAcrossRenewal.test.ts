/**
 * مدقق المرحلة ١ المستقل (2026-11-13) · المال · A2.1 مع التجديد · بيانات مصطنعة كلها، والأرقام بالهللة محسوبة باليد.
 *
 * السيناريو:
 *  - العقد (أ) من 2026-01-01 إلى 2026-06-30 بستة أقساط شهرية كلٌّ ١٬٠٠٠٫٠٠ (٦٬٠٠٠٫٠٠) بلا تأمين.
 *  - في 2026-06-01 دفع المستأجر تحصيلاً جماعياً ٧٬٠٠٠٫٠٠ نقداً عن الأقساط الستة، فبقي له ١٬٠٠٠٫٠٠ رصيداً دائناً (2410).
 *  - جُدّد العقد إلى (ب) من 2026-07-01 إلى 2026-12-31 بستة أقساط كلٌّ ١٬٠٠٠٫٠٠ للمستأجر نفسه.
 *  - في 2026-07-01 سُدّد قسط يوليو في (ب) من رصيده الدائن (applyTenantCredit) · فصار القسط «مدفوعة».
 *
 * الدفتر صحيح: النقد ٧٬٠٠٠٫٠٠، والإيراد ٧٬٠٠٠٫٠٠، و2410 صفر.
 * الخطأ: إصلاح A2.1 (328fd50) جعل سطر «سداد · من الرصيد الدائن» في كشف المستأجر بلا مبلغ (paymentCash = 0) لأن الفائض «عُدّ
 * مقبوضاً يوم قُبض في دفعته» · وهذا صحيحٌ داخل العقد الواحد فقط: الرصيد الدائن للمستأجر لا للعقد، والفائض قُبض في كشف (أ)
 * لا في كشف (ب). فكشف (ب) يُظهر قسط يوليو «مستحقاً ١٬٠٠٠٫٠٠» بلا سداد يقابله، ورصيده عليه ١٬٠٠٠٫٠٠ وهو مسدَّد (وقبل A2.1
 * كان صفراً) · وكشف (أ) يبقى يُظهر له ١٬٠٠٠٫٠٠ رصيداً دائناً استُعمل في غيره.
 *
 * السلوك الصحيح: كشف (ب) بتاريخ 2026-07-15 رصيده صفر (القسط ١٬٠٠٠٫٠٠ مدين يقابله سداده من الرصيد ١٬٠٠٠٫٠٠ دائن).
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordBulkRentPayment, applyTenantCredit, renewContract, tenantCreditOf } from '@/domain/contracts/service';
import { tenantStatementRows } from '@/domain/statement';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';

const balanceDue = (rows: Array<{ debitHalalas: number; creditHalalas: number; future?: boolean }>) =>
  rows.filter((r) => !r.future).reduce((s, r) => s + r.debitHalalas - r.creditHalalas, 0);

test('A2.1 × التجديد: قسطٌ في العقد المجدَّد سُدّد من رصيدٍ دائن نشأ في العقد السابق لا يظهر ديناً في كشف المستأجر', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار رصيدٍ مصطنع' }), { unit_no: 'CR-1' });
  const a = confirmContract(db, contractInput(u, { tenant: 'مستأجر رصيدٍ مصطنع', idNumber: '1000012001', phone: '0500012001',
    start: '2026-01-01', end: '2026-06-30', valueHalalas: 600000, depositHalalas: 0 }));
  const ia = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [a]);
  expect(ia).toHaveLength(6);
  recordBulkRentPayment(db, a, { installmentIds: ia.map((x) => x.id), date: '2026-06-01', lines: [{ method: 'cash', amountHalalas: 700000 }], notes: '' });
  expect(tenantCreditOf(db, a)).toBe(100000);

  const b = renewContract(db, a, { start: '2026-07-01', end: '2026-12-31', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: false,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  const ib = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [b]);
  applyTenantCredit(db, b, { installmentId: ib[0].id, amountHalalas: 100000, date: '2026-07-01' });

  // الدفتر: نقد ٧٬٠٠٠ وإيراد ٧٬٠٠٠ ولا رصيد دائن باقٍ، والفحوص خضراء · وقسط يوليو في (ب) مدفوع
  expect([accountBalance(db, '1100'), accountBalance(db, '4200'), accountBalance(db, '2410')]).toEqual([700000, 700000, 0]);
  expect(integrityChecks(db).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  expect(db.get<{ s: string; p: number }>(`SELECT status AS s, paid_halalas AS p FROM contract_installments WHERE id = ?`, [ib[0].id]))
    .toEqual({ s: 'مدفوعة', p: 100000 });

  // كشف (ب) بتاريخ 2026-07-15: قسط يوليو ١٬٠٠٠ مدين وسداده من الرصيد ١٬٠٠٠ دائن ← صفر (اليوم ١٬٠٠٠ ديناً على المستأجر)
  expect(balanceDue(tenantStatementRows(db, b, '2026-07-15'))).toBe(0);
  db.close();
});

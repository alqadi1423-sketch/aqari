/**
 * مدقق المرحلة ١ المستقل (2026-11-13) · المال · A1-2 مع ترحيل التأمين في التجديد (A1-1) · بيانات مصطنعة، والأرقام بالهللة محسوبة باليد.
 *
 * السيناريو:
 *  - العقد (أ) من 2025-07-01 إلى 2025-12-31 بستة أقساط شهرية كلٌّ ١٬٠٠٠٫٠٠ وتأمين ١٬٠٠٠٫٠٠ لدى المكتب · سُدّد منها خمسة نقداً،
 *    وبقي قسط ديسمبر 2025 (١٬٠٠٠٫٠٠) غير مدفوع.
 *  - جُدّد إلى (ب) من 2026-01-01 إلى 2026-06-30 بترحيل التأمين (كانت الخانة مؤشَّرة افتراضياً قبل A1-1، فهو حال أغلب التجديدات
 *    القائمة) · وسُدّدت أقساط (ب) الستة نقداً.
 *  - انتهى (ب) فسوّى المالك التأمين في 2026-07-05: خصمه كله ١٬٠٠٠٫٠٠ «منها مقابل أقساطٍ متأخرة» ١٬٠٠٠٫٠٠ = قسط ديسمبر في (أ).
 *
 * الخطأ: depositArrearsDue وpayArrearsFromDeposit (fb0ee46) لا يريان إلا أقساط العقد المُسوّى (ب)، والتأمين المرحَّل هو تأمين (أ)
 * نفسه، و(أ) لا تُسوّى بعد ترحيله (depositCarried) · فتُرفض التسوية «مقابل الأقساط المتأخرة أكبر من المتبقي · المتبقي 0.00»،
 * ولا طريق للمالك إلا تسجيل الخصم «أضراراً» (4300) فيبقى قسط ديسمبر مفتوحاً ديناً على المستأجر ويُحسب الإيراد مرتين:
 * عيب A1-2 نفسه في كل تجديدٍ رُحِّل تأمينه.
 *
 * السلوك الصحيح (قرار المالك س١: «يُسدَّد به القسط نفسه»): التسوية تُقبل، ويُسدَّد قسط ديسمبر في (أ) من التأمين المرحَّل ·
 * فلا دين على المستأجر، و2400 صفر، و4300 صفر، وإيراد الإيجار ١٢٬٠٠٠٫٠٠ مرة واحدة (١١٬٠٠٠ نقداً + ١٬٠٠٠ من التأمين).
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment, renewContract, saveDepositSettlement } from '@/domain/contracts/service';
import { tenantProfile } from '@/domain/tenants';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';

test('A1-2 × ترحيل التأمين: الخصم مقابل قسطٍ متأخر في العقد السابق يسدّده من التأمين المرحَّل', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار ترحيلٍ مصطنع' }), { unit_no: 'CA-1' });
  const a = confirmContract(db, contractInput(u, { tenant: 'مستأجر ترحيلٍ مصطنع', idNumber: '1000012002', phone: '0500012002',
    start: '2025-07-01', end: '2025-12-31', valueHalalas: 600000, depositHalalas: 100000 }));
  const ia = db.all<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [a]);
  expect(ia).toHaveLength(6);
  for (const i of ia.slice(0, 5)) {
    recordRentPayment(db, a, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  const b = renewContract(db, a, { start: '2026-01-01', end: '2026-06-30', valueHalalas: 600000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 0, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  for (const i of db.all<{ id: string; due_date: string }>(`SELECT id, due_date FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [b])) {
    recordRentPayment(db, b, { installmentId: i.id, period: '', date: i.due_date, lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '' });
  }
  const tid = db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [b])!.t;
  // قبل التسوية: قسط ديسمبر في (أ) دينٌ ١٬٠٠٠، والتأمين المرحَّل في 2400
  expect(tenantProfile(db, tid, '2026-07-05')!.totals.outstanding).toBe(100000);
  expect(accountBalance(db, '2400')).toBe(100000);

  // التسوية: التأمين كله مقابل قسط ديسمبر المتأخر (اليوم تُرفض: «المتبقي 0.00»)
  saveDepositSettlement(db, b, { date: '2026-07-05', deductionHalalas: 100000, deductionReason: 'إيجار ديسمبر 2025 غير المدفوع',
    refundHalalas: 0, notes: '', arrearsHalalas: 100000 });

  expect(db.get<{ s: string; p: number }>(`SELECT status AS s, paid_halalas AS p FROM contract_installments WHERE id = ?`, [ia[5].id]))
    .toEqual({ s: 'مدفوعة', p: 100000 });
  expect(tenantProfile(db, tid, '2026-07-10')!.totals.outstanding).toBe(0);
  // 2400 صفر · 4300 صفر · إيراد الإيجار ١٢٬٠٠٠ = ١١٬٠٠٠ نقداً + ١٬٠٠٠ من التأمين · والنقد ١٢٬٠٠٠ (١١٬٠٠٠ إيجار + ١٬٠٠٠ تأمين)
  expect([accountBalance(db, '2400'), accountBalance(db, '4300'), accountBalance(db, '4200'), accountBalance(db, '1100')])
    .toEqual([0, 0, 1200000, 1200000]);
  expect(integrityChecks(db).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  db.close();
});

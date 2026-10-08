/**
 * مراجعة التثبيت #12 · كشف حساب المستأجر (وثيقة تُسلَّم له) · بيانات مصطنعة:
 *  المطالبة المحصَّلة لها سطر دائن · وخصم «بعد الاستحقاق» يُطرح (القرار: «عرض الاستحقاق يطرح الخصومات من النوعين») ·
 *  والقسط الذي لم يحلّ بتاريخ الكشف لا يوصف «مستحقاً» ولا يدخل الرصيد المستحق
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { saveClaim, collectClaim } from '@/domain/claims';
import { tenantStatementRows } from '@/domain/statement';
import { buildStatementDoc } from '@/domain/printDocs';
import { DISCOUNT_AFTER_DUE } from '@/domain/contracts/installments';

test('#١٢ الرصيد المستحق على المستأجر بتاريخ الكشف: لا مطالبة محصَّلة ولا خصم ولا قسط لم يحلّ', () => {
  const db = memDb();
  const bank = addBank(db);
  const u = addUnit(db, addProperty(db, { name: 'عقار كشف مصطنع' }), { unit_no: 'S-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر كشف مصطنع', idNumber: '1000000090', phone: '0500000051',
    valueHalalas: 1200000, cycle: 'شهرية', start: '2026-01-01', end: '2026-12-31', depositHalalas: 0 }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  // يناير مسدَّد بخصم «بعد الاستحقاق» ٢٠٠ ريال، وفبراير ومارس قائمان
  recordRentPayment(db, cid, { installmentId: insts[0], period: 'يناير', date: '2026-01-05', notes: '',
    discountHalalas: 20000, discountKind: DISCOUNT_AFTER_DUE, lines: [{ method: 'bank', bankId: bank, amountHalalas: 80000 }] });
  const cl = saveClaim(db, { contractId: cid, amountHalalas: 15000, reason: 'إصلاح مصطنع', date: '2026-02-10' });
  collectClaim(db, cl, '2026-02-20');

  const rows = tenantStatementRows(db, cid, '2026-03-15');
  const due = rows.filter((r) => !r.future);
  const balance = due.reduce((s, r) => s + r.debitHalalas - r.creditHalalas, 0);
  // يناير ١٠٠٠ − (٨٠٠ مقبوض + ٢٠٠ خصم) = ٠ · فبراير ١٠٠٠ · مارس ١٠٠٠ · والمطالبة ١٥٠ ثم تحصيلها ١٥٠
  expect(balance).toBe(200000);
  expect(rows.filter((r) => r.future)).toHaveLength(9);
  expect(rows.filter((r) => r.future).every((r) => !r.descr.includes('مستحق'))).toBe(true);
  // والمطبوع: الرصيد المستحق بتاريخ الكشف وحده
  const html = buildStatementDoc({ name: 'منشأة مصطنعة' } as never,
    { tenantName: 'مستأجر كشف مصطنع', contractNo: 'C-1', unitLabel: 'S-1', start: '2026-01-01', end: '2026-12-31', rows }, '2026-03-15');
  expect(html).toContain('الرصيد المستحق على المستأجر');
  expect(html).toContain('2,000.00');
  db.close();
});

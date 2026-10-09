/**
 * دراسة القائم (2026-10-09) · إصلاحات فورية بقرار المالك: «الرصيد الدائن الوهمي في الكشف بعد الإلغاء، والدمج، والرصيد
 * الافتتاحي بلا قيد» · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment, cancelContract } from '@/domain/contracts/service';
import { tenantStatementRows } from '@/domain/statement';
import { mergeTenants } from '@/domain/tenants';

test('إلغاء العقد بأقساطه لا يترك رصيداً دائناً وهمياً بدفعة القسط المسدَّد جزئياً', () => {
  const db = memDb();
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار كشف مصطنع' })),
    { tenant: 'مستأجر كشف مصطنع', idNumber: '1000000742', phone: '0500000742', start: '2026-01-01', depositHalalas: 0 }));
  const [i1, i2] = db.all<{ id: string; amount_halalas: number }>(`SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 2`, [cid]);
  // دفعة جزئية مقدَّمة على القسط الثاني، ثم إلغاء العقد قبل حلوله بأقساطه: القسط الثاني يُلغى ودفعته باقية
  recordRentPayment(db, cid, { installmentId: i2.id, period: 'الثاني', date: '2026-01-05', lines: [{ method: 'cash', amountHalalas: 40000 }], discountHalalas: 0, notes: '' });
  cancelContract(db, cid, { date: '2026-01-10', reason: 'إلغاء مصطنع', installmentsFate: 'cancel', settle: false, deductionHalalas: 0, refundHalalas: 0, deductionReason: '' });
  const rows = tenantStatementRows(db, cid, '2026-12-31');
  const bal = rows.filter((r) => !r.future).reduce((s, r) => s + r.debitHalalas - r.creditHalalas, 0);
  // عليه القسط الأول كاملاً، ولا رصيد دائن وهمي بدفعة القسط الملغى
  expect(bal).toBe(Number(i1.amount_halalas));
  db.close();
});

test('الدمج ينقل الرصيد الدائن · ولا يدمج هويتين مختلفتين إلا بتأكيدٍ صريح', () => {
  const db = memDb();
  db.run(`INSERT INTO tenants (id, name, national_id, credit_halalas, created_at) VALUES ('TA', 'مستأجر دمج مصطنع', '1000000759', 0, '2026-01-01'), ('TB', 'مستأجر دمج مصطنع', '1000000767', 3000, '2026-01-01'), ('TC', 'مستأجر دمج مصطنع', '', 2000, '2026-01-01')`);
  expect(() => mergeTenants(db, 'TA', ['TB'])).toThrow();
  mergeTenants(db, 'TA', ['TC']);
  expect(db.get(`SELECT credit_halalas AS c FROM tenants WHERE id = 'TA'`)).toEqual({ c: 2000 });
  mergeTenants(db, 'TA', ['TB'], { allowDifferentIds: true });
  expect(db.get(`SELECT credit_halalas AS c FROM tenants WHERE id = 'TA'`)).toEqual({ c: 5000 });
  expect(db.get(`SELECT credit_halalas AS c, deleted_at IS NOT NULL AS d FROM tenants WHERE id = 'TB'`)).toEqual({ c: 0, d: 1 });
  db.close();
});

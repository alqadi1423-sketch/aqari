/**
 * مراجعة التثبيت #63 · قرار المالك 2026-10-07: «رصيد المستأجر الدائن: يظهر عند التحصيل ويختار المستخدم، مع فحص مطابقة» ·
 * الرصيد يسدّد قسطاً بقيدٍ من 2410 إلى الإيراد، وإلغاء الدفعة يعيده، وفحص المطابقة يقارن 2410 بأرصدة المستأجرين · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, applyTenantCredit, tenantCreditOf } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { postEntry } from '@/domain/accounting/post';
import { integrityChecks } from '@/domain/accounting/integrity';
import { accountBalance } from '@/domain/accounting/ledger';

test('الرصيد الدائن يسدّد القسط باختيار المستخدم · وإلغاء الدفعة يعيده · والمطابقة سليمة', () => {
  const db = memDb();
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار رصيد مصطنع' })),
    { tenant: 'مستأجر رصيد مصطنع', idNumber: '1000001015', phone: '0500001015', start: '2026-01-01', depositHalalas: 0 }));
  const tid = db.get<{ t: string }>(`SELECT tenant_id AS t FROM contracts WHERE id = ?`, [cid])!.t;
  // رصيدٌ دائن قائم بقيده (كفائض تحصيل): مدين النقدية / دائن 2410
  postEntry(db, { date: '2026-01-02', memo: 'فائض مصطنع', lines: [{ account: '1100', debit: 30000, credit: 0 }, { account: '2410', debit: 0, credit: 30000 }] });
  db.run(`UPDATE tenants SET credit_halalas = 30000 WHERE id = ?`, [tid]);
  const check = () => integrityChecks(db).find((c) => c.name.includes('الرصيد الدائن'))!;
  expect(check().ok).toBe(true);
  expect(tenantCreditOf(db, cid)).toBe(30000);
  const inst = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  expect(() => applyTenantCredit(db, cid, { installmentId: inst.id, amountHalalas: 40000, date: '2026-01-05' })).toThrow();
  const pid = applyTenantCredit(db, cid, { installmentId: inst.id, amountHalalas: 20000, date: '2026-01-05' });
  expect(tenantCreditOf(db, cid)).toBe(10000);
  expect(accountBalance(db, '2410')).toBe(10000);
  expect(Number(db.get<{ p: number }>(`SELECT paid_halalas AS p FROM contract_installments WHERE id = ?`, [inst.id])!.p)).toBe(20000);
  expect(check().ok).toBe(true);
  cancelPayment(db, pid, { date: '2026-01-06', reason: 'إلغاء مصطنع' });
  expect(tenantCreditOf(db, cid)).toBe(30000);
  expect(accountBalance(db, '2410')).toBe(30000);
  expect(check().ok).toBe(true);
  // رصيدٌ في سجل المستأجر بلا قيده: الفحص يكشفه
  db.run(`UPDATE tenants SET credit_halalas = 99999 WHERE id = ?`, [tid]);
  expect(check().ok).toBe(false);
  db.close();
});

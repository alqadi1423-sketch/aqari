/**
 * التحقق المستقل من 37085a3 · ما وجده يُصلح (القاعدة ٩٦) · بيانات مصطنعة:
 *  ١. سداد القسط من الرصيد الدائن لا يُحسب في الإقرار مرتين: يُطرح من صافي الدفعة دائنُ 2410 وحده (فائضها)، لا صافيه
 *  ٢. فحص مطابقة 2410 لا يُحكم به على جهاز العضو (تصله القيود ولا تصله أرصدة المستأجرين)
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordBulkRentPayment, applyTenantCredit } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { vatReturnData } from '@/domain/vatReturn';
import { integrityChecks } from '@/domain/accounting/integrity';

test('١ السداد من الرصيد الدائن يدخل الإقرار مرة واحدة · وإلغاؤه يعيده', () => {
  const db = memDb();
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار إقرار رصيد مصطنع' })),
    { tenant: 'مستأجر إقرار رصيد مصطنع', idNumber: '1000001049', phone: '0500001049', start: '2026-01-01', depositHalalas: 0 }));
  const insts = db.all<{ id: string; a: number }>(`SELECT id, amount_halalas AS a FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  const A = Number(insts[0].a);
  recordBulkRentPayment(db, cid, { installmentIds: [insts[0].id], date: '2026-01-05', lines: [{ method: 'cash', amountHalalas: A + 20000 }], notes: '' });
  const exempt = () => vatReturnData(db, 2026, 1).schedules.exemptSales.reduce((s, r) => s + Number(r.net), 0);
  expect(exempt()).toBe(A);
  const pid = applyTenantCredit(db, cid, { installmentId: insts[1].id, amountHalalas: 20000, date: '2026-02-05' });
  expect(exempt()).toBe(A + 20000);
  cancelPayment(db, pid, { date: '2026-02-06', reason: 'إلغاء مصطنع' });
  expect(exempt()).toBe(A);
  db.close();
});

test('٢ جهاز العضو لا يُحكم فيه بمطابقة 2410', () => {
  const db = memDb();
  db.run(`INSERT INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'O', uid: 'U', perms: { ledger: 1 }, allProps: true, props: [] })]);
  // قيد فائضٍ وصله من الدفتر، ورصيد المستأجر لا يصله
  db.run(`INSERT INTO journal_entries (id, no, date, memo, status, auto, created_at) VALUES ('JX', 'JE-X1', '2026-01-05', 'فائض مصطنع', 'قيد الإنشاء', 1, '2026-01-05')`);
  db.run(`INSERT INTO journal_lines (id, entry_id, account_code, debit_halalas, credit_halalas) VALUES ('JX1', 'JX', '1100', 5000, 0), ('JX2', 'JX', '2410', 0, 5000)`);
  db.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = 'JX'`);
  const c = integrityChecks(db).find((x) => x.name.includes('الرصيد الدائن'));
  expect(c === undefined || c.ok).toBe(true);
  db.close();
});

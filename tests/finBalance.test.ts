/**
 * مراجعة التثبيت #13 · المركز المالي يتوازن، وحقوق الملكية آخر المدة = حقوقها في المركز · بيانات مصطنعة:
 * لا إقفال للإيراد والمصروف في الدفتر، فأرباح الفترات حتى التاريخ سطرٌ في حقوق الملكية (كفحص المطابقة)
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { financialStatementBlock } from '@/domain/finStatements';
import { postEntry } from '@/domain/accounting/post';
import type { DB } from '@/db/adapter';

function world(): DB {
  const db = memDb();
  const bank = addBank(db);
  const u = addUnit(db, addProperty(db, { name: 'عقار قوائم مصطنع' }), { unit_no: 'F-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر قوائم مصطنع', idNumber: '1000000108', phone: '0500000061',
    valueHalalas: 1200000, start: '2025-01-01', end: '2025-12-31', depositHalalas: 0 }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  // إيراد في سنة سابقة وفي السنة الجارية · ومصروف · وقيد مباشر على الأرباح المرحّلة
  recordRentPayment(db, cid, { installmentId: insts[0], period: 'يناير', date: '2025-01-05', notes: '', discountHalalas: 0, lines: [{ method: 'bank', bankId: bank, amountHalalas: 100000 }] });
  recordRentPayment(db, cid, { installmentId: insts[1], period: 'فبراير', date: '2026-02-05', notes: '', discountHalalas: 0, lines: [{ method: 'bank', bankId: bank, amountHalalas: 100000 }] });
  postEntry(db, { date: '2026-03-01', memo: 'مصروف مصطنع', lines: [{ account: '5900', debit: 30000, credit: 0 }, { account: '1100', debit: 0, credit: 30000 }] });
  postEntry(db, { date: '2026-03-02', memo: 'تسوية أرباح مرحّلة مصطنعة', lines: [{ account: '1100', debit: 5000, credit: 0 }, { account: '3200', debit: 0, credit: 5000 }] });
  return db;
}
const last = (b: ReturnType<typeof financialStatementBlock>) => b.totals[b.totals.length - 1];
const money = (c: unknown) => (c as { money: number }).money;

test('#١٣ المركز المالي يتوازن بأرباح الفترات حتى تاريخه', () => {
  const db = world();
  const b = financialStatementBlock(db, 'balance', null, '2026-12-31');
  expect(last(b)[0]).toBe('الأصول = الخصوم + حقوق الملكية');
  expect(money(last(b)[1])).toBe(0);
  db.close();
});

test('#١٣ حقوق الملكية آخر المدة = حقوقها في المركز · وأولها يشمل أرباح ما قبلها وحركة الأرباح المرحّلة', () => {
  const db = world();
  const bal = financialStatementBlock(db, 'balance', null, '2026-12-31');
  const eqTotal = bal.sections[2].rows.reduce((s, r) => s + money(r[1]), 0);
  for (const from of [null, '2026-01-01']) {
    const eq = financialStatementBlock(db, 'equity', from, '2026-12-31');
    expect([from, money(last(eq)[1])]).toEqual([from, eqTotal]);
  }
  db.close();
});

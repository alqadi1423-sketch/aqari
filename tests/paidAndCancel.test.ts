/**
 * المسدَّد يُحسب من الدفعات وتوزيعها، وإلغاء الدفعة (قرارا المالك ٢٠٢٦-١٠-٠٣) · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { MemoryRemote } from './helpers/memoryRemote';
import { confirmContract, recordRentPayment, recordBulkRentPayment, RuleViolation } from '@/domain/contracts/service';
import { DISCOUNT_AFTER_DUE, DISCOUNT_REDUCES_INSTALLMENT } from '@/domain/contracts/installments';
import { recomputeInstallments } from '@/domain/contracts/paid';
import { planCancelPayment, cancelPayment } from '@/domain/contracts/cancelPayment';
import { contractSurpluses, settleSurplus } from '@/domain/ledgerReview';
import { accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { semanticIssues } from '@/domain/backup/semantic';
import { enableSync, syncOnce } from '@/sync/engine';
import { getMeta } from '@/repos/settings';
import type { DB } from '@/db/adapter';

let seq = 0;
function contract(db: DB, monthly = 150000) {
  const u = addUnit(db, addProperty(db), { rent: monthly });
  seq++;
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر مصطنع ' + seq, valueHalalas: monthly * 12, depositHalalas: 0,
    idNumber: '10' + String(30000000 + seq), start: '2026-01-01', end: '2026-12-31' }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  return { cid, insts };
}
const inst = (db: DB, id: string) => db.get<{ amount: number; paid: number; status: string }>(
  `SELECT amount_halalas AS amount, paid_halalas AS paid, status FROM contract_installments WHERE id = ?`, [id])!;
const pay = (db: DB, k: { cid: string }, iid: string, cash: number, disc = 0, kind: string | null = null, bankId?: string) =>
  recordRentPayment(db, k.cid, { installmentId: iid, period: 'م', date: '2026-02-05', notes: '', discountHalalas: disc,
    discountKind: kind as never, lines: [bankId ? { method: 'bank', bankId, amountHalalas: cash } : { method: 'cash', amountHalalas: cash }] });
const healthy = (db: DB) => {
  expect(semanticIssues(db)).toEqual([]);
  for (const c of integrityChecks(db)) expect(`${c.name}: ${c.ok}`).toBe(`${c.name}: true`);
  expect(recomputeInstallments(db)).toEqual([]); // المخزَّن مطابق للمحسوب
};

describe('المسدَّد من الدفعات', () => {
  test('قسطٌ حُصّل من جهازين بلا اتصال: لا يضيع قبض · المسدَّد بمبلغ القسط والزائد فائض للرد', async () => {
    const r = new MemoryRemote();
    const a = memDb();
    const b = memDb();
    enableSync(a, 'U'); enableSync(b, 'U');
    const k = contract(a);
    await syncOnce(a, r, getMeta(a, 'device_id')!);
    await syncOnce(b, r, getMeta(b, 'device_id')!);
    // الجهازان بلا اتصال · كلٌّ يحصّل القسط الأول كاملاً
    pay(a, k, k.insts[0], 150000);
    pay(b, k, k.insts[0], 150000);
    await syncOnce(a, r, getMeta(a, 'device_id')!);
    await syncOnce(b, r, getMeta(b, 'device_id')!);
    await syncOnce(a, r, getMeta(a, 'device_id')!);
    for (const d of [a, b]) {
      expect(inst(d, k.insts[0]).paid).toBe(150000);
      expect(Number(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contract_payments`)!.n)).toBe(2);
      expect(accountBalance(d, '1100')).toBe(300000); // القبضان في الدفتر
      expect(contractSurpluses(d).map((s) => s.amount)).toEqual([150000]); // والزائد ظاهر للرد
    }
    a.close(); b.close();
  });

  test('المسدَّد المكتوب بيدٍ يُعاد حسابه من الدفعات', () => {
    const db = memDb();
    const k = contract(db);
    pay(db, k, k.insts[0], 100000);
    db.run(`UPDATE contract_installments SET paid_halalas = 0, status = 'مستحقة' WHERE id = ?`, [k.insts[0]]);
    expect(recomputeInstallments(db).map((c) => [c.fromPaid, c.toPaid])).toEqual([[0, 100000]]);
    expect(inst(db, k.insts[0])).toMatchObject({ paid: 100000, status: 'مدفوعة جزئياً' });
    db.close();
  });
});

describe('إلغاء الدفعة', () => {
  test('دفعة نقدية: قيد مرآة بتاريخ الإلغاء · المسدَّد يرجع · الدفعة موسومة لا محذوفة · وفي السجل', () => {
    const db = memDb();
    const k = contract(db);
    const p = pay(db, k, k.insts[0], 150000);
    const plan = planCancelPayment(db, p, '2026-03-01');
    expect(plan.blockers).toEqual([]);
    expect(plan.installments).toEqual([{ id: k.insts[0], due: expect.any(String), fromPaid: 150000, toPaid: 0 }]);
    cancelPayment(db, p, { date: '2026-03-01', reason: 'سُجّلت خطأً' });
    expect(inst(db, k.insts[0])).toMatchObject({ paid: 0, status: 'مستحقة' });
    const row = db.get<{ c: string; r: string; e: string }>(`SELECT cancelled_at AS c, cancel_reason AS r, cancel_entry_id AS e FROM contract_payments WHERE id = ?`, [p])!;
    expect(row.c).toBe('2026-03-01');
    expect(row.r).toBe('سُجّلت خطأً');
    expect(db.get<{ d: string }>(`SELECT date AS d FROM journal_entries WHERE id = ?`, [row.e])!.d).toBe('2026-03-01');
    expect(accountBalance(db, '1100')).toBe(0);
    expect(accountBalance(db, '4200')).toBe(0);
    expect(db.get(`SELECT 1 FROM audit_log WHERE entity_type = 'إلغاء دفعة'`)).toBeTruthy();
    healthy(db);
    // لا يُلغى مرتين
    expect(() => cancelPayment(db, p, { reason: 'ثانية' })).toThrow('ملغاة من قبل');
    db.close();
  });

  test('بخصم بعد الاستحقاق: قيد الدفعة وخطّ الخصم يُعكسان · والقسط يرجع كاملاً', () => {
    const db = memDb();
    const k = contract(db);
    const p = pay(db, k, k.insts[0], 130000, 20000, DISCOUNT_AFTER_DUE);
    expect(inst(db, k.insts[0]).status).toBe('مدفوعة');
    cancelPayment(db, p, { reason: 'إلغاء' });
    expect(inst(db, k.insts[0])).toMatchObject({ paid: 0, status: 'مستحقة' });
    expect(accountBalance(db, '4900')).toBe(0);
    healthy(db);
    db.close();
  });

  test('بتنزيل من القسط: مبلغ القسط يرجع كما كان', () => {
    const db = memDb();
    const k = contract(db);
    const p = pay(db, k, k.insts[0], 120000, 30000, DISCOUNT_REDUCES_INSTALLMENT);
    expect(inst(db, k.insts[0]).amount).toBe(120000);
    cancelPayment(db, p, { reason: 'إلغاء' });
    expect(inst(db, k.insts[0])).toMatchObject({ amount: 150000, paid: 0 });
    healthy(db);
    db.close();
  });

  test('تحصيل جماعي بفائض رصيداً: التوزيع والرصيد الدائن يرجعان معاً', () => {
    const db = memDb();
    const k = contract(db);
    const p = recordBulkRentPayment(db, k.cid, { installmentIds: k.insts.slice(0, 2), date: '2026-02-05', notes: '',
      lines: [{ method: 'cash', amountHalalas: 320000 }] });
    expect(accountBalance(db, '2410')).toBe(20000);
    const plan = planCancelPayment(db, p);
    expect(plan.installments.map((i) => [i.fromPaid, i.toPaid])).toEqual([[150000, 0], [150000, 0]]);
    expect(plan.creditReversal).toBe(20000);
    cancelPayment(db, p, { reason: 'إلغاء' });
    expect(k.insts.slice(0, 2).map((i) => inst(db, i).paid)).toEqual([0, 0]);
    expect(accountBalance(db, '2410')).toBe(0);
    expect(Number(db.get<{ c: number }>(`SELECT t.credit_halalas AS c FROM tenants t JOIN contracts c ON c.tenant_id = t.id WHERE c.id = ?`, [k.cid])!.c)).toBe(0);
    healthy(db);
    db.close();
  });

  test('دفعة بنكية: حركة البنك تُعكس بحركة سالبة', () => {
    const db = memDb();
    const bank = addBank(db);
    const k = contract(db);
    const p = pay(db, k, k.insts[0], 150000, 0, null, bank);
    cancelPayment(db, p, { reason: 'إلغاء' });
    const sum = Number(db.get<{ s: number }>(`SELECT SUM(amount_halalas) AS s FROM bank_tx WHERE bank_id = ?`, [bank])!.s);
    expect(sum).toBe(0);
    healthy(db);
    db.close();
  });

  test('يُمنع بسببه: فائض للعقد رُدّ · ورصيد دائن استُعمل', () => {
    const db = memDb();
    const k = contract(db);
    const r = new MemoryRemote(); void r;
    // فائض من دفعتين على قسط واحد (كما من جهازين) ثم رُدّ
    const p1 = pay(db, k, k.insts[0], 150000);
    db.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'applying'`); // دفعة جهاز آخر لا يفحصها «المتبقي» المحلي
    const p2 = pay(db, k, k.insts[1], 150000);
    db.run(`UPDATE sync_ctl SET v = 0 WHERE k = 'applying'`);
    void p2;
    db.run(`UPDATE contract_payments SET installment_id = ? WHERE id = ?`, [k.insts[0], p2]);
    recomputeInstallments(db);
    expect(contractSurpluses(db).map((s) => s.amount)).toEqual([150000]);
    settleSurplus(db, k.cid, { action: 'refund', amountHalalas: 150000, date: '2026-03-01', method: 'cash' });
    expect(planCancelPayment(db, p1).blockers.join(' ')).toContain('يُلغى الرد أولاً');
    expect(() => cancelPayment(db, p1, { reason: 'إلغاء' })).toThrow(RuleViolation);
    db.close();
  });
});

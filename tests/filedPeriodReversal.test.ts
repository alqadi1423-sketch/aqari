/**
 * المراجعة الخارجية ٧ · النتيجتان ٦ و٧ · بيانات مصطنعة.
 * ٦ (قرار المالك «رابعاً ٥»: «التاريخ الحر داخل فترة مقدَّمة يُرفض برسالة واضحة») · قائمة القبول: «المجس يرمي، وأرقام الربع الأول
 *   لا تتغير بعد التقديم».
 * ٧ (قرار المالك «رابعاً ٤»: «منع تقديم الإقرار مع إيجار تجاري محصَّل») · قائمة القبول: «fileVatReturn يرمي مع دفعات عقد غير سكني
 *   في الفترة».
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment, saveDepositSettlement } from '@/domain/contracts/service';
import { cancelPayment } from '@/domain/contracts/cancelPayment';
import { fileVatReturn } from '@/domain/vatFilings';
import type { DB } from '@/db/adapter';

const q1Revenue = (db: DB) => Number(db.get<{ n: number }>(
  `SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
   JOIN accounts a ON a.code = l.account_code WHERE e.status = 'مرحّل' AND a.type = 'إيراد' AND e.date BETWEEN '2026-01-01' AND '2026-03-31'`)!.n);

function world(shop = false) {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'A-1' });
  if (shop) db.run(`UPDATE units SET type = 'محل' WHERE id = ?`, [u]);
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '1000000601', phone: '0500000601', start: '2026-01-01', depositHalalas: 300000 }));
  const i = db.get<{ id: string; amount_halalas: number }>(`SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  const pay = recordRentPayment(db, cid, { installmentId: i.id, period: 'الأول', date: '2026-01-05', lines: [{ method: 'cash', amountHalalas: Number(i.amount_halalas) }], discountHalalas: 0, notes: '' });
  return { db, cid, pay };
}

test('٦ إلغاء دفعة من ربعٍ قُدِّم إقراره بتاريخٍ فيه يُرفض · وأرقام الربع لا تتغير · وبتاريخٍ مفتوح يُقبل', () => {
  const { db, pay } = world();
  fileVatReturn(db, 2026, 1, '2026-04-20');
  const before = q1Revenue(db);
  expect(() => cancelPayment(db, pay, { date: '2026-01-20', reason: 'إلغاء مصطنع' })).toThrow(/قُدِّم إقرارها/);
  expect(q1Revenue(db)).toBe(before);
  cancelPayment(db, pay, { date: '2026-04-21', reason: 'إلغاء مصطنع' });
  expect(q1Revenue(db)).toBe(before);
  db.close();
});

test('٦ وتسوية التأمين الأولى بتاريخٍ في فترةٍ مقدَّمة مرفوضة', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار تأمين مصطنع' }), { unit_no: 'D-1' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '1000000602', phone: '0500000602', start: '2026-01-01', end: '2026-02-28', depositHalalas: 100000 }));
  fileVatReturn(db, 2026, 1, '2026-04-20');
  expect(() => saveDepositSettlement(db, cid, { date: '2026-02-28', deductionHalalas: 0, deductionReason: '', refundHalalas: 100000, notes: '' }))
    .toThrow(/قُدِّم إقرارها/);
  db.close();
});

test('٧ إقرارٌ في ربعه إيجارٌ تجاري محصَّل لا يُقدَّم · والسكني وحده يُقدَّم', () => {
  const com = world(true);
  expect(() => fileVatReturn(com.db, 2026, 1, '2026-04-20')).toThrow(/إيجارٌ تجاري/);
  expect(com.db.get(`SELECT 1 FROM vat_filings`)).toBeFalsy();
  com.db.close();
  const res = world(false);
  fileVatReturn(res.db, 2026, 1, '2026-04-20');
  expect(res.db.get(`SELECT 1 FROM vat_filings`)).toBeTruthy();
  res.db.close();
});

test('قرار المالك 2026-10-15 «٦»: الدفعة والعملية النقدية والقيد اليدوي بتاريخٍ في فترةٍ مقدَّمة تُرفض · وفي فترةٍ مفتوحة تمرّ', async () => {
  const { postManualEntry, saveManualDraft } = await import('@/domain/accounting/post');
  const { ownerCashIn, pettyCashExpense } = await import('@/domain/cashOps');
  const { recordRentPayment } = await import('@/domain/contracts/service');
  const db = memDb();
  const cid = confirmContract(db, contractInput(addUnit(db, addProperty(db), { rent: 100000 }), { valueHalalas: 1200000, depositHalalas: 0, start: '2026-01-01' }));
  const inst = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  fileVatReturn(db, 2026, 1, '2026-04-20');
  const lines = [{ account: '1100', debit: 500, credit: 0 }, { account: '3100', debit: 0, credit: 500 }];
  for (const run of [
    () => postManualEntry(db, { date: '2026-02-10', memo: 'يدوي مصطنع', lines }),
    () => saveManualDraft(db, { date: '2026-02-10', memo: 'مسودة مصطنعة', lines }),
    () => ownerCashIn(db, { amountHalalas: 500, date: '2026-02-10' }),
    () => pettyCashExpense(db, { amountHalalas: 100, descr: 'نثرية مصطنعة', date: '2026-02-10' }),
    () => recordRentPayment(db, cid, { installmentId: inst, period: 'م', date: '2026-02-10', notes: '', discountHalalas: 0, lines: [{ method: 'cash', amountHalalas: 100000 }] }),
  ]) expect(run).toThrow(/قُدِّم إقرارها/);
  expect(() => ownerCashIn(db, { amountHalalas: 500, date: '2026-04-21' })).not.toThrow();
  expect(() => postManualEntry(db, { date: '2026-04-21', memo: 'يدوي مصطنع', lines })).not.toThrow();
  db.close();
});

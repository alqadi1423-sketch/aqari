/**
 * عكس قيد من الدفتر للقيد اليدوي وحده · قيد الدفعة الآلي مربوط بمسدَّد قسطها فلا يُعكس من الدفتر،
 * وإلا بقي القسط مسدَّداً بلا نقد يقابله (وجده اختبار الثوابت العشوائي: البذور ٦ و٧ و٨).
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment, RuleViolation } from '@/domain/contracts/service';
import { postEntry } from '@/domain/accounting/post';
import { reverseFromJournal, journalReversalBlock } from '@/domain/accounting/journalReversal';
import { invariantIssues } from './helpers/fuzz';

test('قيد الدفعة لا يُعكس من الدفتر · والمسدَّد يبقى مطابقاً للدفتر', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db), { rent: 100000 });
  const cid = confirmContract(db, contractInput(u, { valueHalalas: 1200000, depositHalalas: 0 }));
  const inst = db.get<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!.id;
  const pay = recordRentPayment(db, cid, { installmentId: inst, period: 'يناير', date: '2026-01-05', discountHalalas: 0, notes: '',
    lines: [{ method: 'cash', amountHalalas: 100000 }] });
  const entry = db.get<{ e: string }>(`SELECT journal_entry_id AS e FROM contract_payments WHERE id = ?`, [pay])!.e;

  expect(journalReversalBlock(db, entry)).toMatch(/قيد دفعة إيجار/);
  expect(() => reverseFromJournal(db, entry)).toThrow(RuleViolation);
  expect(db.get<{ r: string | null }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [entry])!.r).toBeNull();
  expect(invariantIssues(db)).toEqual([]);
  db.close();
});

test('القيد اليدوي يُعكس من الدفتر كما كان', () => {
  const db = memDb();
  const e = postEntry(db, { date: '2026-01-01', memo: 'يدوي', auto: false,
    lines: [{ account: '1100', debit: 5000, credit: 0 }, { account: '3100', debit: 0, credit: 5000 }] })!;
  expect(journalReversalBlock(db, e.id)).toBe('');
  const rev = reverseFromJournal(db, e.id);
  expect(rev).not.toBeNull();
  db.close();
});

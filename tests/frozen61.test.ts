/**
 * مراجعة التثبيت #61 · ثغرات تجميد القيد المرحّل في القاعدة (الهجرة ٤١) · بيانات مصطنعة:
 *  رأس القيد المرحّل لا يُعدَّل (التاريخ والبيان والرقم والمصدر) · ولا يُنقل سطرٌ إليه من قيدٍ آخر · والمبالغ أعداد صحيحة
 */
import { memDb } from './helpers/testDb';
import { postEntry } from '@/domain/accounting/post';

const lines = [{ account: '1100', debit: 1000, credit: 0 }, { account: '3100', debit: 0, credit: 1000 }];

test('رأس القيد المرحّل مجمّد · والربط بعاكسه يبقى جائزاً', () => {
  const db = memDb();
  const e = postEntry(db, { date: '2026-03-01', memo: 'قيد مصطنع', lines })!;
  for (const sql of [
    `UPDATE journal_entries SET memo = 'بيان آخر' WHERE id = ?`,
    `UPDATE journal_entries SET date = '2026-03-02' WHERE id = ?`,
    `UPDATE journal_entries SET no = 'JE-999999' WHERE id = ?`,
    `UPDATE journal_entries SET src_type = 'rent' WHERE id = ?`,
  ]) expect(() => db.run(sql, [e.id])).toThrow();
  const r = postEntry(db, { date: '2026-03-05', memo: 'عكس مصطنع', lines: lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })) })!;
  db.run(`UPDATE journal_entries SET reversed_by = ? WHERE id = ?`, [r.id, e.id]);
  db.close();
});

test('لا يُنقل سطرٌ من مسودة إلى قيدٍ مرحّل', () => {
  const db = memDb();
  const posted = postEntry(db, { date: '2026-03-01', memo: 'قيد مرحّل مصطنع', lines })!;
  db.run(`INSERT INTO journal_entries (id, no, date, memo, status, auto, created_at) VALUES ('DRAFT1', 'D-1', '2026-03-01', 'مسودة مصطنعة', 'قيد الإنشاء', 0, '2026-03-01')`);
  db.run(`INSERT INTO journal_lines (id, entry_id, account_code, debit_halalas, credit_halalas) VALUES ('L1', 'DRAFT1', '1100', 500, 0)`);
  expect(() => db.run(`UPDATE journal_lines SET entry_id = ? WHERE id = 'L1'`, [posted.id])).toThrow();
  db.close();
});

test('مبالغ السطر أعداد صحيحة', () => {
  const db = memDb();
  db.run(`INSERT INTO journal_entries (id, no, date, memo, status, auto, created_at) VALUES ('DRAFT2', 'D-2', '2026-03-01', 'مسودة مصطنعة', 'قيد الإنشاء', 0, '2026-03-01')`);
  expect(() => db.run(`INSERT INTO journal_lines (id, entry_id, account_code, debit_halalas, credit_halalas) VALUES ('L2', 'DRAFT2', '1100', 10.5, 0)`)).toThrow();
  db.run(`INSERT INTO journal_lines (id, entry_id, account_code, debit_halalas, credit_halalas) VALUES ('L3', 'DRAFT2', '1100', 10, 0)`);
  expect(() => db.run(`UPDATE journal_lines SET credit_halalas = 0.25, debit_halalas = 0 WHERE id = 'L3'`)).toThrow();
  db.close();
});

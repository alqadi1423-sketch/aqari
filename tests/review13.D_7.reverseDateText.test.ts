/**
 * المراجعة الشاملة 2026-11-13 · D-7 · متوسط · app/journal.tsx (حوار «عكس القيد») · بيانات مصطنعة كلها.
 *
 * الخطأ: الحوار يقول «سيُرحَّل قيد عاكس بتاريخ اليوم»، والعكس يُكتب بتاريخ القيد الأصلي (correctionDate) إلا في
 *   ربعٍ قُدِّم إقراره · فيعكس قيد مارس ظاناً أن التصحيح في نوفمبر، فتتغيّر أرقام مارس المطبوعة.
 * الصحيح: نص الحوار يحمل التاريخ الذي سيُكتب فعلاً، من الدالة نفسها التي يكتب بها العكس.
 */
import fs from 'fs';
import path from 'path';
import { memDb } from './helpers/testDb';
import { postManualEntry } from '@/domain/accounting/post';
import { reverseFromJournal, journalReversalDate } from '@/domain/accounting/journalReversal';

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');

test('D-7 تاريخ العكس المعروض هو الذي يُكتب: تاريخ الأصل في فترةٍ مفتوحة', () => {
  const db = memDb();
  const e = postManualEntry(db, { date: '2026-03-10', memo: 'قيد مصطنع D7', ackSupport: true,
    lines: [{ account: '5100', debit: 5000, credit: 0 }, { account: '3100', debit: 0, credit: 5000 }] });
  expect(e).toBeTruthy();
  const shown = journalReversalDate(db, e!.id);
  expect(shown).toBe('2026-03-10');
  const rev = reverseFromJournal(db, e!.id)!;
  const written = db.get<{ d: string }>(`SELECT date AS d FROM journal_entries WHERE id = ?`, [rev.id])!.d;
  expect(written).toBe(shown);
  db.close();
});

test('D-7 الحوار يحمل التاريخ الفعلي بنصٍّ مترجم لا «بتاريخ اليوم»', () => {
  const src = read('app', 'journal.tsx');
  expect(src).not.toMatch(/قيد عاكس بتاريخ اليوم/);
  expect(src).toMatch(/t\('journal\.reverseBody',\s*\{\s*date:\s*dfmt\(journalReversalDate\(db,\s*id\)\)/);
  const ar = JSON.parse(read('src', 'i18n', 'locales', 'ar.json'));
  const en = JSON.parse(read('src', 'i18n', 'locales', 'en.json'));
  expect(ar.journal.reverseBody).toMatch(/\{\{date\}\}/);
  expect(en.journal.reverseBody).toMatch(/\{\{date\}\}/);
});

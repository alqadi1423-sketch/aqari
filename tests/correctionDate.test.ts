/**
 * مراجعة التثبيت #29 و#34 · تاريخ قيد التصحيح وأبعاده · بيانات مصطنعة:
 * قرار المالك 2026-10-07 على #29: «تاريخ قيد التصحيح: التاريخ الأصلي، إلا إن قُدِّم إقرار فترته فتاريخ اليوم.»
 * و#34: العكس ينسخ أبعاد أصله سطراً بسطر، وتعديل المطالبة يرحّل بأبعاد عقدها الجديد.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { saveClaim, deleteClaim } from '@/domain/claims';
import { postEntry, reverseEntryById, reverseEntryBySource } from '@/domain/accounting/post';
import { repostCopy } from '@/domain/accounting/repost';
import { fileVatReturn, correctionDate, unfileVatReturn } from '@/domain/vatFilings';
import { today } from '@/domain/dates';

const entryDate = (db: ReturnType<typeof memDb>, id: string) =>
  db.get<{ date: string }>(`SELECT date FROM journal_entries WHERE id = ?`, [id])!.date;
const manual = (db: ReturnType<typeof memDb>, date: string) =>
  postEntry(db, { date, memo: 'قيد مصطنع', lines: [{ account: '1100', debit: 5000, credit: 0 }, { account: '3100', debit: 0, credit: 5000 }] })!;

test('#29 العكس بتاريخ أصله · وفي فترةٍ قُدِّم إقرارها بتاريخ اليوم · وإعادة الترحيل كذلك', () => {
  const db = memDb();
  const a = manual(db, '2026-01-10');
  expect(entryDate(db, reverseEntryById(db, a.id)!.id)).toBe('2026-01-10');
  // المصدر كذلك (كان بتاريخ اليوم دائماً)
  const b = postEntry(db, { date: '2026-02-11', memo: 'قيد مصطنع بمصدر', srcType: 'claim', srcId: 'CL-X',
    lines: [{ account: '1250', debit: 3000, credit: 0 }, { account: '4300', debit: 0, credit: 3000 }] })!;
  expect(entryDate(db, reverseEntryBySource(db, 'claim', 'CL-X')!.id)).toBe('2026-02-11');
  // الاستعادة من السلة: نسخة القيد بتاريخه
  expect(entryDate(db, repostCopy(db, b.id, 'استعادة مصطنعة')!.id)).toBe('2026-02-11');

  fileVatReturn(db, 2026, 1, '2026-04-20');
  expect(correctionDate(db, '2026-03-31')).toBe(today());
  expect(correctionDate(db, '2026-04-01')).toBe('2026-04-01');
  const c = manual(db, '2026-03-05');
  expect(entryDate(db, reverseEntryById(db, c.id)!.id)).toBe(today());
  expect(entryDate(db, repostCopy(db, c.id, 'استعادة مصطنعة')!.id)).toBe(today());
  // التاريخ الذي يختاره المستخدم (إلغاء دفعة بتاريخه) كما هو
  const d = manual(db, '2026-03-06');
  expect(entryDate(db, reverseEntryById(db, d.id, undefined, '2026-03-07')!.id)).toBe('2026-03-07');
  // التراجع عن التسجيل يعيد التاريخ الأصلي
  unfileVatReturn(db, 2026, 1);
  expect(correctionDate(db, '2026-03-31')).toBe('2026-03-31');
  db.close();
});

test('#34 العكس من المصدر ينسخ أبعاد أصله · وتعديل عقد المطالبة يرحّلها بأبعاد عقدها الجديد', () => {
  const db = memDb();
  const p1 = addProperty(db, { name: 'عقار أبعاد أول مصطنع' });
  const p2 = addProperty(db, { name: 'عقار أبعاد ثانٍ مصطنع' });
  const c1 = confirmContract(db, contractInput(addUnit(db, p1, { unit_no: 'D-1' }), { tenant: 'مستأجر أبعاد أول', idNumber: '1000000301', phone: '0500000301', depositHalalas: 0 }));
  const c2 = confirmContract(db, contractInput(addUnit(db, p2, { unit_no: 'D-2' }), { tenant: 'مستأجر أبعاد ثانٍ', idNumber: '1000000302', phone: '0500000302', depositHalalas: 0 }));
  const id = saveClaim(db, { contractId: c1, amountHalalas: 12000, reason: 'إصلاح مصطنع', date: '2026-02-10' });
  const live = () => db.all<{ contract_id: string; property_id: string }>(
    `SELECT l.contract_id, l.property_id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.src_type = 'claim' AND e.src_id = ? AND e.reversed_by IS NULL AND e.deleted_at IS NULL`, [id]);
  expect(live().every((l) => l.contract_id === c1)).toBe(true);
  // العقد وحده يتغيّر: يُعكس القيد ويُرحَّل بأبعاد العقد الجديد
  saveClaim(db, { contractId: c2, amountHalalas: 12000, reason: 'إصلاح مصطنع', date: '2026-02-10' }, id);
  expect(live().length).toBeGreaterThan(0);
  expect(live().every((l) => l.contract_id === c2 && l.property_id === p2)).toBe(true);
  // مركز تكلفة أصلٍ اختير في شاشته يُنسخ في عكسه
  db.run(`INSERT INTO cost_centers (id, name, created_at) VALUES ('CC-T', 'مركز مصطنع', '2026-01-01')`);
  db.run(`UPDATE journal_lines SET cost_center_id = 'CC-T' WHERE entry_id IN
          (SELECT id FROM journal_entries WHERE src_type = 'claim' AND src_id = ? AND reversed_by IS NULL)`, [id]);
  deleteClaim(db, id);
  const rev = db.all<{ cc: string | null; contract_id: string }>(
    `SELECT l.cost_center_id AS cc, l.contract_id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.src_type = 'claim_rev' AND e.src_id = ? ORDER BY e.created_at DESC, e.rowid DESC`, [id]);
  expect(rev.slice(0, 2).every((l) => l.cc === 'CC-T' && l.contract_id === c2)).toBe(true);
  db.close();
});

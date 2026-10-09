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
import { addBank } from './helpers/fixtures';
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { restoreFromTrash } from '@/domain/trash';
import { savePurchase, type PurchaseInput } from '@/domain/purchases';
import { recordBulkRentPayment } from '@/domain/contracts/service';
import { vatReturnData } from '@/domain/vatReturn';

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

/** صافي الدائن على حسابٍ لقيود مصدرٍ بعينه، لكل ربع (السنة-Qالربع) */
function byQuarter(db: ReturnType<typeof memDb>, srcId: string, acct: string): Record<string, number> {
  const rows = db.all<{ q: string; v: number }>(
    `SELECT substr(e.date,1,4) || '-Q' || ((CAST(substr(e.date,6,2) AS INTEGER) + 2) / 3) AS q, SUM(l.credit_halalas - l.debit_halalas) AS v
     FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.status = 'مرحّل' AND e.deleted_at IS NULL AND e.src_id = ? AND l.account_code LIKE ? GROUP BY q`, [srcId, acct]);
  const out: Record<string, number> = {};
  for (const r of rows) if (Number(r.v) !== 0) out[r.q] = Number(r.v);
  return out;
}
const qOf = (d: string) => d.slice(0, 4) + '-Q' + Math.floor((Number(d.slice(5, 7)) - 1) / 3 + 1);

test('#29 (التحقق المستقل) الإلغاء بتاريخه ثم الاسترجاع من السلة لا يشطر الفترات: النسخة بتاريخ عكسها', () => {
  const db = memDb();
  const bank = addBank(db, 'بنك تقبيل مصطنع');
  const u = addUnit(db, addProperty(db, { name: 'عقار تقبيل مصطنع' }));
  const deal = recordKeyMoneyDeal(db, { unitId: u, outgoing: 'طرف مصطنع أ', incoming: 'طرف مصطنع ب', amountHalalas: 900000,
    date: '2026-01-10', commissionHalalas: 45000, method: 'bank', bankId: bank, notes: '' });
  const e = db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'key_money' ORDER BY created_at DESC, rowid DESC LIMIT 1`)!.id;
  const a = entrySourceAction(db, e);
  if (a?.kind !== 'op') throw new Error('op');
  a.run('2026-05-10', 'سبب مصطنع');
  restoreFromTrash(db, 'key_money_deals', deal);
  expect(byQuarter(db, deal, '4300')).toEqual({ '2026-Q1': 45000 });
  db.close();
});

test('#29 (التحقق المستقل) تعديل مستندٍ في فترةٍ قُدِّم إقرارها: العكس والترحيل الجديد كلاهما بتاريخ اليوم', () => {
  const db = memDb();
  const c = confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار مطالبة مصطنع' })),
    { tenant: 'مستأجر مطالبة مصطنع', idNumber: '1000000901', phone: '0500000901', depositHalalas: 0 }));
  const id = saveClaim(db, { contractId: c, amountHalalas: 12000, reason: 'سبب مصطنع', date: '2026-02-10' });
  const pid = savePurchase(db, {
    supplier: 'مورد مصطنع', date: '2026-02-11', due: '2026-03-11', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: true, subtotalHalalas: 20000, taxHalalas: 0, totalHalalas: 20000,
  } as PurchaseInput);
  fileVatReturn(db, 2026, 1, '2026-04-20');
  saveClaim(db, { contractId: c, amountHalalas: 15000, reason: 'سبب مصطنع', date: '2026-02-10' }, id);
  expect(byQuarter(db, id, '4300')).toEqual({ '2026-Q1': 12000, [qOf(today())]: 3000 });
  // فاتورة الشراء في فترةٍ قُدِّم إقرارها مقفلة (قرار المالك 2026-10-09: «تُقفل، والتصحيح بقيد في فترة مفتوحة»)
  expect(() => savePurchase(db, {
    supplier: 'مورد مصطنع', date: '2026-02-11', due: '2026-03-11', category: 'صيانة', incorpItem: '', amortize: false,
    amortizeMonths: null, exempt: false, excludeFromVat: true, subtotalHalalas: 26000, taxHalalas: 0, totalHalalas: 26000,
  } as PurchaseInput, pid)).toThrow();
  expect(byQuarter(db, pid, '2100')).toEqual({ '2026-Q1': 20000 });
  db.close();
});

test('#31 (التحقق المستقل) كشف المبيعات المعفاة يساوي البند ٥ · والفائض المسوّى رصيداً بعدها يخرج منه', () => {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار إقرار مصطنع' }), { unit_no: 'V-9' });
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر إقرار مصطنع', idNumber: '1000000991', phone: '0500000991',
    start: '2026-01-01', depositHalalas: 0 }));
  const insts = db.all<{ id: string; amount_halalas: number }>(
    `SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 2`, [cid]);
  const due = insts.reduce((s, i) => s + Number(i.amount_halalas), 0);
  recordBulkRentPayment(db, cid, { installmentIds: insts.map((i) => i.id), date: '2026-01-05',
    lines: [{ method: 'cash', amountHalalas: due + 30000 }], notes: '' });
  const five = (d: ReturnType<typeof vatReturnData>) => d.items.find((x) => x.no === '5')!.amountHalalas;
  let d = vatReturnData(db, 2026, 1);
  expect(d.schedules.exemptSales.reduce((s, r) => s + Number(r.net), 0)).toBe(five(d));
  expect(five(d)).toBe(due);
  // فائضٌ قديم دخل إيراداً ثم سُوّي رصيداً للمستأجر: يخرج من البند ٥ في فترة تسويته
  postEntry(db, { date: '2026-02-03', memo: 'فائض مصطنع رصيداً', srcType: 'surplus_credit', srcId: cid,
    lines: [{ account: '4200', debit: 10000, credit: 0 }, { account: '2410', debit: 0, credit: 10000 }] });
  d = vatReturnData(db, 2026, 1);
  expect(five(d)).toBe(due - 10000);
  expect(d.schedules.exemptSales.reduce((s, r) => s + Number(r.net), 0)).toBe(five(d));
  db.close();
});


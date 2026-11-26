/**
 * كشف البنك (التوجيه الرابع ٦ · ٢): الحفظ ومنع التكرار والربط المحفوظ، والمطابقة المقترحة بدرجة ثقة واعتمادها بموافقة، وتقرير المطابقة
 * لكل بنك وشهر بالفروق · بالأرقام الذهبية (القاعدة ١٠٠) · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { depositCashToBank, ownerCashIn, recordManualBankTx } from '@/domain/cashOps';
import { readStatementGrid } from '@/domain/bankStatement/read';
import {
  saveStatement, statementMapping, matchSuggestions, approveMatch, unmatchLine, excludeLine, reconciliation, StatementDuplicate,
} from '@/domain/bankStatement/store';

const grid = (rows: string[][]) => [['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'], ...rows];
const OCT = grid([
  ['2026/10/02', 'إيداع نقدي مصطنع', '', '5,000.00', '5,000.00'],
  ['2026/10/05', 'رسوم خدمة مصطنعة', '15.00', '', '4,985.00'],
  ['2026/10/20', 'حوالة واردة من مستأجر مصطنع', '', '2,000.00', '6,985.00'],
  ['2026/10/28', 'سحب صراف مصطنع', '500.00', '', '6,485.00'],
]);
const read = (rows: string[][], opening = 0) => {
  const r = readStatementGrid([['الرصيد الافتتاحي', (opening / 100).toFixed(2)], ...rows]);
  if (!r.ok) throw new Error(r.error);
  return r;
};

function setup() {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع للكشف', 0);
  ownerCashIn(db, { amountHalalas: 1000000, date: '2026-10-01' });
  // حركات التطبيق: إيداعٌ في اليوم نفسه، ورسومٌ بعده بيوم، ووارد بلا قيدٍ مقابل في الكشف (يبقى في الدفاتر وحدها)
  depositCashToBank(db, { bankId: bank, amountHalalas: 500000, date: '2026-10-02' });
  recordManualBankTx(db, { kind: 'fee', bankId: bank, amountHalalas: 1500, date: '2026-10-06', descr: 'رسوم مصطنعة' });
  recordManualBankTx(db, { kind: 'income', bankId: bank, amountHalalas: 30000, date: '2026-10-25', descr: 'عائد مصطنع' });
  return { db, bank };
}

describe('الحفظ ومنع التكرار', () => {
  test('الكشف يُحفظ بسطوره، والملف نفسه لا يُحفظ مرتين، والكشف المتداخل لا يضيف ما سبق', () => {
    const { db, bank } = setup();
    const first = saveStatement(db, bank, read(OCT), { name: 'oct.pdf', hash: 'h-oct' });
    expect(first).toMatchObject({ added: 4, skipped: 0 });
    expect(() => saveStatement(db, bank, read(OCT), { name: 'oct-again.pdf', hash: 'h-oct' })).toThrow(StatementDuplicate);
    // كشفٌ من 20 أكتوبر إلى 3 نوفمبر: سطران من أكتوبر مكرران وسطرٌ جديد
    const over = read([...OCT.slice(0, 1), ...OCT.slice(3), ['2026/11/03', 'رسوم مصطنعة', '5.00', '', '6,480.00']], 498500);
    const second = saveStatement(db, bank, over, { name: 'nov.pdf', hash: 'h-nov' });
    expect(second).toMatchObject({ added: 1, skipped: 2 });
    expect(Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_statement_lines WHERE bank_id = ? AND deleted_at IS NULL`, [bank])!.n)).toBe(5);
  });

  test('الربط يُحفظ مع البنك ويُعاد في الكشف التالي', () => {
    const { db, bank } = setup();
    const r = read(OCT);
    saveStatement(db, bank, r, { name: 'oct.pdf', hash: 'h1' });
    expect(statementMapping(db, bank)).toEqual(r.mapping);
  });
});

describe('المطابقة المقترحة بدرجة ثقة، واعتمادها بموافقة', () => {
  test('الإيداع في يومه جاهزٌ للاعتماد، والرسوم بعد يومٍ تحتاج مراجعة، وما لا مقابل له لا يُقترح', () => {
    const { db, bank } = setup();
    saveStatement(db, bank, read(OCT), { name: 'oct.pdf', hash: 'h1' });
    const s = matchSuggestions(db, bank);
    const byDescr = (d: string) => s.find((x) => x.line.descr.includes(d));
    expect(byDescr('إيداع نقدي')).toMatchObject({ level: 'ready' });
    expect(byDescr('إيداع نقدي')!.score).toBeGreaterThanOrEqual(85);
    expect(byDescr('رسوم خدمة')).toMatchObject({ level: 'review' });
    expect(byDescr('حوالة واردة')).toBeUndefined();
    expect(byDescr('سحب صراف')).toBeUndefined();
  });

  test('الاعتماد يربط السطر بحركته، والحركة لا تُعتمد لسطرين، والإلغاء يعيده، والاستبعاد بسببٍ مكتوب', () => {
    const { db, bank } = setup();
    saveStatement(db, bank, read(OCT), { name: 'oct.pdf', hash: 'h1' });
    const [sug] = matchSuggestions(db, bank).filter((x) => x.level === 'ready');
    approveMatch(db, sug.line.id, sug.tx.id);
    expect(db.get(`SELECT status, bank_tx_id FROM bank_statement_lines WHERE id = ?`, [sug.line.id])).toEqual({ status: 'matched', bank_tx_id: sug.tx.id });
    const other = db.get<{ id: string }>(`SELECT id FROM bank_statement_lines WHERE status = 'open' LIMIT 1`)!.id;
    expect(() => approveMatch(db, other, sug.tx.id)).toThrow();
    expect(matchSuggestions(db, bank).some((x) => x.tx.id === sug.tx.id)).toBe(false);
    unmatchLine(db, sug.line.id);
    expect(db.get(`SELECT status, bank_tx_id FROM bank_statement_lines WHERE id = ?`, [sug.line.id])).toEqual({ status: 'open', bank_tx_id: null });
    expect(() => excludeLine(db, other, '  ')).toThrow();
    excludeLine(db, other, 'سطرٌ مكرر من البنك');
    expect(db.get(`SELECT status, note FROM bank_statement_lines WHERE id = ?`, [other])).toEqual({ status: 'excluded', note: 'سطرٌ مكرر من البنك' });
  });
});

describe('تقرير المطابقة لكل بنك وشهر بالفروق', () => {
  test('أكتوبر: الافتتاحي والختامي من الكشف ومن الدفاتر، والفروق في الطرفين', () => {
    const { db, bank } = setup();
    saveStatement(db, bank, read(OCT), { name: 'oct.pdf', hash: 'h1' });
    for (const s of matchSuggestions(db, bank)) approveMatch(db, s.line.id, s.tx.id);
    const rep = reconciliation(db, bank, '2026-10');
    expect(rep).toMatchObject({
      month: '2026-10', statementOpening: 0, statementClosing: 648500, booksClosing: 528500,
      matched: 2, covered: true,
    });
    // في الكشف لا في الدفاتر: الحوالة والسحب · وفي الدفاتر لا في الكشف: العائد
    expect(rep.onlyInStatement.map((l) => l.amount)).toEqual([200000, -50000]);
    expect(rep.onlyInBooks.map((t) => t.amount)).toEqual([30000]);
    // الفرق مفسَّرٌ كله: ختامي الكشف − الدفاتر = ما في الكشف وحده − ما في الدفاتر وحدها
    expect(rep.statementClosing! - rep.booksClosing).toBe(rep.onlyInStatement.reduce((s, l) => s + l.amount, 0) - rep.onlyInBooks.reduce((s, t) => s + t.amount, 0));
    expect(rep.unexplained).toBe(0);
  });

  test('شهرٌ لا يغطيه كشف، وفجوةٌ بين كشفين (ختامي السابق لا يساوي افتتاحي اللاحق)', () => {
    const { db, bank } = setup();
    saveStatement(db, bank, read(OCT), { name: 'oct.pdf', hash: 'h1' });
    expect(reconciliation(db, bank, '2026-09')).toMatchObject({ covered: false });
    saveStatement(db, bank, read(grid([['2026/11/10', 'رسوم', '5.00', '', '6,000.00']]), 600500), { name: 'nov.pdf', hash: 'h2' });
    expect(reconciliation(db, bank, '2026-11').gaps).toEqual([{ after: '2026-10-28', closing: 648500, nextOpening: 600500 }]);
  });
});

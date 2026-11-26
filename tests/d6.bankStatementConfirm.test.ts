/**
 * قرارا المالك 2026-10-09 في كشف البنك (المدقق الخارجي U٩ وU): «المستخدم يؤكد أو يصحح التخمين أول مرة، ويُحفظ الربط باسم البنك»، و«فحص
 * الكشف: الافتتاحي مع الحركات يساوي الختامي، وإلا يُنبَّه ولا تبدأ المطابقة إلا بتأكيد» · بياناتٌ مصطنعة.
 *   TZ=Asia/Riyadh npx jest tests/d6.bankStatementConfirm.test.ts
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { readStatementGrid, unverifiedResult, type ColumnMapping } from '@/domain/bankStatement/read';
import { saveStatement, statementMapping, reconciliation, matchSuggestions } from '@/domain/bankStatement/store';
import { ownerCashIn, depositCashToBank } from '@/domain/cashOps';

const amounts = (r: ReturnType<typeof readStatementGrid>) => (r.ok ? r.lines.map((l) => l.amount) : r.error);

describe('أعمدةٌ يؤكدها المستخدم أو يصححها', () => {
  test('القراءة تحمل نصوص صف العناوين بأدوارها المخمَّنة، فتعرضها الشاشة', () => {
    const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'], ['2026/10/01', 'إيداع مصطنع', '', '100.00', '100.00']]);
    expect(r.ok && [r.mapping.labels, r.mapping.roles]).toEqual([['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'], ['date', 'descr', 'debit', 'credit', 'balance']]);
  });

  test('عناوين لا يعرفها القاموس: يُعرض صفّها المرجَّح بلا أدوار، وبالأدوار التي يحددها المستخدم يُقرأ ويُحفظ الربط مع الكشف', () => {
    const grid = [
      ['كشف حساب مصطنع'],
      ['الرصيد الافتتاحي', '1,000.00'],
      ['اليوم', 'الشرح', 'القيمة', 'المتبقي'],
      ['2026/10/02', 'حوالة مصطنعة', '250.00', '1,250.00'],
      ['2026/10/03', 'رسوم مصطنعة', '10.00', '1,240.00'],
    ];
    const first = readStatementGrid(grid);
    expect(first).toMatchObject({ ok: false, error: 'columns' });
    const guess = !first.ok ? first.partial?.mapping : undefined;
    expect(guess?.labels).toEqual(['اليوم', 'الشرح', 'القيمة', 'المتبقي']);
    const mapping: ColumnMapping = { ...guess!, roles: ['date', 'descr', 'amount', 'balance'] };
    const r = readStatementGrid(grid, { mapping });
    expect(amounts(r)).toEqual([25000, -1000]);
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع للربط', 0);
    if (!r.ok) throw new Error(r.error);
    saveStatement(db, bank, r, { name: 'mapped.csv', hash: 'map-1' });
    // والكشف التالي بالشكل نفسه يُقرأ بالربط المحفوظ بلا سؤال
    const saved = statementMapping(db, bank);
    expect(saved?.roles).toEqual(['date', 'descr', 'amount', 'balance']);
    expect(amounts(readStatementGrid([...grid.slice(0, 3), ['2026/11/01', 'حوالة مصطنعة', '5.00', '1,005.00']], { mapping: saved! }))).toEqual([500]);
    db.close();
  });

  test('تصحيح عمودين تبادلا (المدين والدائن) يُعيد القراءة بهما', () => {
    const grid = [['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'دائن', 'مدين', 'الرصيد'],
      ['2026/10/01', 'إيداع مصطنع', '', '100.00', '100.00']];
    // الكشف يطبع «دائن» فوق عمود المدين خطأً: التخمين يرفضه، وتصحيح المستخدم يقرؤه
    expect(readStatementGrid(grid)).toMatchObject({ ok: false, error: 'balance' });
    const g = readStatementGrid([['التاريخ', 'البيان', 'دائن', 'مدين', 'الرصيد']]);
    expect(g.ok).toBe(false);
    const base: ColumnMapping = { headerKey: 'التاريخ|البيان|دائن|مدين|الرصيد', roles: ['date', 'descr', 'debit', 'credit', 'balance'], dateOrder: 'dmy', signMode: 'split' };
    expect(amounts(readStatementGrid(grid, { mapping: base }))).toEqual([10000]);
  });
});

describe('الكشف الذي لا يثبت فحصه: يُنبَّه، ويُحفظ «غير متحقَّق» بتأكيدٍ صريح', () => {
  // ختاميٌّ مطبوع يخالف الحركات بخمسين
  const grid = [['الرصيد الافتتاحي', '1,000.00'], ['الرصيد الختامي', '1,350.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/05', 'إيداع مصطنع', '', '500.00', ''], ['2026/10/06', 'رسوم مصطنعة', '200.00', '', '']];

  test('الرفض يحمل السطور بإشاراتها، وunverifiedResult يجعلها قراءةً «غير متحقَّقة» بختاميٍّ من مجموعها', () => {
    const r = readStatementGrid(grid);
    expect(r).toMatchObject({ ok: false, error: 'balance' });
    const u = unverifiedResult(!r.ok ? r.partial : undefined);
    expect(u && [u.lines.map((l) => l.amount), u.opening, u.closing, u.warnings]).toEqual([[50000, -20000], 100000, 130000, ['unverified']]);
  });

  test('وما جُهلت إشارته (مبلغٌ واحد بلا علامة وأرصدةٌ لا تتسلسل) لا يُحفظ', () => {
    const r = readStatementGrid([['الرصيد الافتتاحي', '1,000.00'], ['التاريخ', 'البيان', 'المبلغ', 'الرصيد'],
      ['2026/10/05', 'حركة مصطنعة', '500.00', '1,600.00']]);
    expect(r).toMatchObject({ ok: false, error: 'balance' });
    expect(unverifiedResult(!r.ok ? r.partial : undefined)).toBeNull();
  });

  test('المحفوظ بتأكيدٍ يُعلَّم غير متحقَّق، وتقرير الشهر ينبّه به، والمطابقة تبدأ', () => {
    const db = memDb();
    const bank = addBank(db, 'بنك مصطنع غير متحقق', 0);
    ownerCashIn(db, { amountHalalas: 1000000, date: '2026-09-01' });
    depositCashToBank(db, { bankId: bank, amountHalalas: 50000, date: '2026-10-05', notes: 'إيداع مصطنع' });
    const r = readStatementGrid(grid);
    const u = unverifiedResult(!r.ok ? r.partial : undefined)!;
    saveStatement(db, bank, u, { name: 'loose.csv', hash: 'loose-1' });
    expect(db.get<{ v: number }>(`SELECT verified AS v FROM bank_statements WHERE bank_id = ?`, [bank])!.v).toBe(0);
    expect(reconciliation(db, bank, '2026-10').unverified).toBe(true);
    expect(matchSuggestions(db, bank).map((s) => s.line.amount)).toEqual([50000]);
    // وكشفٌ متحقَّق لا يُنبَّه به
    const ok = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'], ['2026/11/01', 'إيداع مصطنع', '', '1.00', '1.00']]);
    if (!ok.ok) throw new Error(ok.error);
    saveStatement(db, bank, ok, { name: 'nov.csv', hash: 'nov-1' });
    expect(reconciliation(db, bank, '2026-11').unverified).toBe(false);
    db.close();
  });
});

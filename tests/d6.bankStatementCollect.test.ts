/**
 * كشف البنك · مطابقة الإيداع بالقسط والمطالبة والفاتورة (قرار المالك 2026-10-09 «أولاً» ج.١ وج.٢ وج.٥ وج.٧): لكل إيداعٍ لا حركة له في
 * الدفاتر اقتراحٌ مقابل قسطٍ مستحق أو أقساطٍ متتالية لعقدٍ واحد أو مطالبةٍ مفتوحة أو فاتورةٍ مستحقة بدرجة ثقة وسبب، والاعتماد يسجّل التحصيل
 * بمساره المعتاد في بنك الكشف ثم يطابق السطر بحركته، وكل اعتمادٍ سطرٌ في سجل العمليات · أرقامٌ ذهبية بالهللة · بياناتٌ مصطنعة.
 *   TZ=Asia/Riyadh npx jest tests/d6.bankStatementCollect.test.ts
 */
import { memDb } from './helpers/testDb';
import { addBank, addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { saveClaim } from '@/domain/claims';
import { saveInvoice } from '@/domain/invoices';
import { depositCashToBank, ownerCashIn } from '@/domain/cashOps';
import { bankBalance } from '@/domain/accounting/ledger';
import { readStatementGrid } from '@/domain/bankStatement/read';
import { saveStatement, matchSuggestions, approveMatch, reconciliation } from '@/domain/bankStatement/store';
import { collectionSuggestions, approveCollection, collectPermission } from '@/domain/bankStatement/collect';
import type { DB } from '@/db/adapter';

function setup() {
  const db = memDb();
  const bank = addBank(db, 'بنك مصطنع للتحصيل', 0);
  const p = addProperty(db, { name: 'عقار مصطنع للتحصيل' });
  const c1 = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'C-1' }), {
    tenant: 'سالم المصطنع', idNumber: '1000000201', phone: '0500000201', valueHalalas: 1200000, cycle: 'شهرية', start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const c2 = confirmContract(db, contractInput(addUnit(db, p, { unit_no: 'C-2' }), {
    tenant: 'فهد المصطنع', idNumber: '1000000202', phone: '0500000202', valueHalalas: 2400000, cycle: 'شهرية', start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
  }));
  const claim = saveClaim(db, { contractId: c1, amountHalalas: 35000, reason: 'إصلاح مصطنع', date: '2026-10-05' });
  const invoice = saveInvoice(db, { customer: 'نجم المصطنع', customerVat: '', issue: '2026-10-01', due: '2026-10-15', notes: '',
    lines: [{ descr: 'خدمة مصطنعة', qty: 1, priceHalalas: 50000, taxPct: 15 }] }, 'مستحقة');
  // وإيداعٌ مسجّلٌ في الدفاتر قبل الكشف: سطره يطابق حركته لا تحصيلاً جديداً
  ownerCashIn(db, { amountHalalas: 50000, date: '2026-10-01' });
  depositCashToBank(db, { bankId: bank, amountHalalas: 50000, date: '2026-10-20', notes: 'إيداع مصطنع' });
  const invNo = db.get<{ no: string }>(`SELECT no FROM invoices WHERE id = ?`, [invoice])!.no;
  const r = readStatementGrid([
    ['الرصيد الافتتاحي', '0.00'],
    ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
    ['2026/10/02', 'حوالة واردة سالم', '', '1,000.00', '1,000.00'],
    ['2026/10/03', 'حوالة واردة فهد', '', '4,000.00', '5,000.00'],
    ['2026/10/10', 'تحويل وارد', '', '350.00', '5,350.00'],
    ['2026/10/12', 'سداد فاتورة ' + invNo, '', '575.00', '5,925.00'],
    ['2026/10/15', 'إيداع مجهول', '', '777.00', '6,702.00'],
    ['2026/10/20', 'إيداع نقدي', '', '500.00', '7,202.00'],
  ]);
  if (!r.ok) throw new Error(r.error);
  saveStatement(db, bank, r, { name: 'oct-collect.csv', hash: 'collect-1' });
  const line = (descr: string) => db.get<{ id: string }>(`SELECT id FROM bank_statement_lines WHERE descr = ?`, [descr])!.id;
  const insts = (c: string) => db.all<{ id: string; paid: number; due: string }>(
    `SELECT id, paid_halalas AS paid, due_date AS due FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [c]);
  return { db, bank, c1, c2, claim, invoice, invNo, line, insts };
}

const byLine = (db: DB, bank: string) => new Map(collectionSuggestions(db, bank).map((s) => [s.line.descr, s]));

describe('اقتراحات التحصيل للإيداع الذي لا حركة له', () => {
  test('القسط باسم المستأجر جاهز، وقسطان متتاليان بتحويلٍ واحد، والمطالبة والفاتورة بسببهما، والمجهول والمسجَّل لا يُقترح لهما', () => {
    const s = setup();
    const m = byLine(s.db, s.bank);
    const one = m.get('حوالة واردة سالم')!;
    expect(one.target).toEqual({ kind: 'installments', contractId: s.c1, installmentIds: [s.insts(s.c1)[0].id] });
    expect([one.level, one.reasons]).toEqual(['ready', ['amount', 'date', 'name', 'unique']]);
    const two = m.get('حوالة واردة فهد')!;
    expect(two.target).toEqual({ kind: 'installments', contractId: s.c2, installmentIds: s.insts(s.c2).slice(0, 2).map((i) => i.id) });
    expect(two.reasons).toContain('several');
    expect(m.get('تحويل وارد')!.target).toEqual({ kind: 'claim', claimId: s.claim });
    expect(m.get('تحويل وارد')!.level).toBe('review');
    const inv = m.get('سداد فاتورة ' + s.invNo)!;
    expect([inv.target, inv.reasons.includes('ref')]).toEqual([{ kind: 'invoice', invoiceId: s.invoice }, true]);
    expect(m.has('إيداع مجهول')).toBe(false);
    // سطر الإيداع النقدي له حركته في الدفاتر: يُقترح لها لا تحصيلاً
    expect(m.has('إيداع نقدي')).toBe(false);
    expect(matchSuggestions(s.db, s.bank).map((x) => x.line.descr)).toEqual(['إيداع نقدي']);
    s.db.close();
  });

  test('والسحب لا يُقترح له تحصيل، والقسط المسدَّد لا يُقترح', () => {
    const s = setup();
    approveCollection(s.db, s.line('حوالة واردة سالم'), byLine(s.db, s.bank).get('حوالة واردة سالم')!.target);
    expect([...byLine(s.db, s.bank).keys()].sort()).toEqual(['تحويل وارد', 'حوالة واردة فهد', 'سداد فاتورة ' + s.invNo].sort());
    s.db.close();
  });
});

describe('الاعتماد: التحصيل بمساره المعتاد في بنك الكشف، ثم المطابقة', () => {
  test('الأرقام الذهبية: الأقساط والمطالبة والفاتورة مسدَّدة، ورصيد البنك = الكشف، وما بقي في الكشف وحده المجهول', () => {
    const s = setup();
    for (const sg of collectionSuggestions(s.db, s.bank)) approveCollection(s.db, sg.line.id, sg.target);
    for (const sg of matchSuggestions(s.db, s.bank)) approveMatch(s.db, sg.line.id, sg.tx.id);
    const c1 = s.insts(s.c1);
    const c2 = s.insts(s.c2);
    expect([c1[0].paid, c1[1].paid, c2[0].paid, c2[1].paid, c2[2].paid]).toEqual([100000, 0, 200000, 200000, 0]);
    expect(s.db.get<{ s: string }>(`SELECT status AS s FROM claims WHERE id = ?`, [s.claim])!.s).toBe('محصَّلة');
    expect(s.db.get(`SELECT status, payment_method AS m, payment_bank_id AS b FROM invoices WHERE id = ?`, [s.invoice]))
      .toEqual({ status: 'مدفوعة', m: 'bank', b: s.bank });
    // 100,000 + 400,000 + 35,000 + 57,500 + 50,000 (الإيداع المسجَّل)
    expect(bankBalance(s.db, s.bank)).toBe(642500);
    const rep = reconciliation(s.db, s.bank, '2026-10');
    expect(rep.matched).toBe(5);
    expect(rep.onlyInStatement.map((l) => l.amount)).toEqual([77700]);
    // والإيداع النقدي يُطابَق بحركته فيصير الفرق المجهولَ وحده
    expect(rep.unexplained).toBe(0);
    s.db.close();
  });

  test('كل اعتمادٍ سطرٌ في سجل العمليات، والسطر مطابَقٌ بحركة التحصيل في بنكه', () => {
    const s = setup();
    const sg = byLine(s.db, s.bank).get('تحويل وارد')!;
    approveCollection(s.db, sg.line.id, sg.target);
    const l = s.db.get<{ status: string; tx: string }>(`SELECT status, bank_tx_id AS tx FROM bank_statement_lines WHERE id = ?`, [sg.line.id])!;
    expect(l.status).toBe('matched');
    expect(s.db.get(`SELECT bank_id AS b, amount_halalas AS a FROM bank_tx WHERE id = ?`, [l.tx])).toEqual({ b: s.bank, a: 35000 });
    expect(s.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'اعتماد تحصيلٍ من كشف البنك'`)!.n).toBe(1);
    s.db.close();
  });

  test('ما لا يصحّ يُرفض ولا يمسّ شيئاً: المبلغ يخالف المتبقي، والسطر مطابَق، والسحب', () => {
    const s = setup();
    const before = bankBalance(s.db, s.bank);
    // سطر 777 على قسط 1,000
    expect(() => approveCollection(s.db, s.line('إيداع مجهول'), { kind: 'installments', contractId: s.c1, installmentIds: [s.insts(s.c1)[0].id] })).toThrow();
    const sg = byLine(s.db, s.bank).get('حوالة واردة سالم')!;
    approveCollection(s.db, sg.line.id, sg.target);
    expect(() => approveCollection(s.db, sg.line.id, { kind: 'claim', claimId: s.claim })).toThrow();
    expect(bankBalance(s.db, s.bank)).toBe(before + 100000);
    expect(s.db.get<{ s: string }>(`SELECT status AS s FROM claims WHERE id = ?`, [s.claim])!.s).toBe('مفتوحة');
    s.db.close();
  });
});

describe('المزامنة: التحصيل المعتمد من الكشف على جهاز العضو يقبله جهاز المالك', () => {
  test('مطالبةٌ تُحصَّل في البنك وقسطٌ يُسدَّد بتحويل: القيود والحركات وسطور الكشف تصل كما هي، ورصيد البنك واحدٌ في الجهازين', async () => {
    const { pair, sync, ownerPulls, MEMBER } = await import('./helpers/rederive');
    const p = await pair();
    const bank = addBank(p.owner, 'بنك مصطنع للمزامنة', 0);
    const prop = addProperty(p.owner, { name: 'عقار مصطنع للمزامنة' });
    const c = confirmContract(p.owner, contractInput(addUnit(p.owner, prop, { unit_no: 'S-1' }), {
      tenant: 'ماجد المصطنع', idNumber: '1000000211', phone: '0500000211', valueHalalas: 1200000, cycle: 'شهرية', start: '2026-10-01', end: '2027-09-30', depositHalalas: 0,
    }));
    const claim = saveClaim(p.owner, { contractId: c, amountHalalas: 35000, reason: 'إصلاح مصطنع', date: '2026-10-05' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    const r = readStatementGrid([['الرصيد الافتتاحي', '0.00'], ['التاريخ', 'البيان', 'مدين', 'دائن', 'الرصيد'],
      ['2026/10/02', 'حوالة ماجد', '', '1,000.00', '1,000.00'], ['2026/10/10', 'تحويل ماجد', '', '350.00', '1,350.00']]);
    if (!r.ok) throw new Error(r.error);
    saveStatement(p.dev, bank, r, { name: 'sync-collect.csv', hash: 'sync-collect' });
    for (const sg of collectionSuggestions(p.dev, bank)) approveCollection(p.dev, sg.line.id, sg.target);
    await sync(p.dev, p.r);
    // كل ما كتبه الجهاز الثاني بكاتبه العضو
    for (const d of [...p.r.docs.values()]) if (d.dev && d.dev !== 'owner' && d.u && d.u > '2026-11-07') p.r.inject({ ...d, by: MEMBER });
    await ownerPulls(p.owner, p.r);
    expect(p.owner.get<{ s: string }>(`SELECT status AS s FROM claims WHERE id = ?`, [claim])!.s).toBe('محصَّلة');
    expect([bankBalance(p.owner, bank), bankBalance(p.dev, bank)]).toEqual([135000, 135000]);
    expect(p.owner.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_statement_lines WHERE bank_id = ? AND status = 'matched'`, [bank])!.n).toBe(2);
    expect(p.owner.all(`SELECT reason FROM sync_rejects`)).toEqual([]);
    p.close();
  });
});

test('W٢ · صلاحية الاعتماد كشاشة الهدف وقاعدة السحابة: القسط «إدخال» في التحصيل، والمطالبة والفاتورة «كامل» في قسمهما', () => {
  expect([
    collectPermission({ kind: 'installments', contractId: 'c', installmentIds: ['i'] }),
    collectPermission({ kind: 'claim', claimId: 'x' }),
    collectPermission({ kind: 'invoice', invoiceId: 'v' }),
  ]).toEqual([{ section: 'collect', level: 2 }, { section: 'claims', level: 3 }, { section: 'invoices', level: 3 }]);
});

test('W١ · المعرّفات الحتمية: سطرٌ أُلغيت مطابقته ودفعته ثم اعتُمد ثانيةً يأخذ معرّفاتٍ جديدة (رقم الاعتماد) ولا يصطدم بالأولى', async () => {
  const { unmatchLine } = await import('@/domain/bankStatement/store');
  const { cancelPayment } = await import('@/domain/contracts/cancelPayment');
  const s = setup();
  const sg = byLine(s.db, s.bank).get('حوالة واردة سالم')!;
  approveCollection(s.db, sg.line.id, sg.target);
  const first = s.db.get<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ?`, [s.c1])!.id;
  unmatchLine(s.db, sg.line.id);
  cancelPayment(s.db, first, { reason: 'إلغاء مصطنع', date: '2026-10-02' });
  approveCollection(s.db, sg.line.id, sg.target);
  const live = s.db.all<{ id: string }>(`SELECT id FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL`, [s.c1]);
  expect(live.length).toBe(1);
  expect(live[0].id).not.toBe(first);
  expect(s.insts(s.c1)[0].paid).toBe(100000);
  s.db.close();
});

/**
 * كل قيد تلقائي يُلغى من عمليته الأصلية (sourceCancel.ts) · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment, RuleViolation } from '@/domain/contracts/service';
import { entrySourceAction } from '@/domain/accounting/sourceCancel';
import { postEntry } from '@/domain/accounting/post';
import { accountBalance, walletCashBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { semanticIssues } from '@/domain/backup/semantic';
import { ownerCashIn, pettyCashExpense } from '@/domain/cashOps';
import { recordKeyMoneyDeal } from '@/domain/keymoney';
import { bookDiscount, contractSurpluses, settleSurplus } from '@/domain/ledgerReview';
import { DISCOUNT_AFTER_DUE } from '@/domain/contracts/installments';
import type { DB } from '@/db/adapter';

const lastEntry = (db: DB, src: string) => db.get<{ id: string }>(
  `SELECT id FROM journal_entries WHERE src_type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, [src])!.id;
const healthy = (db: DB) => {
  expect(semanticIssues(db)).toEqual([]);
  for (const c of integrityChecks(db)) expect(`${c.name}: ${c.ok}`).toBe(`${c.name}: true`);
};
function contract(db: DB) {
  const u = addUnit(db, addProperty(db), { rent: 100000 });
  const cid = confirmContract(db, contractInput(u, { valueHalalas: 1200000, depositHalalas: 0 }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]).map((r) => r.id);
  return { cid, insts };
}

test('قيد دفعة ← إلغاء الدفعة · والقيد اليدوي لا مصدر له · ومرآة القيد لا تُلغى', () => {
  const db = memDb();
  const k = contract(db);
  const p = recordRentPayment(db, k.cid, { installmentId: k.insts[0], period: 'م', date: '2026-01-05', notes: '', discountHalalas: 0,
    lines: [{ method: 'cash', amountHalalas: 100000 }] });
  const e = db.get<{ e: string }>(`SELECT journal_entry_id AS e FROM contract_payments WHERE id = ?`, [p])!.e;
  expect(entrySourceAction(db, e)).toEqual({ kind: 'payment', paymentId: p });
  const manual = postEntry(db, { date: '2026-01-01', memo: 'يدوي', auto: false, lines: [{ account: '1100', debit: 500, credit: 0 }, { account: '3100', debit: 0, credit: 500 }] })!;
  expect(entrySourceAction(db, manual.id)).toBeNull();
  db.close();
});

test('مصروف نثري ← إلغاء العملية · وإيداع المالك لا يُعكس بما ليس في المحفظة', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 50000, date: '2026-01-01' });
  pettyCashExpense(db, { amountHalalas: 10000, descr: 'قرطاسية', date: '2026-01-02' });
  const petty = entrySourceAction(db, lastEntry(db, 'cash_op'));
  expect(petty?.kind).toBe('op');
  if (petty?.kind !== 'op') return;
  expect(() => petty.run('2026-01-03', '')).toThrow(RuleViolation);
  petty.run('2026-01-03', 'سُجّل خطأً');
  expect(walletCashBalance(db)).toBe(50000);
  // الإيداع بعد صرف المحفظة كلها · عكسه ممنوع بسببه
  pettyCashExpense(db, { amountHalalas: 50000, descr: 'صيانة', date: '2026-01-04' });
  const deposit = db.all<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = 'cash_op' AND reversed_by IS NULL ORDER BY rowid`)[0].id;
  const a = entrySourceAction(db, deposit);
  expect(a?.kind === 'op' && a.blockers.join(' ')).toContain('لا يكفي');
  healthy(db);
  db.close();
});

test('عمولة تقبيل بنكية ← إلغاء التقبيل: القيد والبنك يُعكسان والصفقة في السلة', () => {
  const db = memDb();
  const bank = addBank(db);
  const u = addUnit(db, addProperty(db));
  const deal = recordKeyMoneyDeal(db, { unitId: u, outgoing: 'طرف أ', incoming: 'طرف ب', amountHalalas: 900000, date: '2026-01-01',
    commissionHalalas: 45000, method: 'bank', bankId: bank, notes: '' });
  const a = entrySourceAction(db, lastEntry(db, 'key_money'));
  if (a?.kind !== 'op') throw new Error('op');
  a.run('2026-01-10', 'أُلغيت الصفقة');
  expect(accountBalance(db, '4300')).toBe(0);
  expect(Number(db.get<{ s: number }>(`SELECT SUM(amount_halalas) AS s FROM bank_tx WHERE bank_id = ?`, [bank])!.s)).toBe(0);
  expect(db.get<{ d: string | null }>(`SELECT deleted_at AS d FROM key_money_deals WHERE id = ?`, [deal])!.d).toBeTruthy();
  healthy(db);
  db.close();
});

test('قيد خصم حُجز بأثر رجعي ← إلغاء قيد الخصم: يُعكس وترجع الدفعة خصماً بلا نوع', () => {
  const db = memDb();
  const k = contract(db);
  // دفعة من إصدار سابق بخصم على صفّها بلا نوع ولا سطر · ثم يُحجز خصمها
  const p = recordRentPayment(db, k.cid, { installmentId: k.insts[0], period: 'م', date: '2026-01-05', notes: '', discountHalalas: 0,
    lines: [{ method: 'cash', amountHalalas: 80000 }] });
  db.run(`UPDATE contract_payments SET discount_halalas = 20000, gross_halalas = 100000 WHERE id = ?`, [p]);
  bookDiscount(db, p, DISCOUNT_AFTER_DUE);
  expect(accountBalance(db, '4900')).toBe(20000);
  const a = entrySourceAction(db, lastEntry(db, 'discount'));
  if (a?.kind !== 'op') throw new Error('op');
  a.run('2026-02-01', 'حُجز خطأً');
  expect(accountBalance(db, '4900')).toBe(0);
  expect(db.get<{ k: string | null }>(`SELECT discount_kind AS k FROM contract_payments WHERE id = ?`, [p])!.k).toBeNull();
  healthy(db);
  db.close();
});

test('ردّ فائض ← إلغاء الرد: يعود الفائض ظاهراً · والتحويل رصيداً لا يُلغى إن استُعمل الرصيد', () => {
  const db = memDb();
  const k = contract(db);
  recordRentPayment(db, k.cid, { installmentId: k.insts[0], period: 'م', date: '2026-01-05', notes: '', discountHalalas: 0,
    lines: [{ method: 'cash', amountHalalas: 100000 }] });
  // دفعة ثانية على القسط نفسه كما من جهاز آخر · فائض ١٠٠٠
  db.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'applying'`);
  recordRentPayment(db, k.cid, { installmentId: k.insts[1], period: 'م', date: '2026-01-06', notes: '', discountHalalas: 0,
    lines: [{ method: 'cash', amountHalalas: 100000 }] });
  db.run(`UPDATE sync_ctl SET v = 0 WHERE k = 'applying'`);
  db.run(`UPDATE contract_payments SET installment_id = ? WHERE date = '2026-01-06'`, [k.insts[0]]);
  db.run(`UPDATE contract_installments SET paid_halalas = 0, status = 'مستحقة' WHERE id = ?`, [k.insts[1]]);
  expect(contractSurpluses(db).map((s) => s.amount)).toEqual([100000]);
  settleSurplus(db, k.cid, { action: 'refund', amountHalalas: 100000, date: '2026-02-01', method: 'cash' });
  expect(contractSurpluses(db)).toEqual([]);
  const a = entrySourceAction(db, lastEntry(db, 'surplus_refund'));
  if (a?.kind !== 'op') throw new Error('op');
  a.run('2026-02-02', 'لم يُسلَّم المبلغ');
  expect(contractSurpluses(db).map((s) => s.amount)).toEqual([100000]);
  // التحويل رصيداً ثم استعمال جزء منه
  settleSurplus(db, k.cid, { action: 'credit', amountHalalas: 100000, date: '2026-02-03' });
  db.run(`UPDATE tenants SET credit_halalas = 40000`);
  const c = entrySourceAction(db, lastEntry(db, 'surplus_credit'));
  expect(c?.kind === 'op' && c.blockers.join(' ')).toContain('استُعمل');
  db.close();
});

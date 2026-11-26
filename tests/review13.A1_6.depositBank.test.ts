/**
 * A1-6 · قرار المالك س١٧: قبض التأمين والعربون وردّهما «نقداً أو تحويلاً لحساب بنكي» كتحصيل الإيجار (الهجرة ٦٣) · بيانات مصطنعة كلها.
 * كانا نقداً في المحفظة دائماً: المحفظة (1100 ناقص البنوك) تُظهر نقداً هو في البنك، ورصيد البنك ناقص، وردّ التأمين تحويلاً يُمنع إن
 * خلت المحفظة · والقيد على 1100 كما هو، ومعه حركة بنكٍ برقمه.
 *
 * الأرقام الذهبية: تأمين ٢٬٠٠٠ = ٢٠٠٠٠٠ هللة، خصم ٥٠٠ = ٥٠٠٠٠، مسترَد ١٬٥٠٠ = ١٥٠٠٠٠ · عربون ١٬٥٠٠ = ١٥٠٠٠٠ · تأمين إضافي ٤٠٠ = ٤٠٠٠٠.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { pair, sync, ownerPulls, MEMBER } from './helpers/rederive';
import { confirmContract, renewContract, saveDepositSettlement, cancelContract } from '@/domain/contracts/service';
import { createReservation, cancelReservation } from '@/domain/reservations';
import { accountBalance, bankBalance, walletCashBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import { depositCashToBank, ownerCashIn } from '@/domain/cashOps';
import { docId } from '@/sync/engine';
import type { DB } from '@/db/adapter';

const BANK = 'bk-a16';
function world(db: DB = memDb()) {
  db.run(`INSERT INTO banks (id, name, created_at) VALUES (?, 'بنك مصطنع', '2025-01-01')`, [BANK]);
  const p = addProperty(db, { name: 'عقار تأمين مصطنع' });
  return { db, u1: addUnit(db, p, { unit_no: 'B-1' }), u2: addUnit(db, p, { unit_no: 'B-2' }) };
}
const contract = (db: DB, unit: string, bank: string | null, over: Partial<{ start: string; end: string; holder: string }> = {}) =>
  confirmContract(db, { ...contractInput(unit, { tenant: 'مستأجر تأمين مصطنع', idNumber: '1000001025', depositHalalas: 200000,
    start: over.start ?? '2025-01-01', end: over.end ?? '2025-12-31' }), depositHolder: over.holder ?? 'المكتب', depositBankId: bank });
const red = (db: DB) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name);
const settle = (refund: number, bank: string | null, deduction = 200000 - refund) => ({ date: '2026-01-10', deductionHalalas: deduction,
  deductionReason: 'أضرار مصطنعة', refundHalalas: refund, notes: '', refundBankId: bank });

test('A1-6 قبض التأمين تحويلاً: البنك يزيد ٢٠٠٠٠٠ والمحفظة لا تتغير، والعقد يحفظ بنكه', () => {
  const { db, u1 } = world();
  const cid = contract(db, u1, BANK);
  expect(accountBalance(db, '1100')).toBe(200000);
  expect(bankBalance(db, BANK)).toBe(200000);
  expect(walletCashBalance(db)).toBe(0);
  expect(db.get(`SELECT deposit_bank_id AS b FROM contracts WHERE id = ?`, [cid])).toEqual({ b: BANK });
  const e = db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE src_type = 'contract_deposit' AND src_id = ?`, [cid])!;
  expect(db.get(`SELECT amount_halalas AS a, matched AS m FROM bank_tx WHERE journal_no = ?`, [e.no])).toEqual({ a: 200000, m: 1 });
  expect(red(db)).toEqual([]);
  db.close();
});

test('A1-6 نقداً كما كان، وتأمين المنصة لا بنك له', () => {
  const { db, u1, u2 } = world();
  const a = contract(db, u1, null);
  expect(walletCashBalance(db)).toBe(200000);
  const b = contract(db, u2, BANK, { holder: 'منصة إيجار' });
  expect(bankBalance(db, BANK)).toBe(0);
  expect(db.get(`SELECT deposit_bank_id AS b FROM contracts WHERE id = ?`, [b])).toEqual({ b: null });
  expect(db.get(`SELECT deposit_bank_id AS b FROM contracts WHERE id = ?`, [a])).toEqual({ b: null });
  db.close();
});

test('A1-6 ردّ التأمين تحويلاً والمحفظة فارغة (نُقل نقدها إلى البنك): يُقبل، والنقد وحده يُمنع', () => {
  const { db, u1 } = world();
  const cid = contract(db, u1, null);
  depositCashToBank(db, { bankId: BANK, amountHalalas: 200000, date: '2025-01-02' });
  expect(walletCashBalance(db)).toBe(0);
  expect(() => saveDepositSettlement(db, cid, settle(150000, null))).toThrow(/المحفظة|النقد/);
  saveDepositSettlement(db, cid, settle(150000, BANK));
  expect(bankBalance(db, BANK)).toBe(50000);
  expect(walletCashBalance(db)).toBe(0);
  expect(accountBalance(db, '1100')).toBe(50000);
  expect(accountBalance(db, '2400')).toBe(0);
  expect(db.get(`SELECT refund_bank_id AS b FROM deposit_settlements WHERE contract_id = ?`, [cid])).toEqual({ b: BANK });
  expect(red(db)).toEqual([]);
  db.close();
});

test('A1-6 تعديل التسوية من تحويلٍ إلى نقد: يعود المبلغ إلى البنك ويخرج من المحفظة', () => {
  const { db, u1 } = world();
  const cid = contract(db, u1, BANK);
  saveDepositSettlement(db, cid, settle(150000, BANK));
  expect(bankBalance(db, BANK)).toBe(50000);
  ownerCashIn(db, { amountHalalas: 150000, date: '2026-01-05' });
  saveDepositSettlement(db, cid, settle(150000, null));
  expect(bankBalance(db, BANK)).toBe(200000);
  expect(walletCashBalance(db)).toBe(0);
  expect(accountBalance(db, '1100')).toBe(200000);
  // وعكسٌ ثانٍ إلى التحويل: البنك يكفيه بعد ما يعود إليه
  saveDepositSettlement(db, cid, settle(150000, BANK));
  expect(bankBalance(db, BANK)).toBe(50000);
  expect(walletCashBalance(db)).toBe(150000);
  expect(red(db)).toEqual([]);
  db.close();
});

test('A1-6 رصيد البنك لا يكفي الردّ: يُرفض بجملةٍ تسمّي البنك ولا يُكتب شيء', () => {
  const { db, u1 } = world();
  const cid = contract(db, u1, null);
  expect(() => saveDepositSettlement(db, cid, settle(150000, BANK)))
    .toThrow('رصيد بنك مصطنع هو 0.00 ولا يكفي لتحويل 1,500.00');
  expect(db.get(`SELECT 1 FROM deposit_settlements WHERE contract_id = ?`, [cid])).toBeFalsy();
  db.close();
});

test('A1-6 الإلغاء بتسوية يردّ تحويلاً كذلك', () => {
  const { db, u1 } = world();
  const cid = contract(db, u1, BANK, { start: '2026-01-01', end: '2026-12-31' });
  cancelContract(db, cid, { date: '2026-03-31', reason: 'غادر', installmentsFate: 'cancel', settle: true,
    deductionHalalas: 0, refundHalalas: 200000, deductionReason: '', refundBankId: BANK });
  expect(bankBalance(db, BANK)).toBe(0);
  expect(accountBalance(db, '2400')).toBe(0);
  db.close();
});

test('A1-6 التأمين الإضافي في التجديد تحويلاً: للعقد الجديد بنكه وحركته', () => {
  const { db, u1 } = world();
  const a = contract(db, u1, null);
  const b = renewContract(db, a, { start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, cycle: 'شهرية', carryDeposit: true,
    extraDepositHalalas: 40000, extraDepositBankId: BANK, services: '', furnished: 'غير مؤثثة', ejarNo: '', note: '' });
  expect(bankBalance(db, BANK)).toBe(40000);
  expect(walletCashBalance(db)).toBe(200000);
  expect(db.get(`SELECT deposit_halalas AS d, deposit_bank_id AS b FROM contracts WHERE id = ?`, [b])).toEqual({ d: 240000, b: BANK });
  expect(red(db)).toEqual([]);
  db.close();
});

test('A1-6 العربون: قبضه تحويلاً وردّه تحويلاً', () => {
  const { db, u1 } = world();
  // مقبوضٌ قبل ردّه (02-01): الردّ يُفحص بأدنى رصيد البنك من تاريخه فما بعده (A2.8: العكس والإلغاء)، وكان القبض بتاريخ اليوم بعده
  const r = createReservation(db, { unitId: u1, name: 'حاجز مصطنع', phone: '', depositHalalas: 150000, expiryDate: '2027-01-01', bankId: BANK, date: '2026-01-15' });
  expect(bankBalance(db, BANK)).toBe(150000);
  expect(walletCashBalance(db)).toBe(0);
  expect(accountBalance(db, '2450')).toBe(150000);
  cancelReservation(db, r, false, '2026-02-01', BANK);
  expect(bankBalance(db, BANK)).toBe(0);
  expect(accountBalance(db, '2450')).toBe(0);
  expect(db.get(`SELECT bank_id AS b, refund_bank_id AS rb, deposit_outcome AS o FROM reservations WHERE id = ?`, [r]))
    .toEqual({ b: BANK, rb: BANK, o: 'مردود' });
  expect(red(db)).toEqual([]);
  db.close();
});

test('A1-6 العربون نقداً يُردّ تحويلاً من بنكٍ فيه رصيد، والمصادرة لا تمسّ بنكاً', () => {
  const w = world();
  ownerCashIn(w.db, { amountHalalas: 150000, date: '2026-01-01' });
  depositCashToBank(w.db, { bankId: BANK, amountHalalas: 150000, date: '2026-01-01' });
  const r = createReservation(w.db, { unitId: w.u1, name: 'حاجز مصطنع', phone: '', depositHalalas: 150000, expiryDate: '2027-01-01' });
  expect(walletCashBalance(w.db)).toBe(150000);
  cancelReservation(w.db, r, false, '2026-02-01', BANK);
  expect(bankBalance(w.db, BANK)).toBe(0);
  expect(walletCashBalance(w.db)).toBe(150000);
  const r2 = createReservation(w.db, { unitId: w.u2, name: 'حاجز ثانٍ مصطنع', phone: '', depositHalalas: 50000, expiryDate: '2027-01-01', bankId: BANK });
  cancelReservation(w.db, r2, true, '2026-02-02', BANK);
  expect(bankBalance(w.db, BANK)).toBe(50000);
  expect(w.db.get(`SELECT refund_bank_id AS rb FROM reservations WHERE id = ?`, [r2])).toEqual({ rb: null });
  w.db.close();
});

test('A1-6 جهاز المالك: حركة بنكٍ من عضوٍ لقبض تأمينٍ نقدي تُرفض، ولقبضٍ تحويلاً ببنكه تُقبل', async () => {
  const s = await pair();
  const { u1, u2 } = world(s.owner);
  await sync(s.owner, s.r);
  await sync(s.dev, s.r);
  // (أ) تأمينٌ نقداً، وحركة بنكٍ مزوَّرة برقم قيده تنقل نقد المحفظة إلى البنك
  const a = contract(s.dev, u1, null);
  const ea = s.dev.get<{ no: string }>(`SELECT no FROM journal_entries WHERE src_type = 'contract_deposit' AND src_id = ?`, [a])!.no;
  s.dev.run(`INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, journal_no, source, created_at)
             VALUES ('tx-forged', ?, '2025-01-01', 'مزوَّرة', 200000, 1, ?, 'قبض تأمين', '2025-01-01T00:00:00.000Z')`, [BANK, ea]);
  // (ب) تأمينٌ تحويلاً ببنكه
  const b = contract(s.dev, u2, BANK);
  const eb = s.dev.get<{ no: string }>(`SELECT no FROM journal_entries WHERE src_type = 'contract_deposit' AND src_id = ?`, [b])!.no;
  const txb = s.dev.get<{ id: string }>(`SELECT id FROM bank_tx WHERE journal_no = ?`, [eb])!.id;
  await sync(s.dev, s.r);
  for (const k of ['tx-forged', txb]) {
    const d = s.r.docs.get(docId('bank_tx', k))!;
    s.r.inject({ ...d, by: MEMBER });
  }
  await ownerPulls(s.owner, s.r);
  expect(s.owner.get(`SELECT 1 FROM bank_tx WHERE id = 'tx-forged'`)).toBeFalsy();
  expect(s.owner.get<{ reason: string }>(`SELECT reason FROM sync_rejects WHERE pk = 'tx-forged'`)!.reason)
    .toBe('حركة بنكٍ لقيد ' + ea + ' لا تطابق طريقة القبض أو الردّ في مستنده · لا تُطبَّق');
  expect(s.owner.get(`SELECT amount_halalas AS a FROM bank_tx WHERE id = ?`, [txb])).toEqual({ a: 200000 });
  expect(bankBalance(s.owner, BANK)).toBe(200000);
  s.close();
});

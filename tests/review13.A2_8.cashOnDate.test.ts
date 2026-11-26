/**
 * A2.8 · متوسط · src/domain/cashGuard.ts (requireCash) · src/domain/cashOps.ts (bankBalance) · قرار المالك س١٩ (2026-11-13: نعم)
 *
 * السيناريو (بيانات مصطنعة): «إيداع المالك» ١٬٠٠٠٫٠٠ بتاريخ 2026-06-01، ثم مصروف نثري ٨٠٠٫٠٠ بتاريخ 2026-01-15: كان يُقبل،
 * فالمحفظة من ١٥ يناير إلى آخر مايو −٨٠٠٫٠٠ (كشف 1100 يُظهرها) · ومثله سحبٌ من البنك بتاريخٍ قبل الإيداع فيه.
 * القرار: «ولا يصير النقد سالباً أبداً» (2026-10-05) في أي يومٍ مضى أيضاً (س١٩).
 * السلوك الصحيح: الكفاية بأدنى رصيدٍ جارٍ من تاريخ العملية فما بعده (محفظةً أو بنكاً)، برسالةٍ واحدة تذكر اليوم.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { ownerCashIn, pettyCashExpense, ownerCashOut, depositCashToBank, withdrawCashFromBank, transferBetweenBanks, recordManualBankTx } from '@/domain/cashOps';
import { walletLowFrom, bankLowFrom, cashShortfall, CashShortfallError } from '@/domain/cashGuard';
import { postManualEntry } from '@/domain/accounting/post';
import { savePurchase, payPurchase, payPurchaseSplit, TS_EXCLUDED, type PurchaseInput } from '@/domain/purchases';
import { walletCashBalance, bankBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';
import type { DB } from '@/db/adapter';
import type { RemoteDoc } from '@/sync/types';
import { pair, sync, ownerPulls, srcAsMember, MEMBER, has, reasonOf } from './helpers/rederive';

const red = (db: DB) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')');
const pur = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  supplier: 'مورد نقد مصطنع', date: '2026-01-10', due: '2026-01-10', category: 'صيانة', incorpItem: '', amortize: false,
  amortizeMonths: null, exempt: false, excludeFromVat: true, taxStatus: TS_EXCLUDED,
  subtotalHalalas: 30000, taxHalalas: 4500, totalHalalas: 34500, ...over,
} as PurchaseInput);

test('A2.8 المحفظة: مصروفٌ بتاريخٍ سابق يجعل المحفظة سالبة في يومٍ مضى يُرفض برسالةٍ تذكر اليوم · وما يكفي كل يومٍ بعده يُقبل', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 100000, date: '2026-06-01' });
  // الرصيد اليوم ١٬٠٠٠٫٠٠ يكفي ٨٠٠٫٠٠، لكنه يوم 2026-01-15 صفر
  expect(walletCashBalance(db)).toBe(100000);
  expect(walletLowFrom(db, '2026-01-15')).toEqual({ low: 0, at: '2026-01-15' });
  expect(cashShortfall(db, 80000, '2026-01-15')).toBe(80000);
  let err: unknown;
  try { pettyCashExpense(db, { amountHalalas: 80000, descr: 'نثري مصطنع', date: '2026-01-15' }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(CashShortfallError);
  expect((err as Error).message).toContain('15/01/2026');
  expect(() => ownerCashOut(db, { amountHalalas: 10000, date: '2026-05-31' })).toThrow(CashShortfallError);
  expect(() => depositCashToBank(db, { bankId: addBank(db, 'بنك مصطنع'), amountHalalas: 10000, date: '2026-03-01' })).toThrow(CashShortfallError);
  expect(walletCashBalance(db)).toBe(100000);

  // بعد الإيداع يكفي: ٨٠٠٫٠٠ يوم 2026-06-10 ثم ٣٠٠٫٠٠ يوم 2026-06-05 يجعل 06-10 = ١٬٠٠٠ − ٨٠٠ − ٣٠٠ = −١٠٠٫٠٠ فيُرفض، و٢٠٠٫٠٠ يكفي بالضبط
  pettyCashExpense(db, { amountHalalas: 80000, descr: 'نثري مصطنع', date: '2026-06-10' });
  expect(walletLowFrom(db, '2026-06-05')).toEqual({ low: 20000, at: '2026-06-10' });
  expect(() => pettyCashExpense(db, { amountHalalas: 30000, descr: 'نثري مصطنع', date: '2026-06-05' })).toThrow(CashShortfallError);
  pettyCashExpense(db, { amountHalalas: 20000, descr: 'نثري مصطنع', date: '2026-06-05' });
  expect(walletCashBalance(db)).toBe(0);
  // القيد اليدوي بصرف نقدٍ بتاريخٍ سابق كذلك
  expect(() => postManualEntry(db, { date: '2026-02-01', memo: 'يدوي مصطنع', lines: [
    { account: '5400', debit: 100, credit: 0 }, { account: '1100', debit: 0, credit: 100 }] })).toThrow(CashShortfallError);
  expect(red(db)).toEqual([]);
  db.close();
});

test('A2.8 البنك: سحبٌ أو تحويلٌ أو رسومٌ أو سدادٌ بتاريخٍ قبل الإيداع فيه يُرفض · وبعده يُقبل', () => {
  const db = memDb();
  const bank = addBank(db, 'بنك سحب مصطنع');
  const other = addBank(db, 'بنك آخر مصطنع');
  ownerCashIn(db, { amountHalalas: 100000, date: '2026-06-01' });
  depositCashToBank(db, { bankId: bank, amountHalalas: 100000, date: '2026-06-01' });
  expect(bankLowFrom(db, bank, '2026-05-01')).toEqual({ low: 0, at: '2026-05-01' });
  expect(() => withdrawCashFromBank(db, { bankId: bank, amountHalalas: 50000, date: '2026-05-01' })).toThrow(/01\/05\/2026/);
  expect(() => transferBetweenBanks(db, { fromBankId: bank, toBankId: other, amountHalalas: 50000, date: '2026-05-01' })).toThrow(/01\/05\/2026/);
  expect(() => recordManualBankTx(db, { kind: 'fee', bankId: bank, amountHalalas: 500, date: '2026-05-01', descr: 'رسوم مصطنعة' })).toThrow(/01\/05\/2026/);
  const p = savePurchase(db, pur());
  expect(() => payPurchase(db, p, 'bank', bank, '2026-05-01')).toThrow(/01\/05\/2026/);
  expect(() => payPurchaseSplit(db, p, [{ method: 'bank', bankId: bank, amountHalalas: 34500 }], '2026-05-01')).toThrow(/01\/05\/2026/);
  expect(() => payPurchase(db, p, 'cash', null, '2026-05-01')).toThrow(CashShortfallError);
  expect(bankBalance(db, bank)).toBe(100000);
  // بعد الإيداع
  withdrawCashFromBank(db, { bankId: bank, amountHalalas: 50000, date: '2026-06-02' });
  payPurchase(db, p, 'bank', bank, '2026-06-03');
  expect([bankBalance(db, bank), walletCashBalance(db)]).toEqual([100000 - 50000 - 34500, 50000]);
  expect(red(db)).toEqual([]);
  db.close();
});

describe('A2.8 جهاز المالك يحكم على كتابة العضو بأدنى رصيدٍ من تاريخها كما يحكم جهازه', () => {
  async function setup() {
    const p = await pair();
    const bank = addBank(p.owner, 'بنك عضو مصطنع');
    ownerCashIn(p.owner, { amountHalalas: 100000, date: '2026-06-01' });
    depositCashToBank(p.owner, { bankId: bank, amountHalalas: 100000, date: '2026-06-01' });
    await sync(p.owner, p.r);
    await sync(p.dev, p.r);
    return { ...p, bank };
  }
  /** مستند العضو، وبتاريخٍ آخر إن أُعطي (مزوَّر: تطبيق العضو لا يكتبه) */
  const asMemberOn = (r: Awaited<ReturnType<typeof pair>>['r'], d: RemoteDoc, op: string, date: string | null, field = 'date') =>
    r.inject({ ...d, by: MEMBER, op, d: date ? { ...d.d, [field]: date } : d.d } as RemoteDoc);

  for (const forged of [false, true]) {
    test((forged ? 'سلبي' : 'إيجابي') + ' · سداد فاتورة شراء من البنك' + (forged ? ' بتاريخٍ قبل الإيداع فيه: يُرفض ولا ينزل البنك' : ' بعد الإيداع: يُقبل'), async () => {
      const s = await setup();
      const id = savePurchase(s.dev, pur());
      await sync(s.dev, s.r);
      srcAsMember(s.r, /^purchase$/);
      await ownerPulls(s.owner, s.r);
      payPurchase(s.dev, id, 'bank', s.bank, '2026-06-03');
      await sync(s.dev, s.r);
      const on = forged ? '2026-05-01' : null;
      const docs = [...s.r.docs.values()];
      asMemberOn(s.r, docs.find((d) => d.t === 'purchases' && d.k === id)!, 'purchases', on, 'paid_date');
      const entry = docs.find((d) => d.t === 'journal_entries' && d.d?.src_type === 'purchase_pay')!;
      asMemberOn(s.r, entry, 'purchases', on);
      asMemberOn(s.r, docs.find((d) => d.t === 'bank_tx' && d.d?.journal_no === entry.d!.no)!, 'purchases', on);
      await ownerPulls(s.owner, s.r);
      expect(has(s.owner, entry.k)).toBe(!forged);
      expect(bankBalance(s.owner, s.bank)).toBe(forged ? 100000 : 100000 - 34500);
      if (forged) expect(reasonOf(s.owner, entry.k)).toContain('01/05/2026');
      s.close();
    });

    test((forged ? 'سلبي' : 'إيجابي') + ' · سحبٌ من البنك إلى المحفظة' + (forged ? ' بتاريخٍ قبل الإيداع فيه: لا يُطبَّق' : ' بعد الإيداع: يُطبَّق'), async () => {
      const s = await setup();
      withdrawCashFromBank(s.dev, { bankId: s.bank, amountHalalas: 50000, date: '2026-06-02' });
      await sync(s.dev, s.r);
      const tx = [...s.r.docs.values()].find((d) => d.t === 'bank_tx' && Number(d.d?.amount_halalas) === -50000)!;
      asMemberOn(s.r, tx, 'banks', forged ? '2026-05-01' : null);
      await ownerPulls(s.owner, s.r);
      expect(!!s.owner.get(`SELECT 1 FROM bank_tx WHERE id = ? AND deleted_at IS NULL`, [tx.k])).toBe(!forged);
      expect([bankBalance(s.owner, s.bank), walletCashBalance(s.owner)]).toEqual(forged ? [100000, 0] : [50000, 50000]);
      s.close();
    });
  }
});

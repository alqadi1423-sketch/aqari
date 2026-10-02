/**
 * التصرف بالنقد · ست عمليات على المحفظة:
 * كل عملية تحرّك المحفظة والبنوك بالمقدار الصحيح، والرفض بجملة تسمّي السبب والقيمة،
 * والفحوص الثمانية تمر بعد كل شيء.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, addBank, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import {
  depositCashToBank, withdrawCashFromBank, transferBetweenBanks,
  pettyCashExpense, ownerCashIn, ownerCashOut,
} from '@/domain/cashOps';
import { walletCashBalance, bankBalance, accountBalance } from '@/domain/accounting/ledger';
import { integrityChecks } from '@/domain/accounting/integrity';

/** قاعدة فيها 1,000.00 نقداً في المحفظة من دفعة إيجار محصَّلة نقداً */
function seed() {
  const db = memDb();
  const pid = addProperty(db);
  const u = addUnit(db, pid, { unit_no: 'C-1' });
  const bank1 = addBank(db, 'بنك أول', 0);
  const bank2 = addBank(db, 'بنك ثانٍ', 50000);
  const cid = confirmContract(db, contractInput(u, {
    tenant: 'مستأجر المحفظة', valueHalalas: 1200000, depositHalalas: 0,
    start: '2026-01-01', end: '2026-12-31',
  }));
  const inst = db.get<{ id: string }>(
    `SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date LIMIT 1`, [cid])!;
  recordRentPayment(db, cid, {
    installmentId: inst.id, date: '2026-02-01', period: 'فبراير',
    lines: [{ method: 'cash', amountHalalas: 100000 }], discountHalalas: 0, notes: '',
  });
  expect(walletCashBalance(db)).toBe(100000);
  return { db, bank1, bank2 };
}

describe('التصرف بالنقد', () => {
  test('إيداع في بنك: المحفظة تنقص والبنك يزيد والنقدية 1100 لا تتغير', () => {
    const { db, bank1 } = seed();
    const cashBefore = accountBalance(db, '1100');
    depositCashToBank(db, { bankId: bank1, amountHalalas: 30000, date: '2026-02-02' });
    expect(walletCashBalance(db)).toBe(70000);
    expect(bankBalance(db, bank1)).toBe(30000);
    expect(accountBalance(db, '1100')).toBe(cashBefore);
    db.close();
  });

  test('إيداع أكبر من المحفظة يُرفض برسالة تسمّي الرصيد والمبلغ', () => {
    const { db, bank1 } = seed();
    expect(() => depositCashToBank(db, { bankId: bank1, amountHalalas: 100001, date: '2026-02-02' }))
      .toThrow(/رصيد المحفظة النقدية 1,000\.00 لا يكفي/);
    db.close();
  });

  test('سحب من بنك: البنك ينقص والمحفظة تزيد، والسحب فوق رصيد البنك يُرفض', () => {
    const { db, bank2 } = seed();
    withdrawCashFromBank(db, { bankId: bank2, amountHalalas: 20000, date: '2026-02-03' });
    expect(bankBalance(db, bank2)).toBe(30000);
    expect(walletCashBalance(db)).toBe(120000);
    expect(() => withdrawCashFromBank(db, { bankId: bank2, amountHalalas: 30001, date: '2026-02-03' }))
      .toThrow(/لا يكفي لسحب/);
    db.close();
  });

  test('تحويل بين بنكين: حركتان متقابلتان والمحفظة لا تتغير، ونفس الحساب يُرفض', () => {
    const { db, bank1, bank2 } = seed();
    transferBetweenBanks(db, { fromBankId: bank2, toBankId: bank1, amountHalalas: 15000, date: '2026-02-04' });
    expect(bankBalance(db, bank2)).toBe(35000);
    expect(bankBalance(db, bank1)).toBe(15000);
    expect(walletCashBalance(db)).toBe(100000);
    expect(() => transferBetweenBanks(db, { fromBankId: bank1, toBankId: bank1, amountHalalas: 1000, date: '2026-02-04' }))
      .toThrow(/بنكين مختلفين/);
    expect(() => transferBetweenBanks(db, { fromBankId: bank1, toBankId: bank2, amountHalalas: 15001, date: '2026-02-04' }))
      .toThrow(/لا يكفي لتحويل/);
    db.close();
  });

  test('مصروف نثري: قيد 5400 من 1100 والمحفظة تنقص، وبلا بيان يُرفض', () => {
    const { db } = seed();
    const expBefore = accountBalance(db, '5400');
    pettyCashExpense(db, { amountHalalas: 2500, descr: 'قرطاسية', date: '2026-02-05' });
    expect(walletCashBalance(db)).toBe(97500);
    expect(accountBalance(db, '5400')).toBe(expBefore + 2500);
    expect(() => pettyCashExpense(db, { amountHalalas: 1000, descr: '  ', date: '2026-02-05' }))
      .toThrow(/بيان المصروف/);
    db.close();
  });

  test('إيداع المالك ومسحوباته: المحفظة ورأس المال يتحركان معاً بالمقدار نفسه', () => {
    const { db } = seed();
    ownerCashIn(db, { amountHalalas: 50000, date: '2026-02-06' });
    expect(walletCashBalance(db)).toBe(150000);
    ownerCashOut(db, { amountHalalas: 20000, date: '2026-02-07' });
    expect(walletCashBalance(db)).toBe(130000);
    expect(() => ownerCashOut(db, { amountHalalas: 130001, date: '2026-02-07' }))
      .toThrow(/لا يكفي لـمسحوبات المالك/);
    db.close();
  });

  test('بعد سلسلة عمليات كاملة: الفحوص الثمانية كلها تمر', () => {
    const { db, bank1, bank2 } = seed();
    ownerCashIn(db, { amountHalalas: 50000, date: '2026-02-06' });
    depositCashToBank(db, { bankId: bank1, amountHalalas: 40000, date: '2026-02-07' });
    transferBetweenBanks(db, { fromBankId: bank1, toBankId: bank2, amountHalalas: 10000, date: '2026-02-08' });
    withdrawCashFromBank(db, { bankId: bank2, amountHalalas: 5000, date: '2026-02-09' });
    pettyCashExpense(db, { amountHalalas: 2500, descr: 'مصروف اختبار', date: '2026-02-10' });
    ownerCashOut(db, { amountHalalas: 10000, date: '2026-02-11' });
    // المحفظة: 1000 + 500 − 400 + 50 − 25 − 100 = 10.25 ريال بالهللات
    expect(walletCashBalance(db)).toBe(100000 + 50000 - 40000 + 5000 - 2500 - 10000);
    expect(bankBalance(db, bank1)).toBe(30000);
    expect(bankBalance(db, bank2)).toBe(55000);
    for (const c of integrityChecks(db)) expect(`${c.name}: ${c.ok}`).toBe(`${c.name}: true`);
    db.close();
  });
});

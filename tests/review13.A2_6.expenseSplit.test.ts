/**
 * A2.6 · متوسط · src/domain/stats.ts (expenseSplit) · app/(tabs)/index.tsx
 *
 * السيناريو (بيانات مصطنعة، أكتوبر 2026): فاتورة شراء «صيانة» ١٬٠٠٠٫٠٠ + ضريبة ١٥٠٫٠٠ غير قابلة للخصم، ومصروف نثري ٢٠٠٫٠٠.
 * بطاقة «المصروفات» = ١٬٣٥٠٫٠٠ (الدفتر)، و«توزيع المصروفات» كان صيانة ١٬٠٠٠٫٠٠ وحدها: يُسقط الضريبة غير القابلة للخصم
 * والنثري، ويُدخل ما رُسمل أصلاً.
 * السلوك الصحيح: التوزيع من سطور الدفتر لحسابات «مصروف» مجمّعةً بالحساب، ومجموعه يساوي البطاقة بالأساسين (استحقاق ونقدي).
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit } from './helpers/fixtures';
import { expenseSplit } from '@/domain/stats';
import { savePurchase, TS_EXCLUDED } from '@/domain/purchases';
import { pettyCashExpense, ownerCashIn } from '@/domain/cashOps';
import { periodRevenueExpense } from '@/domain/accounting/ledger';
import { periodRevenueExpenseAccrual, BASIS_ACCRUAL, BASIS_CASH } from '@/domain/accrual';
import { integrityChecks } from '@/domain/accounting/integrity';

const red = (db: Parameters<typeof integrityChecks>[0]) => integrityChecks(db).filter((c) => !c.ok).map((c) => c.name + ' (' + c.value + ')');

const sum = (rows: Array<{ amount: number }>) => rows.reduce((s, r) => s + r.amount, 0);

test('A2.6 توزيع المصروفات من الدفتر بالحساب ومجموعه يساوي بطاقة «المصروفات»', () => {
  const db = memDb();
  ownerCashIn(db, { amountHalalas: 100000, date: '2026-10-01' });
  savePurchase(db, {
    supplier: 'مورد صيانة مصطنع', date: '2026-10-05', due: '2026-10-05', category: 'صيانة', incorpItem: '', amortize: false, amortizeMonths: null,
    exempt: false, excludeFromVat: true, taxStatus: TS_EXCLUDED,
    subtotalHalalas: 100000, taxHalalas: 15000, totalHalalas: 115000,
  } as never);
  pettyCashExpense(db, { amountHalalas: 20000, descr: 'نثري مصطنع', date: '2026-10-10' });
  const from = '2026-10-01', to = '2026-10-31';

  // الأرقام الذهبية: 5300 = ١٬٠٠٠٫٠٠ + ١٥٠٫٠٠ = ١١٥٬٠٠٠ هللة · 5400 = ٢٠٬٠٠٠ هللة · المجموع ١٣٥٬٠٠٠
  const cash = expenseSplit(db, from, to, BASIS_CASH);
  expect(cash.map((r) => [r.code, r.amount])).toEqual([['5300', 115000], ['5400', 20000]]);
  expect(sum(cash)).toBe(135000);
  expect(sum(cash)).toBe(periodRevenueExpense(db, from, to).expense);

  const accr = expenseSplit(db, from, to, BASIS_ACCRUAL);
  expect(accr.map((r) => [r.code, r.amount])).toEqual([['5300', 115000], ['5400', 20000]]);
  expect(sum(accr)).toBe(periodRevenueExpenseAccrual(db, from, to).expense);
  expect(red(db)).toEqual([]);
  db.close();
});

test('A2.6 الاستحقاق: فاتورة مستهلكة على ثلاثة أشهر وبند أصلٍ مرسمل · التوزيع يساوي البطاقة في كل شهر وبلا هللة ضائعة', () => {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار توزيع مصطنع' });
  const u = addUnit(db, p, { unit_no: 'X-1' });
  // ١٠٠٠٫٠٠ صيانة مستهلكة على ٣ أشهر + مكيف ٥٠٠٫٠٠ أصل · ضريبة غير قابلة للخصم ٢٢٥٫٠٠ (١٥٪ من ١٬٥٠٠)
  savePurchase(db, {
    supplier: 'مورد مصطنع', date: '2026-10-01', due: '2026-10-01', category: 'صيانة', incorpItem: '', amortize: true, amortizeMonths: 3,
    exempt: false, excludeFromVat: true, taxStatus: TS_EXCLUDED, unitId: u,
    subtotalHalalas: 150000, taxHalalas: 22500, totalHalalas: 172500,
    lines: [{ descr: 'مكيف مصطنع', qty: 1, amountHalalas: 50000, isAsset: true, category: '1410', unitId: u, room: '' },
      { descr: 'صيانة مصطنعة', qty: 1, amountHalalas: 100000, isAsset: false }],
  } as never);
  // وفاتورة مستهلكة بفرق تقريب هللة واحدة (5900): نصيب كل شهر يُقسم على حسابَي قيدها بلا هللة ضائعة
  savePurchase(db, {
    supplier: 'مورد تقريب مصطنع', date: '2026-10-01', due: '2026-10-01', category: 'مصروفات أخرى', incorpItem: '', amortize: true, amortizeMonths: 3,
    exempt: false, excludeFromVat: true, taxStatus: TS_EXCLUDED,
    subtotalHalalas: 10000, taxHalalas: 1500, totalHalalas: 11501, roundingDiffHalalas: 1,
  } as never);
  // الضريبة غير القابلة للخصم تكلفةٌ تتبع بندها: الأصل ٥٠٠٫٠٠ + ٧٥٫٠٠ = ٥٧٥٫٠٠ مرسمل، والمصروف ١٬٠٠٠٫٠٠ + ١٥٠٫٠٠ = ١١٥٬٠٠٠ هللة
  let total = 0;
  for (const [f, t] of [['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-30'], ['2026-12-01', '2026-12-31']]) {
    const rows = expenseSplit(db, f, t, BASIS_ACCRUAL);
    expect(sum(rows)).toBe(periodRevenueExpenseAccrual(db, f, t).expense);
    expect(rows.every((r) => r.code !== '1410')).toBe(true);
    total += sum(rows);
  }
  expect(total).toBe(115000 + 11501);
  // النقدي: كله في أكتوبر بتاريخ الفاتورة
  const oct = expenseSplit(db, '2026-10-01', '2026-10-31', BASIS_CASH);
  expect(sum(oct)).toBe(115000 + 11501);
  expect(oct.find((r) => r.code === '5900')!.amount).toBe(1);
  expect(sum(oct)).toBe(periodRevenueExpense(db, '2026-10-01', '2026-10-31').expense);
  db.close();
});

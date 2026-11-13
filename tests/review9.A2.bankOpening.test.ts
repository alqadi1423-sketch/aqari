/**
 * A2.4 · عالٍ · src/domain/accounting/chart.ts:43 (openingDifference) مع src/domain/finStatements.ts:97 و
 *         src/domain/accounting/ledger.ts:239 (cashOnHand) و src/domain/accounting/integrity.ts (الفحص ٦)
 *
 * السيناريو (بيانات مصطنعة): المالك يبدأ بحسابٍ بنكي رصيده الافتتاحي ٥٠٬٠٠٠٫٠٠ (banks.opening_halalas، خارج الدفتر).
 *  - دليل الحسابات يقول «الأرصدة الافتتاحية غير متوازنة: الفرق ٥٠٬٠٠٠ (المدين أكبر) … تُصحَّح بإكمال الطرف الناقص».
 *  - فيُكمل المالك الطرف الناقص: افتتاحي رأس المال 3100 = ٥٠٬٠٠٠٫٠٠ → يختفي التنبيه، لكن قائمة المركز المالي تقول «الميزانية
 *    غير متوازنة» (الأصول صفر، وحقوق الملكية ٥٠٬٠٠٠)، وفحص المطابقة ٦ أحمر، وبطاقة «النقد في ١ حسابات» في الرئيسية صفر.
 *  - ولا إعداد يتّسق: وضع الخمسين ألفاً في افتتاحي 1100 أيضاً يضاعف الفرق ويُظهر في المحفظة نقداً ليس في اليد.
 *
 * لماذا يهم: كل مالكٍ يبدأ وله رصيد في البنك (الحال الطبيعي) يرى ميزانيةً غير متوازنة أو تنبيهاً دائماً، والرئيسية تُخفي ماله البنكي.
 * وقرار المالك (#60 · 2026-10-07): «يُحفظ ويظهر الفرق، وأرصدة البنوك تُسجَّل في الدفتر».
 * السلوك الصحيح: الرصيد الافتتاحي للبنك جزءٌ من 1100 في الدفتر (قيدٌ افتتاحي أو اشتقاقٌ في الأرصدة)، فبعد إكمال الطرف المقابل:
 * لا فرق افتتاحي، والميزانية متوازنة وأصولها ٥٠٬٠٠٠٫٠٠، وبطاقة النقد ٥٠٬٠٠٠٫٠٠، والمحفظة صفر.
 */
import { memDb } from './helpers/testDb';
import { addBank } from './helpers/fixtures';
import { saveAccount, openingDifference } from '@/domain/accounting/chart';
import { integrityChecks } from '@/domain/accounting/integrity';
import { financialStatementBlock } from '@/domain/finStatements';
import { cashOnHand, walletCashBalance, bankBalance } from '@/domain/accounting/ledger';

test.failing('A2.4 رصيدٌ بنكي افتتاحي مع رأس مالٍ يقابله: الميزانية متوازنة والنقد يظهر', () => {
  const db = memDb();
  const b = addBank(db, 'بنك مصطنع', 5000000);
  expect(openingDifference(db)).toBe(5000000);
  saveAccount(db, { code: '3100', name: 'رأس المال', type: 'حقوق ملكية', openingHalalas: 5000000 }, '3100');
  expect(openingDifference(db)).toBe(0);
  expect(bankBalance(db, b)).toBe(5000000);
  expect(walletCashBalance(db)).toBe(0);

  const bs = financialStatementBlock(db, 'balance', null, '2026-12-31');
  const total = (label: string) => (bs.totals.find((r) => r[0] === label)?.[1] as { money: number }).money;
  expect(total('إجمالي الأصول')).toBe(5000000);
  expect(total('إجمالي الخصوم وحقوق الملكية')).toBe(5000000);
  expect(bs.totals.some((r) => String(r[0]).includes('غير متوازنة'))).toBe(false);

  expect(integrityChecks(db).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
  // بطاقة «النقد في N حسابات» في الرئيسية
  expect(cashOnHand(db)).toBe(5000000);
  db.close();
});

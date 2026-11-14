/**
 * A2.1 · عالٍ · src/domain/statement.ts:45 و src/domain/reportData.ts:84 و:133 و src/domain/stats.ts:253 و:307
 * (والجذر: src/domain/contracts/service.ts:381 مع :951)
 *
 * السيناريو (بيانات مصطنعة): عقد شهري بقسط ١٬٠٠٠٫٠٠. يدفع المستأجر تحصيلاً جماعياً ٣٬٠٠٠٫٠٠ عن قسطين (٢٬٠٠٠٫٠٠)، فيبقى له
 * ١٬٠٠٠٫٠٠ رصيداً دائناً (2410). ثم يُسدَّد القسط الثالث من رصيده الدائن (applyTenantCredit).
 * الدفتر: النقد المقبوض ٣٬٠٠٠٫٠٠، وإيراد الإيجار ٣٬٠٠٠٫٠٠، والرصيد الدائن صفر.
 * الخطأ: صفّ التحصيل الجماعي يحمل net = ٣٬٠٠٠٫٠٠ (ومنه الفائض)، وصفّ «من الرصيد الدائن» يحمل net = ١٬٠٠٠٫٠٠ ثانية، وكل من يجمع
 * contract_payments.net_halalas يعدّ الألف مرتين:
 *  - كشف حساب المستأجر (وثيقة تُسلَّم له) يُظهر له رصيداً دائناً ١٬٠٠٠٫٠٠ لا وجود له (الصحيح صفر).
 *  - «الدخل المحصَّل» في تقرير الوحدة والعقار ٤٬٠٠٠٫٠٠ (الصحيح ٣٬٠٠٠٫٠٠).
 *  - بطاقة «إجمالي قيمة عقود الإيجار (المحصَّلة)» في شاشة العقارات ٤٬٠٠٠٫٠٠.
 *
 * لماذا يهم: رقمٌ مالي يُسلَّم للمستأجر ويُبنى عليه، ومؤشراتٌ يقرؤها المالك، كلها تخالف الدفتر بمقدار كل رصيدٍ دائن استُعمل.
 * السلوك الصحيح: سداد القسط من الرصيد الدائن لا يُعدّ مقبوضاً جديداً (لا نقد فيه)، والفائض في التحصيل الجماعي يُعدّ مقبوضاً مرة
 * واحدة · فالأرقام الثلاثة تطابق الدفتر (النقد ٣٬٠٠٠٫٠٠ والإيراد ٣٬٠٠٠٫٠٠) وكشف المستأجر رصيده صفر.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordBulkRentPayment, applyTenantCredit } from '@/domain/contracts/service';
import { tenantStatementRows } from '@/domain/statement';
import { unitReportData, propertyReportData } from '@/domain/reportData';
import { portfolioStats } from '@/domain/stats';
import { accountBalance } from '@/domain/accounting/ledger';

function world() {
  const db = memDb();
  const p = addProperty(db, { name: 'عقار مصطنع' });
  const u = addUnit(db, p, { unit_no: 'R9-1' });
  const cid = confirmContract(db, contractInput(u, {
    tenant: 'مستأجر مصطنع', idNumber: '1000009101', phone: '0500009101',
    start: '2026-01-01', end: '2026-12-31', valueHalalas: 1200000, depositHalalas: 0,
  }));
  const insts = db.all<{ id: string }>(`SELECT id FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid]);
  // ٣٬٠٠٠٫٠٠ عن قسطين بألفين · والفائض ألفٌ رصيداً دائناً
  recordBulkRentPayment(db, cid, { installmentIds: [insts[0].id, insts[1].id], date: '2026-02-01', lines: [{ method: 'cash', amountHalalas: 300000 }], notes: '' });
  // القسط الثالث من الرصيد الدائن
  applyTenantCredit(db, cid, { installmentId: insts[2].id, amountHalalas: 100000, date: '2026-03-01' });
  return { db, p, u, cid };
}

test('A2.1 الدفتر نفسه: نقدٌ ٣٬٠٠٠ وإيراد ٣٬٠٠٠ ولا رصيد دائن باقٍ (الأرقام الذهبية)', () => {
  const { db } = world();
  expect(accountBalance(db, '1100')).toBe(300000);
  expect(accountBalance(db, '4200')).toBe(300000);
  expect(accountBalance(db, '2410')).toBe(0);
  db.close();
});

test('A2.1 كشف حساب المستأجر: رصيده صفر بعد سداد القسط الثالث من رصيده الدائن', () => {
  const { db, cid } = world();
  const rows = tenantStatementRows(db, cid, '2026-03-15').filter((r) => !r.future);
  const balance = rows.reduce((s, r) => s + r.debitHalalas - r.creditHalalas, 0);
  // الأقساط الثلاثة المستحقة ٣٬٠٠٠ مدين، والمقبوض فعلاً ٣٬٠٠٠ دائن · فلا له ولا عليه
  expect(balance).toBe(0);
  db.close();
});

test('A2.1 «الدخل المحصَّل» في تقرير الوحدة والعقار يطابق النقد المقبوض (٣٬٠٠٠ لا ٤٬٠٠٠)', () => {
  const { db, p, u } = world();
  expect(unitReportData(db, u, null, '2026-12-31')!.totals.income).toBe(300000);
  expect(propertyReportData(db, p, null, '2026-12-31')!.totals.income).toBe(300000);
  db.close();
});

test('A2.1 بطاقة «إجمالي قيمة عقود الإيجار (المحصَّلة)» تطابق المقبوض', () => {
  const { db } = world();
  expect(portfolioStats(db, '2026-06-01').income).toBe(300000);
  db.close();
});

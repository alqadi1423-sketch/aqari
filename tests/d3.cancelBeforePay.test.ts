/**
 * التوجيه الثالث · ٠ · العطل المفتوح ٩ (قرار المالك 2026-11-07 «كل شيء يسويه الوكيل» · تحت القاعدة الدائمة للمال ١٠٠):
 * جهاز عضوٍ بإصدارٍ يسبق e13aa84 يلغي دفعة إيجار بتاريخٍ قبل تاريخها، فيقبله جهاز المالك كما هو (قيدٌ عاكسٌ بتاريخ الإلغاء ووسم
 * الدفعة، ومعهما حركة البنك ورصيد المستأجر إن كانا). كان الإقرار يُسقط الدفعة من البند ٥ في الربعين والدفتر يتحرك فيهما، فيتغيّر
 * المقدَّم ولا يطابق الدفتر. الأسلوب: يُقبل الإلغاء كاملاً كما كتبه (فلا يفترق سجل البنك عن الدفتر كما في 2d67829)، والإقرار يتبع
 * الدفتر بالضبط: الدفعة موجبةٌ في فترتها وإلغاؤها سالبٌ في فترته أيّاً كان ترتيبهما، ويتقابلان إن وقعا في فترةٍ واحدة.
 * بيانات مصطنعة، والأرقام محسوبة يدوياً.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract, recordRentPayment } from '@/domain/contracts/service';
import { reverseEntryById } from '@/domain/accounting/post';
import { recomputeInstallments } from '@/domain/contracts/paid';
import { vatReturnData } from '@/domain/vatReturn';
import { fileVatReturn, filedDiff } from '@/domain/vatFilings';
import type { DB } from '@/db/adapter';

type Q = 1 | 2 | 3 | 4;
const RANGE: Record<Q, [string, string]> = { 1: ['2026-01-01', '2026-03-31'], 2: ['2026-04-01', '2026-06-30'], 3: ['2026-07-01', '2026-09-30'], 4: ['2026-10-01', '2026-12-31'] };
const item5 = (db: DB, q: Q) => vatReturnData(db, 2026, q).items.find((x) => x.no === '5')!.amountHalalas;
/** صافي إيراد الإيجار (42xx، دائن موجب) في الدفتر خلال الربع */
const ledgerRent = (db: DB, q: Q) => Number(db.get<{ s: number }>(
  `SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
   WHERE l.account_code LIKE '42%' AND e.status = 'مرحّل' AND e.deleted_at IS NULL AND e.date >= ? AND e.date <= ?`, RANGE[q])!.s);

/** عقدٌ سكني (أو تجاري) شهريٌّ بقسطٍ ٢٬٠٠٠ ريال (٢٠٠٬٠٠٠ هللة)، ودفعةٌ نقدية لقسطه الرابع بتاريخها */
function world(payDate: string, shop = false) {
  const db = memDb();
  const u = addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'D9-1', rent: 200000 });
  if (shop) db.run(`UPDATE units SET type = 'محل' WHERE id = ?`, [u]);
  const cid = confirmContract(db, contractInput(u, { tenant: 'مستأجر مصطنع', idNumber: '1000000901', phone: '0500000901',
    start: '2026-01-01', valueHalalas: 2400000, cycle: 'شهرية', depositHalalas: 0 }));
  const i = db.all<{ id: string; amount_halalas: number }>(`SELECT id, amount_halalas FROM contract_installments WHERE contract_id = ? ORDER BY due_date`, [cid])[3];
  expect(Number(i.amount_halalas)).toBe(200000);
  const pay = recordRentPayment(db, cid, { installmentId: i.id, period: 'الرابع', date: payDate, lines: [{ method: 'cash', amountHalalas: 200000 }], discountHalalas: 0, notes: '' });
  return { db, pay, inst: i.id };
}

/** ما كتبه إصدار العضو القديم: عاكس قيد الدفعة بتاريخ الإلغاء ووسم الدفعة (بلا منع تاريخٍ قبلها) · ويصل جهاز المالك كما هو */
function legacyCancel(db: DB, pay: string, inst: string, date: string) {
  const p = db.get<{ e: string }>(`SELECT journal_entry_id AS e FROM contract_payments WHERE id = ?`, [pay])!;
  const rev = reverseEntryById(db, p.e, 'إلغاء دفعة مصطنع (إصدار قديم)', date)!;
  db.run(`UPDATE contract_payments SET cancelled_at = ?, cancel_entry_id = ?, cancel_reason = ? WHERE id = ?`, [date, rev.id, 'إصدار قديم مصطنع', pay]);
  recomputeInstallments(db, [inst]);
}

describe('العطل ٩ · إلغاءٌ بتاريخٍ قبل الدفعة من إصدار عضوٍ قديم', () => {
  test('٩ · الدفعة في الربع الثاني وإلغاؤها في الأول: البند ٥ يطابق الدفتر في الربعين (‎−٢٬٠٠٠ و‎+٢٬٠٠٠)', () => {
    const { db, pay, inst } = world('2026-04-02');
    legacyCancel(db, pay, inst, '2026-03-30');
    expect([ledgerRent(db, 1), ledgerRent(db, 2)]).toEqual([-200000, 200000]);
    expect([item5(db, 1), item5(db, 2)]).toEqual([-200000, 200000]);
    expect(vatReturnData(db, 2026, 1).schedules.exemptSales.map((r) => [r.date, r.net])).toEqual([['2026-03-30', -200000]]);
    expect(vatReturnData(db, 2026, 2).schedules.exemptSales.map((r) => [r.date, r.net])).toEqual([['2026-04-02', 200000]]);
    db.close();
  });

  test('٩ · والربع الثاني مقدَّمٌ قبل وصول الإلغاء: لا يتغيّر المقدَّم · والإلغاء في الربع الأول المفتوح', () => {
    const { db, pay, inst } = world('2026-04-02');
    fileVatReturn(db, 2026, 2, '2026-07-15');
    legacyCancel(db, pay, inst, '2026-03-30');
    expect(filedDiff(db, 2026, 2)).toEqual([]);
    expect(item5(db, 1)).toBe(-200000);
    db.close();
  });

  test('٩ · والإيجار التجاري كذلك: المحصَّل في ربعه والملغى سالبٌ في ربع إلغائه', () => {
    const { db, pay, inst } = world('2026-04-02', true);
    legacyCancel(db, pay, inst, '2026-03-30');
    expect([vatReturnData(db, 2026, 1).commercialRentHalalas, vatReturnData(db, 2026, 2).commercialRentHalalas]).toEqual([-200000, 200000]);
    expect(vatReturnData(db, 2026, 2).commercialRentCollectedHalalas).toBe(200000);
    expect([ledgerRent(db, 1), ledgerRent(db, 2)]).toEqual([-200000, 200000]);
    db.close();
  });

  test('٩ · وفي الربع نفسه (الدفعة ٢٠ مارس وإلغاؤها ٥ مارس): يتقابلان صفراً كالدفتر', () => {
    const { db, pay, inst } = world('2026-03-20');
    legacyCancel(db, pay, inst, '2026-03-05');
    expect([ledgerRent(db, 1), item5(db, 1), vatReturnData(db, 2026, 1).schedules.exemptSales.length]).toEqual([0, 0, 0]);
    db.close();
  });

  test('٩ · والإلغاء بعد الدفعة كما كان (البند ١٠): موجبٌ في ربعها وسالبٌ في ربع الإلغاء', () => {
    const { db, pay, inst } = world('2026-02-05');
    legacyCancel(db, pay, inst, '2026-04-10');
    expect([item5(db, 1), item5(db, 2)]).toEqual([200000, -200000]);
    expect([ledgerRent(db, 1), ledgerRent(db, 2)]).toEqual([200000, -200000]);
    db.close();
  });
});

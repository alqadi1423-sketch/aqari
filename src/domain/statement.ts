/**
 * سطور كشف حساب المستأجر · ما عليه (الأقساط القائمة والمطالبات) وما له (الدفعات الحيّة) بترتيب التاريخ.
 * الدفعة الملغاة لا تظهر سداداً (المراجعة ٤.٣) · فالكشف وثيقة تُسلَّم للمستأجر.
 * ومراجعة التثبيت #12: المطالبة المحصَّلة لها سطر دائن · وخصم «بعد الاستحقاق» يُطرح بسطر دائن
 * (قرار 2026-10-03: «عرض الاستحقاق يطرح الخصومات من النوعين»، و«تنزيل من القسط» نزل من مبلغ القسط نفسه) ·
 * والقسط الذي لم يحلّ بتاريخ الكشف «قادم» لا «مستحق»، ولا يدخل الرصيد المستحق.
 */
import type { DB } from '../db/adapter';
import type { StatementRow } from './printDocs';
import { INSTALLMENT_DISCOUNT_SQL, paymentSurplusSql } from './contracts/installments';
import { today } from './dates';
import { t } from '../i18n';

/** الكشف وثيقة عربية كلها كبقية سطورها (التحقق المستقل: لغة الواجهة الإنجليزية كانت تخلطها) */
const ar = (key: string): string => t(key, { lng: 'ar' });
const POSTED_ENTRY = 'مرحّل'; // i18n-exempt: حالة القيد المخزّنة

export function tenantStatementRows(db: DB, contractId: string, asOf: string = today()): StatementRow[] {
  const rows: StatementRow[] = [];
  for (const i of db.all<{ due_date: string; amount_halalas: number; paid_halalas: number; discount: number }>(
    `SELECT i.due_date, i.amount_halalas, i.paid_halalas, ${INSTALLMENT_DISCOUNT_SQL} AS discount FROM contract_installments i
     WHERE i.contract_id = ? AND i.status != 'ملغية' ORDER BY i.due_date`, [contractId])) {
    const future = i.due_date > asOf;
    const amount = Number(i.amount_halalas);
    const d = Number(i.discount) || 0;
    if (!future) {
      rows.push({ date: i.due_date, descr: 'قسط إيجار مستحق', debitHalalas: amount, creditHalalas: 0 });
    } else {
      // القسط القادم: ما سُدّد منه مقدماً (أو خُصم) يقابل دفعته في الرصيد الحالي، والباقي قادم لا يدخل الرصيد
      // (التحقق المستقل: كان القسط المسدَّد مقدماً يظهر رصيداً دائناً للمستأجر)
      const settled = Math.min(amount, (Number(i.paid_halalas) || 0) + d);
      if (settled > 0) rows.push({ date: i.due_date, descr: ar('statement.installmentPrepaid'), debitHalalas: settled, creditHalalas: 0 });
      if (amount - settled > 0) rows.push({ date: i.due_date, descr: ar('statement.installmentUpcoming'), debitHalalas: amount - settled, creditHalalas: 0, future: true });
    }
    if (d > 0) rows.push({ date: i.due_date, descr: ar('statement.installmentDiscount'), debitHalalas: 0, creditHalalas: d });
  }
  // القسط الملغى بعد سدادٍ جزئي: المسدَّد منه مدينٌ يقابل دفعته، فلا يظهر رصيدٌ دائن وهمي (دراسة القائم)
  for (const i of db.all<{ due_date: string; amount_halalas: number; paid_halalas: number }>(
    `SELECT due_date, amount_halalas, paid_halalas FROM contract_installments
     WHERE contract_id = ? AND status = ? AND paid_halalas > 0 ORDER BY due_date`,
    [contractId, 'ملغية'])) { // i18n-exempt: حالة مخزّنة
    const paid = Math.min(Number(i.amount_halalas), Number(i.paid_halalas));
    if (paid > 0) rows.push({ date: i.due_date, descr: ar('statement.installmentCancelledPaid'), debitHalalas: paid, creditHalalas: 0 });
  }
  // كل كشفٍ يتوازن وحده (المراجعة الشاملة 2026-11-13 · R12-DEP-4): الرصيد الدائن للمستأجر لا للعقد، فقد يُستعمل في عقدٍ آخر (التجديد،
  // ودمج مستأجرَين) · فالتحصيل بمبلغه كله ومعه سطرٌ مدين بفائضه الذي صار رصيداً (دائن 2410 في قيده)، والسداد من الرصيد بمبلغه في العقد
  // الذي استُعمل فيه · وفي العقد الواحد يتقابلان فلا يُعدّ الفائض مرتين (A2.1)
  for (const p of db.all<{ date: string; period: string; net_halalas: number; method_label: string; surplus: number }>(
    `SELECT p.date, p.period, p.net_halalas, p.method_label, ${paymentSurplusSql('p.')} AS surplus FROM contract_payments p
     WHERE p.contract_id = ? AND p.cancelled_at IS NULL ORDER BY p.date`, [contractId])) {
    rows.push({ date: p.date, descr: 'سداد' + (p.period ? ' · ' + p.period : '') + ' · ' + p.method_label, debitHalalas: 0, creditHalalas: Number(p.net_halalas) || 0 });
    const surplus = Number(p.surplus) || 0;
    if (surplus > 0) rows.push({ date: p.date, descr: ar('statement.surplusToCredit'), debitHalalas: surplus, creditHalalas: 0 });
  }
  // وفائضٌ قديم دخل إيراداً ثم حُوِّل رصيداً بأداة الفائض كذلك
  for (const e of db.all<{ date: string; n: number }>(
    `SELECT e.date, SUM(l.credit_halalas - l.debit_halalas) AS n FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.src_type = 'surplus_credit' AND e.src_id = ? AND e.reversed_by IS NULL AND e.deleted_at IS NULL AND e.status = ?
       AND l.account_code = '2410' GROUP BY e.id ORDER BY e.date`, [contractId, POSTED_ENTRY])) {
    if (Number(e.n) > 0) rows.push({ date: e.date, descr: ar('statement.surplusToCredit'), debitHalalas: Number(e.n), creditHalalas: 0 });
  }
  for (const cl of db.all<{ date: string; amount_halalas: number; reason: string; status: string; collected_at: string | null }>(
    `SELECT date, amount_halalas, reason, status, collected_at FROM claims WHERE contract_id = ? AND deleted_at IS NULL ORDER BY date`, [contractId])) {
    rows.push({ date: cl.date, descr: 'مطالبة · ' + (cl.reason || ''), debitHalalas: Number(cl.amount_halalas), creditHalalas: 0 });
    if (cl.status === 'محصَّلة') { // i18n-exempt: قيمة مخزّنة
      rows.push({ date: cl.collected_at || cl.date, descr: ar('statement.claimCollected') + ' · ' + (cl.reason || ''), debitHalalas: 0, creditHalalas: Number(cl.amount_halalas) });
    }
  }
  // القادمة بعد المستحقة دائماً · ثم بالتاريخ
  return rows.sort((a, b) => (Number(!!a.future) - Number(!!b.future)) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * سطور كشف حساب المستأجر · ما عليه (الأقساط القائمة والمطالبات) وما له (الدفعات الحيّة) بترتيب التاريخ.
 * الدفعة الملغاة لا تظهر سداداً (المراجعة ٤.٣) · فالكشف وثيقة تُسلَّم للمستأجر.
 * ومراجعة التثبيت #12: المطالبة المحصَّلة لها سطر دائن · وخصم «بعد الاستحقاق» يُطرح بسطر دائن
 * (قرار 2026-10-03: «عرض الاستحقاق يطرح الخصومات من النوعين»، و«تنزيل من القسط» نزل من مبلغ القسط نفسه) ·
 * والقسط الذي لم يحلّ بتاريخ الكشف «قادم» لا «مستحق»، ولا يدخل الرصيد المستحق.
 */
import type { DB } from '../db/adapter';
import type { StatementRow } from './printDocs';
import { INSTALLMENT_DISCOUNT_SQL } from './contracts/installments';
import { today } from './dates';
import { t } from '../i18n';

/** الكشف وثيقة عربية كلها كبقية سطورها (التحقق المستقل: لغة الواجهة الإنجليزية كانت تخلطها) */
const ar = (key: string): string => t(key, { lng: 'ar' });

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
  for (const p of db.all<{ date: string; period: string; net_halalas: number; method_label: string }>(
    `SELECT date, period, net_halalas, method_label FROM contract_payments
     WHERE contract_id = ? AND cancelled_at IS NULL ORDER BY date`, [contractId])) {
    rows.push({ date: p.date, descr: 'سداد' + (p.period ? ' · ' + p.period : '') + ' · ' + p.method_label, debitHalalas: 0, creditHalalas: Number(p.net_halalas) });
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

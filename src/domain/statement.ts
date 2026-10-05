/**
 * سطور كشف حساب المستأجر · ما عليه (الأقساط القائمة والمطالبات) وما له (الدفعات الحيّة) بترتيب التاريخ.
 * الدفعة الملغاة لا تظهر سداداً (المراجعة ٤.٣) · فالكشف وثيقة تُسلَّم للمستأجر.
 */
import type { DB } from '../db/adapter';
import type { StatementRow } from './printDocs';

export function tenantStatementRows(db: DB, contractId: string): StatementRow[] {
  const rows: StatementRow[] = [];
  for (const i of db.all<{ due_date: string; amount_halalas: number }>(
    `SELECT due_date, amount_halalas FROM contract_installments
     WHERE contract_id = ? AND status != 'ملغية' ORDER BY due_date`, [contractId])) {
    rows.push({ date: i.due_date, descr: 'قسط إيجار مستحق', debitHalalas: Number(i.amount_halalas), creditHalalas: 0 });
  }
  for (const p of db.all<{ date: string; period: string; net_halalas: number; method_label: string }>(
    `SELECT date, period, net_halalas, method_label FROM contract_payments
     WHERE contract_id = ? AND cancelled_at IS NULL ORDER BY date`, [contractId])) {
    rows.push({ date: p.date, descr: 'سداد' + (p.period ? ' · ' + p.period : '') + ' · ' + p.method_label, debitHalalas: 0, creditHalalas: Number(p.net_halalas) });
  }
  for (const cl of db.all<{ date: string; amount_halalas: number; reason: string }>(
    `SELECT date, amount_halalas, reason FROM claims WHERE contract_id = ? AND deleted_at IS NULL ORDER BY date`, [contractId])) {
    rows.push({ date: cl.date, descr: 'مطالبة · ' + (cl.reason || ''), debitHalalas: Number(cl.amount_halalas), creditHalalas: 0 });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

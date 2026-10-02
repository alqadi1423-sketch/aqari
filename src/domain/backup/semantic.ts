/**
 * الفحص الدلالي لقاعدة واردة (استعادة اليوم، والمزامنة والاستيراد غداً) ·
 * integrity_check يثبت أن الملف سليم البنية لا أن الدفتر سليم المعنى. فهنا قواعد
 * القاعدة نفسها تُطبَّق على ما كُتب قبل وجودها أو خارجها:
 *  ١) لا قيد مرحّل غير متوازن ولا قيد مرحّل بلا سطور.
 *  ٢) لا قسط مسدَّده مع مجموع خصومه يتجاوز مبلغه، ولا مسدَّد سالب.
 *  ٣) لا دفعة على قسط بصافٍ أو خصم سالب.
 * كل بند جملة عربية تسمّي موضعه · وأي بند يرفض القاعدة كاملة.
 */
import type { DB } from '../../db/adapter';
import { fmt } from '../money';

const SHOW = 5;

function listOf(items: string[], total: number): string {
  return items.join('، ') + (total > items.length ? ` و${total - items.length} غيرها` : '');
}

export function semanticIssues(db: DB): string[] {
  const out: string[] = [];

  const unbalanced = db.all<{ no: string; diff: number }>(
    `SELECT e.no, SUM(l.debit_halalas - l.credit_halalas) AS diff
     FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.status = 'مرحّل'
     GROUP BY e.id HAVING diff != 0 ORDER BY e.no`
  );
  if (unbalanced.length) {
    out.push('قيد مرحّل غير متوازن: ' + listOf(
      unbalanced.slice(0, SHOW).map((r) => `${r.no} (الفرق ${fmt(Math.abs(Number(r.diff)))})`),
      unbalanced.length));
  }

  const lineless = db.all<{ no: string }>(
    `SELECT e.no FROM journal_entries e
     WHERE e.status = 'مرحّل' AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id)
     ORDER BY e.no`
  );
  if (lineless.length) {
    out.push('قيد مرحّل بلا سطور: ' + listOf(lineless.slice(0, SHOW).map((r) => r.no), lineless.length));
  }

  // الخصوم مجمَّعة مرة واحدة لا استعلاماً لكل قسط
  const over = db.all<{ tenant: string | null; contract_no: string | null; due: string; amount: number; paid: number; disc: number }>(
    `WITH d AS (
       SELECT installment_id, SUM(discount_halalas) AS s FROM contract_payments
       WHERE installment_id IS NOT NULL GROUP BY installment_id
     )
     SELECT c.tenant_name AS tenant, c.contract_no, i.due_date AS due,
            i.amount_halalas AS amount, i.paid_halalas AS paid, COALESCE(d.s, 0) AS disc
     FROM contract_installments i
     LEFT JOIN d ON d.installment_id = i.id
     LEFT JOIN contracts c ON c.id = i.contract_id
     WHERE i.paid_halalas < 0 OR i.paid_halalas + COALESCE(d.s, 0) > i.amount_halalas
     ORDER BY i.due_date`
  );
  if (over.length) {
    out.push('قسط يتجاوز المسدَّدُ مع الخصم مبلغَه أو مسدَّده سالب: ' + listOf(
      over.slice(0, SHOW).map((r) =>
        `${r.tenant || 'بلا مستأجر'} · ${r.contract_no || 'بلا رقم عقد'} · ${r.due} (${fmt(Number(r.paid) + Number(r.disc))} من ${fmt(Number(r.amount))})`),
      over.length));
  }

  const negative = db.all<{ tenant: string | null; date: string }>(
    `SELECT c.tenant_name AS tenant, p.date FROM contract_payments p
     LEFT JOIN contracts c ON c.id = p.contract_id
     WHERE p.installment_id IS NOT NULL AND (p.net_halalas < 0 OR p.discount_halalas < 0)
     ORDER BY p.date`
  );
  if (negative.length) {
    out.push('دفعة على قسط بصافٍ أو خصم سالب: ' + listOf(
      negative.slice(0, SHOW).map((r) => `${r.tenant || 'بلا مستأجر'} · ${r.date}`), negative.length));
  }

  return out;
}

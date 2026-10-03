/**
 * مسدَّد القسط يُحسب من الدفعات وتوزيعها · لا يُكتب رقماً ولا يُزامَن رقماً (قرار المالك ٢٠٢٦-١٠-٠٣).
 *
 * المسدَّد = صافي الدفعات الفردية غير الملغاة على القسط (الدفعة التي لها توزيع تُحسب بتوزيعها
 * وحده فلا تُحسب مرتين) + حصة القسط من توزيع التحصيل الجماعي غير الملغى.
 * والعمود paid_halalas نسخةٌ للقراءة السريعة يعيد حسابَها كلُّ ما يغيّر الدفعات: الدفعة والإلغاء
 * والمزامنة والاستعادة · ويُحدّ بمبلغ القسط ناقصاً خصمه، فما زاد (قسطٌ حُصّل من جهازين بلا اتصال)
 * يبقى نقداً في الدفتر ويظهر فائضاً في أداة «رد الفائض» حتى يُرد أو يُحوَّل رصيداً.
 * والحالة تُشتق معه: «مدفوعة» أو «مدفوعة جزئياً» أو «مستحقة» · و«ملغية» قرارٌ لا يُمسّ.
 */
import type { DB } from '../../db/adapter';
import { INSTALLMENT_DISCOUNT_SQL } from './installments';

/** مجموع ما دُفع على القسط i من الدفعات وتوزيعها · نصّ SQL على اسم الجدول المستعار i */
export const DERIVED_PAID_SQL = `(COALESCE((SELECT SUM(p.net_halalas) FROM contract_payments p
    WHERE p.installment_id = i.id AND p.cancelled_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id = p.id)), 0)
  + COALESCE((SELECT SUM(a.amount_halalas) FROM payment_allocations a
    JOIN contract_payments p ON p.id = a.payment_id
    WHERE a.installment_id = i.id AND p.cancelled_at IS NULL), 0))`;

export interface PaidChange {
  installmentId: string;
  contractId: string;
  due: string;
  fromPaid: number;
  toPaid: number;
  /** ما دُفع فوق مبلغ القسط ناقصاً خصمه · يظهر فائضاً */
  excess: number;
}

/** الحالة المخزَّنة من المبلغ والمسدَّد والخصم */
export function derivedStatus(amount: number, paid: number, discount: number): 'مدفوعة' | 'مدفوعة جزئياً' | 'مستحقة' {
  if (amount - paid - discount <= 0) return 'مدفوعة';
  return paid + discount > 0 ? 'مدفوعة جزئياً' : 'مستحقة';
}

/**
 * يعيد حساب مسدَّد الأقساط وحالتها من الدفعات · كلها أو المحدَّدة منها.
 * يكتب ما تغيّر وحده ويعيد قائمته · والقسط «الملغية» لا يُمسّ.
 */
export function recomputeInstallments(db: DB, installmentIds?: string[]): PaidChange[] {
  const scope = installmentIds
    ? (installmentIds.length ? `i.id IN (${installmentIds.map(() => '?').join(',')})` : '0')
    : '1';
  const rows = db.all<{ id: string; contract_id: string; due: string; amount: number; paid: number; status: string; disc: number; derived: number }>(
    `SELECT i.id, i.contract_id, i.due_date AS due, i.amount_halalas AS amount, i.paid_halalas AS paid, i.status,
            ${INSTALLMENT_DISCOUNT_SQL} AS disc, ${DERIVED_PAID_SQL} AS derived
     FROM contract_installments i WHERE ${scope} AND i.status != 'ملغية'`, installmentIds ?? []);
  const changes: PaidChange[] = [];
  db.transaction(() => {
    for (const r of rows) {
      const amount = Number(r.amount);
      const disc = Number(r.disc);
      const derived = Number(r.derived);
      const cap = Math.max(0, amount - disc);
      const paid = Math.min(derived, cap);
      const status = derivedStatus(amount, paid, disc);
      if (paid === Number(r.paid) && status === r.status) continue;
      db.run(`UPDATE contract_installments SET paid_halalas = ?, status = ? WHERE id = ?`, [paid, status, r.id]);
      changes.push({ installmentId: r.id, contractId: r.contract_id, due: r.due, fromPaid: Number(r.paid), toPaid: paid, excess: Math.max(0, derived - cap) });
    }
  });
  return changes;
}

/** أقساط دفعةٍ بعينها · قسطها المباشر وأقساط توزيعها */
export function installmentsOfPayment(db: DB, paymentId: string): string[] {
  return db.all<{ id: string }>(
    `SELECT installment_id AS id FROM contract_payments WHERE id = ? AND installment_id IS NOT NULL
     UNION SELECT installment_id FROM payment_allocations WHERE payment_id = ?`, [paymentId, paymentId]).map((r) => r.id);
}

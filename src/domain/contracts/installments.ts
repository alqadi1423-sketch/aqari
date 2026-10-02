import { toLocalISODate } from '../dates';
import { uid } from '../ids';

/**
 * خصم القسط · لا عمود له، فيُشتقّ من دفعاته: مجموع `discount_halalas` في contract_payments.
 * يُضمَّن في أي استعلام يقرأ من `contract_installments i` · فالمتبقي = القسط ناقص المسدَّد ناقص الخصم،
 * ولا يُطوى الخصم في المسدَّد بل يُعرض بنداً ظاهراً.
 */
export const INSTALLMENT_DISCOUNT_SQL =
  `COALESCE((SELECT SUM(p.discount_halalas) FROM contract_payments p WHERE p.installment_id = i.id), 0)`;

/** المتبقّي على القسط · القاعدة الواحدة لكل شاشة وحساب */
export function installmentRemaining(amountHalalas: number, paidHalalas: number, discountHalalas: number): number {
  return Math.max(0, Number(amountHalalas) - Number(paidHalalas) - Number(discountHalalas));
}

/** الحالة المخزَّنة بعد دفعة · «مدفوعة» متى ما غطّى المسدَّدُ والخصمُ القسطَ */
export function installmentStoredStatus(amountHalalas: number, paidHalalas: number, discountHalalas: number): 'مدفوعة' | 'مدفوعة جزئياً' {
  return installmentRemaining(amountHalalas, paidHalalas, discountHalalas) <= 0 ? 'مدفوعة' : 'مدفوعة جزئياً';
}

export const CYCLE_MONTHS: Record<string, number> = {
  'شهرية': 1, 'ربع سنوية': 3, 'نصف سنوية': 6, 'سنوية': 12,
};

export interface GeneratedInstallment {
  id: string;
  dueDate: string;
  amountHalalas: number;
}

/**
 * توليد جدول الدفعات · خوارزمية النموذج حرفياً بالهللات:
 * عدد الأشهر من المدة/30.44، عدد الدفعات بالدورة، والقسط الأخير يمتص فرق التقريب.
 * يُولَّد عند الإنشاء ولا يُعاد توليده.
 */
export function generateInstallments(
  start: string,
  end: string,
  valueHalalas: number,
  cycle: string
): GeneratedInstallment[] {
  if (!start || !end || !valueHalalas) return [];
  const stepMonths = CYCLE_MONTHS[cycle] || 12;
  const startD = new Date(start + 'T00:00:00');
  const endD = new Date(end + 'T00:00:00');
  const totalDays = Math.round((endD.getTime() - startD.getTime()) / 86400000) + 1; // شامل يومي البداية والنهاية
  const totalMonths = Math.max(1, Math.round(totalDays / 30.44));
  const count = Math.max(1, Math.round(totalMonths / stepMonths));
  const amountPer = Math.round(valueHalalas / count);
  const out: GeneratedInstallment[] = [];
  let cursor = new Date(startD);
  let allocated = 0;
  for (let i = 0; i < count; i++) {
    const amt = i === count - 1 ? valueHalalas - allocated : amountPer;
    allocated += amt;
    out.push({ id: uid(), dueDate: toLocalISODate(cursor), amountHalalas: amt });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + stepMonths, cursor.getDate());
  }
  return out;
}

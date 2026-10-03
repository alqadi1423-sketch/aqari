import { toLocalISODate } from '../dates';
import { uid } from '../ids';

/** حساب الخصومات الممنوحة · بنوع مصروف */
export const DISCOUNT_ACCOUNT = '4900';
/** مصدر قيد الخصم المنفصل · مربوط بقسطه (قيود ما قبل التطبيق) أو بدفعته (ما يُنشأ بأثر رجعي) */
export const DISCOUNT_ENTRY_SRC = 'discount';

/** نوعا الخصم · يُحفظ أحدهما مع كل دفعة فيها خصم */
export const DISCOUNT_AFTER_DUE = 'بعد الاستحقاق';
export const DISCOUNT_REDUCES_INSTALLMENT = 'تنزيل من القسط';
export type DiscountKind = typeof DISCOUNT_AFTER_DUE | typeof DISCOUNT_REDUCES_INSTALLMENT;
export const DISCOUNT_KINDS: readonly DiscountKind[] = [DISCOUNT_AFTER_DUE, DISCOUNT_REDUCES_INSTALLMENT];

/**
 * خصم القسط من الدفتر · لا عمود له، فيُشتقّ من سطور حساب الخصم 4900 في القيود المرحّلة غير المعكوسة:
 *  ١) قيود الخصم المربوطة بالقسط نفسه.
 *  ٢) قيود دفعاته (خصم «بعد الاستحقاق» في قيد الدفعة نفسه).
 *  ٣) قيود الخصم المربوطة بإحدى دفعاته (ما يُنشأ بأثر رجعي).
 *  ٤) وخصم الدفعة القديمة الذي لا سطر له في الدفتر يُعدّ بقيمته في صفّها ما لم يكن لعقدها قيود خصم،
 *     حتى يُحدَّد نوعه · فلا يظهر دينٌ لم يكن قبل التحديد.
 * وخصم «تنزيل من القسط» لا سطر له: نزل من مبلغ القسط نفسه فلا يُعدّ هنا ثانية.
 * النص نفسه في محفّزات السقف (الهجرة ٢٠) · يُضمَّن في أي استعلام يقرأ من `contract_installments i`،
 * فالمتبقي = القسط ناقص المسدَّد ناقص الخصم، ولا يُطوى الخصم في المسدَّد بل يُعرض بنداً ظاهراً.
 */
export const INSTALLMENT_DISCOUNT_SQL = `(COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
    FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
    WHERE e.src_type = 'discount' AND e.src_id = i.id AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
  + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
    FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
    JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
    WHERE p.installment_id = i.id AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
  + COALESCE((SELECT SUM(l.debit_halalas - l.credit_halalas)
    FROM contract_payments p JOIN journal_entries e ON e.src_type = 'discount' AND e.src_id = p.id
    JOIN journal_lines l ON l.entry_id = e.id AND l.account_code = '4900'
    WHERE p.installment_id = i.id AND e.status = 'مرحّل' AND e.reversed_by IS NULL), 0)
  + COALESCE((SELECT SUM(p.discount_halalas) FROM contract_payments p
    WHERE p.installment_id = i.id AND p.cancelled_at IS NULL AND p.discount_kind IS NULL AND p.discount_halalas > 0
      AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = p.journal_entry_id AND l.account_code = '4900')
      AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.src_type = 'discount' AND e.src_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM contract_installments i2
                      JOIN journal_entries e ON e.src_type = 'discount' AND e.src_id = i2.id
                      WHERE i2.contract_id = p.contract_id)), 0))`;

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

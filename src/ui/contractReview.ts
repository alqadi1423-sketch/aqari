/**
 * أرقام «مراجعة بيانات العقد» قبل الإنشاء · D-14 (المراجعة الشاملة 2026-11-13).
 *
 * الخانة التي لم تُكتب غائبةٌ لا صفر: تاريخٌ غائب نصٌّ خالٍ لا «لا يوجد»، والمدة وعدد الدفعات وقيمة العقد والتأمين
 * null حتى تُكتب مدخلاتها، فيُسقط صفّها بعنوانه (قرار المالك 2026-09-09) · والصفر المكتوب قيمةٌ تُعرض.
 * دالةٌ خالصة بلا React Native لتُختبر وحدها.
 */
import { approxMonths, dfmtOut } from '../domain/dates';
import { toHalalas } from '../domain/money';

export interface ContractReviewFigures {
  start: string;
  end: string;
  months: number | null;
  count: number | null;
  each: number | null;
  value: number | null;
  deposit: number | null;
}

/** per: أشهر الدورة الواحدة (١ للشهرية، ١٢ للسنوية) */
export function contractReviewFigures(form: { start: string; end: string; value: string; deposit: string }, per: number): ContractReviewFigures {
  const months = form.start && form.end ? Math.max(1, approxMonths(form.start, form.end)) : null;
  const value = String(form.value ?? '').trim() ? toHalalas(form.value) : null;
  const count = months != null ? Math.max(1, Math.round(months / Math.max(1, per))) : null;
  return {
    start: dfmtOut(form.start),
    end: dfmtOut(form.end),
    months,
    count,
    each: count != null && value != null ? Math.round(value / count) : null,
    value,
    deposit: String(form.deposit ?? '').trim() ? toHalalas(form.deposit) : null,
  };
}

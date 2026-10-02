/**
 * المال كله أعداد صحيحة بالهللات. لا REAL في أي حقل مالي.
 */

/** ريالات (نص أو رقم من إدخال المستخدم) ← هللات، بتقريب نصفي */
export function toHalalas(riyals: string | number | null | undefined): number {
  const n = typeof riyals === 'string' ? parseFloat(riyals.replace(/[,،\s]/g, '')) : riyals;
  if (n == null || !isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function toRiyals(halalas: number): number {
  return halalas / 100;
}

/** التنسيق المعروض · مطابق لـ fmt() في النموذج: en-US بمنزلتين */
export function fmt(halalas: number): string {
  const n = toRiyals(Number(halalas) || 0);
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** ضرب كمية (قد تكون كسرية) في سعر بالهللات مع تقريب لهللة */
export function mulQty(qty: number, priceHalalas: number): number {
  return Math.round(qty * priceHalalas);
}

/** نسبة مئوية من مبلغ بالهللات */
export function pctOf(halalas: number, pct: number): number {
  return Math.round((halalas * pct) / 100);
}

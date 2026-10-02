/**
 * كل التواريخ نصوص ISO محلية yyyy-mm-dd · لا toISOString (UTC) إطلاقاً.
 */

export function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function today(): string {
  return toLocalISODate(new Date());
}

/** العرض dd/mm/yyyy · مطابق لـ dfmt في النموذج */
export function dfmt(iso: string | null | undefined): string {
  if (!iso) return 'لا يوجد';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  if (!y || !m || !d) return String(iso);
  return `${d}/${m}/${y}`;
}

/** فرق الأيام: كم مضى من b حتى a (موجب = a بعد b) */
export function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(a + 'T00:00:00').getTime() - new Date(b + 'T00:00:00').getTime()) / 86400000
  );
}

/** إضافة أشهر مع تثبيت اليوم لآخر يوم في الشهر عند اللزوم (منطق renewAddMonths محلياً) */
export function addMonthsClamped(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, last));
  return toLocalISODate(t);
}

/** إضافة أيام */
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toLocalISODate(d);
}

/** مدة العقد: بداية + أشهر - يوم واحد (العقد ينتهي بآخر يوم بالمدة) */
export function contractEndFromDuration(start: string, months: number): string {
  const d = new Date(start + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  d.setDate(d.getDate() - 1);
  return toLocalISODate(d);
}

/** عدد الأشهر التقريبي بين تاريخين · نفس ثابت النموذج 2629800000 مللي ثانية */
export function approxMonths(start: string, end: string): number {
  return Math.round(
    (new Date(end + 'T00:00:00').getTime() - new Date(start + 'T00:00:00').getTime()) / 2629800000
  );
}

export const ARABIC_MONTHS_SHORT = [
  'ينا','فبر','مار','أبر','ماي','يون','يول','أغس','سبت','أكت','نوف','ديس',
];

/** تسمية فترة القسط: «ينا 2026» */
export function periodLabel(dueDate: string): string {
  const d = new Date(dueDate + 'T00:00:00');
  return ARABIC_MONTHS_SHORT[d.getMonth()] + ' ' + d.getFullYear();
}

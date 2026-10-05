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
  // الطابع الزمني (فيه ساعة) يُعرض بيومه المحلي لا يوم UTC (المراجعة ٤.١٤)
  const s = String(iso);
  const [y, m, d] = (s.length > 10 && s[10] === 'T' ? localDateOf(s) : s.slice(0, 10)).split('-');
  if (!y || !m || !d) return String(iso);
  return `${d}/${m}/${y}`;
}

/**
 * الطابع الزمني المخزَّن لحظةٌ بتوقيت UTC (toISOString، أو بلا علامة Z في سجل العمليات) ·
 * يُعرض بيومه وساعته المحليين (المراجعة ٤.١٤)، فلا يظهر ما بعد منتصف الليل باليوم السابق.
 */
function stampToDate(stamp: string): Date {
  const s = String(stamp);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
}
export function localDateOf(stamp: string): string {
  return toLocalISODate(stampToDate(stamp));
}
export function localTimeOf(stamp: string): string {
  const d = stampToDate(stamp);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** حدود «هذا الشهر» و«هذا الربع» و«هذه السنة» بالتقويم المحلي */
export function periodBounds(kind: 'month' | 'quarter' | 'year', now: Date = new Date()): { from: string; to: string } {
  const y = now.getFullYear();
  if (kind === 'month') return { from: toLocalISODate(new Date(y, now.getMonth(), 1)), to: toLocalISODate(new Date(y, now.getMonth() + 1, 0)) };
  if (kind === 'quarter') {
    const qs = Math.floor(now.getMonth() / 3) * 3;
    return { from: toLocalISODate(new Date(y, qs, 1)), to: toLocalISODate(new Date(y, qs + 3, 0)) };
  }
  return { from: y + '-01-01', to: y + '-12-31' };
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
  // المراجعة ٤.٨: الذكرى تُثبَّت على آخر الشهر · فإن ثُبّتت (يوم البداية بعد آخر أيام شهر الذكرى)
  // فالنهاية آخر ذلك الشهر نفسه، وإلا فاليوم الذي قبل الذكرى. ٣١ يناير بشهر ← ٢٨ فبراير، و٣١ يناير بسنة ← ٣٠ يناير
  const day = Number(start.slice(8, 10));
  const anniversary = addMonthsClamped(start, months);
  return Number(anniversary.slice(8, 10)) < day ? anniversary : addDays(anniversary, -1);
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

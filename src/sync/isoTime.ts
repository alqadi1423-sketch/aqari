/**
 * أوقات ISO بدقة كسورٍ مختلفة (المراجعة الشاملة · البندان ٢ و١٦): وقت الخادم بأجزاء المليون أو المليار، ووقت الجهاز بأجزاء الألف ·
 * والمقارنة نصاً تخطئ بينهما ("…00.5Z" > "…00.123Z")، ومحرّك الجوال قد لا يقرأ أكثر من ثلاثة أجزاء من الثانية ·
 * فاللحظة تُقرأ من الثواني وأجزاء الألف وحدها، والمقارنة بها.
 */

const ISO = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/;

/** اللحظة بالمللي ثانية · NaN لما ليس وقتاً */
export function isoMs(s: string | null | undefined): number {
  if (!s) return NaN;
  const m = ISO.exec(s);
  if (!m) return Date.parse(s);
  return Date.parse(m[1] + '.' + (m[2] ?? '').padEnd(3, '0').slice(0, 3) + m[3]);
}

/** الوقت بصيغة واحدة ثابتة (أجزاء الألف، UTC) · وما ليس وقتاً كما هو */
export function isoNorm(s: string): string {
  const t = isoMs(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : s;
}

/** مقارنة وقتين باللحظة لا بالنص · ما ليس وقتاً يُقارن نصاً كما كان */
export function isoCmp(a: string, b: string): number {
  const x = isoMs(a), y = isoMs(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x === y ? 0 : x < y ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

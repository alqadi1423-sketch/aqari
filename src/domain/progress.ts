/**
 * تقدّم العمليات الطويلة (توجيه المالك ٢٠٢٦-١٠-٠٧): كل تنزيل ورفع واستعادة ونسخ يعرض النسبة،
 * والحجم المنجز من الكلي، وزر إلغاء · وإن لم يتقدم دقيقةً كاملة ظهر ذلك مع إعادة المحاولة.
 * منطق خالص: الرسالة نصٌّ كما كانت، ومعها مقدارٌ اختياري (بايتات أو عدد) تُحسب منه النسبة والحجم.
 */

export interface ProgressInfo {
  done: number;
  total: number;
  /** بايتات: يُعرض الحجم «٢٫٤ م.ب من ٥٨ م.ب» · عدد: «٣ من ١٢» */
  unit: 'bytes' | 'items';
}

/** نداء التقدم · والنداء القديم بالنص وحده يوافقه */
export type ProgressFn = (msg: string, info?: ProgressInfo) => void;

/* ═══════════ الإلغاء ═══════════ */

export class CancelledError extends Error {
  constructor() {
    super('أُلغيت العملية');
    this.name = 'CancelledError';
  }
}

export interface CancelSignal {
  readonly cancelled: boolean;
  /** يُنادى عند الإلغاء (أو فوراً إن أُلغي) · ويعيد ما يفكّ الاشتراك */
  onCancel(fn: () => void): () => void;
}

export function cancelSource(): { signal: CancelSignal; cancel(): void } {
  let cancelled = false;
  const subs = new Set<() => void>();
  const signal: CancelSignal = {
    get cancelled() { return cancelled; },
    onCancel(fn) {
      if (cancelled) { fn(); return () => {}; }
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  return {
    signal,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const fn of [...subs]) { try { fn(); } catch { /* المشترك لا يعطّل الإلغاء */ } }
      subs.clear();
    },
  };
}

/** نقطة توقّف آمنة · تُرمى عندها CancelledError إن طُلب الإلغاء */
export function throwIfCancelled(signal?: CancelSignal | null): void {
  if (signal?.cancelled) throw new CancelledError();
}

export const isCancelled = (e: unknown): boolean => e instanceof CancelledError;

/* ═══════════ العرض ═══════════ */

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const ar = (s: string) => s.replace(/\d/g, (d) => AR_DIGITS[Number(d)]).replace(/\./g, '٫');

/** الحجم بوحدته · بايت، ك.ب، م.ب، ج.ب */
export function fmtBytes(n: number): string {
  const v = Math.max(0, n);
  if (v < 1024) return ar(String(Math.round(v))) + ' بايت';
  const units = ['ك.ب', 'م.ب', 'ج.ب'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return ar(x >= 100 ? String(Math.round(x)) : x.toFixed(1)) + ' ' + units[i];
}

export interface ProgressView {
  /** النسبة ٠–١٠٠ · null حين لا يُعرف الكلي (شريط غير محدد) */
  pct: number | null;
  /** «٢٫٤ م.ب من ٥٨ م.ب» أو «٣ من ١٢» · null بلا مقدار */
  amount: string | null;
}

/** ما يُعرض من رسالة ومقدار · والرسائل القديمة «… · N من M» تُفهم كذلك */
export function progressView(msg: string, info?: ProgressInfo | null): ProgressView {
  let i = info ?? null;
  if (!i) {
    const m = msg.match(/·\s*(\d+)\s*من\s*(\d+)\s*$/);
    if (m) i = { done: Number(m[1]), total: Number(m[2]), unit: 'items' };
  }
  if (!i || !(i.total > 0)) return { pct: null, amount: null };
  const pct = Math.max(0, Math.min(100, Math.floor((i.done / i.total) * 100)));
  const amount = i.unit === 'bytes'
    ? fmtBytes(i.done) + ' من ' + fmtBytes(i.total)
    : ar(String(i.done)) + ' من ' + ar(String(i.total));
  return { pct, amount };
}

/* ═══════════ التوقّف ═══════════ */

/** دقيقة كاملة بلا تقدّم = توقّف ظاهر للمستخدم */
export const STALL_MS = 60_000;

/**
 * يرصد آخر تقدّم حقيقي · الرسالة نفسها والمقدار نفسه لا يُعدّان تقدّماً،
 * فشاشةٌ تعيد الرسالة ذاتها كل ثانية وهي عالقة تُعرف عالقة.
 */
export class StallWatch {
  private last = '';
  private at: number;
  constructor(private now: () => number = Date.now) { this.at = now(); }
  /** يُنادى مع كل نداء تقدّم · ويعيد true إن كان تقدّماً حقيقياً */
  tick(msg: string, info?: ProgressInfo | null): boolean {
    const key = msg + '|' + (info ? info.done + '/' + info.total : '');
    if (key === this.last) return false;
    this.last = key;
    this.at = this.now();
    return true;
  }
  /** بدء محاولة جديدة · العدّ من الآن */
  reset(): void { this.last = ''; this.at = this.now(); }
  stalled(): boolean { return this.now() - this.at >= STALL_MS; }
  sinceMs(): number { return this.now() - this.at; }
}

/** الرسالة بلا ذيل «· N من M» · فالمقدار يُعرض في سطره */
export const progressLabel = (msg: string): string => msg.replace(/\s*·\s*\d+\s*من\s*\d+\s*$/, '');

/**
 * سطر المقدار: «٤٢٪، ٢٫٤ م.ب من ٥٨ م.ب» · فارغ بلا مقدار ·
 * بفاصلةٍ عربية لا بنقطة «·»: النقطة بين رقمين عربيين تُقرأ صفراً («١ · ٣٣» ← «١٠٣٣») كما ظهر على الجهاز
 */
export function progressLine(v: ProgressView): string {
  return [v.pct !== null ? ar(String(v.pct)) + '٪' : null, v.amount].filter(Boolean).join('، ');
}

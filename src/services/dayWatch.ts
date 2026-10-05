/**
 * مراقب اليوم (المراجعة ٤.١٥) · المتأخرات وأيامها والحالات تُحسب بـ«اليوم»، والتبويبات تبقى حيّة،
 * فبتغيّر اليوم والتطبيق مفتوح، أو بالعودة من الخلفية في يوم آخر، يُبلَّغ المتجر فتُعاد الحسبة.
 * خالٍ من React Native · الساعة والمؤقت وحدث العودة تُمرَّر إليه فيُختبر.
 */
import { toLocalISODate } from '../domain/dates';

/** ما بقي حتى منتصف الليل المحلي */
export function msUntilNextDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

export interface DayWatchIO {
  now: () => Date;
  onNewDay: (day: string) => void;
  /** الاشتراك في عودة التطبيق للواجهة · يعيد دالة الإلغاء */
  onActive: (cb: () => void) => () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
}

export function startDayWatch(io: DayWatchIO): () => void {
  let day = toLocalISODate(io.now());
  let timer: unknown = null;
  const check = () => {
    const d = toLocalISODate(io.now());
    if (d !== day) { day = d; io.onNewDay(d); }
  };
  const arm = () => {
    if (timer !== null) io.clearTimer(timer);
    // ثانية بعد منتصف الليل · فلا يسبق المؤقتُ اليومَ بفارق الساعة
    timer = io.setTimer(() => { timer = null; check(); arm(); }, msUntilNextDay(io.now()) + 1000);
  };
  arm();
  const off = io.onActive(() => { check(); arm(); });
  return () => { off(); if (timer !== null) io.clearTimer(timer); timer = null; };
}

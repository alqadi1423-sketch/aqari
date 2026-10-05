/**
 * المراجعة ٤.١٥ · الشاشات تتحدث بتغيّر اليوم والتطبيق مفتوح: عند منتصف الليل، وعند العودة من الخلفية في يوم آخر.
 * ساعة ومؤقت مصطنعان · بلا بيئة React Native.
 */
process.env.TZ = 'Asia/Riyadh';
import { startDayWatch, msUntilNextDay } from '@/services/dayWatch';

function harness(start: Date) {
  let now = start;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let seq = 0;
  let activeCb: (() => void) | null = null;
  const days: string[] = [];
  const stop = startDayWatch({
    now: () => now,
    onNewDay: (d) => days.push(d),
    onActive: (cb) => { activeCb = cb; return () => { activeCb = null; }; },
    setTimer: (fn, ms) => { const id = ++seq; timers.push({ fn, at: now.getTime() + ms, id }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  });
  return {
    days, stop,
    /** يقدّم الساعة ويطلق ما حان من المؤقتات */
    advance(to: Date) {
      now = to;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now.getTime() && timers.includes(t)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
      }
    },
    /** القفز بلا مؤقتات (الجهاز نائم) ثم العودة للواجهة */
    resume(to: Date) { now = to; activeCb?.(); },
    pending: () => timers.length,
  };
}

test('الوقت حتى منتصف الليل المحلي', () => {
  expect(msUntilNextDay(new Date(2026, 9, 5, 23, 59, 0))).toBe(60_000);
});

test('منتصف الليل والتطبيق مفتوح: يوم جديد مرة واحدة', () => {
  const h = harness(new Date(2026, 9, 5, 22, 0));
  h.advance(new Date(2026, 9, 5, 23, 0));
  expect(h.days).toEqual([]);
  h.advance(new Date(2026, 9, 6, 0, 0, 5));
  expect(h.days).toEqual(['2026-10-06']);
  expect(h.pending()).toBe(1); // مؤقت الليلة التالية
  h.stop();
  expect(h.pending()).toBe(0);
});

test('العودة من الخلفية صباحاً: يوم جديد · وفي اليوم نفسه لا شيء', () => {
  const h = harness(new Date(2026, 9, 5, 20, 0));
  h.resume(new Date(2026, 9, 5, 21, 0));
  expect(h.days).toEqual([]);
  h.resume(new Date(2026, 9, 6, 8, 0));
  expect(h.days).toEqual(['2026-10-06']);
  h.resume(new Date(2026, 9, 6, 9, 0));
  expect(h.days).toEqual(['2026-10-06']);
});

/**
 * مفتاح الترتيب الطبيعي: كل مقطع رقمي يُحشى بالأصفار إلى عشر خانات
 * ويُسبق بعلامة #، فيرتَّب «1 · 2 · 10 · 100» صحيحاً، و«A-1 · A-2 · A-10»،
 * ويبقى المختلط في موضعه · بلا تحويل رقمي يكسر القيم غير الرقمية.
 * يُحسب عند الحفظ ويُخزَّن، والترتيب في SQL بفهرسه لا في الشاشة.
 */
export const naturalKey = (s: string | null | undefined): string =>
  String(s ?? '').replace(/\d+/g, (m) => '#' + m.padStart(10, '0'));

/** مقارن للترتيب في الذاكرة حيث لا عمود مفتاح (فرز قوائم محمّلة) */
export const naturalCompare = (a: string | null | undefined, b: string | null | undefined): number => {
  const ka = naturalKey(a);
  const kb = naturalKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

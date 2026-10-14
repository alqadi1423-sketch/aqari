/** معرّف قصير فريد · نفس فكرة uid() في النموذج مع عشوائية أوسع */
export function uid(): string {
  const t = Date.now().toString(36);
  let r = '';
  for (let i = 0; i < 12; i++) r += Math.floor(Math.random() * 36).toString(36);
  return t + r;
}

/**
 * معرّفاتٌ حتمية داخل fn (المراجعة الخارجية ٧ · النتيجة ٤): الاستعادة من السلة على جهازين بلا اتصال كانت تُرحِّل قيدين مختلفي
 * المعرّف للمستند نفسه · فقيود الاستعادة وسطورها وحركات بنكها معرّفاتها من بذرةٍ واحدة (القيد المعكوس الذي تعيده) وبترتيبها،
 * فيُنتج الجهازان القيد نفسه فيلتقيان مستنداً واحداً · وخارجها rowId كـ uid
 */
let det: { seed: string; n: number } | null = null;
export function withDeterministicIds<T>(seed: string, fn: () => T): T {
  const prev = det;
  det = { seed, n: 0 };
  try { return fn(); } finally { det = prev; }
}
/** FNV-1a بـ٣٢ بتاً مرتين (بذرتان) · ستة عشر حرفاً ست عشرية */
function fnv(s: string, h: number): string {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
export function rowId(): string {
  if (!det) return uid();
  det.n++;
  const k = det.seed + '#' + det.n;
  return 'd' + fnv(k, 0x811c9dc5) + fnv(k, 0x050c5d1f);
}

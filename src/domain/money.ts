/**
 * المال كله أعداد صحيحة بالهللات. لا REAL في أي حقل مالي.
 */

/**
 * ريالات (نص أو رقم من إدخال المستخدم) ← هللات، بتقريب نصفي بعيداً عن الصفر · النص يُحلَّل بمنازله نصّاً لا بعدد عشري
 * (مراجعة التثبيت #62: «10.075» كانت 1007 لا 1008)، والأرقام العربية الهندية والفارسية و«٫» تُطبَّع (كانت صفراً بصمت)
 */
export function toHalalas(riyals: string | number | null | undefined): number {
  if (riyals == null) return 0;
  const raw = typeof riyals === 'number'
    ? (isFinite(riyals) ? riyals.toFixed(6) : '')
    : riyals
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
      .replace(/\u066B/g, '.')
      .replace(/[,،\u066C\s]/g, '');
  // البادئة الرقمية كما كان parseFloat يقرؤها (نصٌّ بعدها كوحدة العملة لا يُسقط المبلغ)
  const m = /^([-+]?)(\d*)(?:\.(\d*))?/.exec(raw);
  if (!m || (!m[2] && !m[3])) return 0;
  const frac = (m[3] ?? '').padEnd(3, '0');
  const abs = Number(m[2] || '0') * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
  return m[1] === '-' ? -abs : abs;
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

/**
 * المبلغ بالحروف العربية لسندات القبض والمستندات:
 * «4,000.00 · أربعة آلاف ريال فقط لا غير» · الهللات تُذكر إن وُجدت.
 */

const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة',
  'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مئة', 'مئتان', 'ثلاثمئة', 'أربعمئة', 'خمسمئة', 'ستمئة', 'سبعمئة', 'ثمانمئة', 'تسعمئة'];

/** ٠-٩٩٩ بالحروف */
function triplet(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (r) {
    if (r < 20) parts.push(ONES[r]);
    else {
      const t = Math.floor(r / 10);
      const o = r % 10;
      parts.push(o ? ONES[o] + ' و' + TENS[t] : TENS[t]);
    }
  }
  return parts.join(' و');
}

/** المئات مضافةً إلى ما بعدها: «مئتا ألف» لا «مئتان ألف» */
const HUNDREDS_CONSTRUCT = HUNDREDS.map((h) => (h === 'مئتان' ? 'مئتا' : h));

/**
 * كلمة المرتبة بعدد أصحابها (المراجعة ٤.١٣) · المعدود يتبع آخر ما يليه من العدد:
 * ١ ألف · ٢ ألفان · ٣–١٠ آلاف · ١١–٩٩ ألفاً · والمئات الصحيحة تضاف إليه مفرداً «مئة ألف، مئتا ألف»،
 * وما زاد عليها بواحد أو اثنين «مئة ألف وألف، مئتا ألف وألفان».
 */
function scaled(n: number, one: string, two: string, few: string, many: string): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const small = (k: number): string => {
    if (k === 1) return one;
    if (k === 2) return two;
    return triplet(k) + ' ' + (k <= 10 ? few : many);
  };
  if (!h) return small(r);
  if (!r) return HUNDREDS_CONSTRUCT[h] + ' ' + one;
  if (r <= 2) return HUNDREDS_CONSTRUCT[h] + ' ' + one + ' و' + small(r);
  return HUNDREDS[h] + ' و' + small(r);
}

/** عدد صحيح ٠ فأكثر بالحروف */
export function intToArabicWords(n: number): string {
  if (!Number.isInteger(n) || n < 0) return String(n);
  if (n === 0) return 'صفر';
  const parts: string[] = [];
  const millions = Math.floor(n / 1000000);
  const thousands = Math.floor((n % 1000000) / 1000);
  const rest = n % 1000;
  if (millions) parts.push(scaled(millions, 'مليون', 'مليونان', 'ملايين', 'مليوناً'));
  if (thousands) parts.push(scaled(thousands, 'ألف', 'ألفان', 'آلاف', 'ألفاً'));
  if (rest) parts.push(triplet(rest));
  return parts.join(' و');
}

/** المبلغ بالهللات → جملة السند: «أربعة آلاف ريال وخمسون هللة فقط لا غير» */
export function moneyToArabicWords(halalas: number): string {
  const total = Math.abs(Math.round(halalas));
  const riyals = Math.floor(total / 100);
  const hal = total % 100;
  const parts: string[] = [];
  if (riyals || !hal) parts.push(intToArabicWords(riyals) + ' ريال');
  if (hal) parts.push(intToArabicWords(hal) + ' هللة');
  return parts.join(' و') + ' فقط لا غير';
}

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
  // مرتبة المليار (E-15): ألف مليون فأكثر كان يُكتب «undefined مليون»
  const billions = Math.floor(n / 1000000000);
  if (billions >= 1000) return String(n);
  if (billions) parts.push(scaled(billions, 'مليار', 'ملياران', 'مليارات', 'ملياراً')); // i18n-exempt: التفقيط
  const millions = Math.floor((n % 1000000000) / 1000000);
  const thousands = Math.floor((n % 1000000) / 1000);
  const rest = n % 1000;
  if (millions) parts.push(scaled(millions, 'مليون', 'مليونان', 'ملايين', 'مليوناً'));
  if (thousands) parts.push(scaled(thousands, 'ألف', 'ألفان', 'آلاف', 'ألفاً'));
  if (rest) parts.push(triplet(rest));
  return parts.join(' و');
}

/*
 * المعدود بعدده (المراجعة الشاملة 2026-11-13 · E-14 · قرار المالك ٤.١٣ وس١٤): ألفاظ العدد والمعدود بيانات لغوية للتفقيط العربي
 * لا نصّ واجهةٍ يُترجم، فالمبلغ بالحروف عربيٌّ في كل مستند · ولذا وُسمت i18n-exempt
 */
// الهللة مؤنثة: ١ و٢ بعد المعدود، و٣-١٠ تخالفه («ثلاث هللات»)، و١١-١٩ «إحدى عشرة، اثنتا عشرة، ثلاث عشرة»
const ONES_F = ['', 'إحدى', 'اثنتان', 'ثلاث', 'أربع', 'خمس', 'ست', 'سبع', 'ثماني', 'تسع', 'عشر', 'إحدى عشرة', 'اثنتا عشرة', 'ثلاث عشرة', 'أربع عشرة', 'خمس عشرة', 'ست عشرة', 'سبع عشرة', 'ثماني عشرة', 'تسع عشرة']; // i18n-exempt: ألفاظ العدد المؤنث للتفقيط
const EIGHT_IN_TENS = 'ثمان'; // i18n-exempt: «ثمانٍ وعشرون» في المعطوف

/** ١-٩٩ مؤنثاً */
function femBelow100(n: number): string {
  if (n < 20) return ONES_F[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? (o === 8 ? EIGHT_IN_TENS : ONES_F[o]) + ' و' + TENS[t] : TENS[t];
}

/** المرتبة مضافةً إلى ما بعدها: تمييز ١١-٩٩ المنصوب يُضاف («ألفاً» ← «ألف ريال»)، والمثنى تسقط نونه («ألفان» ← «ألفا ريال») */
const CONSTRUCT: Record<string, string> = { // i18n-exempt: ألفاظ العدد للتفقيط
  'ألفاً': 'ألف', 'مليوناً': 'مليون', 'ملياراً': 'مليار', // i18n-exempt: التفقيط
  'ألفان': 'ألفا', 'مليونان': 'مليونا', 'ملياران': 'مليارا', 'مئتان': 'مئتا', // i18n-exempt: التفقيط
};

/** الريال بعدده: «ريال واحد · ريالان · ثلاثة ريالات · أحد عشر ريالاً · مئة ريال» */
function riyalPhrase(n: number): string {
  if (n === 0) return 'صفر ريال'; // i18n-exempt: التفقيط
  if (n === 1) return 'ريال واحد'; // i18n-exempt: التفقيط
  if (n === 2) return 'ريالان'; // i18n-exempt: التفقيط
  const r = n % 100;
  const words = intToArabicWords(n);
  if (r >= 3 && r <= 10) return words + ' ريالات'; // i18n-exempt: التفقيط
  if (r >= 11) return words + ' ريالاً'; // i18n-exempt: التفقيط
  // المئات والمراتب الصحيحة وما زاد عليها بواحد أو اثنين: المعدود مفرداً بعدها («مئة ريال · ألف ريال · مئة وواحد ريال») ·
  // والمرتبة الأخيرة مضافةٌ إلى «ريال»: «أحد عشر ألف ريال · ألفا ريال · مئتا ريال» (المدقق المستقل للمرحلة ٣ · س١٤)
  if (r === 0) {
    // آخر كلمة بعد واو العطف إن كانت («مئتا ألف وألفان» ← «… وألفا ريال»)
    let cut = words.lastIndexOf(' ') + 1;
    if (words[cut] === 'و' && CONSTRUCT[words.slice(cut + 1)]) cut += 1; // i18n-exempt: واو العطف في التفقيط
    const last = words.slice(cut);
    return words.slice(0, cut) + (CONSTRUCT[last] ?? last) + ' ريال'; // i18n-exempt: التفقيط
  }
  return words + ' ريال'; // i18n-exempt: التفقيط
}

/** الهللة بعددها (١-٩٩): «هللة واحدة · هللتان · ثلاث هللات · إحدى عشرة هللة · ست وخمسون هللة» */
function halalaPhrase(n: number): string {
  if (n === 1) return 'هللة واحدة'; // i18n-exempt: التفقيط
  if (n === 2) return 'هللتان'; // i18n-exempt: التفقيط
  return femBelow100(n) + (n <= 10 ? ' هللات' : ' هللة'); // i18n-exempt: التفقيط
}

/** المبلغ بالهللات → جملة السند: «أربعة آلاف ريال وخمسون هللة فقط لا غير» */
export function moneyToArabicWords(halalas: number): string {
  const total = Math.abs(Math.round(halalas));
  const riyals = Math.floor(total / 100);
  const hal = total % 100;
  const parts: string[] = [];
  if (riyals || !hal) parts.push(riyalPhrase(riyals));
  if (hal) parts.push(halalaPhrase(hal));
  return parts.join(' و') + ' فقط لا غير';
}

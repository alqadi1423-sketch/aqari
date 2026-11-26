/**
 * المنطق المحاسبي النقي (التوجيه الرابع ٤ · ٥ · «المنطق المحاسبي النقي بالأرقام الذهبية بلا تغيير في المخطط»):
 * دوالٌ خالصة بلا قاعدة ولا وحدات جهاز ولا ترجمة · مدخلاتها أعدادٌ بالهللات وقيمٌ معروفة، ومخرجاتها مبالغ وسطور قيود · فتعمل كما هي على
 * الجوال، وعلى أي خادمٍ تختاره البنية (تقرير البنية السحابية: الخيار ٥ يشغّل src/domain نفسه)، وتُختبر بأرقامٍ ذهبية محسوبة يدوياً
 * (tests/golden/ledger.golden.json) · والدوال المرتبطة بالقاعدة (taxCode وrentSplit وpost وdepreciation) تستدعيها فلا يكون للحساب مصدران.
 *
 * القاعدة ١٠٠: المال أعدادٌ صحيحة بالهللات، والتقريب في موضعٍ واحدٍ لكل حساب، والمجموع يطابق دائماً (الباقي على بندٍ معلوم).
 */

/** نسبة ضريبة القيمة المضافة الأساسية في المملكة */
export const VAT_STANDARD_PCT = 15;

/** نسبةٌ مئوية من مبلغٍ بالهللات · تقريبٌ لأقرب هللة (نصف الهللة إلى الأعلى) */
export function pct(halalas: number, percent: number): number {
  return Math.round((halalas * percent) / 100);
}

/** مبلغٌ شامل الضريبة يُفصل: الصافي مقرَّباً لأقرب هللة، والضريبة الباقي · فمجموعهما المبلغ نفسه دائماً */
export function vatInclusiveSplit(grossHalalas: number, percent = VAT_STANDARD_PCT): { net: number; tax: number } {
  const net = Math.round((grossHalalas * 100) / (100 + percent));
  return { net, tax: grossHalalas - net };
}

/* ═══════════ إيراد العقد: الإيجار والخدمات والمواقف ═══════════ */

export interface ContractParts { value: number; services: number; parking: number }

/**
 * نصيب الخدمات والمواقف من مبلغٍ بنسبتهما من إجمالي العقد، والهللات الباقية على الإيجار · تراكمياً على مستوى العقد: نصيب كل بندٍ نسبته
 * من المحصَّل بعد المبلغ ناقص نسبته منه قبله (لا تتآكل الهللات مع كثرة الدفعات) · side 'debit' للعكس
 */
export function rentShares(c: ContractParts, paidBefore: number, amount: number, side: 'credit' | 'debit' = 'credit'):
  { rent: number; services: number; parking: number } {
  const v = Number(c.value) || 0;
  const s = Number(c.services) || 0;
  const p = Number(c.parking) || 0;
  if (!amount || !v || (!s && !p) || s < 0 || p < 0) return { rent: amount, services: 0, parking: 0 };
  const total = v + s + p;
  const share = (cum: number, x: number) => (cum >= 0 ? Math.floor((cum * x) / total) : -Math.floor((-cum * x) / total));
  const after = paidBefore + (side === 'credit' ? amount : -amount);
  const dir = side === 'credit' ? 1 : -1;
  const clamp = (x: number) => Math.min(Math.max(0, x), amount);
  const services = clamp(dir * (share(after, s) - share(paidBefore, s)));
  let parking = clamp(dir * (share(after, p) - share(paidBefore, p)));
  if (services + parking > amount) parking = amount - services;
  return { rent: amount - services - parking, services, parking };
}

/* ═══════════ الإهلاك بالقسط الثابت ═══════════ */

export interface DepreciableParts { cost: number | null; salvage: number; lifeMonths: number; purchaseDate: string | null }

export const monthIndexOf = (date: string): number => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
export const daysInMonthOf = (mi: number): number => {
  const y = Math.floor(mi / 12); const m = mi % 12;
  return m === 1 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m];
};

/** القسط الشهري وقسط الشهر الأخير (يأخذ فرق الهللات) · يبدأ من الشهر التالي لشهر الشراء · null لما لا يُهلَك */
export function straightLine(a: DepreciableParts): { per: number; last: number; base: number; start: number } | null {
  if (a.cost == null || !a.purchaseDate || a.lifeMonths < 1) return null;
  const base = Number(a.cost) - Number(a.salvage || 0);
  if (base <= 0) return null;
  const per = Math.floor(base / a.lifeMonths);
  return { per, last: base - per * (a.lifeMonths - 1), base, start: monthIndexOf(a.purchaseDate) + 1 };
}

/** المستحق المتراكم حتى نهاية يوم «date» · والشهر الجاري بنسبة أيامه مقرَّبةً لأقرب هللة */
export function depreciationThrough(a: DepreciableParts, date: string): number {
  const m = straightLine(a);
  if (!m) return 0;
  const k = monthIndexOf(date) - m.start;
  if (k < 0) return 0;
  if (k >= a.lifeMonths) return m.base;
  const cur = k === a.lifeMonths - 1 ? m.last : m.per;
  const dim = daysInMonthOf(monthIndexOf(date));
  const d = Math.min(Number(date.slice(8, 10)) || 1, dim);
  const partial = d >= dim ? cur : Math.round((cur * d) / dim);
  return m.per * k + partial;
}

/* ═══════════ سطور القيود ═══════════ */

/** سطر قيدٍ بلا أبعاد · المدين والدائن بالهللات */
export interface CoreLine { account: string; descr?: string; debit: number; credit: number }

/** الحسابات التي تستعملها السطور هنا · كما في دليل الحسابات المزروع (chart.ts) */
export const ACC = {
  cash: '1100', receivable: '1200', heldByOthers: '1260', inputVat: '1270', payable: '2100', outputVat: '2200',
  deposits: '2400', otherIncome: '4300', sales: '4100', rent: '4200', services: '4210', parking: '4220', discount: '4900',
  rounding: '5900',
} as const;

/** عمولة التقبيل: النقد بها كلها، وللمسجّلة في الضريبة صافيها إيراداً وضريبتها مخرجات (من المبلغ شاملاً) · null لما لا قيد له */
export function keyMoneyLinesOf(commission: number, vatRegistered: boolean): CoreLine[] | null {
  if (!(commission > 0)) return null;
  const { net, tax } = vatRegistered ? vatInclusiveSplit(commission) : { net: commission, tax: 0 };
  return [
    { account: ACC.cash, descr: 'عمولة مستلمة', debit: commission, credit: 0 }, // i18n-exempt: بيان القيد المخزَّن
    { account: ACC.otherIncome, descr: 'إيراد عمولة تقبيل', debit: 0, credit: net }, // i18n-exempt: بيان القيد المخزَّن
    ...(tax ? [{ account: ACC.outputVat, descr: 'ضريبة مخرجات عمولة تقبيل', debit: 0, credit: tax }] : []), // i18n-exempt: بيان القيد المخزَّن
  ];
}

/** فاتورة المبيعات: الذمة بالإجمالي، والمبيعات بالصافي، والضريبة مخرجات */
export const invoiceLinesOf = (v: { subtotal: number; tax: number; total: number }): CoreLine[] => [
  { account: ACC.receivable, debit: v.total, credit: 0 },
  ...(v.subtotal ? [{ account: ACC.sales, debit: 0, credit: v.subtotal }] : []),
  ...(v.tax ? [{ account: ACC.outputVat, debit: 0, credit: v.tax }] : []),
];

/**
 * فاتورة الشراء: «قابلة للخصم» وحدها تفصل ضريبتها مدخلاتٍ قابلة للاسترداد (1270)، وغيرها بالتكلفة الكاملة على حساب فئتها · وفرق التقريب
 * المقبول على 5900 · وبنود الأصول سطورٌ بمبالغها تُطرح من سطر الفئة · والدائن الموردون بالإجمالي
 */
export function purchaseLinesOf(
  p: { expenseAccount: string; subtotal: number; tax: number; total: number; roundingDiff?: number; deductible?: boolean },
  assetLines: CoreLine[] = [],
): CoreLine[] {
  const diff = p.roundingDiff ?? 0;
  const assetSum = assetLines.reduce((s, l) => s + (l.debit || 0), 0);
  const dedTax = p.deductible ? p.tax : 0;
  return [
    { account: p.expenseAccount, debit: p.subtotal + p.tax - dedTax - assetSum, credit: 0 },
    ...assetLines,
    ...(dedTax ? [{ account: ACC.inputVat, descr: 'ضريبة مدخلات قابلة للاسترداد', debit: dedTax, credit: 0 }] : []), // i18n-exempt: بيان القيد المخزَّن
    ...(diff > 0 ? [{ account: ACC.rounding, descr: 'فرق تقريب مقبول', debit: diff, credit: 0 }] : []), // i18n-exempt: بيان القيد المخزَّن
    { account: ACC.payable, debit: 0, credit: p.total },
    ...(diff < 0 ? [{ account: ACC.rounding, descr: 'فرق تقريب مقبول', debit: 0, credit: -diff }] : []), // i18n-exempt: بيان القيد المخزَّن
  ];
}

/** قبض التأمين: المكتب في النقدية، والمنصة محتجزاتٌ لدى الغير، والطرف الآخر لا قيد له · null لما لا قيد له */
export function depositLinesOf(deposit: number, holder?: string | null): CoreLine[] | null {
  if (deposit <= 0) return null;
  const h = holder || 'المكتب'; // i18n-exempt: جهة مخزّنة
  if (h === 'طرف آخر') return null; // i18n-exempt: جهة مخزّنة
  return [
    { account: h === 'منصة إيجار' ? ACC.heldByOthers : ACC.cash, descr: 'تأمين مستلم', debit: deposit, credit: 0 }, // i18n-exempt: جهة مخزّنة وبيان القيد
    { account: ACC.deposits, descr: 'التزام تأمين المستأجر', debit: 0, credit: deposit }, // i18n-exempt: بيان القيد المخزَّن
  ];
}

/** مجموع المدين والدائن · القيد متوازن حين يتساويان */
export function totals(lines: CoreLine[]): { debit: number; credit: number } {
  return lines.reduce((t, l) => ({ debit: t.debit + (l.debit || 0), credit: t.credit + (l.credit || 0) }), { debit: 0, credit: 0 });
}

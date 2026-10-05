/**
 * أساس الاستحقاق · الدخل والمصروف بأيامهما لا بتاريخ المستند وحده.
 *
 * «٥٨٪ من العقود تبدأ في غير أول الشهر · عقد يبدأ ٢٠ أغسطس يُسجَّل اليوم في أغسطس
 * كاملاً، والحقيقة أنه سكن ١٢ يوماً من ٣١». فهنا تُوزَّع قيمة العقد على أيامه،
 * ويأخذ كل شهر نصيب أيامه منها. وكذلك الفاتورة المستهلَكة على أشهر:
 * إيجار العقار السنوي يستقر شهرياً بدل أن يقفز في شهر توقيعه.
 *
 * تحذير ملزم: هذا الملف قراءة واشتقاق فقط · لا يكتب في جدول ولا يمسّ قيداً ولا دفتراً.
 * الفاتورة بتاريخها والدفعة بتاريخها، والضريبة تُستحق بتاريخ الفاتورة لا بتوزيعها،
 * فلا يدخل هذا الأساس الإقرار الضريبي ولا ميزان المراجعة ولا كشف الحساب
 * ولا القيود ولا التحصيل · موضعه العرض والتحليل وحدهما.
 */
import type { DB } from '../db/adapter';
import { daysBetween, addDays, contractEndFromDuration } from './dates';
import { TS_DEDUCTIBLE } from './purchases';
import { DISCOUNT_REDUCES_INSTALLMENT } from './contracts/installments';

/** أساس القياس المعروض · نص صريح تستعمله الشاشات في الأزرار والعناوين */
export type Basis = 'استحقاق' | 'نقدي';
export const BASES: readonly Basis[] = ['استحقاق', 'نقدي'];
export const BASIS_ACCRUAL: Basis = 'استحقاق';
export const BASIS_CASH: Basis = 'نقدي';

/**
 * مصادر القيود التي يحلّ التوزيع محلّها فتُستثنى من الجانب الدفتري كي لا تُحسب مرتين:
 * دفعة الإيجار (تُسجَّل إيراداً يوم قبضها) وقيد فاتورة الشراء (يُسجَّل مصروفاً يوم تحريرها)،
 * ومعهما قيدا عكسهما · وما عداهما يبقى بتاريخه كما هو في الدفتر.
 * ودفعة الإيجار في البيانات المنقولة إلى التطبيق مصدرها rent_payment · وقيد الخصم المنفصل (discount)
 * دائنه الإيراد بقيمة الخصم، والتوزيع يحسب القيمة كاملة فيُستثنى جانب إيراده كذلك ·
 * أما مدينه 4900 فمصروف يبقى في جانب المصروف، فيُطرح خصم «بعد الاستحقاق» من صافي الدخل.
 */
// وتسوية الفائض (ردّاً أو رصيداً) مدينها الإيراد بما قُبض فوق الأقساط · والتوزيع لم يعدّ ذلك الفائض أصلاً
// فيُستثنى جانب إيرادها كذلك
const RENT_SOURCES = ['rent', 'rent_rev', 'rent_payment', 'rent_payment_rev', 'discount', 'discount_rev',
  'surplus_refund', 'surplus_refund_rev', 'surplus_credit', 'surplus_credit_rev'];
const PURCHASE_SOURCES = ['purchase', 'purchase_rev'];

// ─── توزيع قيمة على أيامها ───

/** عدد الأيام شاملاً الطرفين · نظير julianday(end) - julianday(start) + 1 */
export function inclusiveDays(start: string, end: string): number {
  if (!start || !end) return 0;
  const n = daysBetween(end, start) + 1;
  return n > 0 ? n : 0;
}

export interface DailySpread {
  valueHalalas: number;
  start: string;
  end: string;
  days: number;
  /** نصيب اليوم الواحد بالهللات · كسريٌّ عمداً، والتقريب يقع عند التجميع لا هنا */
  perDayHalalas: number;
}

/** توزيع قيمة على أيام مدتها · value_halalas ÷ (عدد الأيام شاملاً الطرفين) */
export function dailySpread(valueHalalas: number, start: string, end: string): DailySpread {
  const days = inclusiveDays(start, end);
  return {
    valueHalalas: Number(valueHalalas) || 0,
    start,
    end,
    days,
    perDayHalalas: days ? (Number(valueHalalas) || 0) / days : 0,
  };
}

/**
 * المتراكم من القيمة حتى نهاية يوم upto (شاملاً) بالهللة الصحيحة.
 * الحيلة التي تمنع ضياع الهللات: التقريب على المتراكم لا على نصيب كل فترة،
 * وآخر يوم يأخذ القيمة كاملة · فيمتصّ فرق التقريب كلّه ويبقى المجموع مساوياً للقيمة بالضبط.
 */
export function accruedThrough(valueHalalas: number, start: string, end: string, upto: string): number {
  const value = Number(valueHalalas) || 0;
  const days = inclusiveDays(start, end);
  if (!days) return 0;
  if (!upto || upto < start) return 0;
  if (upto >= end) return value;
  const elapsed = daysBetween(upto, start) + 1;
  return Math.round((value * elapsed) / days);
}

/**
 * نصيب الفترة [from,to] من قيمة موزَّعة على [start,end].
 * = المتراكم حتى to ناقص المتراكم حتى اليوم السابق لـ from · فتتلاصق الفترات بلا هللة ضائعة.
 */
export function accrualShare(
  valueHalalas: number,
  start: string,
  end: string,
  from: string,
  to: string
): number {
  if (!start || !end || !from || !to) return 0;
  if (to < from) return 0;
  if (to < start || from > end) return 0;
  return (
    accruedThrough(valueHalalas, start, end, to) -
    accruedThrough(valueHalalas, start, end, addDays(from, -1))
  );
}

/** حدود الشهر yyyy-mm · أول يوم وآخر يوم فيه */
export function monthBounds(ym: string): { from: string; to: string } {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const last = new Date(y, m, 0).getDate();
  const p = (n: number) => String(n).padStart(2, '0');
  return { from: `${y}-${p(m)}-01`, to: `${y}-${p(m)}-${p(last)}` };
}

function nextMonthKey(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const p = (n: number) => String(n).padStart(2, '0');
  return m === 12 ? `${y + 1}-01` : `${y}-${p(m + 1)}`;
}

/**
 * نصيب كل شهر من القيمة · بترتيب أشهر المدة، ومجموع الأنصبة = القيمة بالهللة بالضبط.
 * هذه هي التي تغذّي عمود «الدخل بالاستحقاق» شهراً بشهر.
 */
export function monthlyAccrual(
  valueHalalas: number,
  start: string,
  end: string
): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  if (!inclusiveDays(start, end)) return out;
  const lastKey = end.slice(0, 7);
  for (let ym = start.slice(0, 7); ym <= lastKey; ym = nextMonthKey(ym)) {
    const b = monthBounds(ym);
    out.push([ym, accrualShare(valueHalalas, start, end, b.from, b.to)]);
  }
  return out;
}

// ─── العقود ───

export interface ContractAccrualRow {
  id?: string;
  value_halalas: number;
  start: string | null;
  end: string | null;
  status?: string;
  cancel_date?: string | null;
}

export interface ContractAccrualWindow {
  /** مدة العقد الكاملة · هي مقام نصيب اليوم مهما قُطع العقد */
  start: string;
  end: string;
  /** آخر يوم يُستحق فيه فعلاً · تاريخ الإلغاء إن أُلغي العقد */
  accrueUntil: string;
}

/**
 * مدة استحقاق العقد · نصيب اليوم من مدته الكاملة، والاستحقاق يتوقف يوم الإلغاء:
 * مستأجر دفع سنة وغادر بعد ثلاثة أشهر لم يُكسِبنا إلا ثلاثة أشهر.
 * المسودة لا تستحق شيئاً، والملغى بلا تاريخ إلغاء لا يُعرف متى توقف فيُترك.
 */
export function contractAccrualWindow(c: ContractAccrualRow): ContractAccrualWindow | null {
  const start = c.start || '';
  const end = c.end || '';
  if (!start || !end || end < start) return null;
  if (c.status === 'مسودة') return null;
  if (c.status === 'ملغى') {
    const cd = c.cancel_date || '';
    if (!cd || cd < start) return null;
    return { start, end, accrueUntil: cd < end ? cd : end };
  }
  return { start, end, accrueUntil: end };
}

/** نصيب فترة من قيمة عقد واحد · null في from أو to يعني حدّ العقد نفسه */
export function contractPeriodRevenue(
  c: ContractAccrualRow,
  from: string | null,
  to: string | null
): number {
  const w = contractAccrualWindow(c);
  if (!w) return 0;
  const f = from || w.start;
  let t = to || w.accrueUntil;
  if (t > w.accrueUntil) t = w.accrueUntil;
  return accrualShare(c.value_halalas, w.start, w.end, f, t);
}

/**
 * «تنزيل من القسط» يُخفّض القسط ولا يمسّ قيمة العقد الموثّقة · فيُطرح من إيراد الاستحقاق على مدة قسطه:
 * من استحقاقه إلى ما قبل القسط التالي (أو نهاية العقد)، ويتوقف الطرح عند إلغاء العقد كما يتوقف الاستحقاق.
 */
interface AccrualReduction { amount: number; start: string; end: string; accrueUntil: string }

function accrualReductions(db: DB): AccrualReduction[] {
  const rows = db.all<{
    amount: number; due: string; next_due: string | null;
    start: string | null; end: string | null; status: string; cancel_date: string | null; value_halalas: number;
  }>(
    `SELECT p.discount_halalas AS amount, i.due_date AS due,
            (SELECT MIN(i2.due_date) FROM contract_installments i2
             WHERE i2.contract_id = i.contract_id AND i2.due_date > i.due_date) AS next_due,
            c.start, c.end, c.status, c.cancel_date, c.value_halalas
     FROM contract_payments p
     JOIN contract_installments i ON i.id = p.installment_id
     JOIN contracts c ON c.id = i.contract_id
     WHERE p.discount_kind = '${DISCOUNT_REDUCES_INSTALLMENT}' AND p.discount_halalas > 0 AND p.cancelled_at IS NULL
       AND c.deleted_at IS NULL AND c.status != 'مسودة'`
  );
  const out: AccrualReduction[] = [];
  for (const r of rows) {
    const w = contractAccrualWindow({ value_halalas: Number(r.value_halalas), start: r.start, end: r.end, status: r.status, cancel_date: r.cancel_date });
    if (!w) continue;
    const start = r.due < w.start ? w.start : r.due;
    let end = r.next_due ? addDays(r.next_due, -1) : w.end;
    if (end > w.end) end = w.end;
    if (end < start) continue;
    out.push({ amount: Number(r.amount), start, end, accrueUntil: w.accrueUntil < end ? w.accrueUntil : end });
  }
  return out;
}

/** نصيب فترة من تنزيلٍ واحد · بقاعدة توزيع العقد نفسها */
function reductionShare(r: AccrualReduction, from: string | null, to: string | null): number {
  if (r.accrueUntil < r.start) return 0;
  const f = from || r.start;
  let t = to || r.accrueUntil;
  if (t > r.accrueUntil) t = r.accrueUntil;
  return accrualShare(r.amount, r.start, r.end, f, t);
}

function accrualContracts(db: DB): ContractAccrualRow[] {
  return db.all<{
    id: string; value_halalas: number; start: string | null; end: string | null;
    status: string; cancel_date: string | null;
  }>(
    `SELECT id, value_halalas, start, end, status, cancel_date
     FROM contracts
     WHERE deleted_at IS NULL AND status != 'مسودة'
       AND start IS NOT NULL AND end IS NOT NULL AND start != '' AND end != ''`
  ).map((r) => ({ ...r, value_halalas: Number(r.value_halalas) }));
}

// ─── فواتير الشراء ───

/**
 * أعمدة purchases: فيها date وdue فقط ولا بداية فترة ولا نهايتها.
 * فمصدر الفترة الوحيد هو استهلاك الفاتورة على أشهر (amortize مع amortize_months):
 * الفترة من تاريخ الفاتورة وتمتد هذا العدد من الأشهر ناقصاً يوماً.
 * وإن لم يكن لها استهلاك فالفاتورة كلها تقع في تاريخها (spread = false).
 */
export interface PurchaseAccrualRow {
  id?: string;
  date: string;
  amortize: number;
  amortize_months: number | null;
  subtotal_halalas?: number;
  tax_halalas: number;
  total_halalas: number;
  tax_status?: string | null;
}

export interface AccrualPeriod {
  start: string;
  end: string;
  /** هل للفاتورة فترة تتوزع عليها أصلاً؟ */
  spread: boolean;
}

export function purchaseAccrualPeriod(p: Pick<PurchaseAccrualRow, 'date' | 'amortize' | 'amortize_months'>): AccrualPeriod {
  const months = Number(p.amortize_months) || 0;
  if (Number(p.amortize) && months > 0) {
    return { start: p.date, end: contractEndFromDuration(p.date, months), spread: true };
  }
  return { start: p.date, end: p.date, spread: false };
}

/**
 * مصروف الفاتورة كما يراه الدفتر: الإجمالي ناقص ضريبة المدخلات القابلة للخصم وحدها
 * (فهي أصل مستردّ لا تكلفة) · ونفس معادلة postPurchaseToLedger حرفياً بما فيها فرق التقريب.
 */
export function purchaseExpenseHalalas(p: Pick<PurchaseAccrualRow, 'tax_halalas' | 'total_halalas' | 'tax_status'>): number {
  const deductible = p.tax_status === TS_DEDUCTIBLE ? Number(p.tax_halalas) || 0 : 0;
  return (Number(p.total_halalas) || 0) - deductible;
}

/** نصيب فترة من فاتورة شراء · null في from أو to يعني حدّ الفاتورة نفسه */
export function purchasePeriodExpense(
  p: PurchaseAccrualRow,
  from: string | null,
  to: string | null
): number {
  const per = purchaseAccrualPeriod(p);
  const amount = purchaseExpenseHalalas(p);
  return accrualShare(amount, per.start, per.end, from || per.start, to || per.end);
}

function accrualPurchases(db: DB): PurchaseAccrualRow[] {
  return db.all<{
    id: string; date: string; amortize: number; amortize_months: number | null;
    subtotal_halalas: number; tax_halalas: number; total_halalas: number; tax_status: string | null;
  }>(
    `SELECT id, date, amortize, amortize_months, subtotal_halalas, tax_halalas, total_halalas, tax_status
     FROM purchases
     WHERE deleted_at IS NULL AND date IS NOT NULL AND date != ''`
  ).map((r) => ({
    ...r,
    amortize: Number(r.amortize),
    amortize_months: r.amortize_months == null ? null : Number(r.amortize_months),
    subtotal_halalas: Number(r.subtotal_halalas),
    tax_halalas: Number(r.tax_halalas),
    total_halalas: Number(r.total_halalas),
  }));
}

// ─── الجانب الدفتري الباقي ───

/**
 * صافي حركة حسابات نوع بعينه خلال الفترة، مستثنياً مصادر القيود التي حلّ التوزيع محلها.
 * قراءة محضة · لا يمسّ قيداً ولا يعدّل حالته.
 */
function ledgerNetOfType(
  db: DB,
  type: 'إيراد' | 'مصروف',
  from: string | null,
  to: string | null,
  excludeSources: string[]
): number {
  const conds = [`e.status = 'مرحّل'`, `e.deleted_at IS NULL`, `a.type = ?`];
  const params: (string | number)[] = [type];
  if (excludeSources.length) {
    conds.push(`COALESCE(e.src_type,'') NOT IN (${excludeSources.map(() => '?').join(',')})`);
    params.push(...excludeSources);
  }
  if (from) { conds.push(`e.date >= ?`); params.push(from); }
  if (to) { conds.push(`e.date <= ?`); params.push(to); }
  const sign = type === 'إيراد'
    ? `l.credit_halalas - l.debit_halalas`
    : `l.debit_halalas - l.credit_halalas`;
  const row = db.get<{ net: number }>(
    `SELECT COALESCE(SUM(${sign}),0) AS net
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.code = l.account_code
     WHERE ${conds.join(' AND ')}`,
    params
  );
  return row ? Number(row.net) : 0;
}

// ─── الدالتان التجميعيتان ───

/**
 * إيراد الفترة بأساس الاستحقاق · بنفس توقيع periodRevenueExpense النقدية في accounting/ledger
 * فتتبادلان المواضع بلا تغيير في المنادي.
 * = نصيب الفترة من قيم العقود (بدل إيراد الدفعات يوم قبضها)
 *   + ما بقي من إيراد الدفتر بتاريخه (فواتير المبيعات، خصم التأمين، المطالبات، التقبيل).
 */
export function periodRevenueAccrual(db: DB, from: string | null, to: string | null): number {
  let sum = 0;
  for (const c of accrualContracts(db)) sum += contractPeriodRevenue(c, from, to);
  for (const r of accrualReductions(db)) sum -= reductionShare(r, from, to);
  return sum + ledgerNetOfType(db, 'إيراد', from, to, RENT_SOURCES);
}

/**
 * مصروف الفترة بأساس الاستحقاق · نفس التوقيع كذلك.
 * = نصيب الفترة من فواتير الشراء (المستهلَكة على أشهرها، وغيرها في تاريخها)
 *   + ما بقي من مصروف الدفتر بتاريخه (القيود اليدوية وما لا فاتورة شراء له).
 */
export function periodExpenseAccrual(db: DB, from: string | null, to: string | null): number {
  let sum = 0;
  for (const p of accrualPurchases(db)) sum += purchasePeriodExpense(p, from, to);
  return sum + ledgerNetOfType(db, 'مصروف', from, to, PURCHASE_SOURCES);
}

/** الاثنان معاً · توقيع periodRevenueExpense حرفياً كي يحلّ أحدهما محل الآخر */
export function periodRevenueExpenseAccrual(
  db: DB,
  from: string | null,
  to: string | null
): { revenue: number; expense: number } {
  return {
    revenue: periodRevenueAccrual(db, from, to),
    expense: periodExpenseAccrual(db, from, to),
  };
}

/**
 * إيراد كل شهر ومصروفه بالاستحقاق · نظير monthlyRevenueExpense النقدية.
 * العقود والفواتير تُقرأ مرة واحدة لكل المدى لا مرة لكل شهر.
 */
export function monthlyRevenueExpenseAccrual(
  db: DB,
  fromMonth: string,
  toMonth: string
): Map<string, { revenue: number; expense: number }> {
  const out = new Map<string, { revenue: number; expense: number }>();
  const contracts = accrualContracts(db);
  const reductions = accrualReductions(db);
  const purchases = accrualPurchases(db);
  for (let ym = fromMonth; ym <= toMonth; ym = nextMonthKey(ym)) {
    const b = monthBounds(ym);
    let revenue = ledgerNetOfType(db, 'إيراد', b.from, b.to, RENT_SOURCES);
    let expense = ledgerNetOfType(db, 'مصروف', b.from, b.to, PURCHASE_SOURCES);
    for (const c of contracts) revenue += contractPeriodRevenue(c, b.from, b.to);
    for (const r of reductions) revenue -= reductionShare(r, b.from, b.to);
    for (const p of purchases) expense += purchasePeriodExpense(p, b.from, b.to);
    out.set(ym, { revenue, expense });
  }
  return out;
}

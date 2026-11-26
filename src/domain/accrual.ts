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
import { purchaseExpenseAccount } from './accounting/post';
import { DISCOUNT_REDUCES_INSTALLMENT, CYCLE_MONTHS } from './contracts/installments';
import { contractTotalSql } from './accounting/rentSplit';
import { ASSET_CATEGORIES } from './assets/catalog';
import { hasDimColumns } from './accounting/dimensions';

/** حسابات فئات الأصول في SQL · بنود الشراء التي صارت أصولاً تُرحَّل مدينةً عليها */
const ASSET_CATEGORY_SQL = ASSET_CATEGORIES.map((c) => `'${c.code}'`).join(',');

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
// والعربون المحوَّل إلى عقد إيرادٌ من قيمة العقد التي يعدّها التوزيع كاملة (مراجعة التثبيت #11)
// وكذلك القسط المتأخر المسدَّد من التأمين في تسويته (deposit_rent · المراجعة الشاملة 2026-11-13 · A1-2): كان خصمه 4300 فيُعدّ مرتين
// وردّ الإيجار المقدَّم عند الإنهاء المبكر (prepaid_refund · A1-4): مدينه الإيراد بما رُدّ مما قُبض عن مدةٍ لم تُسكن
export const RENT_SOURCES = ['rent', 'rent_rev', 'rent_payment', 'rent_payment_rev', 'discount', 'discount_rev',
  'surplus_refund', 'surplus_refund_rev', 'surplus_credit', 'surplus_credit_rev', 'reservation_convert', 'reservation_convert_rev',
  'deposit_rent', 'deposit_rent_rev', 'prepaid_refund', 'prepaid_refund_rev'];
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
  /** النهاية المتفق عليها (الهجرة ٤٨) · الإلغاء يقصّ end ولا يمسّها · وغيابها: end */
  original_end?: string | null;
  /** دورة العقد وعدد أقساطه · لاشتقاق النهاية المتفق عليها لملغى قُصّت نهايته ولا original_end سليمة له */
  cycle?: string | null;
  installments?: number;
  /** أقساطه المستحقة بعد تاريخ الإلغاء · دليل القصّ: الجدول يقع في المدة المتفق عليها، فقسطٌ بعد الإلغاء نهايته بعده */
  installments_after_cancel?: number;
}

/**
 * النهاية المتفق عليها للعقد الملغى (المراجعة الشاملة · البند ٣، وتتمة المتحقق المستقل): original_end إن جاوزت تاريخ الإلغاء · وإلا
 * فلملغى قُصّت نهايته (end = cancel_date) ولا تُعرف نهايته المتفق عليها: من جدول أقساطه بقاعدة الهجرة نفسها (عدد الأقساط × أشهر
 * الدورة، contractEndFromDuration)، فيتفق كل جهاز على مقامٍ واحد · ولا تقلّ عن end.
 * ولا تُشتق إلا بدليل (تتمة · المراجعة الأخيرة): original_end غائبة (ملغى قبل الهجرة ٤٨ وصل جهازاً جديداً، فالمزامنة تُبقيها فارغة ·
 * sync/engine.ts: keepUnknownOriginalEnd) أو قسطٌ مستحق بعد تاريخ الإلغاء (قُصّت يقيناً) · فما أُلغي بعد الهجرة في يوم نهايته بالضبط
 * لم تُقصّ نهايته، وoriginal_end = end نهايته: كان يُشتق له فتطول إن لم تقسم الدورة المدة (ستة أشهر بدورة سنوية) فيُبخس الإيراد
 */
export function agreedEnd(c: ContractAccrualRow): string {
  const end = c.end || '';
  const cd = c.cancel_date || '';
  if (c.original_end && c.original_end > cd && c.original_end > end) return c.original_end;
  const cut = !c.original_end || (c.installments_after_cancel ?? 0) > 0;
  if (c.status === 'ملغى' && cd && end === cd && cut && c.start && (c.installments ?? 0) > 0) { // i18n-exempt: حالة العقد المخزّنة
    const derived = contractEndFromDuration(c.start, (c.installments ?? 0) * (CYCLE_MONTHS[c.cycle ?? ''] || 12));
    if (derived > end) return derived;
  }
  return c.original_end && c.original_end > end ? c.original_end : end;
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
    // المقام المدة المتفق عليها لا المقصوصة بالإلغاء (المراجعة الشاملة · البند ٣): عقد سنةٍ أُلغي بعد ربعها استحق ربعها
    const full = agreedEnd(c);
    return { start, end: full, accrueUntil: cd < full ? cd : full };
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
interface AccrualReduction { contractId: string; amount: number; start: string; end: string; accrueUntil: string }

/** override: عقدٌ واحد بحالٍ مفترضة (معاينة الإلغاء بتاريخه · prepaidUnearned) فتُحسب تنزيلاته وحدها بنافذته */
function accrualReductions(db: DB, override?: ContractAccrualRow & { id: string }): AccrualReduction[] {
  const rows = db.all<{
    contract_id: string; amount: number; due: string; next_due: string | null;
    start: string | null; end: string | null; status: string; cancel_date: string | null; value_halalas: number; original_end: string | null;
    cycle: string | null; installments: number; after_cancel: number;
  }>(
    `SELECT c.id AS contract_id, p.discount_halalas AS amount, i.due_date AS due,
            (SELECT MIN(i2.due_date) FROM contract_installments i2
             WHERE i2.contract_id = i.contract_id AND i2.due_date > i.due_date) AS next_due,
            c.start, c.end, c.status, c.cancel_date, c.value_halalas, c.original_end, c.cycle,
            (SELECT COUNT(*) FROM contract_installments i3 WHERE i3.contract_id = c.id) AS installments,
            (SELECT COUNT(*) FROM contract_installments i4 WHERE i4.contract_id = c.id AND i4.due_date > c.cancel_date) AS after_cancel
     FROM contract_payments p
     JOIN contract_installments i ON i.id = p.installment_id
     JOIN contracts c ON c.id = i.contract_id
     WHERE p.discount_kind = '${DISCOUNT_REDUCES_INSTALLMENT}' AND p.discount_halalas > 0 AND p.cancelled_at IS NULL
       AND c.deleted_at IS NULL AND c.status != 'مسودة' ${override ? 'AND c.id = ?' : ''}`,
    override ? [override.id] : []
  );
  const out: AccrualReduction[] = [];
  for (const r of rows) {
    const w = contractAccrualWindow(override ?? { value_halalas: Number(r.value_halalas), start: r.start, end: r.end, status: r.status, cancel_date: r.cancel_date,
      original_end: r.original_end, cycle: r.cycle, installments: Number(r.installments), installments_after_cancel: Number(r.after_cancel) });
    if (!w) continue;
    const start = r.due < w.start ? w.start : r.due;
    let end = r.next_due ? addDays(r.next_due, -1) : w.end;
    if (end > w.end) end = w.end;
    if (end < start) continue;
    out.push({ contractId: r.contract_id, amount: Number(r.amount), start, end, accrueUntil: w.accrueUntil < end ? w.accrueUntil : end });
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
    status: string; cancel_date: string | null; original_end: string | null; cycle: string | null; installments: number;
    installments_after_cancel: number;
  }>(
    `SELECT id, ${contractTotalSql(db)} AS value_halalas, start, end, status, cancel_date, original_end, cycle,
            (SELECT COUNT(*) FROM contract_installments i WHERE i.contract_id = contracts.id) AS installments,
            (SELECT COUNT(*) FROM contract_installments i WHERE i.contract_id = contracts.id AND i.due_date > contracts.cancel_date)
              AS installments_after_cancel
     FROM contracts
     WHERE deleted_at IS NULL AND status != 'مسودة'
       AND start IS NOT NULL AND end IS NOT NULL AND start != '' AND end != ''`
  ).map((r) => ({ ...r, value_halalas: Number(r.value_halalas), installments: Number(r.installments),
    installments_after_cancel: Number(r.installments_after_cancel) }));
}

// ─── الإنهاء المبكر: ما قُبض عن مدةٍ لم تُسكن (A1-4) ───

/**
 * المراجعة الشاملة 2026-11-13 · A1-4 · قرار المالك س١٦: العقد الملغى يستحق حتى يوم إلغائه بمقام مدته المتفق عليها، وما قبضه المكتب
 * فوق ذلك (إيجارٌ مقدَّم عن مدةٍ بعد الإنهاء) «يُحتفظ به» افتراضاً فيُحسب إيراداً يوم الإنهاء، أو «يُردّ» بقيد ردٍّ (prepaid_refund)
 * فينقص المحتفَظ به · كانت دفعات الإيجار مستثناة من جانب الدفتر (RENT_SOURCES) فلا شيء يقابل المحتفَظ به بعد الإلغاء: ٥٬٤٥٧٫٥٣ بدل
 * ٦٬٠٠٠، و٢٬٩٥٨٫٩٠ بدل ١٢٬٠٠٠ · والثابت: مجموع استحقاق العقد عبر عمره = إيراد إيجاره المحتفَظ به في الدفتر (إن لم يكن عليه متأخر).
 *
 * المحتفَظ به R(d) = صافي سطور الإيراد في قيود RENT_SOURCES على العقد حتى يوم d (شاملاً) · والمكتسب E = استحقاق العقد عبر عمره ناقص
 * تنزيلاته · والمعترَف به زيادةً حتى d: X(d) = 0 قبل يوم الإلغاء، وبعده max(0, R(d) − E) · فالمقبوض قبل الإنهاء يظهر يومه، والمقبوض بعده
 * (متأخرٌ عن قسطٍ بعد الإلغاء أُبقي مستحقاً) يوم قبضه، والردّ يوم ردّه · والعقد الذي عليه متأخر (R < E) لا زيادة له.
 */
const POSTED_STATUS = 'مرحّل'; // i18n-exempt: حالة القيد المخزّنة
const REVENUE_TYPE = 'إيراد'; // i18n-exempt: نوع الحساب المخزَّن
interface PrepaidExtra { contractId: string; cancelDate: string; earned: number; timeline: Array<[string, number]> }

/** المكتسب عبر عمر العقد: نصيبه كاملاً ناقص تنزيلاته · بنافذة الصف المعطى */
function earnedOverLife(c: ContractAccrualRow, reductions: AccrualReduction[]): number {
  let e = contractPeriodRevenue(c, null, null);
  for (const r of reductions) if (r.contractId === c.id) e -= reductionShare(r, null, null);
  return e;
}

/** صافي إيراد الإيجار المحتفَظ به لكل عقد بأيامه · مرتّباً بالتاريخ */
function retainedTimelines(db: DB, ids: string[]): Map<string, Array<[string, number]>> {
  const out = new Map<string, Array<[string, number]>>();
  if (!ids.length || !hasDimColumns(db)) return out;
  const rows = db.all<{ cid: string; date: string; net: number }>(
    `SELECT l.contract_id AS cid, e.date AS date, SUM(l.credit_halalas - l.debit_halalas) AS net
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.code = l.account_code
     WHERE e.status = ? AND e.deleted_at IS NULL AND a.type = ?
       AND e.src_type IN (${RENT_SOURCES.map(() => '?').join(',')})
       AND l.contract_id IN (SELECT value FROM json_each(?))
     GROUP BY l.contract_id, e.date ORDER BY e.date`,
    [POSTED_STATUS, REVENUE_TYPE, ...RENT_SOURCES, JSON.stringify(ids)]);
  for (const r of rows) {
    const arr = out.get(r.cid) ?? [];
    arr.push([String(r.date).slice(0, 10), Number(r.net)]);
    out.set(r.cid, arr);
  }
  return out;
}

function prepaidExtras(db: DB, contracts: ContractAccrualRow[], reductions: AccrualReduction[]): PrepaidExtra[] {
  const cancelled = contracts.filter((c) => c.id && c.status === 'ملغى' && c.cancel_date); // i18n-exempt: حالة العقد المخزّنة
  const lines = retainedTimelines(db, cancelled.map((c) => c.id!));
  return cancelled.map((c) => ({
    contractId: c.id!, cancelDate: c.cancel_date!, earned: earnedOverLife(c, reductions), timeline: lines.get(c.id!) ?? [],
  }));
}

/** X(d) · المعترَف به زيادةً حتى نهاية يوم d (null: كل الزمن) */
function prepaidRecognizedThrough(x: PrepaidExtra, d: string | null): number {
  if (d !== null && d < x.cancelDate) return 0;
  let r = 0;
  for (const [day, net] of x.timeline) if (d === null || day <= d) r += net;
  return Math.max(0, r - x.earned);
}

/** نصيب الفترة [from,to] من زيادة الإنهاء المبكر · null حدٌّ مفتوح */
function prepaidShare(x: PrepaidExtra, from: string | null, to: string | null): number {
  return prepaidRecognizedThrough(x, to) - (from ? prepaidRecognizedThrough(x, addDays(from, -1)) : 0);
}

/**
 * ما قبضه المكتب من إيجار العقد فوق ما يكتسبه لو أُلغي في cancelDate (أو بإلغائه القائم): الإيجار المقدَّم عن مدةٍ بعد الإنهاء ·
 * هو ما يُعرض للردّ في نافذة الإلغاء، وسقف قيد الردّ (contracts/prepaid.ts)
 */
export function prepaidUnearned(db: DB, contractId: string, cancelDate?: string): number {
  const c = accrualContracts(db).find((x) => x.id === contractId);
  if (!c) return 0;
  const row: ContractAccrualRow & { id: string } = c.status === 'ملغى' || !cancelDate // i18n-exempt: حالة العقد المخزّنة
    ? { ...c, id: contractId }
    : {
      ...c, id: contractId, status: 'ملغى', cancel_date: cancelDate, // i18n-exempt: حالة العقد المخزّنة
      original_end: c.original_end || c.end, end: c.end && c.end > cancelDate ? cancelDate : c.end,
      installments_after_cancel: Number(db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM contract_installments WHERE contract_id = ? AND due_date > ?`, [contractId, cancelDate])!.n),
    };
  if (row.status !== 'ملغى') return 0; // i18n-exempt: حالة العقد المخزّنة
  const earned = earnedOverLife(row, accrualReductions(db, row));
  const r = (retainedTimelines(db, [contractId]).get(contractId) ?? []).reduce((s, [, n]) => s + n, 0);
  return Math.max(0, r - earned);
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
  /** ما رُسمل أصولاً من الفاتورة (مدين حسابات فئات الأصول في قيدها) */
  asset_halalas?: number;
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
export function purchaseExpenseHalalas(p: Pick<PurchaseAccrualRow, 'tax_halalas' | 'total_halalas' | 'tax_status'> & { asset_halalas?: number }): number {
  const deductible = p.tax_status === TS_DEDUCTIBLE ? Number(p.tax_halalas) || 0 : 0;
  // وبنودها التي صارت أصولاً ليست مصروفاً: إهلاكها يأتي من الدفتر (مراجعة التثبيت #11)
  return (Number(p.total_halalas) || 0) - deductible - (Number(p.asset_halalas) || 0);
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
    subtotal_halalas: number; tax_halalas: number; total_halalas: number; tax_status: string | null; asset_halalas: number;
  }>(
    // ما رُسمل أصولاً من الفاتورة: مدين قيدها في حسابات فئات الأصول، كما رحّله postPurchaseToLedger
    `SELECT p.id, p.date, p.amortize, p.amortize_months, p.subtotal_halalas, p.tax_halalas, p.total_halalas, p.tax_status,
            COALESCE((SELECT SUM(l.debit_halalas) FROM journal_lines l
                      WHERE l.entry_id = p.journal_entry_id AND l.account_code IN (${ASSET_CATEGORY_SQL})), 0) AS asset_halalas
     FROM purchases p
     WHERE p.deleted_at IS NULL AND p.date IS NOT NULL AND p.date != ''`
  ).map((r) => ({
    ...r,
    asset_halalas: Number(r.asset_halalas),
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
  const contracts = accrualContracts(db);
  const reductions = accrualReductions(db);
  for (const c of contracts) sum += contractPeriodRevenue(c, from, to);
  for (const r of reductions) sum -= reductionShare(r, from, to);
  for (const x of prepaidExtras(db, contracts, reductions)) sum += prepaidShare(x, from, to);
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

/**
 * مصروف الفترة بالاستحقاق موزَّعاً على حساباته (توزيع المصروفات في الرئيسية · المراجعة الشاملة 2026-11-13 · A2.6) ·
 * مجموعه periodExpenseAccrual بالهللة: سطور الدفتر لحسابات «مصروف» بلا قيود فواتير الشراء بحساباتها، ونصيب الفترة من كل
 * فاتورة شراء يُقسم على حسابات المصروف في قيدها بنسبها (والباقي من التقريب لأكبرها) · وفاتورةٌ بلا سطر مصروفٍ في قيدها
 * نصيبها لحساب فئتها.
 */
export function expenseByAccountAccrual(db: DB, from: string | null, to: string | null): Map<string, number> {
  const out = new Map<string, number>();
  const add = (code: string, v: number) => { if (v) out.set(code, (out.get(code) ?? 0) + v); };
  // i18n-exempt: حالة القيد ونوع الحساب المخزّنان
  const conds = [`e.status = 'مرحّل'`, `e.deleted_at IS NULL`, `a.type = 'مصروف'`,
    `COALESCE(e.src_type,'') NOT IN (${PURCHASE_SOURCES.map(() => '?').join(',')})`];
  const params: string[] = [...PURCHASE_SOURCES];
  if (from) { conds.push(`e.date >= ?`); params.push(from); }
  if (to) { conds.push(`e.date <= ?`); params.push(to); }
  for (const r of db.all<{ code: string; net: number }>(
    `SELECT l.account_code AS code, COALESCE(SUM(l.debit_halalas - l.credit_halalas),0) AS net
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.code = l.account_code
     WHERE ${conds.join(' AND ')} GROUP BY l.account_code`, params)) add(r.code, Number(r.net));
  // حسابات المصروف في قيد كل فاتورة شراء حية · أوزانُ قسمة نصيبها
  const weights = new Map<string, Array<{ code: string; w: number }>>();
  for (const r of db.all<{ pid: string; code: string; w: number }>(
    // i18n-exempt: نوع الحساب المخزّن
    `SELECT p.id AS pid, l.account_code AS code, SUM(l.debit_halalas - l.credit_halalas) AS w
     FROM purchases p JOIN journal_lines l ON l.entry_id = p.journal_entry_id JOIN accounts a ON a.code = l.account_code
     WHERE p.deleted_at IS NULL AND a.type = 'مصروف'
     GROUP BY p.id, l.account_code ORDER BY p.id, w DESC, l.account_code`)) {
    if (!Number(r.w)) continue;
    const list = weights.get(r.pid) ?? [];
    list.push({ code: r.code, w: Number(r.w) });
    weights.set(r.pid, list);
  }
  const categories = new Map(db.all<{ id: string; category: string | null }>(
    `SELECT id, category FROM purchases WHERE deleted_at IS NULL`).map((r) => [r.id, r.category]));
  for (const p of accrualPurchases(db)) {
    const share = purchasePeriodExpense(p, from, to);
    if (!share) continue;
    const list = weights.get(p.id!) ?? [];
    const total = list.reduce((s, x) => s + x.w, 0);
    if (!list.length || !total) { add(purchaseExpenseAccount(categories.get(p.id!)), share); continue; }
    let given = 0;
    for (let i = 1; i < list.length; i++) {
      const part = Math.round((share * list[i].w) / total);
      add(list[i].code, part);
      given += part;
    }
    add(list[0].code, share - given);
  }
  return out;
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
  const extras = prepaidExtras(db, contracts, reductions);
  const purchases = accrualPurchases(db);
  for (let ym = fromMonth; ym <= toMonth; ym = nextMonthKey(ym)) {
    const b = monthBounds(ym);
    let revenue = ledgerNetOfType(db, 'إيراد', b.from, b.to, RENT_SOURCES);
    let expense = ledgerNetOfType(db, 'مصروف', b.from, b.to, PURCHASE_SOURCES);
    for (const c of contracts) revenue += contractPeriodRevenue(c, b.from, b.to);
    for (const r of reductions) revenue -= reductionShare(r, b.from, b.to);
    for (const x of extras) revenue += prepaidShare(x, b.from, b.to);
    for (const p of purchases) expense += purchasePeriodExpense(p, b.from, b.to);
    out.set(ym, { revenue, expense });
  }
  return out;
}

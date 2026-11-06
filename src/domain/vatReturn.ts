/**
 * الإقرار الضريبي بترقيم الهيئة · ستة عشر بنداً:
 * البند ٧ = الفواتير الضريبية باسم المنشأة وحدها · والمستبعدة تُحصى في سطر منفصل
 * بعددها ومبلغها فتُرى وتُتأكد أنها خرجت. مع الكشوف المساندة الأربعة.
 */
import type { DB } from '../db/adapter';
import { mulQty, pctOf } from './money';
import { lineTaxCode, vatRegistered } from './taxCode';

export interface VatItem {
  no: string;
  label: string;
  amountHalalas: number;
  taxHalalas: number;
  /** يُملأ يدوياً في النموذج المصدَّر */
  manual?: boolean;
}

export interface VatReturnData {
  period: string;
  from: string;
  to: string;
  items: VatItem[];
  /** إيجارٌ تجاري محصَّل في الفترة خارج البند ٥ (سطر رقابة حتى تُبنى ضريبة التجاري) */
  commercialRentHalalas: number;
  /**
   * الإيجار التجاري المحصَّل في الفترة قبل خصم ما أُلغي فيها من فتراتٍ سابقة (التحقق المستقل على البند ١٠): منع التقديم به لا بالصافي،
   * فإلغاءٌ بالمبلغ نفسه لا يفتح تقديم إقرارٍ ناقص
   */
  commercialRentCollectedHalalas: number;
  /** المستبعدة من الإقرار خلال الفترة · سطر الرقابة */
  excluded: { count: number; amountHalalas: number; taxWithinHalalas: number };
  schedules: {
    deductiblePurchases: Array<{ id: string; no: string; date: string; supplier: string; supplierVatno: string; subtotal: number; tax: number; total: number }>;
    excludedPurchases: Array<{ id: string; no: string; date: string; supplier: string; subtotal: number; tax: number; total: number; reason: string }>;
    exemptSales: Array<{ date: string; tenant: string; contractNo: string; unitLabel: string; net: number }>;
    transfers: Array<{ date: string; amount: number; party: string; purpose: string; bankRef: string; invoiceNo: string }>;
  };
}

export function quarterRange(year: number, quarter: 1 | 2 | 3 | 4): { from: string; to: string } {
  const m0 = (quarter - 1) * 3;
  const from = `${year}-${String(m0 + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(year, m0 + 3, 0).getDate();
  const to = `${year}-${String(m0 + 3).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

type ExemptRow = VatReturnData['schedules']['exemptSales'][number];

/** أنواع الوحدة السكنية (المعفى إيجارها) · والعقد بلا نوع (قديم) سكنيٌّ كما كان افتراض الوحدة */
const RESIDENTIAL_TYPES = ['سكني', 'سكن طلاب', 'سكن طالبات']; // i18n-exempt: أنواع وحدة مخزّنة
const RESIDENTIAL_SQL = `(COALESCE(c.unit_type, '') = '' OR c.unit_type IN (${RESIDENTIAL_TYPES.map((x) => `'${x}'`).join(', ')}))`;

/** صافي الدفعة بلا فائضها الذي صار رصيداً دائناً للمستأجر (دائن 2410 في قيدها) */
const PAY_NET_SQL = `p.net_halalas - COALESCE((SELECT SUM(l.credit_halalas) FROM journal_lines l
  WHERE l.entry_id = p.journal_entry_id AND l.account_code = '2410'), 0)`;
/** يوم إلغاء الدفعة · المخزَّن تاريخٌ، والقديم قد يكون لحظة */
const CANCEL_DAY_SQL = `substr(p.cancelled_at, 1, 10)`;

/**
 * الإيجار التجاري المحصَّل في الفترة (خارج البند ٥) · الدفعة في فترة قبضها ولو أُلغيت بعدها، وإلغاؤها يُخصم في فترة إلغائه
 * (المراجعة الشاملة · البند ١٠) · والملغاة في فترتها نفسها لا تُعدّ فيها أصلاً (صافيها صفر)
 */
function commercialRentParts(db: DB, from: string, to: string): { paid: number; cancelled: number } {
  const paid = Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(${PAY_NET_SQL}), 0) AS s
     FROM contract_payments p JOIN contracts c ON c.id = p.contract_id
     WHERE p.date >= ? AND p.date <= ? AND (p.cancelled_at IS NULL OR ${CANCEL_DAY_SQL} > ?) AND NOT ${RESIDENTIAL_SQL}`,
    [from, to, to])?.s ?? 0);
  const cancelled = Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(${PAY_NET_SQL}), 0) AS s
     FROM contract_payments p JOIN contracts c ON c.id = p.contract_id
     WHERE p.cancelled_at IS NOT NULL AND ${CANCEL_DAY_SQL} >= ? AND ${CANCEL_DAY_SQL} <= ? AND p.date < ? AND NOT ${RESIDENTIAL_SQL}`,
    [from, to, from])?.s ?? 0);
  return { paid, cancelled };
}

/** مبيعات الفواتير بالرمز: الفاتورة برمزٍ واحد بمجاميعها المحفوظة، والمختلطة سطراً سطراً */
function invoiceSales(db: DB, from: string, to: string): { S: number; tax: number; Z: number; E: number } {
  const out = { S: 0, tax: 0, Z: 0, E: 0 };
  const registered = vatRegistered(db);
  const hasKind = db.all<{ name: string }>(`PRAGMA table_info(invoices)`).some((c) => c.name === 'kind');
  const invs = db.all<{ id: string; subtotal_halalas: number; tax_halalas: number; kind: string | null }>(
    `SELECT id, subtotal_halalas, tax_halalas, ${hasKind ? 'kind' : 'NULL AS kind'} AS kind FROM invoices
     WHERE deleted_at IS NULL AND status != ? AND issue >= ? AND issue <= ?`,
    ['مسودة', from, to]); // i18n-exempt: حالة مخزّنة
  for (const v of invs) {
    const lines = db.all<{ qty: number; price_halalas: number; tax_pct: number; tax_code: string | null }>(
      `SELECT qty, price_halalas, tax_pct, tax_code FROM invoice_lines WHERE invoice_id = ?`, [v.id]);
    const codes = new Set(lines.map((l) => lineTaxCode(l.tax_code, Number(l.tax_pct))));
    const parts = codes.size <= 1
      ? [{ code: [...codes][0] ?? (Number(v.tax_halalas) ? 'S' : 'E'), net: Number(v.subtotal_halalas), tax: Number(v.tax_halalas) }]
      : lines.map((l) => {
        const net = mulQty(Number(l.qty), Number(l.price_halalas));
        return { code: lineTaxCode(l.tax_code, Number(l.tax_pct)), net, tax: pctOf(net, Number(l.tax_pct)) };
      });
    // الإشعار الدائن المقسوم على رموز فاتورته (المراجعة الشاملة · البند ٧): ضريبته المرحّلة على سطره الخاضع، فيطابق الإقرار دفتره
    // بالهللة ولا يُعاد حسابها سطراً سطراً
    if (codes.size > 1 && v.kind === 'credit_note') {
      const s = parts.find((p) => p.code === 'S');
      if (s) s.tax = Number(v.tax_halalas) - parts.filter((p) => p !== s).reduce((x, p) => x + p.tax, 0);
    }
    for (const p of parts) {
      if (p.code === 'S') { if (registered) { out.S += p.net; out.tax += p.tax; } }
      else if (p.code === 'Z') { if (registered) out.Z += p.net; }
      else out.E += p.net;
    }
  }
  return out;
}

/**
 * عمولات التقبيل الخاضعة في البند ١ (المراجعة الشاملة ٨ · البند ١١): من سطور قيودها نفسها في الدفتر، فيطابق البند ١ حركةَ 2200
 * بالهللة · القيد الذي حمل ضريبة مخرجات (منشأة مسجّلة يوم الصفقة) وعكسه (key_money_rev) ونسخة استعادته من السلة، كلٌّ بتاريخه:
 * فالإلغاء ينقص البند ١ في فترة العكس كما ينقص الدفتر. والعمولة بلا سطر 2200 (منشأة غير مسجّلة يومها) خارجه كما كانت.
 */
function keyMoneySales(db: DB, from: string, to: string): { net: number; tax: number } {
  const r = db.get<{ net: number; tax: number }>(
    `SELECT COALESCE(SUM(CASE WHEN l.account_code = '4300' THEN l.credit_halalas - l.debit_halalas ELSE 0 END), 0) AS net,
            COALESCE(SUM(CASE WHEN l.account_code = '2200' THEN l.credit_halalas - l.debit_halalas ELSE 0 END), 0) AS tax
     FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.src_type IN ('key_money', 'key_money_rev') AND e.status = ? AND e.deleted_at IS NULL AND e.date >= ? AND e.date <= ?
       AND EXISTS (SELECT 1 FROM journal_lines x WHERE x.entry_id = e.id AND x.account_code = '2200')`,
    ['مرحّل', from, to]); // i18n-exempt: حالة مخزّنة
  return { net: Number(r?.net ?? 0), tax: Number(r?.tax ?? 0) };
}

/**
 * صفوف المبيعات المعفاة (البند ٥ وكشفه معاً · #31 والتحقق المستقل):
 *  - كل دفعة إيجار بصافيها بلا فائضها الذي صار رصيداً دائناً للمستأجر (دائن 2410 في قيدها): التزامٌ له لا توريد.
 *  - والدفعة الملغاة بعد فترتها تبقى فيها، ويُخصم صافيها بصفٍّ سالب بتاريخ إلغائها (المراجعة الشاملة · البند ١٠): كان الإلغاء يُسقطها
 *    من فترتها الأصلية فيتغير ما قُدِّم، ولا يظهر في فترة الإلغاء · والملغاة في فترتها نفسها لا تظهر فيها (صافيها صفر).
 *  - وفائضٌ قديمٌ دخل إيراداً ثم سُوّي رصيداً أو رُدّ (surplus_credit وsurplus_refund وعكوسهما): ينقص في فترة تسويته.
 */
function exemptSalesRows(db: DB, from: string, to: string): ExemptRow[] {
  const none = 'لا يوجد'; // i18n-exempt: نص الكشف المصدَّر بالعربية
  const pays = db.all<ExemptRow>(
    `SELECT p.date, c.tenant_name AS tenant, COALESCE(c.contract_no, ?) AS contractNo, c.unit_label AS unitLabel,
            ${PAY_NET_SQL} AS net
     FROM contract_payments p JOIN contracts c ON c.id = p.contract_id
     WHERE p.date >= ? AND p.date <= ? AND (p.cancelled_at IS NULL OR ${CANCEL_DAY_SQL} > ?) AND ${RESIDENTIAL_SQL}
     ORDER BY p.date`, [none, from, to, to]);
  const cancelled = db.all<ExemptRow>(
    `SELECT ${CANCEL_DAY_SQL} AS date, c.tenant_name AS tenant, COALESCE(c.contract_no, ?) AS contractNo, c.unit_label AS unitLabel,
            -(${PAY_NET_SQL}) AS net
     FROM contract_payments p JOIN contracts c ON c.id = p.contract_id
     WHERE p.cancelled_at IS NOT NULL AND ${CANCEL_DAY_SQL} >= ? AND ${CANCEL_DAY_SQL} <= ? AND p.date < ? AND ${RESIDENTIAL_SQL}
     ORDER BY ${CANCEL_DAY_SQL}`, [none, from, to, from]);
  const settled = db.all<ExemptRow>(
    `SELECT e.date, c.tenant_name AS tenant, COALESCE(c.contract_no, ?) AS contractNo, c.unit_label AS unitLabel,
            -SUM(l.debit_halalas - l.credit_halalas) AS net
     FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN contracts c ON c.id = e.src_id
     WHERE ${RESIDENTIAL_SQL} AND e.src_type IN ('surplus_credit', 'surplus_refund', 'surplus_credit_rev', 'surplus_refund_rev')
       AND e.status = ? AND e.deleted_at IS NULL AND l.account_code LIKE '42%' AND e.date >= ? AND e.date <= ?
     GROUP BY e.id ORDER BY e.date`,
    [none, 'مرحّل', from, to]); // i18n-exempt: حالة مخزّنة
  return [...pays, ...cancelled.filter((r) => Number(r.net) !== 0), ...settled.filter((r) => Number(r.net) !== 0)]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function vatReturnData(db: DB, year: number, quarter: 1 | 2 | 3 | 4): VatReturnData {
  const { from, to } = quarterRange(year, quarter);
  const commercial = commercialRentParts(db, from, to);
  const inPeriod = (col: string) => ` AND ${col} >= '${from}' AND ${col} <= '${to}'`;

  // ١ و٣ و٥ · فواتير البيع غير المسودة برمز ضريبة سطورها (الهجرة ٣٩): الخاضع في ١، والصفري في ٣، والمعفى في ٥ ·
  // والمنشأة غير المسجّلة لا مبيعات خاضعة لها (دراسة القائم)
  const sales = invoiceSales(db, from, to);
  // ١ · وعمولات التقبيل الخاضعة من قيودها (المراجعة الشاملة ٨ · البند ١١)
  const keyMoney = keyMoneySales(db, from, to);

  // ٥ · المبيعات المعفاة = إيرادات الإيجار السكني المحصَّلة، من صفوف كشفها نفسها (exemptSalesRows)

  // ٧ · المشتريات الخاضعة باسمنا وحدها · لبّ الطلب
  const ded = db.get<{ sub: number; tax: number }>(
    `SELECT COALESCE(SUM(subtotal_halalas),0) AS sub, COALESCE(SUM(tax_halalas),0) AS tax
     FROM purchases WHERE deleted_at IS NULL AND tax_status = 'فاتورة ضريبية · قابلة للخصم'${inPeriod('date')}`
  )!;

  // ١٠ و١١ · المشتريات بالنسبة الصفرية والمعفاة من حالتها الضريبية لا من فئتها (#31)
  const zeroPur = db.get<{ s: number }>(
    `SELECT COALESCE(SUM(subtotal_halalas),0) AS s FROM purchases
     WHERE deleted_at IS NULL AND tax_status = ?${inPeriod('date')}`,
    ['خاضعة بنسبة صفرية'] // i18n-exempt: حالة مخزّنة
  )!;
  const exemptPur = db.get<{ s: number }>(
    `SELECT COALESCE(SUM(total_halalas),0) AS s FROM purchases
     WHERE deleted_at IS NULL AND tax_status = ?${inPeriod('date')}`,
    ['معفاة من الضريبة'] // i18n-exempt: حالة مخزّنة
  )!;

  // سطر الرقابة: المستبعدة بعددها ومبلغها
  const excl = db.get<{ n: number; amt: number; tx: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total_halalas),0) AS amt, COALESCE(SUM(tax_halalas),0) AS tx
     FROM purchases WHERE deleted_at IS NULL AND tax_status = 'غير قابلة للخصم'${inPeriod('date')}`
  )!;

  const salesSub = sales.S + keyMoney.net, salesTax = sales.tax + keyMoney.tax, zeroSales = sales.Z;
  const exemptSales = exemptSalesRows(db, from, to);
  const rentNet = exemptSales.reduce((s, r) => s + Number(r.net), 0);
  const dedSub = Number(ded.sub), dedTax = Number(ded.tax);
  const exemptPurAmt = Number(exemptPur.s), zeroPurAmt = Number(zeroPur.s);
  const totalSales = salesSub + zeroSales + rentNet + sales.E;
  const totalPurch = dedSub + zeroPurAmt + exemptPurAmt;
  const netVat = salesTax - dedTax;

  const items: VatItem[] = [
    { no: '1', label: 'المبيعات الخاضعة للنسبة الأساسية', amountHalalas: salesSub, taxHalalas: salesTax },
    { no: '1.1', label: 'المبيعات الخاضعة لنسبة ٥٪', amountHalalas: 0, taxHalalas: 0 },
    { no: '1.2', label: 'المبيعات الحكومية الخاضعة', amountHalalas: 0, taxHalalas: 0 },
    { no: '2', label: 'المبيعات التي تتحمل الدولة ضريبتها', amountHalalas: 0, taxHalalas: 0 },
    { no: '3', label: 'المبيعات المحلية بالنسبة الصفرية', amountHalalas: zeroSales, taxHalalas: 0 },
    { no: '4', label: 'الصادرات', amountHalalas: 0, taxHalalas: 0 },
    { no: '5', label: 'المبيعات المعفاة (إيرادات الإيجار السكني)', amountHalalas: rentNet + sales.E, taxHalalas: 0 },
    { no: '6', label: 'إجمالي المبيعات', amountHalalas: totalSales, taxHalalas: salesTax },
    { no: '7', label: 'المشتريات الخاضعة للنسبة الأساسية (الفواتير الضريبية القابلة للخصم وحدها)', amountHalalas: dedSub, taxHalalas: dedTax },
    { no: '7.1', label: 'المشتريات الخاضعة لنسبة ٥٪', amountHalalas: 0, taxHalalas: 0 },
    { no: '8', label: 'الاستيرادات الخاضعة المسددة في الجمارك', amountHalalas: 0, taxHalalas: 0 },
    { no: '9', label: 'الاستيرادات الخاضعة للآلية العكسية', amountHalalas: 0, taxHalalas: 0 },
    { no: '10', label: 'المشتريات بالنسبة الصفرية', amountHalalas: zeroPurAmt, taxHalalas: 0 },
    { no: '11', label: 'المشتريات المعفاة', amountHalalas: exemptPurAmt, taxHalalas: 0 },
    { no: '12', label: 'إجمالي المشتريات', amountHalalas: totalPurch, taxHalalas: dedTax },
    { no: '13', label: 'إجمالي ضريبة القيمة المضافة المستحقة للفترة', amountHalalas: 0, taxHalalas: netVat },
    { no: '14', label: 'تصحيحات من فترات سابقة', amountHalalas: 0, taxHalalas: 0, manual: true },
    { no: '15', label: 'الضريبة المرحَّلة من فترات سابقة', amountHalalas: 0, taxHalalas: 0, manual: true },
    { no: '16', label: netVat >= 0 ? 'صافي الضريبة المستحقة' : 'صافي الضريبة المستردة', amountHalalas: 0, taxHalalas: netVat },
  ];

  const deductiblePurchases = db.all<{ id: string; no: string; date: string; supplier: string; supplierVatno: string; subtotal: number; tax: number; total: number }>(
    `SELECT id, no, date, supplier_name AS supplier, supplier_vatno AS supplierVatno,
            subtotal_halalas AS subtotal, tax_halalas AS tax, total_halalas AS total
     FROM purchases WHERE deleted_at IS NULL AND tax_status = 'فاتورة ضريبية · قابلة للخصم'${inPeriod('date')} ORDER BY date`
  );
  const excludedPurchases = db.all<{ id: string; no: string; date: string; supplier: string; subtotal: number; tax: number; total: number; reason: string }>(
    `SELECT id, no, date, supplier_name AS supplier, subtotal_halalas AS subtotal,
            tax_halalas AS tax, total_halalas AS total, exclude_reason AS reason
     FROM purchases WHERE deleted_at IS NULL AND tax_status = 'غير قابلة للخصم'${inPeriod('date')} ORDER BY date`
  );

  const transfers = db.all<{ date: string; amount: number; party: string; purpose: string; bankRef: string; invoiceNo: string }>(
    `SELECT pu.paid_date AS date, pu.total_halalas AS amount, pu.supplier_name AS party,
            pu.category AS purpose, COALESCE(je.no,'لا يوجد') AS bankRef, pu.no AS invoiceNo
     FROM purchases pu LEFT JOIN journal_entries je ON je.id = pu.payment_journal_entry_id
     WHERE pu.deleted_at IS NULL AND pu.paid = 1 AND pu.payment_method LIKE '%تحويل%'
       AND pu.paid_date >= '${from}' AND pu.paid_date <= '${to}' ORDER BY pu.paid_date`
  );

  return {
    period: `${year}-Q${quarter}`, from, to, items, commercialRentHalalas: commercial.paid - commercial.cancelled,
    commercialRentCollectedHalalas: commercial.paid,
    excluded: { count: Number(excl.n), amountHalalas: Number(excl.amt), taxWithinHalalas: Number(excl.tx) },
    schedules: { deductiblePurchases, excludedPurchases, exemptSales, transfers },
  };
}

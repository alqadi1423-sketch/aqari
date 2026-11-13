/**
 * إعادة اشتقاق سطور قيد العضو من مستنده · بقية المراحل بعد التحصيل (التوجيه الثالث · ١ · قرار المالك 2026-10-15 «١»: «(ب) على مراحل،
 * الدفعات والتحصيل أولاً، ثم بقية المصادر بترتيب كثرة استعمالها»، و2026-11-07: «وتُطبق المطابقة في كل مرحلة قادمة من إعادة
 * الاشتقاق») · حين يصل جهازَ المالك قيدٌ مرحّل كتبه عضو بمصدرٍ هنا، تُحسب سطوره من مستنده (الصف هنا أو الوارد المنتظر) بدوال بناء
 * السطور نفسها التي رحّل بها الجهاز الكاتب (post.ts)، وتُقارن حساباً بحساب ومبلغاً بمبلغ وبُعداً ببُعد (أبعاد المصدر كما يشتقها
 * dimsFromSource) · ويُرفض القيد كله إن خالف، ويُنتظر إن لم يصل مستنده.
 *
 *  - القيد الذي وصل معكوساً (reversed_by) أثره صفر متى طُبِّق عاكسه بعده: يُفحص عاكسه مرآةً لسطوره كلها بالحساب والمبلغ والبُعد،
 *    وحساباته من أطراف مصدره، ولا يُطابق بمستنده الحالي (تعديل التسوية أو المطالبة يعكس القديم ويرحّل الجديد، فالمستند يحمل القيم
 *    الجديدة) · والعاكس سيُقبل بعده فعلاً (المتحقق المستقل): لم يُطبَّق قبله، ولا سمّاه قيدٌ آخر، ويمرّ بفحص memberReversalCheck
 *    وبتفرّد رقمه وسطوره · وإلا بقي القيد حياً بأي مبلغٍ وعاكسه مرفوض.
 *  - وقيدٌ ثانٍ حيّ من المصدر نفسه لا يدخل حتى يُطبَّق عاكس الأول (مرحَّلٌ مرتين بالمبلغ الصحيح يضاعف أثره): يُنتظر، فإن لم يصل
 *    عاكسٌ رُفض لطول انتظاره ولم يدخل الدفتر.
 */
import type { DB } from '../../db/adapter';
import { t } from '../../i18n';
import { isFiledDate } from '../vatFilings';
import { today as todayFn } from '../dates';
import { unitPastProperties } from '../unitMove';
import {
  contractDepositLines, depositCarryLines, depositDeductLines, depositDeductMoveLines, depositRefundLines, depositRentLines,
  reservationDepositLines, reservationForfeitLines, reservationRefundLines, keyMoneyLines,
  claimLines, claimCollectionLines, purchaseLedgerLines, purchasePaymentLines, PURCHASE_CATEGORY_ACCOUNT,
  invoiceLedgerLines, creditNoteLedgerLines, invoicePaymentLines, vatRefundLines, vatRejectLines, cashOpLines, purchaseExpenseAccount, type EntryLine,
} from './post';
import { TS_DEDUCTIBLE } from '../purchases';
import { RENT_REVENUE_GROUP } from './rentSplit';
import { DEPOSIT_RENT_METHOD, DEPOSIT_RENT_SRC, SETTLEMENT_CLAIM_SOURCE } from '../contracts/installments';
import { invoiceTotals, normalizeInvoiceLines, KIND_CREDIT } from '../invoices';
import { remainingByCodeOf, creditNoteAmounts, type StoredInvoiceLine } from '../creditNote';
import { lineTaxCode, vatRegistered, type TaxCode } from '../taxCode';
import { mulQty } from '../money';
import { lineCosts, splitQty } from '../assets/purchaseLines';
import {
  ASSET_CATEGORIES, isAssetCategory, ENDED, ACC_ACCUM, ACC_DEPRECIATION, ACC_RETAINED, ACC_CAPITAL, ACC_CASH, ACC_DISPOSAL_LOSS, ACC_SALE_GAIN,
} from '../assets/catalog';
import { catchUpAmounts, expectedThrough, monthEnd, monthIndex, type DepreciableAsset } from '../assets/depreciation';

/** سطرٌ وارد كما في مستنده (journal_lines) */
export interface SrcLine {
  id?: unknown; entry_id?: unknown; account_code?: unknown; debit_halalas?: unknown; credit_halalas?: unknown;
  contract_id?: unknown; unit_id?: unknown; property_id?: unknown; asset_id?: unknown;
}
/** قيدٌ مرحّل لمصدرٍ هنا أو في الوارد · وعاكسه المربوط به هنا */
export interface SrcEntry { id: string; src_type: string | null; src_id: string | null; lines: SrcLine[]; reversed_by?: string | null; date?: string | null }
/** قيدٌ بمعرّفه كما سيُطبَّق: هنا (here) أو من الوارد بأعمدة مستنده */
export interface RevEntry extends SrcEntry {
  here: boolean; key: string | null; no: string | null; status: string | null; date: string | null; created_at: string | null;
  deleted_at: string | null;
}

/** قارئ المستندات على جهاز المالك (sync/engine.ts): أحدث نسخةٍ للصف (الوارد المنتظر ثم القائم)، والقيود المرحّلة بمصدرها */
export interface SourceReader {
  row<T>(table: string, key: string): T | null;
  /**
   * صفّ الأصل كما سيُطبَّق: أحدث نسخه في الوارد، إلا نسخةً تغيّر أساس إهلاكه بعد إثبات تكلفته هنا فتُرفض حين يأتي دورها (المتحقق
   * المستقل: كان الإهلاك يُشتق من عمرٍ مقصَّر في الصف الوارد قبل رفضه) · فيُشتق مما هنا
   */
  asset<T>(id: string): T | null;
  /** صفوف جدولٍ بعمودٍ وقيمته: هنا، وأحدث نسخها في الوارد تغلبها، والمحذوف فيه يُسقطها (سطور المستند وأصوله وإشعاراته) */
  rows<T>(table: string, col: string, value: string): T[];
  /**
   * القيود المرحّلة بمصدرها هنا وحده: ما في الوارد لم يُفحص بعد (عاكسٌ مزوّر فيه كان يُحتسب) · وما يُنتظر منه يُنتظر به، فيُعاد
   * القيد في المرور التالي بعد تطبيقه
   */
  entries(srcType: string, srcId: string): SrcEntry[];
  /** قيدٌ مرحّل بمعرّفه هنا، أو في الوارد مرحّلاً ولم يُطبَّق هنا بعد */
  entry(id: string): RevEntry | null;
  /** القيود التي تسمّي revId عاكساً لها: هنا، وفي الربط المعلّق والمخمَّن، وفي الوارد */
  claimants(revId: string): string[];
  /** رقمٌ أو معرّف سطرٍ يحمله قيدٌ غير exceptId هنا أو في الوارد (فيُرفض قيد exceptId بتفرّدهما حين يُطبَّق) */
  taken(no: string, lineIds: string[], exceptId: string): boolean;
  /** معرّفات القيود المرحّلة بمصدرها في الوارد ولم تُطبَّق هنا بعد */
  pending(srcType: string, srcId: string): string[];
  /** القيود المرحّلة التي في سطورها الأصل assetId: هنا (here)، وفي الوارد مرحّلةً ولم تُطبَّق هنا بعد */
  assetEntries(assetId: string): Array<SrcEntry & { here: boolean }>;
}

/** حسابات مصروف فئات الشراء (purchaseExpenseAccount: الفئة المعروفة، وإلا 5300) */
const EXPENSE_ACCOUNTS = [...new Set([...Object.values(PURCHASE_CATEGORY_ACCOUNT), '5300'])];

/** المصادر التي يُعاد اشتقاقها هنا · وأطراف حساباتها (لما وصل معكوساً) */
export const DERIVED_SOURCES: Record<string, string[]> = {
  contract_deposit: ['1100', '1260', '2400'],
  deposit_deduct: ['2400', '4300', '1100'],
  deposit_deduct_move: ['1265', '1100', '1260'],
  deposit_refund: ['2400', '1100', '1260'],
  deposit_carry: ['2400'],
  // سداد القسط المتأخر من التأمين في تسويته (المراجعة الشاملة 2026-11-13 · A1-2): التزام التأمين وإيراد العقد بتقسيمه
  deposit_rent: ['2400', ...RENT_REVENUE_GROUP],
  reservation: ['1100', '2450'],
  reservation_forfeit: ['2450', '4300'],
  reservation_refund: ['2450', '1100'],
  key_money: ['1100', '4300', '2200'],
  claim: ['1250', '4300'],
  claim_collect: ['1100', '1250'],
  // فاتورة الشراء: مصروف فئتها، وحسابات فئات أصول بنودها، وضريبة المدخلات القابلة للاسترداد، وفرق التقريب، والذمم الدائنة
  purchase: [...EXPENSE_ACCOUNTS, ...ASSET_CATEGORIES.map((c) => c.code), '1270', '5900', '2100'],
  purchase_pay: ['2100', '1100'],
  // استرداد ضريبة المدخلات نقداً، أو رفضه تكلفةً في مصروف الفئة
  vat_refund: ['1100', '1270', ...EXPENSE_ACCOUNTS],
  // العملية النقدية: المصروف النثري ورسوم البنك، وإيداع المالك ومسحوباته، والوارد البنكي الآخر (بلا ضريبة مخرجات · البند ١١)
  cash_op: ['1100', '5400', '3100', '4300'],
  // فاتورة المبيعات وإشعارها الدائن (مصدره صفّ الإشعار نفسه) وتحصيلها
  invoice: ['1200', '4100', '2200'],
  invoice_pay: ['1100', '1200'],
  // الإهلاك الشهري (runDepreciation) وإهلاك أصلٍ واحد حتى تاريخ عمليته (depreciateAssetTo): مصروف الإهلاك ومجمعه
  depreciation: [ACC_DEPRECIATION, ACC_ACCUM],
  asset_dep: [ACC_DEPRECIATION, ACC_ACCUM],
  // إثبات تكلفة أصلٍ بلا فاتورة (دائن رأس المال) ومعه إهلاك ما فات، وإهلاك ما فات لأصول فاتورةٍ بتاريخٍ مضى أو محوّلة
  asset_cost: [...ASSET_CATEGORIES.map((c) => c.code), ACC_CAPITAL, ACC_DEPRECIATION, ACC_RETAINED, ACC_ACCUM],
  asset_catchup: [ACC_DEPRECIATION, ACC_RETAINED, ACC_ACCUM],
  // نقل الأصل بين وحدتين (تكلفته ومجمعه)، واستبعاده (خسارته)، وبيعه نقداً أو ببنك (ربحه أو خسارته)
  asset_transfer: [...ASSET_CATEGORIES.map((c) => c.code), ACC_ACCUM],
  asset_dispose: [...ASSET_CATEGORIES.map((c) => c.code), ACC_ACCUM, ACC_DISPOSAL_LOSS],
  asset_sell: [...ASSET_CATEGORIES.map((c) => c.code), ACC_ACCUM, ACC_DISPOSAL_LOSS, ACC_CASH, ACC_SALE_GAIN],
  // تحويل فاتورةٍ قديمة مسجّلة مصروفاً إلى أصول: مدين حسابات فئات أصولها ودائن مصروف فئتها
  asset_convert: [...ASSET_CATEGORIES.map((c) => c.code), ...EXPENSE_ACCOUNTS],
};

/**
 * مصادر يرحّل منها التطبيق قيوداً عدة حيّة لمستندٍ واحد (المعرّف معرّف الأصل): إهلاك ما قبل كل نقلٍ أو استبعادٍ أو بيع، وكل نقل ·
 * فلا يُنتظر لها عاكس قيدٍ سابق، ويُفحص تكرارها بالمطابقة نفسها (المجمع بعد ما رُحِّل قبلها، والنقل بحدثه المسمّي قيده)
 */
// وسداد الأقساط من التأمين: قيدٌ حيّ لكل قسطٍ والمعرّف العقد (A1-2)
const MULTI = ['asset_dep', 'asset_transfer', DEPOSIT_RENT_SRC];

/** أبعاد سطرٍ متوقعة: العقد والوحدة، والعقار أحد عقاراتٍ (الحالي أو ما نُقلت منه الوحدة)، والأصل (بنود الشراء الأصول وحدها) */
interface DimSpec { contract: string | null; unit: string | null; props: Array<string | null>; asset?: string | null }
interface Want { account: string; debit: number; credit: number; dims: DimSpec[] }
/**
 * السطور المشتقة وتاريخها · alts: أشكالٌ أخرى يرحّلها التطبيق من المستند نفسه (يكفي أن يطابق أحدها) · date: null لمستندٍ لا يخزّن
 * تاريخ قيده · also: تواريخ أخرى مقبولة (نسخة الاستعادة من السلة بتاريخ عكس قيدها السابق: repostDate)
 */
interface Derived {
  lines: Want[]; alts?: Want[][]; date: string | null; also?: string[]; correctable: boolean;
  /**
   * صفٌّ لا يسمّي قيده وقد يكون أقدم من القيد (المتحقق المستقل): التعديل، أو الإلغاء ثم الترحيل الجديد، يعكس القيد السابق ويكتب الصف
   * من جديد، والقيود قبل مستنداتها في ترتيب الرفع والعضو يرفع على دفعات، فقد يصل القيد قبل صفّه المحدَّث · فإن طابق ما يشتقه الصف
   * قيداً سابقاً من مصدره عُكس هنا (سطوراً وتاريخاً)، فالصف هو الذي رُحِّل منه ذلك القيد، وما خالفه يُنتظر ولا يُرفض (والمزوَّر يُرفض
   * لطول انتظاره ولا يدخل الدفتر) · وإلا فالصف محدَّثٌ بعده وما خالفه يُرفض
   */
  stale?: boolean;
  /**
   * في الوارد قيدٌ لم يُطبَّق بعد يغيّر ما اشتُقّ منه (مجمع الأصل أو تكلفته قبل القيد · وسطور مستندٍ من حفظين): ما خالف يُنتظر حتى
   * يُطبَّق أو يُرفض، ثم يُفحص بالدفتر هنا وحده (والمزوَّر يُرفض لطول انتظاره ولا يدخل الدفتر)
   */
  pending?: boolean;
}

const str = (v: unknown) => (v == null || v === '' ? null : String(v));
const num = (v: unknown) => Number(v) || 0;
const nonZero = <T extends SrcLine>(ls: T[]) => ls.filter((l) => num(l.debit_halalas) || num(l.credit_halalas));
const total = (e: SrcEntry) => e.lines.reduce((s, l) => s + num(l.credit_halalas), 0);

const AWAIT = 'await';
const POSTED = 'مرحّل'; // i18n-exempt: حالة القيد المخزّنة
type Outcome = Derived | typeof AWAIT | string;

/** أبعاد عقدٍ ووحدته وعقارها كما يشتقها dimsFromSource على الجهاز الكاتب · null إن لم يصل العقد */
function contractDims(db: DB, r: SourceReader, contractId: string, ownContract?: string): DimSpec | null {
  const c = r.row<{ unit_id: string | null }>('contracts', contractId);
  if (!c) return null;
  return { ...unitDims(db, r, c.unit_id ?? null), contract: ownContract ?? contractId };
}
function unitDims(db: DB, r: SourceReader, unitId: string | null): DimSpec {
  if (!unitId) return { contract: null, unit: null, props: [null] };
  const now = r.row<{ property_id: string | null }>('units', unitId)?.property_id ?? null;
  return { contract: null, unit: unitId, props: [now, ...unitPastProperties(db, unitId)] };
}
/** أبعاد فاتورة الشراء أو المبيعات (dimsFromSource): عقارها المختار وإلا عقار وحدتها، ووحدتها، ولا عقد */
function docDims(db: DB, r: SourceReader, unitId: string | null, propertyId: string | null): DimSpec {
  const u = unitDims(db, r, unitId ?? null);
  return { contract: null, unit: unitId ?? null, props: propertyId ? [propertyId] : u.props };
}
/** لا بُعد: مصدرٌ لا يشتق dimsFromSource أبعاده (العملية النقدية واسترداد الضريبة) */
const NONE: DimSpec = { contract: null, unit: null, props: [null] };
/** تواريخ عواكس المصدر هنا: نسخة الاستعادة من السلة تُرحَّل بتاريخ عكس قيدها السابق (repostCopy وrestoreInvoice: repostDate) */
const revDates = (r: SourceReader, src: string, srcId: string): string[] =>
  r.entries(src + '_rev', srcId).map((x) => String(x.date ?? '')).filter(Boolean);
/** مبالغ السطور لكل حساب كما في المشتق (بلا الأبعاد: قيودٌ أقدم من أبعاد التقبيل) */
const sameAmounts = (ls: SrcLine[], w: Want[]): boolean => {
  const net = new Map<string, number>();
  for (const l of ls) net.set(String(l.account_code ?? ''), (net.get(String(l.account_code ?? '')) ?? 0) + num(l.debit_halalas) - num(l.credit_halalas));
  for (const x of w) net.set(x.account, (net.get(x.account) ?? 0) - x.debit + x.credit);
  return [...net.values()].every((v) => v === 0);
};
/**
 * تواريخ قيد عمولة التقبيل الحيّ غير تاريخ الصفقة: تاريخ عاكس أصلٍ من الصفقة نفسها (نسخة الاستعادة من السلة بتاريخ عكس قيدها السابق ·
 * repostDate) بشرط أن يكون ذلك الأصل نفسه بتاريخٍ مقبول وبمبالغ الصفقة، وعاكسه مرآته · هنا أو في الوارد
 */
function keyMoneyDates(r: SourceReader, dealId: string, exceptId: string, dealDate: string, w: Want[]): string[] {
  const day = (d: unknown) => String(d ?? '').slice(0, 10);
  const valid = new Set<string>([day(dealDate)]);
  const originals = [...new Map([...r.entries('key_money', dealId), ...r.pending('key_money', dealId).map((id) => r.entry(id))]
    .filter((x): x is SrcEntry => !!x && x.id !== exceptId).map((x) => [x.id, x] as const)).values()];
  const revsOf = (o: SrcEntry): SrcEntry[] => {
    const named = o.reversed_by ? [r.entry(o.reversed_by)] : [];
    const claimed = r.pending('key_money_rev', dealId).filter((id) => r.claimants(id).includes(o.id)).map((id) => r.entry(id));
    return [...named, ...claimed].filter((x): x is RevEntry => !!x && x.src_type === 'key_money_rev' && x.src_id === dealId && sameMirror(o.lines, x.lines));
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const o of originals) {
      if (!valid.has(day(o.date)) || !sameAmounts(nonZero(o.lines), w)) continue;
      for (const rv of revsOf(o)) {
        const d = day(rv.date);
        if (d && !valid.has(d)) { valid.add(d); grew = true; }
      }
    }
  }
  valid.delete(day(dealDate));
  return [...valid];
}
const want = (lines: EntryLine[] | null, dims: (l: EntryLine, i: number) => DimSpec[]): Want[] | null =>
  lines ? lines.map((l, i) => ({ account: l.account, debit: l.debit || 0, credit: l.credit || 0, dims: dims(l, i) })) : null;

const no = (key: string, opts: Record<string, unknown> = {}) => t('deriveSrc.' + key, { ...opts, lng: 'ar' });

/**
 * المستند يسمّي قيداً غير هذا (journal_entry_id أو payment_journal_entry_id) · '' إن سمّاه أو لم يسمِّ شيئاً · 'await' إن كان المسمّى
 * قائماً هنا من مصدره (ولا قيد حيّاً قبل هذا، فقد عُكس): الصف قديم، وصفّه المحدَّث الذي يسمّي هذا القيد لم يصل بعد (المتحقق المستقل:
 * تعديل فاتورة الشراء، وإعادة سدادها أو تحصيل فاتورة المبيعات بتاريخٍ آخر، كان قيدها الجديد يُرفض رفضاً نهائياً) · وإلا فالمستند
 * لا يرحّل قيداً بهذا المصدر
 */
function namedOther(r: SourceReader, src: string, srcId: string, named: string | null, id: string): string {
  if (!named || named === id) return '';
  const x = r.entry(named);
  return x?.here && x.src_type === src && x.src_id === srcId ? AWAIT : no('noEntry');
}

/** «قابلة للخصم» والمنشأة غير مسجّلة في الضريبة على هذا الجهاز، والفاتورة لم تكن هنا قابلةً للخصم */
export function deductibleIssue(db: DB, purchaseId: string): boolean {
  if (vatRegistered(db)) return false;
  return db.get<{ s: string | null }>(`SELECT tax_status AS s FROM purchases WHERE id = ?`, [purchaseId])?.s !== TS_DEDUCTIBLE;
}

/**
 * تأمين العقد رُحِّل إلى عقدٍ مجدَّد: قيد deposit_carry حيٌّ هنا لخلفٍ قائم (منطق depositCarried في الخدمة) · فلا يُسوّى بعده
 * (المراجعة الشاملة 2026-11-13 · R12-DEP-1: مرآة carryAfterSettle، فالتأمين لا يُردّ للمستأجر ويبقى محمولاً في المجدَّد معاً) · وما في
 * الوارد من الترحيل لم يُطبَّق بعد لا يُعدّ: يُفحص هو بصفّ التسوية هنا أو في الوارد فيُرفض (carryAfterSettle)
 */
function carriedOn(db: DB, contractId: string): boolean {
  return !!db.get(
    `SELECT 1 FROM contracts n JOIN journal_entries e ON e.src_type = 'deposit_carry' AND e.src_id = n.id
     WHERE n.renewed_from = ? AND n.deleted_at IS NULL AND e.reversed_by IS NULL AND e.deleted_at IS NULL AND e.status = ? LIMIT 1`,
    [contractId, POSTED]);
}

/**
 * العقد ومن رُحِّل تأمينه إليه بترحيلٍ حيٍّ هنا (depositCarryChain على جهاز المالك · R12-DEP-2) · pending: ترحيلٌ إلى حلقةٍ في الوارد لم
 * يُطبَّق بعد
 */
function carryChain(r: SourceReader, contractId: string): { ids: string[]; pending: boolean } {
  const ids = [contractId];
  let cur = contractId;
  for (let i = 0; i < 100; i++) {
    const prev = r.row<{ renewed_from: string | null }>('contracts', cur)?.renewed_from ?? null;
    if (!prev || ids.includes(prev)) break;
    if (live(r, 'deposit_carry', cur, '', total) <= 0) return { ids, pending: r.pending('deposit_carry', cur).length > 0 };
    ids.push(prev);
    cur = prev;
  }
  return { ids, pending: false };
}

/** المصدر الحيّ الذي لم يُعكس: قيوده المرحّلة هنا ناقصاً عواكسها · بمجموع مبالغها أو عددها */
function live(r: SourceReader, src: string, srcId: string, exceptId: string, by: (e: SrcEntry) => number): number {
  return r.entries(src, srcId).filter((e) => e.id !== exceptId).reduce((s, e) => s + by(e), 0)
    - r.entries(src + '_rev', srcId).reduce((s, e) => s + by(e), 0);
}

interface PurchaseRow {
  no: string | null; refund_status: string | null; refund_date: string | null;
  category: string | null; subtotal_halalas: number; tax_halalas: number; total_halalas: number; tax_status: string | null;
  date: string | null; unit_id: string | null; property_id: string | null; deleted_at: string | null; journal_entry_id: string | null;
  payment_journal_entry_id: string | null; paid: number; paid_date: string | null;
}

/**
 * سطور مستندٍ من حفظين (المتحقق المستقل): تعديل السطور يحذف القديمة ويُدرج جديدةً بمعرّفاتٍ أخرى، والحذف والإدراج في رتبةٍ واحدة
 * يُرتَّبان بالمفتاح فيقعان في دفعاتٍ مختلفة، فقد تصل الجديدة قبل حذف القديمة · وكل حفظٍ يرقّم سطوره من الصفر (sort)، فترتيبٌ مكرر
 * يعني أن بعضها من حفظٍ سابق لم يصل حذفه بعد · فما خالف رأسه منها يُنتظر ولا يُرفض
 */
const twoSaves = (rows: Array<{ sort?: unknown }>): boolean => new Set(rows.map((x) => num(x.sort))).size < rows.length;

/** سطور أصول بنود الفاتورة في قيد تسجيلها وأبعاد كل سطر · وشكلٌ بلا أصول */
interface AssetForm { lines: EntryLine[]; specs: DimSpec[][] }

/**
 * أشكال سطور أصول فاتورة الشراء في قيد تسجيلها (writePurchaseLines كما رحّلها الكاتب): كل بندٍ أصلٍ بتكلفته (أساسه ونصيبه من
 * الضريبة: lineCosts) مقسومةً على كميته (splitQty) على حساب فئته، وبُعده أصلٌ من أصول بنده بوحدته وعقاره (وإلا وحدة الفاتورة
 * وعقارها) · وبنودٌ كتبها «تحويل المصروف إلى أصول» (أصولها من مصدر convert) لم تكن في قيد التسجيل، فلا أصول فيه · والبنود التي
 * أثبتت تكلفة أصولٍ قائمة وحدها (لا مصدر يميّز وقت كتابتها) تُقبل بالشكلين · 'await' لأصلٍ لم يصل
 */
function purchaseAssetForms(db: DB, r: SourceReader, purchaseId: string, subtotal: number, tax: number, deductible: boolean, dims: DimSpec,
  assetAccount: boolean): AssetForm[] | typeof AWAIT {
  const none: AssetForm = { lines: [], specs: [] };
  const lines = r.rows<{ id: string; qty: number; amount_halalas: number; is_asset: number; asset_category: string | null; sort: number; deleted_at?: string | null }>(
    'purchase_lines', 'purchase_id', purchaseId).filter((l) => !l.deleted_at).sort((a, b) => num(a.sort) - num(b.sort));
  // لا بند هنا: الفاتورة بلا بنود لا ترحّل حساب أصل، فقيدٌ بحساب أصلٍ بنودُه لم تصل بعد (المتحقق المستقل: كان يُرفض بالمصروف)
  if (!lines.length) return assetAccount ? AWAIT : [none];
  const assets = r.rows<{ id: string; purchase_line_id: string | null; unit_id: string | null; property_id: string | null; source: string | null; category?: string | null; deleted_at?: string | null }>(
    'assets', 'purchase_id', purchaseId).filter((a) => !a.deleted_at);
  if (assets.some((a) => a.source === 'convert')) return [none];
  // بنود الحفظ مجموعها أساس الفاتورة (validateLines) · ودونه بنودٌ لم تصل بعد: العضو يرفع على دفعاتٍ صغيرة بترتيب الجداول، فقد يصل
  // القيد ورأس الفاتورة قبل بقية بنودها · ويُفحص قبل البحث عن بند أصل (المتحقق المستقل: بند الأصل وحده إن تأخر بدت الفاتورة بلا أصول
  // فرُفض قيدها) · وفوقه من حفظين: بنودٌ جديدة وصلت قبل حذف القديمة
  const sum = lines.reduce((s, l) => s + num(l.amount_halalas), 0);
  if (sum < subtotal || (sum !== subtotal && twoSaves(lines))) return AWAIT;
  if (!lines.some((l) => num(l.is_asset))) return [none];
  const costs = lineCosts(lines.map((l) => ({ descr: '', qty: num(l.qty), amountHalalas: num(l.amount_halalas), isAsset: !!num(l.is_asset) })), tax, deductible);
  const form: AssetForm = { lines: [], specs: [] };
  for (const [i, l] of lines.entries()) {
    if (!num(l.is_asset)) continue;
    const mine = assets.filter((a) => a.purchase_line_id === l.id);
    if (mine.length < num(l.qty)) return AWAIT;
    // وبوحدة الأصل يومها: وحدة صفّه أو وحدةٌ نُقل منها بعد (originUnits · المدقق الخارجي هـ٦)
    const specs = mine.flatMap((a): DimSpec[] => originUnits(r, a.id, a.unit_id ?? null, String(a.category ?? l.asset_category ?? '')).map((u) => (u === (a.unit_id ?? null)
      ? { contract: null, unit: a.unit_id ?? dims.unit, props: a.property_id ? [a.property_id] : dims.props, asset: a.id }
      : { contract: null, unit: u, props: unitDims(db, r, u).props, asset: a.id })));
    for (const cost of splitQty(costs[i], num(l.qty))) {
      form.lines.push({ account: String(l.asset_category ?? ''), debit: cost, credit: 0 });
      form.specs.push(specs);
    }
  }
  return assets.some((a) => a.source === 'purchase') ? [form] : [form, none];
}

interface InvoiceRow {
  id?: string; kind: string | null; status: string | null; subtotal_halalas: number; tax_halalas: number; total_halalas: number;
  issue: string | null; unit_id: string | null; property_id: string | null; deleted_at: string | null; journal_entry_id: string | null;
  payment_journal_entry_id: string | null; paid_date: string | null; ref_invoice_id: string | null; created_at: string | null;
}
const DRAFT_INVOICE = 'مسودة'; // i18n-exempt: حالة الفاتورة المخزّنة

/** سطور فاتورةٍ أو إشعارٍ بترتيبها (هنا وفي الوارد) */
const invoiceLinesOf = (r: SourceReader, id: string) =>
  r.rows<StoredInvoiceLine & { id: string; sort: number }>('invoice_lines', 'invoice_id', id).sort((a, b) => num(a.sort) - num(b.sort));
/** الإشعارات الدائنة القائمة على فاتورة */
const creditNotesOf = (r: SourceReader, invoiceId: string) =>
  r.rows<InvoiceRow & { id: string }>('invoices', 'ref_invoice_id', invoiceId).filter((n) => n.kind === KIND_CREDIT && !n.deleted_at);

/**
 * الإشعار الدائن يُشتق من فاتورته وإشعاراتها قبله (saveCreditNote · المراجعة الشاملة · البند ٧): صافيه لا يتجاوز الباقي منها، وسطوره
 * سطرٌ لكل رمزٍ ضريبي بنسبة الباقي من صافيه ونسبة رمزه (الصفري والمعفى بلا نسبة · البند ٦)، وضريبته وإجماليه كما يحسبها
 * creditNoteAmounts، ولا يتجاوز إجماليه ما بقي على العميل، ولا يسبق تاريخه تاريخها · '' أو 'await' أو السبب
 */
function creditNoteIssue(r: SourceReader, id: string, v: InvoiceRow, lines: StoredInvoiceLine[]): string {
  if (!v.ref_invoice_id) return no('creditNote');
  const ref = r.row<InvoiceRow>('invoices', v.ref_invoice_id);
  if (!ref) return AWAIT;
  if (ref.kind === KIND_CREDIT || ref.status === DRAFT_INVOICE || ref.deleted_at || String(v.issue ?? '') < String(ref.issue ?? '')) return no('creditNote');
  const sub = -num(v.subtotal_halalas);
  const prior = creditNotesOf(r, v.ref_invoice_id).filter((n) => n.id !== id && String(n.created_at ?? '') < String(v.created_at ?? ''));
  const left = {
    sub: num(ref.subtotal_halalas) + prior.reduce((s, n) => s + num(n.subtotal_halalas), 0),
    tax: num(ref.tax_halalas) + prior.reduce((s, n) => s + num(n.tax_halalas), 0),
  };
  if (sub <= 0 || sub > left.sub) return no('creditNote');
  // يُقسم على رموز سطور فاتورته والإشعارات قبله: سطورٌ لم تصل كلها بعد (المتحقق المستقل: فاتورةٌ وإشعارٌ عليها من الجلسة نفسها، ووصل
  // قيد الإشعار قبل سطر الفاتورة المعفى، كان يُرفض نهائياً) تُنتظر · وفاتورةٌ أو إشعارٌ بلا سطورٍ هنا قد يكون قديماً قبلها (سطرٌ واحد
  // بضريبتها: creditNoteAmounts) أو لم تصل سطوره، فما خالف يُنتظر ولا يُرفض
  const refLines = invoiceLinesOf(r, v.ref_invoice_id);
  const priorLines = prior.map((n) => ({ n, lines: invoiceLinesOf(r, n.id) }));
  if (linesShort(refLines, num(ref.subtotal_halalas)) || priorLines.some((x) => linesShort(x.lines, -num(x.n.subtotal_halalas)))) return AWAIT;
  const lineless = !refLines.length || priorLines.some((x) => !x.lines.length);
  const byCode = remainingByCodeOf(refLines, priorLines.map((x) => ({ tax: num(x.n.tax_halalas), lines: x.lines })));
  const x = creditNoteAmounts({ subtotal: num(ref.subtotal_halalas), tax: num(ref.tax_halalas) }, byCode, left, sub);
  const total = sub + x.tax;
  if (num(v.tax_halalas) !== -x.tax || num(v.total_halalas) !== -total) return lineless ? AWAIT : no('creditNote');
  if (total > num(ref.total_halalas) + prior.reduce((s, n) => s + num(n.total_halalas), 0)) return no('creditNote');
  // سطورٌ صافيها دون صافي رأسه لم تصل كلها بعد فيُنتظر
  if (-lines.reduce((s, l) => s + mulQty(num(l.qty), num(l.price_halalas)), 0) < sub) return AWAIT;
  const key = (code: TaxCode, pct: number, price: number) => code + '|' + pct + '|' + price;
  const got = lines.map((l) => key(lineTaxCode(l.tax_code, num(l.tax_pct)), num(l.tax_pct), mulQty(num(l.qty), num(l.price_halalas)))).sort();
  const exp = x.lines.map((l) => key(l.code, l.pct, l.price)).sort();
  return got.join() === exp.join() ? '' : lineless ? AWAIT : no('creditNote');
}

/**
 * سطور فاتورةٍ أو إشعارٍ لم تكتمل بعد: صافيها (بلا إشارة) دون صافي رأسها، أو خالفه وهي من حفظين (twoSaves) · وبلا سطورٍ لا يُحكم
 * (فاتورةٌ قديمة قبل السطور)
 */
function linesShort(lines: Array<StoredInvoiceLine & { sort: number }>, head: number): boolean {
  if (!lines.length) return false;
  const net = Math.abs(lines.reduce((s, l) => s + mulQty(num(l.qty), num(l.price_halalas)), 0));
  return net < Math.abs(head) || (net !== Math.abs(head) && twoSaves(lines));
}

interface AssetDoc {
  id: string; category: string; unit_id: string | null; property_id: string | null; cost_halalas: number | null; salvage_halalas: number;
  life_months: number; purchase_date: string | null; status: string; source: string | null; purchase_id: string | null;
  purchase_line_id: string | null; end_date: string | null; end_entry_id: string | null; sale_halalas: number | null; deleted_at?: string | null;
}
interface AssetEvent { id: string; asset_id: string; kind: string; date: string | null; from_unit_id: string | null; to_unit_id: string | null; entry_id: string | null }

/** الأصل كما يحسب جدولُه إهلاكه (depreciation.ts) */
const depreciable = (a: AssetDoc): DepreciableAsset => ({
  id: a.id, cost_halalas: a.cost_halalas == null ? null : num(a.cost_halalas), salvage_halalas: num(a.salvage_halalas),
  life_months: num(a.life_months), purchase_date: a.purchase_date ?? null,
});

/** صافي حسابٍ لأصلٍ في قيد: مدينه ناقص دائنه */
const assetNet = (x: SrcEntry, assetId: string, account: string) => x.lines
  .filter((l) => str(l.asset_id) === assetId && String(l.account_code ?? '') === account)
  .reduce((s, l) => s + num(l.debit_halalas) - num(l.credit_halalas), 0);

/**
 * موضع القيد المفحوص في ترتيب الترحيل على الجهاز الكاتب: الإهلاك الشهري لشهرٍ (month)، أو عمليةٌ على الأصل بتاريخها (op: النقل
 * وإهلاك ما قبل العملية)، أو الاستبعاد والبيع بتاريخهما (end: آخر ما يُرحَّل للأصل)، أو إهلاك ما فات بتاريخ إثبات التكلفة (catchup)
 */
type When = { kind: 'month'; m: number } | { kind: 'op' | 'end' | 'catchup'; d: string };

/**
 * هل رُحِّل x قبل القيد المفحوص على الجهاز الكاتب، فدخل في المجمع المرحَّل (postedAccum) الذي حُسب منه · وترتيب الوصول هنا غير
 * ترتيب الترحيل هناك (القيود بمفاتيحها)، فيُعرف السابق من نوعه وتاريخه:
 *  - الإهلاك الشهري يُرحَّل قبل كل عمليةٍ بتاريخٍ في شهره أو بعده (requireOpenDate: تاريخ العملية بعد آخر شهرٍ رُحِّل)، وبعدها لما بعده.
 *  - وإهلاك العملية (asset_dep) بتاريخها: ما بعده بتاريخه رُحِّل بعده، وما رُحِّل بعده بتاريخٍ قبله صفرٌ لا قيد له.
 *  - وإهلاك ما فات بتاريخ إثبات التكلفة يسبق كل إهلاكٍ للأصل بعد ذلك.
 *  - والاستبعاد والبيع آخر ما يُرحَّل للأصل: كل إهلاك عمليةٍ قبلهما ولو كان تاريخه بعد تاريخهما (المتحقق المستقل: استبعادٌ بتاريخٍ قبل
 *    نقلٍ رُحِّل قبله، والتاريخ حقلٌ حر بعد آخر شهرٍ رُحِّل، فكان يُرفض).
 * وما سواها (التكلفة وعكسها، والنقل بصافٍ صفر، وعكس الإهلاك) سابق
 */
function before(x: SrcEntry, w: When): boolean {
  const base = String(x.src_type ?? '').replace(/_rev$/, '');
  if (base === 'asset_dispose' || base === 'asset_sell') return false;
  if (base === 'depreciation') {
    const m = monthIndex(String(x.src_id ?? '') + '-01');
    return w.kind === 'month' ? m <= w.m : m < monthIndex(w.d);
  }
  if (base === 'asset_dep') {
    const d = String(x.date ?? '').slice(0, 10);
    return w.kind === 'month' ? monthIndex(d) <= w.m : w.kind === 'end' ? true : w.kind === 'op' ? d <= w.d : d < w.d;
  }
  return true;
}

/**
 * ما رُحِّل للأصل قبل القيد المفحوص: مجمعه (1490 دائناً) وتكلفته (حساب فئته مديناً) في الدفتر هنا، وهما ما حسبه الجهاز الكاتب
 * (postedAccum وpostedCost) · pending: قيدٌ سابقٌ في الوارد لم يُطبَّق بعد يغيّر أحدهما
 */
function ledgerOf(r: SourceReader, assetId: string, category: string, exceptId: string, w: When, also?: (x: SrcEntry) => boolean):
  { accum: number; cost: number; pending: boolean } {
  let accum = 0, cost = 0, pending = false;
  for (const x of r.assetEntries(assetId)) {
    if (x.id === exceptId || !(before(x, w) || also?.(x))) continue;
    const a = -assetNet(x, assetId, ACC_ACCUM);
    const c = assetNet(x, assetId, category);
    if (x.here) { accum += a; cost += c; } else if (a || c) pending = true;
  }
  return { accum, cost, pending };
}

/**
 * أساس إهلاك الأصل: تكلفته في صفّه هي ما رُحِّل له في الدفتر (صفّ الأصل يكتبه العضو، فتكلفةٌ مضاعفة فيه تضاعف إهلاكه)، وقيمه تصح
 * كما يشترطها setAssetCost · '' أو 'await' (قيد تكلفته لم يُطبَّق هنا بعد: في الوارد، أو لم يصل والعضو يرفع على دفعات) أو السبب
 */
function basisIssue(r: SourceReader, a: AssetDoc, led: { cost: number; pending: boolean }): string {
  if (a.cost_halalas == null) return led.cost ? (led.pending ? AWAIT : no('assetCost')) : '';
  const cost = num(a.cost_halalas), salvage = num(a.salvage_halalas), life = num(a.life_months);
  if (!(cost > 0) || salvage < 0 || salvage >= cost || !Number.isInteger(life) || life < 1 || life > 600) return no('assetCost');
  // وأصل الفاتورة (writePurchaseLines، المتحقق المستقل): تاريخ شرائه تاريخ فاتورته وفئته فئة بنده، والذي أنشأه البند (لا القطعة
  // المربوطة به) عمره عمر البند ولا متبقية له · وما لم يصل من بنده أو فاتورته يُنتظر
  if (a.purchase_line_id) {
    const line = r.row<{ purchase_id: string | null; asset_category: string | null; life_months: number | null }>('purchase_lines', a.purchase_line_id);
    const p = r.row<PurchaseRow>('purchases', String(a.purchase_id ?? ''));
    if (!line || !p) return AWAIT;
    if (line.purchase_id !== a.purchase_id || String(line.asset_category ?? '') !== a.category
      || String(a.purchase_date ?? '').slice(0, 10) !== String(p.date ?? '').slice(0, 10)) return no('assetCost');
    if ((a.source === 'purchase' || a.source === 'convert') && (salvage !== 0 || (line.life_months != null && num(line.life_months) !== life))) {
      return no('assetCost');
    }
  }
  return cost === led.cost ? '' : led.pending || !led.cost ? AWAIT : no('assetCost');
}

/**
 * تكلفةٌ أو مجمعٌ في قيد عمليةٍ على الأصل فوق ما رُحِّل له هنا، ولا يتجاوز تكلفته في صفّه ولا المستحق من جدوله حتى تاريخها: قيدٌ
 * قبلها لم يصل بعد (العضو يرفع على دفعاتٍ صغيرة، والقيود المتزامنة بمفاتيحها) فيُنتظر · وما تجاوزهما يُرفض ولا يُنتظر (المضاعف)
 */
function opShort(a: AssetDoc, d: string, led: { cost: number; accum: number }, got: { cost: number; accum: number }): boolean {
  const capCost = num(a.cost_halalas);
  const capAccum = expectedThrough(depreciable(a), d);
  return (got.cost > led.cost && got.cost <= capCost && got.accum <= Math.max(capAccum, led.accum))
    || (got.accum > led.accum && got.accum <= capAccum && got.cost <= Math.max(capCost, led.cost));
}

/** مجموع جانبٍ من حسابٍ لأصلٍ في سطور القيد نفسه */
const sideOf = (lines: SrcLine[], assetId: string, account: string, side: 'debit_halalas' | 'credit_halalas') => lines
  .filter((l) => str(l.asset_id) === assetId && String(l.account_code ?? '') === account).reduce((s, l) => s + num(l[side]), 0);
/** مجمع الأصل في سطور القيد نفسه: دائن 1490 ناقص مدينه */
const accumIn = (lines: SrcLine[], assetId: string) => -assetNet({ id: '', src_type: null, src_id: null, lines }, assetId, ACC_ACCUM);

/** وحدات الأصل: الحالية، وما نُقل منه وإليه (أحداث نقله) · فسطرٌ رُحِّل قبل نقله بوحدته يومها */
const assetUnits = (r: SourceReader, a: AssetDoc): Array<string | null> => [...new Set([a.unit_id ?? null,
  ...r.rows<AssetEvent>('asset_events', 'asset_id', a.id).filter((v) => v.kind === 'transfer').flatMap((v) => [v.from_unit_id ?? null, v.to_unit_id ?? null])])];

/**
 * أبعاد سطور الأصل (assetDims): الأصل، ووحدته وعقارها (الحالي أو ما نُقلت منه الوحدة، أو عقار صفّه)، والعقد الساري على الوحدة في
 * التاريخ (contractAt) أو بلا عقد (جهازٌ لم يصله العقد بعد) · ولا عقد لسطور التحويل (withContract: false)
 */
/**
 * وحدات الأصل قبل نقله: وحدة صفّه، والوحدات التي خرج منها في أحداث نقلٍ لها قيد (المدقق الخارجي هـ٦: تكلفة الأصل تُثبت بوحدته يومها،
 * وصفّه بعد نقله يسمّي الجديدة · فإثبات التكلفة أو فاتورة البند ثم النقل قبل أن يسحب المالك كان يُرفض ثم كل ما بعده) · والنقل بعدها
 * يُفحص بحمل التكلفة هنا فلا تُقبل وحدةٌ لم تكن تكلفته فيها
 */
function originUnits(r: SourceReader, assetId: string, current: string | null, category: string): Array<string | null> {
  // وحدث النقل يُحسب إن كان له قيدٌ هنا أو في الوارد يشهد له بوحدتيه (المدقق الخارجي O١ وO٢: حدثٌ «شبح» يسمّي قيداً لا وجود له كان
  // يُدخل تكلفة الأصل أو بند الفاتورة بأبعاد وحدةٍ في عقارٍ آخر لم يكن فيها قط)
  const from = r.rows<AssetEvent>('asset_events', 'asset_id', assetId)
    .filter((v) => {
      if (v.kind !== 'transfer' || !v.entry_id || (v.from_unit_id ?? null) === (v.to_unit_id ?? null)) return false;
      const e = r.entry(v.entry_id);
      // وقيد النقل نفسه: مصدره نقل هذا الأصل (المدقق الخارجي I · O١ب: قيدٌ مزوَّر بمصدر أصلٍ آخر سطوره بوحدتي الحدث كان يكفي شاهداً)
      if (!e || e.deleted_at || e.src_type !== 'asset_transfer' || e.src_id !== assetId) return false;
      const ls = nonZero(e.lines).filter((l) => str(l.asset_id) === assetId && String(l.account_code ?? '') === category);
      return ls.length > 0 && ls.every((l) => str(l.unit_id) === (num(l.credit_halalas) > 0 ? (v.from_unit_id ?? null) : (v.to_unit_id ?? null)));
    })
    .map((v) => v.from_unit_id ?? null);
  return [...new Set([current, ...from])];
}

function assetSpecs(db: DB, r: SourceReader, a: AssetDoc, date: string, units = assetUnits(r, a), withContract = true): DimSpec[] {
  return units.flatMap((u) => {
    const props = [...new Set([...unitDims(db, r, u).props, ...(u === (a.unit_id ?? null) ? [a.property_id ?? null] : [])])];
    const contracts = withContract && u ? r.rows<{ id: string; start: string | null; end: string | null; deleted_at?: string | null }>('contracts', 'unit_id', u)
      .filter((c) => !c.deleted_at && String(c.start ?? '') <= date && String(c.end ?? '') >= date).map((c) => c.id) : [];
    return [null, ...contracts].map((c): DimSpec => ({ contract: c, unit: u, props, asset: a.id }));
  });
}

/**
 * موضع تكلفة الأصل في الدفتر هنا (المتحقق المستقل: كانت أبعاد قيوده من صفّه وأحداثه، والعضو يكتبهما، فاستبعادٌ أو نقلٌ من وحدةٍ لم
 * تكن تكلفته فيها يُنشئ فيها رصيداً سالباً، ولو في عقارٍ آخر): صافي حساب فئته لكل وحدة من القيود هنا غير المفحوص، بلا الاستبعاد والبيع
 * (آخر ما يُرحَّل للأصل)، وبالنقل الذي يعدّه keep سابقاً للمفحوص · at: الوحدات بصافٍ موجب · seen: كل وحدةٍ كانت فيها تكلفته هنا ·
 * pending: قيدٌ في الوارد يمسّ حساب فئته (نقلٌ أو تكلفةٌ لم تُطبَّق بعد)
 */
interface Place { net: Map<string | null, number>; at: Array<string | null>; seen: Set<string | null>; pending: boolean; trusted?: number }
function placeOf(r: SourceReader, a: AssetDoc, exceptId: string, keep: (x: SrcEntry) => boolean = () => true, ahead = false,
  /** سطور قيدٍ يُفحص تُطبَّق قبل محاكاة الوارد (النقل المفحوص ثم ما بعده) */ seed: SrcLine[] = []): Place {
  const net = new Map<string | null, number>();
  const seen = new Set<string | null>();
  const add = (m: Map<string | null, number>, ls: SrcLine[]) => {
    for (const l of ls) m.set(str(l.unit_id), (m.get(str(l.unit_id)) ?? 0) + num(l.debit_halalas) - num(l.credit_halalas));
  };
  let pending = false;
  // نقلٌ مشهود في الوارد · يُطبَّق بالمحاكاة بعد غيره
  const moves: Array<{ x: SrcEntry; ls: SrcLine[] }> = [];
  for (const x of r.assetEntries(a.id)) {
    if (x.id === exceptId) continue;
    const ls = nonZero(x.lines).filter((l) => str(l.asset_id) === a.id && String(l.account_code ?? '') === a.category);
    if (!ls.length) continue;
    const base = String(x.src_type ?? '').replace(/_rev$/, '');
    // والاستبعاد والبيع في الوارد لا يغيّران موضعها قبلهما · وahead: ما في الوارد محسوبٌ كأنه طُبِّق (الموضع بعد تطبيقه)، إلا قيد نقلٍ
    // لا يشهد له حدثه (المدقق الخارجي ح١ وح٢: نقلٌ مزوَّر أو ناقصٌ حدثُه يبقى في الوارد فيجعل وحدةً قديمة «صحيحة بعد الوارد»، أو يحبس
    // إهلاك الأصل المشروع حتى يُرفض بعد ثلاثين يوماً)
    if (!x.here) {
      pending ||= base !== 'asset_dispose' && base !== 'asset_sell';
      if (!ahead) continue;
      if (x.src_type === 'asset_transfer' && !evidencedTransfer(r, a, x.id, ls)) continue;
      // وعكس النقل في الوارد لا يُحسب إلا مرآةً لنقلٍ مطبَّقٍ هنا (المدقق الخارجي ج٦: كان يُحسب بلا شاهد)
      if (x.src_type === 'asset_transfer_rev' && !r.claimants(x.id).some((o) => { const t = r.entry(o); return !!t?.here && t.src_type === 'asset_transfer'; })) continue;
      // ونقلُ هذا الأصل نفسه (المدقق الخارجي هـ٤: نقلٌ مصدره أصلٌ آخر وسطوره لهذا كان يُحسب ثم يُرفض)
      if (base === 'asset_transfer') { if (x.src_type !== 'asset_transfer' || x.src_id === a.id) moves.push({ x, ls }); continue; }
    }
    for (const l of ls) seen.add(str(l.unit_id));
    if (base === 'asset_dispose' || base === 'asset_sell' || (base === 'asset_transfer' && !keep(x))) continue;
    add(net, ls);
  }
  add(net, seed);
  if (moves.length) {
    // النقل المشهود في الوارد بالمحاكاة (المدقق الخارجي ج٦): يُطبَّق ما تحمل وحدةُ خروجه مبلغَه، مرةً بعد مرة حتى لا يتغيّر شيء، فالنقل
    // المستحيل (من وحدةٍ لم تحمل التكلفة قط) لا يُحسب، والسلسلة المشروعة تُحسب بأي ترتيبٍ وصلت · ثم لا يُصدَّق منها إلا أطول بدايةٍ تنتهي
    // إلى وحدة صفّ الأصل (نقلٌ مزوَّر بحدثٍ يشهد له وصفُّ الأصل في غيرها لا يُحسب) · ولا بداية تنتهي إليها: لا نقل من الوارد يُحسب ·
    // والسلسلة كلها بلا مرشّح الشهر، ثم يُطبَّق منها ما يقبله المرشّح
    const sim = new Map(net);
    const left = [...moves];
    const chain: Array<{ x: SrcEntry; ls: SrcLine[] }> = [];
    let trusted = 0;
    const atRow = (m: Map<string | null, number>) => {
      const at = [...m].filter(([, v]) => v > 0).map(([u]) => u);
      return at.length === 1 && at[0] === (a.unit_id ?? null);
    };
    let progress = true;
    while (progress) {
      progress = false;
      for (let k = 0; k < left.length; k++) {
        const out = left[k].ls.filter((l) => num(l.credit_halalas) > 0);
        if (!out.every((l) => (sim.get(str(l.unit_id)) ?? 0) >= num(l.credit_halalas))) continue;
        add(sim, left[k].ls);
        chain.push(left[k]);
        if (atRow(sim)) trusted = chain.length;
        left.splice(k, 1);
        k -= 1;
        progress = true;
      }
    }
    for (const m of chain.slice(0, trusted)) {
      for (const l of m.ls) seen.add(str(l.unit_id));
      if (keep(m.x)) add(net, m.ls);
    }
    return { net, at: [...net].filter(([, v]) => v > 0).map(([u]) => u), seen, pending, trusted };
  }
  return { net, at: [...net].filter(([, v]) => v > 0).map(([u]) => u), seen, pending, trusted: 0 };
}
/** قيد نقلٍ يشهد له حدثه: حدث نقلٍ واحد للأصل يسمّيه، يُخرج التكلفة من وحدة حدثه ويُدخلها وحدته الأخرى كما في سطوره */
function evidencedTransfer(r: SourceReader, a: AssetDoc, entryId: string, ls: SrcLine[]): boolean {
  const evs = r.rows<AssetEvent>('asset_events', 'entry_id', entryId).filter((v) => v.kind === 'transfer' && v.asset_id === a.id);
  if (evs.length !== 1) return false;
  const from = evs[0].from_unit_id ?? null;
  const to = evs[0].to_unit_id ?? null;
  return from !== to && ls.every((l) => str(l.unit_id) === (num(l.credit_halalas) > 0 ? from : to));
}
/** وحدةٌ تكلفة الأصل فيها كلها في الموضع */
const holding = (p: Place, cost: number) => [...p.net].filter(([, v]) => cost > 0 && v === cost).map(([u]) => u);
/** حدث نقلٍ للأصل لم يُطبَّق قيده هنا بعد (إلى unit إن سُمّيت) · فقيدٌ بعده ينتظره */
const transferOut = (r: SourceReader, a: AssetDoc, exceptId: string, unit?: string | null) => r.rows<AssetEvent>('asset_events', 'asset_id', a.id)
  .some((v) => v.kind === 'transfer' && !!v.entry_id && v.entry_id !== exceptId && (unit === undefined || (v.to_unit_id ?? null) === unit)
    && !r.entry(v.entry_id)?.here);

/**
 * وحدات قيد إهلاكٍ للأصل من موضع تكلفته: الشهري لشهرٍ بعد النقل الذي في شهره أو قبله (runDepreciation قبل عمليةٍ بتاريخٍ بعد شهره)،
 * وإهلاك ما قبل العملية بالوحدة التي نُقل منها في يومها (depreciateAssetTo قبل النقل)، وكلاهما أو بموضعه الآن (نقلٌ بتاريخٍ مقبل
 * يسبق إهلاك شهرٍ قبله) · ولا وحدة لم تكن تكلفته فيها هنا
 */
function depUnits(r: SourceReader, a: AssetDoc, exceptId: string, w: When): { units: Array<string | null>; pending: boolean } {
  const now = placeOf(r, a, exceptId);
  // وحدة النقل في يوم العملية من حدثٍ يشهد له قيده (المدقق الخارجي ح٣: حدثٌ بلا قيد، أو غُيّرت وحدته، كان يُدخل إهلاكاً بوحدةٍ قديمة
  // في عقارٍ آخر)
  // وفي جانب «هنا» قيده مطبَّقٌ هنا، وفي جانب «بعد الوارد» يُحسب معه ما في الوارد بشاهده (المدقق الخارجي ج٦: قيد نقلٍ في الوارد بحدثٍ
  // يشهد له كان يمرّر وحده إهلاك اليوم بوحدته القديمة ثم يُرفض هو · والمقبول ما في الجانبين معاً)
  const opFrom = (ahead: boolean) => (w.kind === 'month' ? [] : r.rows<AssetEvent>('asset_events', 'asset_id', a.id)
    .filter((v) => v.kind === 'transfer' && String(v.date ?? '').slice(0, 10) === w.d && !!v.entry_id)
    .filter((v) => {
      const x = r.entry(v.entry_id!);
      return !!x && (ahead || x.here) && x.src_type === 'asset_transfer' && x.src_id === a.id
        && evidencedTransfer(r, a, x.id, nonZero(x.lines).filter((l) => str(l.asset_id) === a.id && String(l.account_code ?? '') === a.category));
    })
    .map((v) => v.from_unit_id ?? null).filter((u) => now.seen.has(u)));
  const unitsOf = (ahead: boolean) => {
    const cur = ahead ? placeOf(r, a, exceptId, () => true, true) : now;
    // وإهلاك يوم العملية: الوحدة التي خرج منها يومها، أو موضعه بالنقل المؤرَّخ يومها أو قبله (المدقق الخارجي هـ٧: تغيير الغرفة ثم النقل
    // في سحبٍ واحد كان إهلاك يوم الغرفة يُقارن بموضعه بعد النقل وحده، فينتظر كلٌّ منهما الآخر)
    const then = w.kind === 'month' ? placeOf(r, a, exceptId, (x) => monthIndex(String(x.date ?? '')) <= w.m, ahead).at
      : [...opFrom(ahead), ...placeOf(r, a, exceptId, (x) => String(x.date ?? '').slice(0, 10) <= w.d, ahead).at];
    return new Set([...then, ...cur.at]);
  };
  const here = unitsOf(false);
  // وحدث نقلٍ وصل وقيده لم يصل بعد (المدقق الخارجي ح٤: العضو يرفع بدفعات، فقد يصل إهلاك الشهر بوحدته الجديدة قبل قيد النقل): يُنتظر
  // قيده ولا يُرفض المشروع
  if (!now.pending) return { units: [...here], pending: transferOut(r, a, exceptId) };
  // ونقلٌ أو تكلفةٌ في الوارد لم تُطبَّق هنا (التوجيه الرابع · كان اختبار d3 يسقط مرةً من أربع على main): الموضع من الدفتر هنا وحده قديم،
  // وكان قيدٌ مزوَّر بالوحدة القديمة يطابقه ويُقبل حين يُفحص قبل النقل في المرور نفسه · فالمقبول ما يصح في الموضعين معاً: هنا، وبعد تطبيق
  // ما في الوارد · وما خالف ينتظر (pending) حتى يُطبَّق أو يُرفض ما في الوارد · ولا يُنتظر النقل نفسه مقدّماً، فالتاريخ حقلٌ حر لا يدل على
  // ترتيب الترحيل (نقلٌ ثانٍ بتاريخٍ قبل الأول ينتظر إهلاك ما قبل الأول، فانتظارهما معاً يحبسهما)
  // و«بعد الوارد» بسلسلة النقل المصدَّقة وحدها (placeOf: الممكنة المنتهية إلى وحدة صفّ الأصل · المدقق الخارجي ج٦)
  const ahead = unitsOf(true);
  return { units: [...here].filter((u) => ahead.has(u)), pending: true };
}

/** سطرا الإهلاك (مدين المصروف ودائن المجمع) بمبلغه · لا سطر لصفر */
const depPair = (amt: number, dims: DimSpec[]): Want[] => (amt > 0 ? [
  { account: ACC_DEPRECIATION, debit: amt, credit: 0, dims }, { account: ACC_ACCUM, debit: 0, credit: amt, dims },
] : []);

/**
 * إهلاك الأصل حتى تاريخ (runDepreciation وdepreciateAssetTo): المستحق من جدوله (expectedThrough) ناقصاً ما رُحِّل له قبل القيد ·
 * 'await' لأصلٍ لم يصل أو أساسٍ في الوارد
 */
function depOf(db: DB, r: SourceReader, assetId: string, exceptId: string, w: When, through: string):
  { a: AssetDoc; amt: number; specs: DimSpec[]; pending: boolean } | string {
  const a = r.asset<AssetDoc>(assetId);
  if (!a) return AWAIT;
  const led = ledgerOf(r, assetId, a.category, exceptId, w);
  const why = basisIssue(r, a, led);
  if (why) return why;
  const at = depUnits(r, a, exceptId, w);
  return { a, amt: expectedThrough(depreciable(a), through) - led.accum, specs: assetSpecs(db, r, a, through, at.units), pending: led.pending || at.pending };
}

/**
 * إهلاك ما فات للأصل بتاريخ إثبات تكلفته (catchUpLines): مبالغه من catchUpAmounts بعد ما رُحِّل له قبله · السنة الجارية على مصروف
 * الإهلاك وما قبلها على الأرباح المحتجزة، ودائن المجمع بمجموعهما · pending: قيدٌ سابقٌ في الوارد، أو مجمعٌ في القيد دون المستحق
 */
function catchUpOf(db: DB, r: SourceReader, a: AssetDoc, exceptId: string, today: string, lines: SrcLine[], units: Array<string | null>, costHere = false):
  { lines: Want[]; pending: boolean } | string {
  const led = ledgerOf(r, a.id, a.category, exceptId, { kind: 'catchup', d: today });
  // وتكلفةٌ يثبتها القيد نفسه (asset_cost) أساسها فيه
  const why = basisIssue(r, a, costHere ? { ...led, cost: led.cost + num(a.cost_halalas) } : led);
  if (why) return why;
  const c = catchUpAmounts(depreciable(a), today, led.accum);
  if (c.total <= 0) return { lines: [], pending: led.pending };
  const dims = assetSpecs(db, r, a, today, units);
  const got = accumIn(lines, a.id);
  return {
    lines: [
      { account: ACC_DEPRECIATION, debit: c.current, credit: 0, dims }, { account: ACC_RETAINED, debit: c.prior, credit: 0, dims },
      { account: ACC_ACCUM, debit: 0, credit: c.total, dims },
    ],
    pending: led.pending || (got > 0 && got < c.total),
  };
}

/**
 * شهرٌ يُهلك حتى آخره انتهى على ساعة المالك (المتحقق المستقل): التطبيق يرحّل الأشهر التامة وحدها (runDepreciation وcatchUpAmounts: حتى
 * الشهر السابق لليوم)، وشهرٌ مقبل يُقدَّم به إهلاك سنةٍ إلى أخرى ثم يتخطاه الإهلاك الشهري هنا · '' أو 'await' للشهر الجاري هنا
 * (ساعة الكاتب سبقت عند حدّ الشهر، فيُقبل بعد انتهائه) أو السبب لما بعده
 */
function monthEnded(m: number): string {
  const now = monthIndex(todayFn());
  return m < now ? '' : m === now ? AWAIT : no('future');
}

/**
 * المنتهي (المستبعد أو المبيع) لا يُهلك بعد تاريخ انتهائه · إلا إهلاك عمليةٍ رُحِّلت قبل انتهائه بتاريخٍ بعده (المتحقق المستقل: النقل
 * ثم الاستبعاد بتاريخٍ قبله): قيد الانتهاء آخر ما يُرحَّل للأصل، فالمجمع الذي أقفله (هنا أو في الوارد) يشمله · 'await' إن لم يصل
 */
function endedBefore(r: SourceReader, a: AssetDoc, d: string, amt: number, exceptId: string): boolean | typeof AWAIT {
  if (!ENDED.includes(a.status as never) || String(a.end_date ?? '').slice(0, 10) >= d) return false;
  const end = a.end_entry_id ? r.entry(a.end_entry_id) : null;
  if (!end) return a.end_entry_id ? AWAIT : true;
  const here = r.assetEntries(a.id).filter((x) => x.here && x.id !== exceptId && x.id !== end.id).reduce((s, x) => s + accumIn(x.lines, a.id), 0);
  return sideOf(end.lines, a.id, ACC_ACCUM, 'debit_halalas') < here + amt;
}

/** سطور القيد المتوقعة من مستنده · 'await' لمستندٍ لم يصل · أو سبب الرفض */
function derive(db: DB, r: SourceReader, e: { id: string; src: string; srcId: string; no: string | null; date: string; total: number; lines: SrcLine[] }): Outcome {
  switch (e.src) {
    case 'depreciation': {
      // الإهلاك الشهري (runDepreciation): قيدٌ لشهره بتاريخ آخر يومٍ فيه، وسطرا كل أصلٍ بالمستحق من جدوله حتى آخر الشهر ناقصاً ما رُحِّل
      // له قبله، وبأبعاده يومها · وما لم يكن فيه من الأصول (صفرٌ أو لم يصل جهازه بعد) لا يُطالب به · والمنتهي في الشهر أو قبله لا يُهلك
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(e.srcId)) return no('noEntry');
      const m = monthIndex(e.srcId + '-01');
      const ended = monthEnded(m);
      if (ended) return ended;
      const end = monthEnd(m);
      const lines: Want[] = [];
      let pending = false;
      const ids = [...new Set(nonZero(e.lines).map((l) => str(l.asset_id)))];
      const bare = nonZero(e.lines).find((l) => !str(l.asset_id));
      if (bare) return no('account', { account: String(bare.account_code) });
      for (const id of ids as string[]) {
        const x = depOf(db, r, id, e.id, { kind: 'month', m }, end);
        if (typeof x === 'string') return x;
        // ودون المستحق: قيدٌ قبله لم يصل بعد (العضو يرفع على دفعاتٍ صغيرة، والقيود المتزامنة بمفاتيحها) فيُنتظر ولا يُرفض
        const got = accumIn(e.lines, id);
        pending ||= x.pending || (got > 0 && got < x.amt);
        lines.push(...depPair(ENDED.includes(x.a.status as never) && monthIndex(String(x.a.end_date ?? '')) <= m ? 0 : x.amt, x.specs));
      }
      return { lines, date: end, correctable: false, pending };
    }
    case 'asset_dep': {
      // إهلاك أصلٍ حتى تاريخ عمليته قبل نقله أو استبعاده أو بيعه (depreciateAssetTo): بتاريخ حدث العملية على الأصل، وبالمستحق حتى
      // تاريخه ناقصاً ما رُحِّل قبله · وحدثه لم يصل بعد فيُنتظر
      const d = e.date.slice(0, 10);
      const ops = r.rows<AssetEvent>('asset_events', 'asset_id', e.srcId)
        .filter((v) => ['transfer', 'dispose', 'sell'].includes(v.kind) && String(v.date ?? '').slice(0, 10) === d);
      if (!ops.length) return AWAIT;
      const x = depOf(db, r, e.srcId, e.id, { kind: 'op', d }, d);
      if (typeof x === 'string') return x;
      const got = accumIn(e.lines, e.srcId);
      const ended = endedBefore(r, x.a, d, x.amt, e.id);
      if (ended === AWAIT) return AWAIT;
      return { lines: depPair(ended ? 0 : x.amt, x.specs), date: d, correctable: false, pending: x.pending || (got > 0 && got < x.amt) };
    }
    case 'asset_cost': {
      // إثبات تكلفة قطعةٍ بلا فاتورة (setAssetCost): مدين حساب فئتها ودائن رأس المال بتكلفتها في صفّها، ومعه إهلاك ما فات منذ شرائها
      // حتى آخر شهرٍ انتهى قبل تاريخه، بتاريخ حدث إثباتها المسمّي هذا القيد · والقطعة بانتظار تكلفةٍ قبله: لا فاتورة لها، ولا تكلفة
      // لها في الدفتر قبله
      const a = r.asset<AssetDoc>(e.srcId);
      if (!a) return AWAIT;
      if (a.purchase_id || a.source === 'purchase' || a.source === 'convert') return no('noEntry');
      // تكلفةٌ لم يصل صفّها المحدَّث بعد
      if (a.cost_halalas == null) return AWAIT;
      const evs = r.rows<AssetEvent>('asset_events', 'entry_id', e.id);
      if (!evs.length) return AWAIT;
      if (evs.length > 1 || evs[0].kind !== 'cost' || evs[0].asset_id !== a.id) return no('noEntry');
      const today = String(evs[0].date ?? '').slice(0, 10);
      // إهلاك ما فات حتى الشهر السابق لتاريخ الإثبات
      const ended = monthEnded(monthIndex(today) - 1);
      if (ended) return ended;
      const led = ledgerOf(r, a.id, a.category, e.id, { kind: 'catchup', d: today });
      if (led.cost) return led.pending ? AWAIT : no('assetCost');
      // والتكلفة تُثبت بوحدته يومها: وحدة صفّه، أو وحدةٌ نُقل منها بعد (originUnits) · لا موضع لها في الدفتر قبل هذا القيد
      const units = originUnits(r, a.id, a.unit_id ?? null, a.category);
      const cu = catchUpOf(db, r, a, e.id, today, e.lines, units, true);
      if (typeof cu === 'string') return cu;
      const dims = assetSpecs(db, r, a, today, units);
      const cost = num(a.cost_halalas);
      return {
        lines: [{ account: a.category, debit: cost, credit: 0, dims }, { account: ACC_CAPITAL, debit: 0, credit: cost, dims }, ...cu.lines],
        date: today, correctable: false, pending: cu.pending,
      };
    }
    case 'asset_transfer': {
      // نقل الأصل بين وحدتين بتاريخ (transferAsset): بحدث نقله المسمّي هذا القيد، تكلفته ومجمعه المرحّلان قبله (postedCost
      // وpostedAccum بعد إهلاك ما قبل النقل) يخرجان من أبعاد الوحدة القديمة ويدخلان أبعاد الجديدة
      const evs = r.rows<AssetEvent>('asset_events', 'entry_id', e.id);
      if (!evs.length) return AWAIT;
      const ev = evs[0];
      if (evs.length > 1 || ev.kind !== 'transfer' || ev.asset_id !== e.srcId || (ev.from_unit_id ?? null) === (ev.to_unit_id ?? null)) return no('noEntry');
      const a = r.asset<AssetDoc>(e.srcId);
      if (!a) return AWAIT;
      const d = String(ev.date ?? '').slice(0, 10);
      const led = ledgerOf(r, a.id, a.category, e.id, { kind: 'op', d });
      // ينقل من وحدةٍ تكلفته فيها كلها هنا، لا من وحدةٍ يسمّيها حدثه وحده · وإلا فنقلٌ إليها لم يُطبَّق بعد يُنتظر
      const fromU = ev.from_unit_id ?? null;
      const place = placeOf(r, a, e.id);
      if (!holding(place, led.cost).includes(fromU)) {
        return place.pending || led.pending || transferOut(r, a, e.id, fromU) ? AWAIT : no('assetPlace');
      }
      // والأصل المنتهي: قيد انتهائه آخر ما يُرحَّل له، فموضعه بعد كل نقلٍ موضع قيد انتهائه (نقلٌ بعد الاستبعاد يُرفض)
      const end = ENDED.includes(a.status as never) && a.end_entry_id ? r.entry(a.end_entry_id) : null;
      if (end) {
        const last = [...new Set(nonZero(end.lines).filter((x) => str(x.asset_id) === a.id && String(x.account_code ?? '') === a.category)
          .map((x) => str(x.unit_id)))];
        const mine = nonZero(e.lines).filter((x) => str(x.asset_id) === a.id && String(x.account_code ?? '') === a.category);
        const endsAt = (at: Array<string | null>) => at.length === 1 && last.length === 1 && at[0] === last[0];
        const endsThere = (p: Place) => {
          const after = new Map(p.net);
          for (const l of mine) after.set(str(l.unit_id), (after.get(str(l.unit_id)) ?? 0) + num(l.debit_halalas) - num(l.credit_halalas));
          return endsAt([...after].filter(([, v]) => v > 0).map(([u]) => u));
        };
        // وموضعه بعد هذا النقل وحده، أو بعد ما في الوارد من نقلٍ يشهد له حدثه (المدقق الخارجي ح٥: نقلان ثم استبعادٌ يرفعها العضو معاً
        // كان الأول ينتظر الثاني لأن موضعه بعده وحده غير موضع الاستبعاد، والثاني ينتظر الأول، فيتوقف جهاز المالك بلا مخرج)
        // ومتى طُبِّق قيد الانتهاء هنا فالنقل بعده بنفسه لا بما في الوارد (المدقق الخارجي ج٢: نقلٌ ومعه نقلٌ «مشهود» يُرفض بعده كان
        // يُخرج تكلفة المستبعَد إلى وحدةٍ أخرى) · والاستبعاد ينتظر ما في الوارد من نقل، فالسلسلة المشروعة تُطبَّق قبله
        // (وبعد تطبيق قيد الانتهاء: نقلٌ بتاريخه أو قبله وحده، فنقلٌ قبل الاستبعاد تأخر وصوله يُقبل بسلسلته · المدقق الخارجي هـ٣)
        const aheadOk = place.pending && (!end.here || d <= String(a.end_date ?? '').slice(0, 10));
        if (!endsThere(place) && !(aheadOk && endsAt(placeOf(r, a, e.id, () => true, true, mine).at))) {
          return place.pending || transferOut(r, a, e.id) ? AWAIT : no('assetPlace');
        }
      }
      // وموضعه بعد هذا النقل وحدة صفّ الأصل، أو في الوارد نقلٌ آخر مشهود إليها (المدقق الخارجي ج٦: نقلٌ مزوَّر بحدثٍ يشهد له وصفُّ الأصل
      // في غيرها) · وإلا يُنتظر ما يطابقه شكلاً (صفٌّ أو نقلٌ لم يصل بعد، أو يُرفض بطول انتظاره) · والتاريخ لا يدل على الترتيب
      const rowUnit = a.unit_id ?? null;
      const fin = new Map(place.net);
      for (const l of nonZero(e.lines).filter((x) => str(x.asset_id) === a.id && String(x.account_code ?? '') === a.category)) {
        fin.set(str(l.unit_id), (fin.get(str(l.unit_id)) ?? 0) + num(l.debit_halalas) - num(l.credit_halalas));
      }
      const finAt = [...fin].filter(([, v]) => v > 0).map(([u]) => u);
      const towardRow = r.assetEntries(a.id).some((x) => !x.here && x.id !== e.id && x.src_type === 'asset_transfer'
        && r.rows<AssetEvent>('asset_events', 'entry_id', x.id).some((v) => v.kind === 'transfer' && (v.to_unit_id ?? null) === rowUnit)
        && evidencedTransfer(r, a, x.id, nonZero(x.lines).filter((l) => str(l.asset_id) === a.id && String(l.account_code ?? '') === a.category)));
      const offRow = !(finAt.length === 1 && finAt[0] === rowUnit) && !towardRow;
      const from = assetSpecs(db, r, a, d, [fromU]);
      const to = assetSpecs(db, r, a, d, [ev.to_unit_id ?? null]);
      // ومجمعٌ أو تكلفةٌ في القيد فوق ما رُحِّل هنا في حدود الأصل: قيدٌ قبله لم يصل بعد فيُنتظر
      const short = opShort(a, d, led, { cost: sideOf(e.lines, a.id, a.category, 'debit_halalas'), accum: sideOf(e.lines, a.id, ACC_ACCUM, 'credit_halalas') });
      const form = (l: { cost: number; accum: number }): Want[] => [
        { account: a.category, debit: l.cost, credit: 0, dims: to }, { account: a.category, debit: 0, credit: l.cost, dims: from },
        { account: ACC_ACCUM, debit: l.accum, credit: 0, dims: from }, { account: ACC_ACCUM, debit: 0, credit: l.accum, dims: to },
      ];
      // ونقلٌ بتاريخٍ قبل نقلٍ رُحِّل قبله إلى وحدته (المتحقق المستقل: التاريخ حقلٌ حر بعد آخر شهرٍ رُحِّل): مجمعه يشمل إهلاك ما قبل
      // ذلك النقل وإن كان تاريخه بعده
      const into = r.rows<AssetEvent>('asset_events', 'asset_id', a.id).filter((v) => v.kind === 'transfer' && v.entry_id !== e.id
        && (v.to_unit_id ?? null) === (ev.from_unit_id ?? null) && String(v.date ?? '').slice(0, 10) > d).map((v) => String(v.date ?? '').slice(0, 10));
      const prior = into.length ? ledgerOf(r, a.id, a.category, e.id, { kind: 'op', d }, (x) => String(x.src_type ?? '') === 'asset_dep'
        && into.includes(String(x.date ?? '').slice(0, 10))) : led;
      const forms = [form(led), ...(prior.accum !== led.accum ? [form(prior)] : [])];
      if (offRow && forms.some((w) => matchIssue(e.lines, w) === '')) return AWAIT;
      return {
        lines: forms[0], alts: forms.slice(1),
        date: d, correctable: false, pending: led.pending || prior.pending || short,
      };
    }
    case 'asset_dispose':
    case 'asset_sell': {
      // استبعاد الأصل أو بيعه (disposeAsset وsellAsset): بتاريخ انتهائه في صفّه الذي يسمّي هذا القيد، تكلفته ومجمعه المرحّلان قبله
      // (بعد إهلاك ما قبله) يُقفلان، والقيمة الدفترية خسارة استبعاد، أو يقابلها مبلغ البيع نقداً والفرق ربحٌ أو خسارة · وبأبعاده يومها
      const a = r.asset<AssetDoc>(e.srcId);
      if (!a) return AWAIT;
      const status = e.src === 'asset_dispose' ? 'disposed' : 'sold';
      // صفّه المنتهي لم يصل بعد
      if (!ENDED.includes(a.status as never)) return AWAIT;
      if (a.status !== status || a.end_entry_id !== e.id || !a.end_date) return no('noEntry');
      const d = String(a.end_date).slice(0, 10);
      const led = ledgerOf(r, a.id, a.category, e.id, { kind: 'end', d });
      // بوحدةٍ تكلفته فيها كلها هنا بعد كل نقل (لا بوحدة صفّه وحدها) · ونقلٌ لم يُطبَّق بعد يُنتظر
      const place = placeOf(r, a, e.id);
      // ونقلٌ في الوارد أو حدث نقلٍ بلا قيدٍ هنا يُنتظر قبل الانتهاء ولو طابق موضعه الآن (المدقق الخارجي ج٢): فلا يُطبَّق الانتهاء قبل
      // سلسلة نقلٍ مشروعة، وما بعده من نقلٍ يُفحص بنفسه
      // (نقلٌ مصدَّق: مشهودٌ ممكن ينتهي إلى وحدة صفّ الأصل · لا قيدٌ معلَّق بلا حدث ولا حدثٌ بلا قيد يحبسه · المدقق الخارجي هـ٣)
      if ((placeOf(r, a, e.id, () => true, true).trusted ?? 0) > 0) return AWAIT;
      const dims = assetSpecs(db, r, a, d, holding(place, led.cost));
      const moving = place.pending || transferOut(r, a, e.id);
      const nbv = led.cost - led.accum;
      const short = opShort(a, d, led, { cost: sideOf(e.lines, a.id, a.category, 'credit_halalas'), accum: sideOf(e.lines, a.id, ACC_ACCUM, 'debit_halalas') });
      const close: Want[] = [
        { account: ACC_ACCUM, debit: led.accum, credit: 0, dims }, { account: a.category, debit: 0, credit: led.cost, dims },
      ];
      if (e.src === 'asset_dispose') {
        return { lines: [...close, { account: ACC_DISPOSAL_LOSS, debit: nbv, credit: 0, dims }], date: d, correctable: false, pending: led.pending || short || moving };
      }
      const amount = num(a.sale_halalas);
      if (amount < 0) return no('noEntry');
      // والبيع ببنك حركته برقم قيده بمبلغه
      const txs = e.no ? r.rows<{ amount_halalas: number; deleted_at?: string | null }>('bank_tx', 'journal_no', e.no).filter((x) => !x.deleted_at) : [];
      if (txs.length > 1 || (txs.length && num(txs[0].amount_halalas) !== amount)) return no('assetSale');
      const diff = amount - nbv;
      return {
        lines: [
          ...close, { account: ACC_CASH, debit: amount, credit: 0, dims },
          { account: ACC_DISPOSAL_LOSS, debit: diff < 0 ? -diff : 0, credit: 0, dims }, { account: ACC_SALE_GAIN, debit: 0, credit: diff > 0 ? diff : 0, dims },
        ],
        date: d, correctable: false, pending: led.pending || short || moving,
      };
    }
    case 'asset_convert': {
      // تحويل الفاتورة القديمة إلى أصول (convertPurchase): لكل بندٍ أصلٍ من بنودها مبلغه كما أُدخل (بلا نصيبٍ من الضريبة) مقسوماً على
      // كميته (splitQty) على حساب فئته، وبُعده أصلٌ من أصول بنده بوحدته وعقاره بلا عقد، ودائن مصروف فئة الفاتورة بمجموعها بوحدتها
      // وعقارها · ولا يتجاوز ما صُرف فيها، ولا يسبق تاريخها · والفاتورة ذات البنود من حفظها (أصولها من مصدر الشراء) لا تُحوَّل
      const p = r.row<PurchaseRow>('purchases', e.srcId);
      if (!p) return AWAIT;
      if (p.deleted_at) return no('deleted');
      if (e.date.slice(0, 10) < String(p.date ?? '').slice(0, 10)) return no('date');
      const plines = r.rows<{ id: string; qty: number; amount_halalas: number; is_asset: number; asset_category: string | null; sort: number; deleted_at?: string | null }>(
        'purchase_lines', 'purchase_id', e.srcId).filter((l) => !l.deleted_at).sort((a, b) => num(a.sort) - num(b.sort));
      // بنودٌ لم تصل بعد
      if (!plines.some((l) => num(l.is_asset))) return AWAIT;
      const assets = r.rows<AssetDoc>('assets', 'purchase_id', e.srcId).filter((a) => !a.deleted_at);
      if (assets.some((a) => a.source === 'purchase')) return no('noEntry');
      const lines: Want[] = [];
      let sum = 0;
      for (const l of plines) {
        if (!num(l.is_asset)) continue;
        const mine = assets.filter((a) => a.purchase_line_id === l.id);
        if (mine.length < num(l.qty) || num(l.qty) < 1) return AWAIT;
        const specs = mine.flatMap((a) => assetSpecs(db, r, a, e.date, assetUnits(r, a), false));
        for (const cost of splitQty(num(l.amount_halalas), num(l.qty))) {
          lines.push({ account: String(l.asset_category ?? ''), debit: cost, credit: 0, dims: specs });
          sum += cost;
        }
      }
      if (sum > num(p.subtotal_halalas) + (p.tax_status === TS_DEDUCTIBLE ? 0 : num(p.tax_halalas))) return no('convertSum');
      lines.push({ account: purchaseExpenseAccount(p.category), debit: 0, credit: sum, dims: [{ contract: null, unit: p.unit_id ?? null, props: [p.property_id ?? null] }] });
      // بنودٌ من حفظين (تراجعٌ ثم تحويلٌ جديد وصل قبل حذف القديمة) تُنتظر
      return { lines, date: null, correctable: false, pending: twoSaves(plines) };
    }
    case 'asset_catchup': {
      // إهلاك ما فات لأصول فاتورة الشراء (purchaseCatchUp بتاريخ حفظها، وconvertPurchase بتاريخ تحويلها): لكل أصلٍ قائمٍ بتكلفته من
      // أصولها حتى آخر شهرٍ انتهى قبل تاريخ القيد · وتاريخه لا يُخزَّن في مستند، فلا يسبق تاريخ الفاتورة
      const p = r.row<PurchaseRow>('purchases', e.srcId);
      if (!p) return AWAIT;
      if (p.deleted_at) return no('deleted');
      const today = e.date.slice(0, 10);
      if (today < String(p.date ?? '').slice(0, 10)) return no('date');
      const ended = monthEnded(monthIndex(today) - 1);
      if (ended) return ended;
      const assets = r.rows<AssetDoc>('assets', 'purchase_id', e.srcId).map((a) => r.asset<AssetDoc>(a.id) ?? a)
        .filter((a) => !a.deleted_at && a.cost_halalas != null);
      // أصولٌ لم يصل صفّها بعد
      if (!assets.length) return AWAIT;
      const lines: Want[] = [];
      let pending = false;
      for (const a of assets) {
        // بوحدةٍ كانت فيها تكلفته هنا (قيد الفاتورة أو التحويل)
        const place = placeOf(r, a, e.id);
        const cu = catchUpOf(db, r, a, e.id, today, e.lines, [...place.seen]);
        if (typeof cu === 'string') return cu;
        lines.push(...cu.lines);
        pending ||= cu.pending || place.pending;
      }
      return { lines, date: null, correctable: false, pending };
    }
    case 'cash_op': {
      // العملية النقدية (cashOps.ts): معرّف مصدرها عشوائي ولا صفّ يحمل مبلغها إلا حركة البنك اليدوية (الرسوم والوارد الآخر: recordManualBankTx)
      // المربوطة برقم قيدها، فتُشتق منها نوعاً ومبلغاً وتاريخاً · وبلا حركة: المصروف النثري وإيداع المالك ومسحوباته بأطرافها الثابتة
      // ومجموع القيد نفسه (لا مستند يحمل مبلغها) · ولا ضريبة مخرجات على الوارد (المراجعة الشاملة · البند ١١) · ولا أبعاد لها
      const txs = e.no ? r.rows<{ amount_halalas: number; date: string | null; deleted_at?: string | null }>('bank_tx', 'journal_no', e.no).filter((x) => !x.deleted_at) : [];
      if (txs.length > 1) return no('cashOp');
      if (txs.length === 1) {
        const amount = num(txs[0].amount_halalas);
        const lines = amount ? want(cashOpLines(amount < 0 ? 'fee' : 'income', Math.abs(amount), '', ''), () => [NONE]) : null;
        return lines ? { lines, date: txs[0].date ?? '', correctable: false } : no('noEntry');
      }
      // الوارد إلى 4300 لا يُرحَّل إلا مع حركة بنكه في المعاملة نفسها: حركته لم تصل بعد فيُنتظر
      if (e.lines.some((l) => String(l.account_code) === '4300')) return AWAIT;
      const [first, ...alts] = (['petty', 'ownerIn', 'ownerOut'] as const).map((k) => want(cashOpLines(k, e.total, '', ''), () => [NONE])!);
      return { lines: first, alts, date: null, correctable: false };
    }
    case 'contract_deposit': {
      // التأمين المقبوض: تأمين العقد ناقصاً ما رُحِّل إليه من عقده السابق (التجديد: تأمينه المرحَّل وزيادته)
      const c = r.row<{ deposit_halalas: number; deposit_holder: string | null; start: string | null; status: string; renewed_from: string | null }>('contracts', e.srcId);
      if (!c) return AWAIT;
      if (c.status === 'مسودة') return AWAIT; // i18n-exempt: حالة العقد المخزّنة · توثيقه لم يصل بعد
      const carried = live(r, 'deposit_carry', e.srcId, e.id, total);
      const amount = num(c.deposit_halalas) - carried;
      if (e.total !== amount && !carried && c.renewed_from) {
        // ترحيلٌ لم يصل بعد: القيد بقدر الزيادة على تأمين العقد السابق ينتظره
        const prev = r.row<{ deposit_halalas: number }>('contracts', c.renewed_from);
        if (prev && e.total === num(c.deposit_halalas) - num(prev.deposit_halalas)) return AWAIT;
      }
      const dims = contractDims(db, r, e.srcId);
      if (!dims) return AWAIT;
      const lines = want(contractDepositLines(amount, c.deposit_holder), () => [dims]);
      return lines ? { lines, date: c.start ?? '', correctable: true } : no('noEntry');
    }
    case 'deposit_carry': {
      // ترحيل التأمين عند التجديد (renewContract): تأمين العقد السابق كاملاً، وسطر إقفاله بعقد السابق ووحدته وعقاره من الجديد
      // (lineDims: الصريح فيه العقد وحده)، والجديد دائن بأبعاده
      const c = r.row<{ deposit_halalas: number; renewed_from: string | null; start: string | null; contract_no: string | null }>('contracts', e.srcId);
      if (!c) return AWAIT;
      if (!c.renewed_from) return no('noEntry');
      const prev = r.row<{ deposit_halalas: number; renewed_to: string | null }>('contracts', c.renewed_from);
      if (!prev || !prev.renewed_to) return AWAIT;
      // والسابق مجدَّدٌ إلى هذا العقد نفسه: لا يُرحَّل تأمينه إلى عقدين
      if (prev.renewed_to !== c.contract_no) return no('noEntry');
      // وتأمينٌ سُوّي لا يُرحَّل: العقد الجديد يحمل ما لم يُقبض فيُردّ مرتين (A1-1)
      if (r.row('deposit_settlements', c.renewed_from)) return no('carryAfterSettle');
      const carried = num(prev.deposit_halalas);
      // وتأمين الجديد يتسع للمرحَّل مع ما قُبض له (totalDeposit: المرحَّل وزيادته)
      if (live(r, 'contract_deposit', e.srcId, e.id, total) + carried > num(c.deposit_halalas)) return no('carryOver');
      const dims = contractDims(db, r, e.srcId);
      if (!dims) return AWAIT;
      const lines = want(depositCarryLines(carried, c.renewed_from), (l) => [l.dims?.contractId ? { ...dims, contract: l.dims.contractId } : dims]);
      return lines ? { lines, date: c.start ?? '', correctable: true } : no('noEntry');
    }
    case 'reservation':
    case 'reservation_forfeit':
    case 'reservation_refund': {
      // الحجز بعربون (reservations.ts): قبضه بتاريخ إنشاء الحجز، ومصادرته أو ردّه بتاريخ تسويته وبمآله المخزَّن، والمبلغ عربونه كله
      const rv = r.row<{ unit_id: string | null; deposit_halalas: number; created_date: string | null; deposit_outcome: string | null;
        deposit_settled_date: string | null; converted_contract_id: string | null }>('reservations', e.srcId);
      if (!rv) return AWAIT;
      // أبعاده وحدة الحجز، ومع عقده إن حُوِّل (dimsFromSource: قيدٌ رُحِّل قبل التحويل بلا عقد، وبعده بعقده)
      const unit = unitDims(db, r, rv.unit_id ?? null);
      const dims: DimSpec[] = [unit];
      const conv = rv.converted_contract_id ? contractDims(db, r, rv.converted_contract_id) : null;
      if (conv) dims.push(conv.unit ? conv : { ...unit, contract: conv.contract });
      const deposit = num(rv.deposit_halalas);
      if (e.src === 'reservation') {
        const lines = want(reservationDepositLines(deposit), () => dims);
        return lines ? { lines, date: rv.created_date ?? '', correctable: false } : no('noEntry');
      }
      const FORFEITED = 'مصادَر'; // i18n-exempt: مآل العربون المخزَّن
      const REFUNDED = 'مردود'; // i18n-exempt: مآل العربون المخزَّن
      if (!rv.deposit_outcome) return AWAIT;
      if (rv.deposit_outcome !== (e.src === 'reservation_forfeit' ? FORFEITED : REFUNDED)) return no('noEntry');
      const lines = want(e.src === 'reservation_forfeit' ? reservationForfeitLines(deposit) : reservationRefundLines(deposit), () => dims);
      return lines ? { lines, date: rv.deposit_settled_date ?? '', correctable: false } : no('noEntry');
    }
    case 'key_money': {
      // عمولة التقبيل (keymoney.ts): المقبوض من الصفقة، وضريبته بتسجيل المنشأة في الضريبة (keyMoneyLines كما رحّلها الكاتب)،
      // والتاريخ تاريخ الصفقة · وقيد الصفقة قيدها نفسه
      const k = r.row<{ unit_id: string | null; contract_id: string | null; date: string | null; commission_halalas: number;
        journal_entry_id: string | null; deleted_at?: string | null }>('key_money_deals', e.srcId);
      if (!k) return AWAIT;
      // والصفقة في السلة عُكس قيدها حين حُذفت، فلا يُقبل لها قيدٌ حيّ جديد (المدقق الخارجي ج٤) · بل ينتظر: نسخة الاستعادة قد تصل قبل
      // صفّها المستعاد لأن العضو يرفع على دفعات (هـ١)، ويُرفض لطول انتظاره إن بقيت في السلة · وقيدها القديم الواصل معكوساً يمرّ بمسار العكس
      if (k.deleted_at) return AWAIT;
      if (k.journal_entry_id && k.journal_entry_id !== e.id) {
        // استعادةٌ من السلة بإصدارٍ قبل إصلاح ك١ (المدقق الخارجي): الصفّ يسمّي القيد المعكوس، وهذه نسخته الحيّة الوحيدة · وغيرها كما
        // في المستندات الأخرى: صفٌّ قديم ينتظر محدَّثه، أو مستندٌ لا يرحّل هذا القيد
        const named = r.entry(k.journal_entry_id);
        const restored = !!named && named.src_type === 'key_money' && named.src_id === e.srcId && !!named.reversed_by
          && live(r, 'key_money', e.srcId, e.id, () => 1) === 0;
        if (!restored) return namedOther(r, e.src, e.srcId, k.journal_entry_id, e.id) || no('noEntry');
      }
      // والقيد يُرحَّل بعد صفّ صفقته (recordKeyMoneyDeal · قرار المالك 2026-11-07 «قيد عمولة التقبيل يُرحّل بعد صف الصفقة، وتحقق
      // جهاز المالك يرفض القيد بلا أبعاد») فيحمل أبعادها: عقدها ووحدته وعقاره، أو وحدتها وعقارها · ولا يُقبل بلا أبعاد ولا بأبعاد
      // مستندٍ آخر (ما كتبه إصدارٌ أقدم بلا أبعاد يُرفض ويظهر سببه، ويُعاد بإصدارٍ حديث)
      const own = k.contract_id ? contractDims(db, r, k.contract_id) : unitDims(db, r, k.unit_id ?? null);
      if (!own) return AWAIT;
      const lines = want(keyMoneyLines(db, num(k.commission_halalas)), () => [own]);
      // ونسخة الاستعادة من السلة بتاريخ عكس قيدها السابق (repostDate)
      // وعاكسٌ في الوارد لم يُطبَّق بعد يُحسب تاريخه (المدقق الخارجي ج٥: الصفقة وإلغاؤها واستعادتها في سحبٍ واحد)
      // ومرآةٌ لأصلٍ من الصفقة يسمّيها (المدقق الخارجي هـ٢: عاكسٌ مزوَّر معلَّق بتاريخٍ يختاره العضو كان يُقبل به القيد في سنةٍ أخرى)
      // والتاريخ المقبول سلسلةٌ من تاريخ الصفقة: عاكسُ أصلٍ من الصفقة بتاريخٍ مقبول وبمبالغها يُقبل تاريخه، ثم أصلٌ بذلك التاريخ وهكذا
      // (المدقق الخارجي G · K١: أصلٌ مزوَّر يصل معكوساً ومعه عاكسه المرآة كان يجعل تاريخ عاكسه مقبولاً فيُنقل الإيراد وضريبته إلى سنةٍ
      // أخرى · وشرط هـ٢ لا يحمي لأن العضو يكتب ذلك الأصل)
      const also = lines ? keyMoneyDates(r, e.srcId, e.id, String(k.date ?? ''), lines) : [];
      return lines ? { lines, date: k.date ?? '', also, correctable: false } : no('noEntry');
    }
    case 'claim':
    case 'claim_collect': {
      // المطالبة (claims.ts، ومطالبة زيادة التسوية): قيدها بمبلغها وتاريخها أو تاريخ التصحيح بعده (تعديل المفتوحة يعكس القديم ويرحّل
      // الجديد) · وتحصيلها بمبلغها وتاريخ تحصيلها المخزَّن · والأبعاد عقد المطالبة ووحدته وعقاره
      const cl = r.row<{ contract_id: string | null; amount_halalas: number; date: string | null; collected_at: string | null;
        deleted_at: string | null; source: string | null }>('claims', e.srcId);
      if (!cl) return AWAIT;
      // والمحذوفة عُكس قيدها حين حُذفت (deleteClaim) فلا قيد حيّاً لها: قيدٌ جديد بمبلغها يُدخل ذمةً وإيراداً لا مستند لهما
      // (المتحقق المستقل) · وقيدها القديم الواصل معكوساً يمرّ بمسار العكس قبل هذا
      if (cl.deleted_at) return no('deleted');
      // ومطالبة زيادة التسوية جزءٌ من تسويةٍ تُرفض كلها حين رُحِّل التأمين إلى التجديد، فلا تبقى وحدها ذمةً وإيراداً لتسويةٍ لا وجود لها
      // (المراجعة الشاملة 2026-11-13 · R12-DEP-1 · كقيود الخصم والرد)
      if (cl.source === SETTLEMENT_CLAIM_SOURCE && cl.contract_id && carriedOn(db, cl.contract_id)) return no('settleAfterCarry');
      const dims = cl.contract_id ? contractDims(db, r, cl.contract_id) : unitDims(db, r, null);
      if (!dims) return AWAIT;
      if (e.src === 'claim') {
        // تعديل المطالبة يعكس قيدها ويرحّل الجديد بقيمها الجديدة: صفّها قد يكون قديماً
        const lines = want(claimLines(num(cl.amount_halalas)), () => [dims]);
        return lines ? { lines, date: cl.date ?? '', correctable: true, stale: true } : no('noEntry');
      }
      // تحصيلٌ لم يصل وسمه بعد يُنتظر
      if (!cl.collected_at) return AWAIT;
      const lines = want(claimCollectionLines(num(cl.amount_halalas)), () => [dims]);
      return lines ? { lines, date: cl.collected_at, correctable: false } : no('noEntry');
    }
    case 'invoice':
    case 'invoice_pay': {
      // فاتورة المبيعات (invoices.ts): قيد إصدارها من سطورها برمز كل سطرٍ ونسبته كما يحسبها saveInvoice (invoiceTotals)، ورأسها
      // يطابقها (البند ٦: سطرٌ صفري أو معفى بنسبةٍ يرحّل ضريبةً لا يراها الإقرار) · والإشعار الدائن (مصدره صفّه، بنوعه) من فاتورته
      // مقسوماً على رموزها (البند ٧) · وتحصيلها بما بقي منها بعد إشعاراتها وبتاريخ تحصيلها · ونسخة الاستعادة من السلة بتاريخ عكس
      // قيدها السابق · والأبعاد عقار الفاتورة ووحدتها
      const v = r.row<InvoiceRow>('invoices', e.srcId);
      if (!v) return AWAIT;
      // الصادرة لا تُحذف ولا تعود مسودة (قرار المالك على #30) فلا قيد حيّاً لمحذوفة · والمسودة لا قيد لها: صفّها الذي صدرت به لم يصل
      // بعد (المتحقق المستقل: مسودةٌ عرفها المالك ثم أصدرها العضو، ووصل قيدها قبل صفّها المحدَّث، كان يُرفض نهائياً) فيُنتظر كالعقد
      // المسودة في contract_deposit، والمزوَّر يُرفض لطول انتظاره ولا يدخل الدفتر
      if (v.deleted_at) return no('deleted');
      if (v.status === DRAFT_INVOICE) return AWAIT;
      const dims = docDims(db, r, v.unit_id ?? null, v.property_id ?? null);
      const also = revDates(r, e.src, e.srcId);
      const credit = v.kind === KIND_CREDIT;
      if (e.src === 'invoice_pay') {
        if (credit) return no('noEntry');
        // تحصيلٌ بتاريخٍ جديد يعكس السابق: الصف القديم يسمّي قيده
        const other = namedOther(r, e.src, e.srcId, v.payment_journal_entry_id, e.id);
        if (other) return other;
        // تحصيلٌ لم يصل وسمه بعد يُنتظر
        if (!v.paid_date) return AWAIT;
        const remaining = num(v.total_halalas) + creditNotesOf(r, e.srcId).reduce((s, n) => s + num(n.total_halalas), 0);
        // دون الباقي: إشعارٌ دائن قبله لم يصل صفّه بعد فيُنتظر (ويُرفض لطول انتظاره إن لم يصل)
        if (e.total > 0 && e.total < remaining) return AWAIT;
        const lines = remaining > 0 ? want(invoicePaymentLines(remaining), () => [dims]) : null;
        return lines ? { lines, date: v.paid_date, also, correctable: false } : no('noEntry');
      }
      const other = namedOther(r, e.src, e.srcId, v.journal_entry_id, e.id);
      if (other) return other;
      const lines = invoiceLinesOf(r, e.srcId);
      const head = { subtotal: num(v.subtotal_halalas), tax: num(v.tax_halalas), total: num(v.total_halalas) };
      if (credit) {
        const why = creditNoteIssue(r, e.srcId, v, lines);
        if (why) return why;
        const built = want(creditNoteLedgerLines({ subtotal: -head.subtotal, tax: -head.tax, total: -head.total }), () => [dims]);
        return built ? { lines: built, date: v.issue ?? '', also, correctable: false } : no('noEntry');
      }
      if (lines.length) {
        let calc: { subtotal: number; tax: number; total: number };
        try {
          calc = invoiceTotals(normalizeInvoiceLines(lines.map((l) => ({
            descr: '', qty: num(l.qty), priceHalalas: num(l.price_halalas), taxPct: num(l.tax_pct), taxCode: (l.tax_code ?? undefined) as TaxCode | undefined,
          }))));
        } catch {
          return twoSaves(lines) ? AWAIT : no('taxCode');
        }
        // صافي سطورها دون صافي رأسها: سطورٌ لم تصل بعد (العضو يرفع على دفعاتٍ صغيرة بترتيب الجداول) فيُنتظر · وما خالفه وسطوره من
        // حفظين: سطورٌ جديدة وصلت قبل حذف القديمة (المتحقق المستقل: تعديل سطور المسودة وإصدارها في حفظٍ واحد) فيُنتظر · وما سواه مخالفة
        if (calc.subtotal < head.subtotal) return AWAIT;
        if (calc.subtotal !== head.subtotal || calc.tax !== head.tax || calc.total !== head.total) {
          return twoSaves(lines) ? AWAIT : no('invoiceTotals');
        }
      } else {
        // ولا سطر هنا: الرأس وحده لا يُقبل وإن اتسق مع نفسه (المتحقق المستقل: رأسٌ بضريبةٍ على سطرٍ صفري وقيده يصلان والسطور مؤخَّرة،
        // فكان يُقبل ولا يُعاد فحصه حين تصل) · فاتورةٌ بقيدٍ لها سطورٌ دائماً (رأسها من invoiceTotals على سطورها)، فسطورها لم تصل بعد
        // فيُنتظر، ثم يُفحص حين تصل أو يُرفض لطول انتظاره
        return AWAIT;
      }
      const built = want(invoiceLedgerLines(head), () => [dims]);
      return built ? { lines: built, date: v.issue ?? '', also, correctable: false } : no('noEntry');
    }
    case 'vat_refund': {
      // استرداد ضريبة المدخلات أو رفضه (purchases.ts: markVatRefunded وmarkVatRejected) بضريبة الفاتورة كلها، والفاتورة «قابلة للخصم»
      // وحدها، والمآل من حالة استردادها المخزّنة: «مسترَد» نقداً بتاريخ استرداده، و«مرفوض» تكلفةً في مصروف فئتها · ولا أبعاد له
      // (dimsFromSource لا يشتقها)
      const p = r.row<PurchaseRow>('purchases', e.srcId);
      if (!p) return AWAIT;
      // المسترَدة والمرفوضة لا تُحذف (failVatSettled) فلا قيد حيّاً لمحذوفة
      if (p.deleted_at) return no('deleted');
      if (p.tax_status !== TS_DEDUCTIBLE) return no('noEntry');
      const status = String(p.refund_status ?? '');
      const tax = num(p.tax_halalas);
      // وإلغاء الاسترداد ثم الرفض أو الاسترداد ثانيةً: حالة الصف قد تكون قديمة (stale)
      const REFUNDED = 'مسترَد'; // i18n-exempt: حالة الاسترداد المخزّنة
      const REJECTED = 'مرفوض'; // i18n-exempt: حالة الاسترداد المخزّنة
      if (status.startsWith(REFUNDED)) {
        if (!p.refund_date) return AWAIT;
        const lines = tax > 0 ? want(vatRefundLines(p.no ?? '', tax), () => [NONE]) : null;
        return lines ? { lines, date: p.refund_date, correctable: false, stale: true } : no('noEntry');
      }
      // ولا يُخزَّن تاريخ الرفض فلا يُطابق تاريخه (وفترته المقدَّمة يفحصها memberSourceCheck)
      if (status === REJECTED) {
        const lines = tax > 0 ? want(vatRejectLines(p.category, p.no ?? '', tax), () => [NONE]) : null;
        return lines ? { lines, date: null, correctable: false, stale: true } : no('noEntry');
      }
      // مآلٌ لم يصل وسمه بعد يُنتظر
      return AWAIT;
    }
    case 'purchase':
    case 'purchase_pay': {
      // فاتورة الشراء (purchases.ts): قيد تسجيلها من قيمها ووضعها الضريبي وفئتها وأصول بنودها (postPurchaseToLedger) بتاريخها أو
      // تاريخ التصحيح بعده (تعديلها يعكس القديم ويرحّل الجديد)، وقيد سدادها بإجماليها وتاريخ سدادها (postPurchasePayment) ·
      // ونسخة الاستعادة من السلة بتاريخ عكس قيدها السابق · والأبعاد عقار الفاتورة ووحدتها، وسطر كل أصلٍ بأصله
      const p = r.row<PurchaseRow>('purchases', e.srcId);
      if (!p) return AWAIT;
      // المحذوفة عُكس قيداها حين حُذفت (deletePurchase) فلا قيد حيّاً لها · وقيدها القديم الواصل معكوساً يمرّ بمسار العكس قبل هذا
      if (p.deleted_at) return no('deleted');
      const dims = docDims(db, r, p.unit_id ?? null, p.property_id ?? null);
      const also = revDates(r, e.src, e.srcId);
      const subtotal = num(p.subtotal_halalas);
      const tax = num(p.tax_halalas);
      const total = num(p.total_halalas);
      if (e.src === 'purchase_pay') {
        const other = namedOther(r, e.src, e.srcId, p.payment_journal_entry_id, e.id);
        if (other) return other;
        // سدادٌ لم يصل وسمه بعد يُنتظر
        if (!num(p.paid) || !p.paid_date) return AWAIT;
        const lines = want(purchasePaymentLines(total), () => [dims]);
        return lines ? { lines, date: p.paid_date, also, correctable: false } : no('noEntry');
      }
      const other = namedOther(r, e.src, e.srcId, p.journal_entry_id, e.id);
      if (other) return other;
      const deductible = p.tax_status === TS_DEDUCTIBLE;
      // «قابلة للخصم» للمنشأة المسجّلة وحدها، إلا فاتورةً كانت هنا قابلةً للخصم فتبقى بوضعها (taxStatusesFor · المدقق الخارجي ض١:
      // الحارس كان في الحفظ المحلي وحده، فجهاز عضوٍ يرى المنشأة مسجّلة يدخل ضريبة مدخلاتٍ لا تُسترد)
      if (deductible && deductibleIssue(db, e.srcId)) return no('notRegistered');
      const forms = purchaseAssetForms(db, r, e.srcId, subtotal, tax, deductible, dims, nonZero(e.lines).some((l) => isAssetCategory(String(l.account_code))));
      if (forms === AWAIT) return AWAIT;
      const built = forms.map((f) => want(purchaseLedgerLines(
        { category: p.category ?? '', subtotal, tax, total, roundingDiff: total - subtotal - tax, deductible }, f.lines),
      (l) => {
        const i = f.lines.indexOf(l);
        return i < 0 ? [dims] : f.specs[i];
      })!);
      return { lines: built[0], alts: built.slice(1), date: p.date ?? '', also, correctable: true };
    }
    case 'deposit_rent': {
      // سداد قسطٍ متأخر من التأمين في تسويته (applyDepositSettlement · المراجعة الشاملة 2026-11-13 · A1-2): دفعته «من التأمين» تسمّي
      // القيد ومن عقده، وتسويته قائمة، والتأمين ليس لدى طرف آخر (لم يدخل 2400)، والحيّ من هذه القيود لا يتجاوز المخصوم في صفّ التسوية ·
      // والسطور مدين 2400 بمبلغ الدفعة ودائن إيراد العقد به
      const pays = r.rows<{ id: string; contract_id: string; date: string; net_halalas: number; method_label: string | null }>(
        'contract_payments', 'journal_entry_id', e.id);
      if (!pays.length) return AWAIT;
      const pay = pays[0];
      if (pays.length > 1 || pay.method_label !== DEPOSIT_RENT_METHOD) return no('noEntry');
      // ودفعة قسطٍ من عقدٍ رُحِّل تأمينه إلى عقد القيد (R12-DEP-2): على عقد القسط، وترحيله حيٌّ هنا · وترحيلٌ في الوارد لم يُطبَّق بعد يُنتظر
      if (pay.contract_id !== e.srcId) {
        const chain = carryChain(r, e.srcId);
        if (!chain.ids.includes(pay.contract_id)) return chain.pending ? AWAIT : no('noEntry');
      }
      // ولا يُسدَّد من تأمينٍ رُحِّل إلى التجديد (R12-DEP-1)
      if (carriedOn(db, e.srcId)) return no('settleAfterCarry');
      const c = r.row<{ deposit_holder: string | null }>('contracts', e.srcId);
      const s = r.row<{ deduction_halalas: number }>('deposit_settlements', e.srcId);
      if (!c || !s) return AWAIT;
      if (c.deposit_holder === 'طرف آخر') return no('noEntry'); // i18n-exempt: جهة مخزّنة
      const amount = num(pay.net_halalas);
      // فوق المخصوم: تعديل تسويةٍ لم يصل عاكس سدادها السابق بعد، فيُنتظر (والمزوَّر يُرفض لطول انتظاره ولا يدخل الدفتر)
      if (amount <= 0 || live(r, DEPOSIT_RENT_SRC, e.srcId, e.id, total) + amount > num(s.deduction_halalas)) return AWAIT;
      const dims = contractDims(db, r, e.srcId);
      if (!dims) return AWAIT;
      // والإيراد بعقد القسط (lineDims: الصريح فيه العقد وحده، والوحدة والعقار من مصدر القيد)
      const revDims = pay.contract_id === e.srcId ? dims : contractDims(db, r, e.srcId, pay.contract_id)!;
      // تقسيم الإيراد من العقد ودفعاته (rentSplit) يبعد بين جهازين بهللةٍ لكل حساب (derive.ts: SPLIT_SLACK) · فالوارد يُقبل بتقسيمه
      // إن طابق مجموعُه المبلغ وقرُب كل حسابٍ من المشتق، وإلا قورن بالمشتق فرُفض
      const derived = depositRentLines(db, e.srcId, amount, pay.contract_id)!;
      const got = new Map<string, number>();
      for (const l of nonZero(e.lines)) {
        const a = String(l.account_code ?? '');
        if (RENT_REVENUE_GROUP.includes(a)) got.set(a, (got.get(a) ?? 0) + num(l.credit_halalas) - num(l.debit_halalas));
      }
      const wantRev = new Map<string, number>(derived.filter((l) => l.account !== '2400').map((l) => [l.account, l.credit]));
      const near = [...got.values()].reduce((x, v) => x + v, 0) === amount
        && [...new Set([...got.keys(), ...wantRev.keys()])].every((a) => Math.abs((got.get(a) ?? 0) - (wantRev.get(a) ?? 0)) <= 2);
      const built = near
        ? [derived[0], ...[...got].filter(([, v]) => v).map(([account, v]) => ({ account, debit: 0, credit: v }))]
        : derived;
      return { lines: want(built, (l) => [l.account === '2400' ? dims : revDims])!, date: pay.date ?? '', correctable: true };
    }
    case 'deposit_deduct':
    case 'deposit_deduct_move':
    case 'deposit_refund': {
      // تسوية التأمين (applyDepositSettlement): المخصوم والمردود من صفّ التسوية، وجهة القبض من العقد، ووجهة المخصوم لدى المنصة
      // ولا تسوية لتأمينٍ رُحِّل إلى التجديد: يُردّ للمستأجر ويبقى محمولاً في المجدَّد فيُردّ مرتين (R12-DEP-1 · مرآة carryAfterSettle)
      if (carriedOn(db, e.srcId)) return no('settleAfterCarry');
      const c = r.row<{ deposit_halalas: number; deposit_holder: string | null }>('contracts', e.srcId);
      const s = r.row<{ date: string; deduction_halalas: number; refund_halalas: number; deduct_destination: string | null }>('deposit_settlements', e.srcId);
      if (!c || !s) return AWAIT;
      // والتسوية توزّع تأمين العقد كله: المخصوم بعد طرح ما زاد مطالبةً، والمردود (قرار المالك على #27 و2026-10-09) · فلا يُرحَّل
      // من التأمين أكثر منه بصفّ تسويةٍ يُكتب معه
      const deduction = num(s.deduction_halalas);
      const refund = num(s.refund_halalas);
      if (deduction < 0 || refund < 0 || deduction + refund !== num(c.deposit_halalas)) return no('settlement');
      const dims = contractDims(db, r, e.srcId);
      if (!dims) return AWAIT;
      const PLATFORM = 'منصة إيجار'; // i18n-exempt: جهة مخزّنة
      const OURS = 'حسابنا'; // i18n-exempt: وجهة مخزّنة
      const WALLET = 'محفظة إيجار'; // i18n-exempt: وجهة مخزّنة
      // وما سدّد من المخصوم أقساطاً متأخرة قيدُه إيجارٌ (deposit_rent · A1-2) فخصم 4300 بما بقي · وما في الوارد منه لم يُطبَّق بعد
      // يُنتظر (يُرحَّل قبل الخصم في المعاملة نفسها)
      if (e.src === 'deposit_deduct' && (r.pending(DEPOSIT_RENT_SRC, e.srcId).length || r.pending(DEPOSIT_RENT_SRC + '_rev', e.srcId).length)) return AWAIT;
      const arrears = e.src === 'deposit_deduct' ? live(r, DEPOSIT_RENT_SRC, e.srcId, e.id, total) : 0;
      const built = e.src === 'deposit_deduct'
        // لدى «طرف آخر» لا قيد إلا إن وصل المخصوم للمكتب، ووصوله لا يُخزَّن إلا بقيده (قرار المالك على #26)
        ? depositDeductLines(deduction - arrears, c.deposit_holder, true)
        : e.src === 'deposit_refund'
          ? depositRefundLines(refund, c.deposit_holder)
          : (c.deposit_holder === PLATFORM ? depositDeductMoveLines(deduction, s.deduct_destination === OURS ? OURS : WALLET) : null);
      const lines = want(built, () => [dims]);
      return lines ? { lines, date: s.date, correctable: true } : no('noEntry');
    }
  }
  return '';
}

/** بداية سبب البُعد (deriveSrc.dims قبل رقم حسابه) · يُميَّز به بين أسباب الأشكال البديلة */
const dimsPrefix = () => no('dims', { account: '\u0000' }).split('\u0000')[0];

/** المطابقة: كل سطرٍ وارد يقابله سطرٌ مشتق واحد بحسابه ومدينه ودائنه وأبعاده · '' إن طابقت */
function matchIssue(got: SrcLine[], want: Want[]): string {
  const g = nonZero(got);
  const w = want.filter((l) => l.debit || l.credit);
  const used = new Set<number>();
  for (const l of g) {
    const acc = String(l.account_code ?? '');
    const same = (x: Want) => x.account === acc && x.debit === num(l.debit_halalas) && x.credit === num(l.credit_halalas);
    const i = w.findIndex((x, j) => !used.has(j) && same(x) && x.dims.some((d) =>
      d.contract === str(l.contract_id) && d.unit === str(l.unit_id) && d.props.includes(str(l.property_id))
      && (d.asset ?? null) === str(l.asset_id)));
    if (i < 0) return w.some((x, j) => !used.has(j) && same(x)) ? no('dims', { account: acc }) : no('account', { account: acc });
    used.add(i);
  }
  const left = w.find((_, j) => !used.has(j));
  return left ? no('account', { account: left.account }) : '';
}

/** تاريخ القيد تاريخ مستنده · أو بعده إن قُدِّم إقرار ربعه (قيد تصحيحٍ بتاريخ اليوم: correctionDate) */
function dateIssue(db: DB, got: string, d: Derived): string {
  if (d.date === null) return '';
  const g = got.slice(0, 10);
  const want = d.date.slice(0, 10);
  if (g === want || (d.also ?? []).some((x) => x.slice(0, 10) === g)) return '';
  return d.correctable && g > want && isFiledDate(db, want) ? '' : no('date');
}

/** بُعدٌ واحد · الفارغ كالغائب (mirror.ts: sameDim) */
const sameDim = (a: unknown, b: unknown) => str(a) === str(b);
/**
 * rev مرآة orig بسطوره كلها، الصفري منها (mirrorIssue يعدّها كلها): كل سطرٍ يقابله سطرٌ واحد بحسابه، ومبلغه مقلوباً، وعقده ووحدته
 * وعقاره · وأضيق من mirrorIssue (لا استثناء للأرباح المحتجزة 3200) فما قُبل هنا لا يرفضه هناك
 */
function sameMirror(orig: SrcLine[], rev: SrcLine[]): boolean {
  if (!orig.length || orig.length !== rev.length) return false;
  const used = new Set<number>();
  for (const l of rev) {
    const i = orig.findIndex((x, j) => !used.has(j) && String(x.account_code ?? '') === String(l.account_code ?? '')
      && num(x.debit_halalas) === num(l.credit_halalas) && num(x.credit_halalas) === num(l.debit_halalas)
      && sameDim(x.contract_id, l.contract_id) && sameDim(x.unit_id, l.unit_id) && sameDim(x.property_id, l.property_id));
    if (i < 0) return false;
    used.add(i);
  }
  return true;
}

/**
 * عاكس القيد الوارد معكوساً · '' أو 'await' أو السبب · القيد يُقبل بلا مطابقة مستنده لأن عاكسه يمحو أثره، فلا يُقبل إلا بعاكسٍ سيُقبل
 * بعده فعلاً (المتحقق المستقل: عاكسٌ بسطرٍ صفري زائد يُرفض بعده فيبقى القيد بأي مبلغ، وعاكسٌ مشروع مربوطٌ بأصله يُسمّى ثانيةً لنسخةٍ
 * منه فيُقبلان معاً):
 *  - في الوارد لم يُطبَّق هنا: العاكس المقبول يُربط بأصله حين يُقبل (guessLink)، فعاكسٌ هنا قبل القيد عاكس قيدٍ آخر · ولا يسمّيه
 *    قيدٌ آخر هنا أو في الربط المعلّق أو في الوارد.
 *  - ويمرّ بفحص memberReversalCheck حين يأتي دوره: مرحّلٌ بمصدره، مرآةٌ بسطوره كلها، ولا عواكس هنا أكثر من أصولها، ولا عاكس هنا غير
 *    مربوط يطابق القيد (فلا يكون القيد أصلاً حراً له).
 *  - ويُدرج بلا رفض: مفتاحه مفتاح مستنده، وسطوره لقيده، ورقمه ومعرّفات سطوره لا يحملها قيدٌ آخر، وتاريخه ووقت إنشائه.
 */
function reversedIssue(r: SourceReader, e: { id: string; src: string; srcId: string; no: string | null; lines: SrcLine[] }, revId: string): string {
  const rev = r.entry(revId);
  if (!rev) return AWAIT;
  // وعاكسٌ طُبِّق هنا لا يسمّيه أصلٌ غير هذا (ولا تخمين) فهذا أصله (المدقق الخارجي K١: نسخةٌ محدَّثة للأصل تسمّي عاكسها بعد تطبيقه
  // كانت تُرفض «عاكسه طُبِّق قبله») · وما سمّاه أصلٌ آخر محجوزٌ له
  const claim = r.claimants(revId);
  if (claim.some((id) => id !== e.id) || (rev.here && claim.length > 0 && !claim.includes(e.id))) return no('revTaken');
  if (rev.key !== revId || rev.status !== POSTED || rev.deleted_at || rev.src_type !== e.src + '_rev' || rev.src_id !== e.srcId) return no('mirror');
  if (!sameMirror(e.lines, rev.lines)) return no('mirror');
  const originals = r.entries(e.src, e.srcId);
  const revs = r.entries(e.src + '_rev', e.srcId);
  const linked = new Set(originals.map((o) => o.reversed_by).filter(Boolean));
  if (revs.length > originals.length || revs.some((x) => !linked.has(x.id) && sameMirror(e.lines, x.lines))) return no('revTaken');
  const ids = rev.lines.map((l) => str(l.id) ?? '');
  const mine = new Set(e.lines.map((l) => str(l.id)));
  if (!rev.no || rev.no === e.no || !rev.date || !rev.created_at || ids.some((x) => !x || mine.has(x)) || new Set(ids).size !== ids.length
    || rev.lines.some((l) => str(l.entry_id) !== null && str(l.entry_id) !== revId) || r.taken(rev.no, ids, revId)) return no('revApply');
  // وقيد الصفقة قيدها نفسه في هذا المسار أيضاً (عمولة التقبيل)
  // والصفقة تسمّيه، أو تسمّي قيداً بعده من الصفقة نفسها (نسخة الاستعادة من السلة · المدقق الخارجي ج٥: الأصل الواصل معكوساً كان يُرفض
  // لأن الصفّ صار يسمّي النسخة، فيعلق عاكسه)
  if (e.src === 'key_money') {
    const k = r.row<{ journal_entry_id: string | null }>('key_money_deals', e.srcId);
    if (k?.journal_entry_id && k.journal_entry_id !== e.id) {
      const named = r.entry(k.journal_entry_id);
      if (!named || named.src_type !== 'key_money' || named.src_id !== e.srcId) return no('noEntry');
    }
  }
  // وما يُشتق منه بلا مستنده: حساباته من أطراف مصدره
  const allowed = DERIVED_SOURCES[e.src];
  const bad = e.lines.find((l) => !allowed.includes(String(l.account_code)));
  return bad ? no('account', { account: String(bad.account_code) }) : '';
}

/**
 * سبب رفض قيد عضوٍ مرحّل بمصدرٍ من المصادر المشتقة · '' إن طابق مستنده أو لم يكن مصدره منها · 'await' إن لم يصل مستنده بعد
 * (أو عاكسه، أو عاكس قيدٍ حيٍّ قبله من المصدر نفسه)
 */
export function memberSourceIssue(db: DB, r: SourceReader,
  e: { id: string; src_type: string | null; src_id: string | null; no?: string | null; date: string; reversed_by: string | null; lines: SrcLine[] }): string {
  const src = e.src_type ?? '';
  if (!DERIVED_SOURCES[src]) return '';
  const srcId = e.src_id ?? '';
  if (e.reversed_by) return reversedIssue(r, { id: e.id, src, srcId, no: e.no ?? null, lines: e.lines }, e.reversed_by);
  if (!MULTI.includes(src)) {
    if (live(r, src, srcId, e.id, () => 1) > 0) return AWAIT;
    // وقيدٌ آخر من المصدر نفسه في الوارد يُطبَّق قبله: القديم الواصل معكوساً يسبق الجديد، وإلا وصل عاكس القديم والجديد وحده هنا فلا
    // يطابقه فيُرفض، ويبقى القديم بلا عاكسٍ ينتظره (تعديل التسوية أو المطالبة في مزامنةٍ واحدة بترتيبٍ آخر)
    // وبين قيدين حيّين من المصدر نفسه في الوارد معاً (تحصيلا المطالبة نفسها على جهازين · المدقق الخارجي Z٢-٦) ينتظر الأكبر معرّفاً وحده
    // فيُطبَّق الأصغر ويُرفض الآخر تحصيلاً ثانياً، ولا ينتظر كلٌّ منهما الآخر
    // (والمعكوس معكوسٌ بعاكسٍ موجود هنا أو في الوارد: عاكسٌ وهمي يسمّيه مزوَّرٌ لا يحبس الصحيح · B٢-٦)
    if (r.pending(src, srcId).some((id) => {
      if (id === e.id) return false;
      const rb = r.entry(id)?.reversed_by;
      return rb ? !!r.entry(rb) : id < e.id;
    })) return AWAIT;
  }
  const d = derive(db, r, { id: e.id, src, srcId, no: e.no ?? null, date: e.date, total: nonZero(e.lines).reduce((s, l) => s + num(l.credit_halalas), 0), lines: e.lines });
  if (typeof d === 'string') return d;
  const forms = [d.lines, ...(d.alts ?? [])];
  const stale = () => !!d.stale && r.entries(src, srcId).some((x) => x.id !== e.id
    && forms.some((w) => matchIssue(x.lines, w) === '') && (d.date === null || String(x.date ?? '').slice(0, 10) === d.date.slice(0, 10)));
  const dateWhy = dateIssue(db, e.date, d);
  if (dateWhy) return d.pending || stale() ? AWAIT : dateWhy;
  // يكفي أن يطابق شكلاً واحداً مما يرحّله التطبيق من المستند · وإلا فسبب شكلٍ طابقت حساباته ومبالغه وخالف بُعده، ثم سبب الأول
  const whys = forms.map((w) => matchIssue(e.lines, w));
  if (whys.includes('')) return '';
  if (d.pending || stale()) return AWAIT;
  const dims = dimsPrefix();
  return whys.find((w) => w.startsWith(dims)) ?? whys[0];
}

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
import { unitPastProperties } from '../unitMove';
import {
  contractDepositLines, depositCarryLines, depositDeductLines, depositDeductMoveLines, depositRefundLines,
  reservationDepositLines, reservationForfeitLines, reservationRefundLines, keyMoneyLines,
  claimLines, claimCollectionLines, purchaseLedgerLines, purchasePaymentLines, PURCHASE_CATEGORY_ACCOUNT,
  invoiceLedgerLines, creditNoteLedgerLines, invoicePaymentLines, vatRefundLines, vatRejectLines, cashOpLines, type EntryLine,
} from './post';
import { TS_DEDUCTIBLE } from '../purchases';
import { invoiceTotals, normalizeInvoiceLines, KIND_CREDIT } from '../invoices';
import { remainingByCodeOf, creditNoteAmounts, type StoredInvoiceLine } from '../creditNote';
import { lineTaxCode, type TaxCode } from '../taxCode';
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
};

/**
 * مصادر يرحّل منها التطبيق قيوداً عدة حيّة لمستندٍ واحد (المعرّف معرّف الأصل): إهلاك ما قبل كل نقلٍ أو استبعادٍ أو بيع، وكل نقل ·
 * فلا يُنتظر لها عاكس قيدٍ سابق، ويُفحص تكرارها بالمطابقة نفسها (المجمع بعد ما رُحِّل قبلها، والنقل بحدثه المسمّي قيده)
 */
const MULTI = ['asset_dep', 'asset_transfer'];

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
  const assets = r.rows<{ id: string; purchase_line_id: string | null; unit_id: string | null; property_id: string | null; source: string | null; deleted_at?: string | null }>(
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
    const specs = mine.map((a): DimSpec => ({ contract: null, unit: a.unit_id ?? dims.unit, props: a.property_id ? [a.property_id] : dims.props, asset: a.id }));
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
 * والاستبعاد والبيع وإهلاك ما قبلها)، أو إهلاك ما فات بتاريخ إثبات التكلفة (catchup)
 */
type When = { kind: 'month'; m: number } | { kind: 'op' | 'catchup'; d: string };

/**
 * هل رُحِّل x قبل القيد المفحوص على الجهاز الكاتب، فدخل في المجمع المرحَّل (postedAccum) الذي حُسب منه · وترتيب الوصول هنا غير
 * ترتيب الترحيل هناك (القيود بمفاتيحها)، فيُعرف السابق من نوعه وتاريخه:
 *  - الإهلاك الشهري يُرحَّل قبل كل عمليةٍ بتاريخٍ في شهره أو بعده (requireOpenDate: تاريخ العملية بعد آخر شهرٍ رُحِّل)، وبعدها لما بعده.
 *  - وإهلاك العملية (asset_dep) بتاريخها: ما بعده بتاريخه رُحِّل بعده، وما رُحِّل بعده بتاريخٍ قبله صفرٌ لا قيد له.
 *  - وإهلاك ما فات بتاريخ إثبات التكلفة يسبق كل إهلاكٍ للأصل بعد ذلك.
 *  - والاستبعاد والبيع آخر ما يُرحَّل للأصل.
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
    return w.kind === 'month' ? monthIndex(d) <= w.m : w.kind === 'op' ? d <= w.d : d < w.d;
  }
  return true;
}

/**
 * ما رُحِّل للأصل قبل القيد المفحوص: مجمعه (1490 دائناً) وتكلفته (حساب فئته مديناً) في الدفتر هنا، وهما ما حسبه الجهاز الكاتب
 * (postedAccum وpostedCost) · pending: قيدٌ سابقٌ في الوارد لم يُطبَّق بعد يغيّر أحدهما
 */
function ledgerOf(r: SourceReader, assetId: string, category: string, exceptId: string, w: When): { accum: number; cost: number; pending: boolean } {
  let accum = 0, cost = 0, pending = false;
  for (const x of r.assetEntries(assetId)) {
    if (x.id === exceptId || !before(x, w)) continue;
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
function basisIssue(a: AssetDoc, led: { cost: number; pending: boolean }): string {
  if (a.cost_halalas == null) return led.cost ? (led.pending ? AWAIT : no('assetCost')) : '';
  const cost = num(a.cost_halalas), salvage = num(a.salvage_halalas), life = num(a.life_months);
  if (!(cost > 0) || salvage < 0 || salvage >= cost || !Number.isInteger(life) || life < 1 || life > 600) return no('assetCost');
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
function assetSpecs(db: DB, r: SourceReader, a: AssetDoc, date: string, units = assetUnits(r, a), withContract = true): DimSpec[] {
  return units.flatMap((u) => {
    const props = [...new Set([...unitDims(db, r, u).props, ...(u === (a.unit_id ?? null) ? [a.property_id ?? null] : [])])];
    const contracts = withContract && u ? r.rows<{ id: string; start: string | null; end: string | null; deleted_at?: string | null }>('contracts', 'unit_id', u)
      .filter((c) => !c.deleted_at && String(c.start ?? '') <= date && String(c.end ?? '') >= date).map((c) => c.id) : [];
    return [null, ...contracts].map((c): DimSpec => ({ contract: c, unit: u, props, asset: a.id }));
  });
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
  const a = r.row<AssetDoc>('assets', assetId);
  if (!a) return AWAIT;
  const led = ledgerOf(r, assetId, a.category, exceptId, w);
  const why = basisIssue(a, led);
  if (why) return why;
  return { a, amt: expectedThrough(depreciable(a), through) - led.accum, specs: assetSpecs(db, r, a, through), pending: led.pending };
}

/**
 * إهلاك ما فات للأصل بتاريخ إثبات تكلفته (catchUpLines): مبالغه من catchUpAmounts بعد ما رُحِّل له قبله · السنة الجارية على مصروف
 * الإهلاك وما قبلها على الأرباح المحتجزة، ودائن المجمع بمجموعهما · pending: قيدٌ سابقٌ في الوارد، أو مجمعٌ في القيد دون المستحق
 */
function catchUpOf(db: DB, r: SourceReader, a: AssetDoc, exceptId: string, today: string, lines: SrcLine[], costHere = false):
  { lines: Want[]; pending: boolean } | string {
  const led = ledgerOf(r, a.id, a.category, exceptId, { kind: 'catchup', d: today });
  // وتكلفةٌ يثبتها القيد نفسه (asset_cost) أساسها فيه
  const why = basisIssue(a, costHere ? { ...led, cost: led.cost + num(a.cost_halalas) } : led);
  if (why) return why;
  const c = catchUpAmounts(depreciable(a), today, led.accum);
  if (c.total <= 0) return { lines: [], pending: led.pending };
  const dims = assetSpecs(db, r, a, today);
  const got = accumIn(lines, a.id);
  return {
    lines: [
      { account: ACC_DEPRECIATION, debit: c.current, credit: 0, dims }, { account: ACC_RETAINED, debit: c.prior, credit: 0, dims },
      { account: ACC_ACCUM, debit: 0, credit: c.total, dims },
    ],
    pending: led.pending || (got > 0 && got < c.total),
  };
}

/** المنتهي (المستبعد أو المبيع) لا يُهلك بعد تاريخ انتهائه */
const endedBy = (a: AssetDoc, d: string) => ENDED.includes(a.status as never) && String(a.end_date ?? '').slice(0, 10) < d;

/** سطور القيد المتوقعة من مستنده · 'await' لمستندٍ لم يصل · أو سبب الرفض */
function derive(db: DB, r: SourceReader, e: { id: string; src: string; srcId: string; no: string | null; date: string; total: number; lines: SrcLine[] }): Outcome {
  switch (e.src) {
    case 'depreciation': {
      // الإهلاك الشهري (runDepreciation): قيدٌ لشهره بتاريخ آخر يومٍ فيه، وسطرا كل أصلٍ بالمستحق من جدوله حتى آخر الشهر ناقصاً ما رُحِّل
      // له قبله، وبأبعاده يومها · وما لم يكن فيه من الأصول (صفرٌ أو لم يصل جهازه بعد) لا يُطالب به · والمنتهي في الشهر أو قبله لا يُهلك
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(e.srcId)) return no('noEntry');
      const m = monthIndex(e.srcId + '-01');
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
      return { lines: depPair(endedBy(x.a, d) ? 0 : x.amt, x.specs), date: d, correctable: false, pending: x.pending || (got > 0 && got < x.amt) };
    }
    case 'asset_cost': {
      // إثبات تكلفة قطعةٍ بلا فاتورة (setAssetCost): مدين حساب فئتها ودائن رأس المال بتكلفتها في صفّها، ومعه إهلاك ما فات منذ شرائها
      // حتى آخر شهرٍ انتهى قبل تاريخه، بتاريخ حدث إثباتها المسمّي هذا القيد · والقطعة بانتظار تكلفةٍ قبله: لا فاتورة لها، ولا تكلفة
      // لها في الدفتر قبله
      const a = r.row<AssetDoc>('assets', e.srcId);
      if (!a) return AWAIT;
      if (a.purchase_id || a.source === 'purchase' || a.source === 'convert') return no('noEntry');
      // تكلفةٌ لم يصل صفّها المحدَّث بعد
      if (a.cost_halalas == null) return AWAIT;
      const evs = r.rows<AssetEvent>('asset_events', 'entry_id', e.id);
      if (!evs.length) return AWAIT;
      if (evs.length > 1 || evs[0].kind !== 'cost' || evs[0].asset_id !== a.id) return no('noEntry');
      const today = String(evs[0].date ?? '').slice(0, 10);
      const led = ledgerOf(r, a.id, a.category, e.id, { kind: 'catchup', d: today });
      if (led.cost) return led.pending ? AWAIT : no('assetCost');
      const cu = catchUpOf(db, r, a, e.id, today, e.lines, true);
      if (typeof cu === 'string') return cu;
      const dims = assetSpecs(db, r, a, today);
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
      const a = r.row<AssetDoc>('assets', e.srcId);
      if (!a) return AWAIT;
      const d = String(ev.date ?? '').slice(0, 10);
      const led = ledgerOf(r, a.id, a.category, e.id, { kind: 'op', d });
      const from = assetSpecs(db, r, a, d, [ev.from_unit_id ?? null]);
      const to = assetSpecs(db, r, a, d, [ev.to_unit_id ?? null]);
      // ومجمعٌ أو تكلفةٌ في القيد فوق ما رُحِّل هنا في حدود الأصل: قيدٌ قبله لم يصل بعد فيُنتظر
      const short = opShort(a, d, led, { cost: sideOf(e.lines, a.id, a.category, 'debit_halalas'), accum: sideOf(e.lines, a.id, ACC_ACCUM, 'credit_halalas') });
      return {
        lines: [
          { account: a.category, debit: led.cost, credit: 0, dims: to }, { account: a.category, debit: 0, credit: led.cost, dims: from },
          { account: ACC_ACCUM, debit: led.accum, credit: 0, dims: from }, { account: ACC_ACCUM, debit: 0, credit: led.accum, dims: to },
        ],
        date: d, correctable: false, pending: led.pending || short,
      };
    }
    case 'asset_dispose':
    case 'asset_sell': {
      // استبعاد الأصل أو بيعه (disposeAsset وsellAsset): بتاريخ انتهائه في صفّه الذي يسمّي هذا القيد، تكلفته ومجمعه المرحّلان قبله
      // (بعد إهلاك ما قبله) يُقفلان، والقيمة الدفترية خسارة استبعاد، أو يقابلها مبلغ البيع نقداً والفرق ربحٌ أو خسارة · وبأبعاده يومها
      const a = r.row<AssetDoc>('assets', e.srcId);
      if (!a) return AWAIT;
      const status = e.src === 'asset_dispose' ? 'disposed' : 'sold';
      // صفّه المنتهي لم يصل بعد
      if (!ENDED.includes(a.status as never)) return AWAIT;
      if (a.status !== status || a.end_entry_id !== e.id || !a.end_date) return no('noEntry');
      const d = String(a.end_date).slice(0, 10);
      const led = ledgerOf(r, a.id, a.category, e.id, { kind: 'op', d });
      const dims = assetSpecs(db, r, a, d, [a.unit_id ?? null]);
      const nbv = led.cost - led.accum;
      const short = opShort(a, d, led, { cost: sideOf(e.lines, a.id, a.category, 'credit_halalas'), accum: sideOf(e.lines, a.id, ACC_ACCUM, 'debit_halalas') });
      const close: Want[] = [
        { account: ACC_ACCUM, debit: led.accum, credit: 0, dims }, { account: a.category, debit: 0, credit: led.cost, dims },
      ];
      if (e.src === 'asset_dispose') {
        return { lines: [...close, { account: ACC_DISPOSAL_LOSS, debit: nbv, credit: 0, dims }], date: d, correctable: false, pending: led.pending || short };
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
        date: d, correctable: false, pending: led.pending || short,
      };
    }
    case 'asset_catchup': {
      // إهلاك ما فات لأصول فاتورة الشراء (purchaseCatchUp بتاريخ حفظها، وconvertPurchase بتاريخ تحويلها): لكل أصلٍ قائمٍ بتكلفته من
      // أصولها حتى آخر شهرٍ انتهى قبل تاريخ القيد · وتاريخه لا يُخزَّن في مستند، فلا يسبق تاريخ الفاتورة
      const p = r.row<PurchaseRow>('purchases', e.srcId);
      if (!p) return AWAIT;
      if (p.deleted_at) return no('deleted');
      const today = e.date.slice(0, 10);
      if (today < String(p.date ?? '').slice(0, 10)) return no('date');
      const assets = r.rows<AssetDoc>('assets', 'purchase_id', e.srcId).filter((a) => !a.deleted_at && a.cost_halalas != null);
      // أصولٌ لم يصل صفّها بعد
      if (!assets.length) return AWAIT;
      const lines: Want[] = [];
      let pending = false;
      for (const a of assets) {
        const cu = catchUpOf(db, r, a, e.id, today, e.lines);
        if (typeof cu === 'string') return cu;
        lines.push(...cu.lines);
        pending ||= cu.pending;
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
        journal_entry_id: string | null }>('key_money_deals', e.srcId);
      if (!k) return AWAIT;
      if (k.journal_entry_id && k.journal_entry_id !== e.id) return no('noEntry');
      // والقيد يُرحَّل قبل صفّ صفقته (recordKeyMoneyDeal) فلا يجد dimsFromSource مستنده فتُكتب سطوره بلا أبعاد · ويُقبل بأبعاد
      // صفقته (عقدها أو وحدتها) إن مُلئت، ولا يُقبل بأبعاد مستندٍ آخر
      const none: DimSpec = { contract: null, unit: null, props: [null] };
      const own = k.contract_id ? contractDims(db, r, k.contract_id) : unitDims(db, r, k.unit_id ?? null);
      if (!own) return AWAIT;
      const lines = want(keyMoneyLines(db, num(k.commission_halalas)), () => [none, own]);
      return lines ? { lines, date: k.date ?? '', correctable: false } : no('noEntry');
    }
    case 'claim':
    case 'claim_collect': {
      // المطالبة (claims.ts، ومطالبة زيادة التسوية): قيدها بمبلغها وتاريخها أو تاريخ التصحيح بعده (تعديل المفتوحة يعكس القديم ويرحّل
      // الجديد) · وتحصيلها بمبلغها وتاريخ تحصيلها المخزَّن · والأبعاد عقد المطالبة ووحدته وعقاره
      const cl = r.row<{ contract_id: string | null; amount_halalas: number; date: string | null; collected_at: string | null;
        deleted_at: string | null }>('claims', e.srcId);
      if (!cl) return AWAIT;
      // والمحذوفة عُكس قيدها حين حُذفت (deleteClaim) فلا قيد حيّاً لها: قيدٌ جديد بمبلغها يُدخل ذمةً وإيراداً لا مستند لهما
      // (المتحقق المستقل) · وقيدها القديم الواصل معكوساً يمرّ بمسار العكس قبل هذا
      if (cl.deleted_at) return no('deleted');
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
    case 'deposit_deduct':
    case 'deposit_deduct_move':
    case 'deposit_refund': {
      // تسوية التأمين (applyDepositSettlement): المخصوم والمردود من صفّ التسوية، وجهة القبض من العقد، ووجهة المخصوم لدى المنصة
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
      const built = e.src === 'deposit_deduct'
        // لدى «طرف آخر» لا قيد إلا إن وصل المخصوم للمكتب، ووصوله لا يُخزَّن إلا بقيده (قرار المالك على #26)
        ? depositDeductLines(deduction, c.deposit_holder, true)
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
  if (rev.here || r.claimants(revId).some((id) => id !== e.id)) return no('revTaken');
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
  if (e.src === 'key_money') {
    const k = r.row<{ journal_entry_id: string | null }>('key_money_deals', e.srcId);
    if (k?.journal_entry_id && k.journal_entry_id !== e.id) return no('noEntry');
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
    if (r.pending(src, srcId).some((id) => id !== e.id)) return AWAIT;
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

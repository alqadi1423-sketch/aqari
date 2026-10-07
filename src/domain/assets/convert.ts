/**
 * تحويل فواتير الشراء القديمة المسجّلة مصروفاً إلى أصول (موجز الأصول §٥ · قرار المالك: القيود بتاريخ التحويل):
 *  1. تُقسم الفاتورة إلى بنود: ما يصير أصلاً بفئته وكميته ووحدته، وما يبقى مصروفاً.
 *  2. المعاينة قبل أي كتابة: الأصول، وقيد إعادة التصنيف، وإهلاك ما فات، والجدول سنةً بسنة، والقيمة الدفترية اليوم.
 *  3. التنفيذ: إعادة التصنيف (مدين الفئة / دائن مصروف الفئة الأصلي)، وإهلاك ما فات (السنة الجارية 5600
 *     وما قبلها 3200 / دائن 1490) · كلاهما بتاريخ التحويل فلا تتغير فتراتٌ سبق أن رآها المالك.
 *  4. التراجع: عمليةٌ واحدة تعكس الكل ما لم يُنقل أصلٌ منها أو يُستبعد أو يُبع.
 */
import type { DB } from '../../db/adapter';
import { postEntry, purchaseExpenseAccount, reverseEntryById, type EntryLine } from '../accounting/post';
import { fmt as fmtH } from '../money';
import { logAudit } from '../audit';
import { t } from '../../i18n';
import { ACC_ACCUM, ACC_DEPRECIATION, defaultLife } from './catalog';
import { catchUpLines, expectedThrough, monthEnd, monthIndex, scheduleByYear } from './depreciation';
import { splitQty, writePurchaseLines, purchaseAssets, type PurchaseLineInput } from './purchaseLines';

const fail = (key: string, opts?: Record<string, unknown>): never => { throw new Error(t('assets.err.' + key, opts)); };
const POSTED = 'مرحّل'; // i18n-exempt: حالة القيد المخزّنة
const DEDUCTIBLE = 'فاتورة ضريبية · قابلة للخصم'; // i18n-exempt: الوضع الضريبي المخزّن
const AUDIT = 'الأصول'; // i18n-exempt: وحدة سجل العمليات المخزّنة

interface PurchaseRow {
  id: string; no: string; supplier_name: string; date: string; category: string; subtotal_halalas: number; tax_halalas: number;
  tax_status: string; unit_id: string | null; property_id: string | null; journal_entry_id: string | null;
}

/** ما صُرف في الفاتورة على مصروف فئتها · سقف ما يُحوَّل */
export const expensedOf = (p: PurchaseRow): number =>
  Number(p.subtotal_halalas) + (p.tax_status === DEDUCTIBLE ? 0 : Number(p.tax_halalas));

function getPurchase(db: DB, id: string): PurchaseRow {
  const p = db.get<PurchaseRow>(
    `SELECT id, no, supplier_name, date, category, subtotal_halalas, tax_halalas, tax_status, unit_id, property_id, journal_entry_id
     FROM purchases WHERE id = ? AND deleted_at IS NULL`, [id]);
  return p ?? fail('notFound');
}
const converted = (db: DB, id: string) => !!db.get(`SELECT 1 FROM purchase_lines WHERE purchase_id = ? AND deleted_at IS NULL`, [id]);

/** فواتير مسجّلة مصروفاً بلا بنود · مع تصفية الفئة والمورد والتاريخ والبحث بالكلمة */
export function convertibleInvoices(db: DB, f: { category?: string; supplier?: string; from?: string; to?: string; q?: string } = {}) {
  const w = [`p.deleted_at IS NULL`, `p.journal_entry_id IS NOT NULL`, `NOT EXISTS (SELECT 1 FROM purchase_lines l WHERE l.purchase_id = p.id AND l.deleted_at IS NULL)`];
  const prm: string[] = [];
  if (f.category) { w.push('p.category = ?'); prm.push(f.category); }
  if (f.supplier) { w.push('p.supplier_name = ?'); prm.push(f.supplier); }
  if (f.from) { w.push('p.date >= ?'); prm.push(f.from); }
  if (f.to) { w.push('p.date <= ?'); prm.push(f.to); }
  if (f.q?.trim()) { w.push(`(p.supplier_name LIKE ? OR p.incorp_item LIKE ? OR p.no LIKE ? OR p.category LIKE ?)`); const q = '%' + f.q.trim() + '%'; prm.push(q, q, q, q); }
  return db.all<PurchaseRow & { incorp_item: string; total_halalas: number }>(
    `SELECT p.id, p.no, p.supplier_name, p.date, p.category, p.subtotal_halalas, p.tax_halalas, p.total_halalas, p.tax_status, p.unit_id,
            p.property_id, p.journal_entry_id, p.incorp_item
     FROM purchases p WHERE ${w.join(' AND ')} ORDER BY p.date DESC LIMIT 300`, prm);
}

export interface ConversionPreview {
  purchase: { id: string; no: string; date: string; supplier: string; expensed: number; expenseAccount: string };
  assets: Array<{ name: string; category: string; cost: number; lifeMonths: number; unitId: string | null; room: string }>;
  reclass: { debit: Array<{ account: string; amount: number }>; credit: { account: string; amount: number } };
  catchUp: { current: number; prior: number; total: number };
  byYear: Array<{ year: number; amount: number }>;
  bookValueToday: number;
}

function check(db: DB, p: PurchaseRow, lines: PurchaseLineInput[]): void {
  if (converted(db, p.id)) fail('converted');
  if (!lines.some((l) => l.isAsset)) fail('convertEmpty');
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 500) fail('qty');
    if (l.isAsset && !l.descr.trim()) fail('name');
    if (l.isAsset && !l.unitId && !l.linkAssetId) fail('unit');
  }
  const sum = lines.filter((l) => l.isAsset).reduce((s, l) => s + l.amountHalalas, 0);
  const max = expensedOf(p);
  if (sum > max) fail('convertSum', { sum: fmtH(sum), max: fmtH(max) });
}

/** المعاينة · لا يُكتب شيء */
export function previewConversion(db: DB, purchaseId: string, lines: PurchaseLineInput[], today: string): ConversionPreview {
  const p = getPurchase(db, purchaseId);
  check(db, p, lines);
  const assets = lines.filter((l) => l.isAsset).flatMap((l) => splitQty(l.amountHalalas, l.qty).map((cost) => ({
    name: l.descr.trim(), category: l.category!, cost, lifeMonths: l.lifeMonths ?? defaultLife(l.category!), unitId: l.unitId ?? null, room: (l.room ?? '').trim(),
  })));
  const through = monthEnd(monthIndex(today) - 1);
  const prevYearEnd = String(Number(today.slice(0, 4)) - 1) + '-12-31';
  let total = 0; let prior = 0;
  const years = new Map<number, number>();
  for (const a of assets) {
    const d = { id: '', cost_halalas: a.cost, salvage_halalas: 0, life_months: a.lifeMonths, purchase_date: p.date };
    const tot = expectedThrough(d, through);
    total += tot;
    prior += Math.min(tot, expectedThrough(d, prevYearEnd));
    for (const y of scheduleByYear(d)) years.set(y.year, (years.get(y.year) ?? 0) + y.amount);
  }
  const byCat = new Map<string, number>();
  for (const a of assets) byCat.set(a.category, (byCat.get(a.category) ?? 0) + a.cost);
  const costSum = assets.reduce((s, a) => s + a.cost, 0);
  return {
    purchase: { id: p.id, no: p.no, date: p.date, supplier: p.supplier_name, expensed: expensedOf(p), expenseAccount: purchaseExpenseAccount(p.category) },
    assets,
    reclass: { debit: [...byCat].map(([account, amount]) => ({ account, amount })), credit: { account: purchaseExpenseAccount(p.category), amount: costSum } },
    catchUp: { current: total - prior, prior, total },
    byYear: [...years].sort((a, b) => a[0] - b[0]).map(([year, amount]) => ({ year, amount })),
    bookValueToday: costSum - total,
  };
}

/** التنفيذ بعد المعاينة · بتاريخ التحويل */
export function convertPurchase(db: DB, purchaseId: string, lines: PurchaseLineInput[], today: string): void {
  const p = getPurchase(db, purchaseId);
  check(db, p, lines);
  db.transaction(() => {
    // البنود المصروفة تُكتب بنوداً بلا أصل · والأصلية بتكلفتها كما أُدخلت (جزءٌ مما صُرف)
    const assetLines: EntryLine[] = writePurchaseLines(db, { id: p.id, date: p.date }, lines, lines.map((l) => l.amountHalalas), 'convert');
    const sum = assetLines.reduce((s, l) => s + l.debit, 0);
    postEntry(db, {
      date: today, memo: t('assets.memo.convert', { no: p.no, lng: 'ar' }),
      lines: [...assetLines, { account: purchaseExpenseAccount(p.category), descr: p.no, debit: 0, credit: sum, dims: { propertyId: p.property_id, unitId: p.unit_id } }],
      srcType: 'asset_convert', srcId: p.id,
    });
    const catchUp = purchaseAssets(db, p.id).flatMap((a) => catchUpLines(db, a, today));
    if (catchUp.length) {
      postEntry(db, { date: today, memo: t('assets.memo.catchup', { what: p.no, lng: 'ar' }), lines: catchUp, srcType: 'asset_catchup', srcId: p.id });
    }
    logAudit(db, AUDIT, 'create', 'conversion', p.no, undefined, { assets: assetLines.length, cost: sum });
  });
}

/** عكس التحويل كاملاً · ما لم يُنقل أصلٌ منه أو يُستبعد أو يُبع */
export function undoConversion(db: DB, purchaseId: string, today: string): void {
  const p = getPurchase(db, purchaseId);
  // ما أنشأه التحويل، وما أثبت تكلفته من أصولٍ قائمة «بانتظار تكلفة»
  const assets = purchaseAssets(db, purchaseId);
  if (!assets.some((a) => a.source === 'convert') && !converted(db, purchaseId)) fail('notConverted');
  for (const a of assets) {
    if (a.status === 'disposed' || a.status === 'sold') fail('undoBlocked');
    if (db.get(`SELECT 1 FROM asset_events WHERE asset_id = ? AND kind IN ('transfer', 'dispose', 'sell')`, [a.id])) fail('undoBlocked');
  }
  db.transaction(() => {
    for (const e of db.all<{ id: string }>(
      `SELECT id FROM journal_entries WHERE src_id = ? AND src_type IN ('asset_convert', 'asset_catchup') AND status = ? AND deleted_at IS NULL AND reversed_by IS NULL`,
      [purchaseId, POSTED])) {
      reverseEntryById(db, e.id, t('assets.memo.undo', { no: p.no, lng: 'ar' }), today);
    }
    // الإهلاك الشهري الذي رُحِّل لها بعد التحويل يُعكس بقيدٍ واحد
    const lines: EntryLine[] = [];
    for (const a of assets) {
      const r = db.get<{ v: number }>(
        `SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE l.asset_id = ? AND l.account_code = ? AND e.status = ? AND e.deleted_at IS NULL AND e.src_type IN ('depreciation', 'asset_dep')`,
        [a.id, ACC_ACCUM, POSTED]);
      const v = Number(r?.v ?? 0);
      if (v > 0) {
        const dims = { assetId: a.id, unitId: a.unit_id, propertyId: a.property_id };
        lines.push({ account: ACC_ACCUM, descr: a.name, debit: v, credit: 0, dims }, { account: ACC_DEPRECIATION, descr: a.name, debit: 0, credit: v, dims });
      }
    }
    if (lines.length) postEntry(db, { date: today, memo: t('assets.memo.undo', { no: p.no, lng: 'ar' }), lines, srcType: 'asset_convert_rev', srcId: purchaseId });
    const stamp = new Date().toISOString();
    db.run(`UPDATE assets SET deleted_at = ? WHERE purchase_id = ? AND source = 'convert' AND deleted_at IS NULL`, [stamp, purchaseId]);
    db.run(`UPDATE assets SET cost_halalas = NULL, purchase_id = NULL, purchase_line_id = NULL WHERE purchase_id = ? AND source != 'convert' AND deleted_at IS NULL`, [purchaseId]);
    db.run(`UPDATE purchase_lines SET deleted_at = ? WHERE purchase_id = ? AND deleted_at IS NULL`, [stamp, purchaseId]);
    logAudit(db, AUDIT, 'delete', 'conversion', p.no);
  });
}

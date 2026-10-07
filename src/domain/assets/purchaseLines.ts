/**
 * بنود فاتورة الشراء والأصول التي تُنشئها (موجز الأصول §١ و§٣أ · قرار المالك: جدول البنود الجديد،
 * والفاتورة بلا بنود تبقى كما هي):
 *  - تكلفة البند = أساسه + نصيبه من الضريبة (كما يذهب اليوم للمصروف)، إلا «القابلة للخصم» فضريبتها في 1270.
 *  - الكمية ٣ تُنشئ ثلاثة أصول بالتكلفة مقسومة، والهللة الباقية على الأول.
 *  - البند يُثبت تكلفة أصلٍ قائم «بانتظار تكلفة» إن رُبط به (linkAssetId).
 *  - فاتورةٌ لأصولها إهلاك أو حركة لا تُعدَّل ولا تُحذف حتى يُعدَّل الأصل نفسه.
 */
import type { DB } from '../../db/adapter';
import { uid } from '../ids';
import { postEntry, type EntryLine } from '../accounting/post';
import { t } from '../../i18n';
import { defaultLife, isAssetCategory } from './catalog';
import { catchUpLines, postedAccum } from './depreciation';
import type { AssetRow } from './service';

export interface PurchaseLineInput {
  descr: string;
  qty: number;
  /** أساس البند قبل الضريبة لكل الكمية */
  amountHalalas: number;
  isAsset: boolean;
  category?: string | null;
  lifeMonths?: number | null;
  unitId?: string | null;
  room?: string;
  /** أصلٌ قائم بانتظار تكلفة يُثبتها هذا البند (الكمية ١) */
  linkAssetId?: string | null;
}

const fail = (key: string, opts?: Record<string, unknown>): never => { throw new Error(t('assets.err.' + key, opts)); };
/** فاتورةٌ لأصولها تحويل أو ربط · تُعكس أو تُعدَّل من الأصل أولاً */
export const failPurchaseLocked = (): never => fail('purchaseLocked');

/** تكلفة كل بند: أساسه ونصيبه من الضريبة غير القابلة للخصم · الفرق على آخر بند فيطابق المجموع */
export function lineCosts(lines: PurchaseLineInput[], taxHalalas: number, deductible: boolean): number[] {
  const base = lines.reduce((s, l) => s + l.amountHalalas, 0);
  const tax = deductible ? 0 : taxHalalas;
  if (!tax || !base) return lines.map((l) => l.amountHalalas);
  let given = 0;
  return lines.map((l, i) => {
    const share = i === lines.length - 1 ? tax - given : Math.floor((tax * l.amountHalalas) / base);
    given += share;
    return l.amountHalalas + share;
  });
}

/** تكلفة كل أصلٍ من بنده · الهللة الباقية على الأول */
export function splitQty(cost: number, qty: number): number[] {
  const each = Math.floor(cost / qty);
  return Array.from({ length: qty }, (_, i) => (i === 0 ? cost - each * (qty - 1) : each));
}

export function validateLines(lines: PurchaseLineInput[], subtotalHalalas: number, fmtH: (n: number) => string): void {
  const sum = lines.reduce((s, l) => s + l.amountHalalas, 0);
  if (sum !== subtotalHalalas) fail('linesSum', { sum: fmtH(sum), base: fmtH(subtotalHalalas) });
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 500) fail('qty');
    if (l.isAsset) {
      if (!l.descr.trim()) fail('name');
      if (!isAssetCategory(l.category)) fail('category');
      if (!l.unitId && !l.linkAssetId) fail('unit');
      if (l.linkAssetId && l.qty !== 1) fail('qty');
    }
  }
}

const unitProperty = (db: DB, unitId: string | null | undefined): string | null =>
  unitId ? db.get<{ p: string }>(`SELECT property_id AS p FROM units WHERE id = ?`, [unitId])?.p ?? null : null;

/**
 * يكتب بنود الفاتورة وأصولها ويعيد سطور القيد المدينة لحسابات الفئات بأبعاد كل أصل ·
 * source: 'purchase' للفاتورة الجديدة، و'convert' لتحويل فاتورة قديمة
 */
export function writePurchaseLines(db: DB, p: { id: string; date: string }, lines: PurchaseLineInput[], costs: number[], source: 'purchase' | 'convert'): EntryLine[] {
  const out: EntryLine[] = [];
  const now = new Date().toISOString();
  lines.forEach((l, i) => {
    const lineId = uid();
    db.run(
      `INSERT INTO purchase_lines (id, purchase_id, descr, qty, amount_halalas, is_asset, asset_category, life_months, unit_id, room, sort, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [lineId, p.id, l.descr.trim(), l.qty, l.amountHalalas, l.isAsset ? 1 : 0, l.isAsset ? l.category ?? null : null,
       l.isAsset ? (l.lifeMonths ?? defaultLife(l.category!)) : null, l.unitId ?? null, (l.room ?? '').trim(), i, now]);
    if (!l.isAsset) return;
    const parts = splitQty(costs[i], l.qty);
    parts.forEach((cost, k) => {
      let assetId: string;
      let unitId = l.unitId ?? null;
      let prop = unitProperty(db, unitId);
      if (l.linkAssetId && k === 0) {
        const a = db.get<AssetRow>(`SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL`, [l.linkAssetId]);
        if (!a) fail('notFound');
        if (a!.cost_halalas != null) fail('notPending');
        assetId = a!.id;
        unitId = a!.unit_id;
        prop = a!.property_id;
        db.run(`UPDATE assets SET cost_halalas = ?, purchase_date = ?, purchase_id = ?, purchase_line_id = ?, category = ?, life_months = ? WHERE id = ?`,
          [cost, p.date, p.id, lineId, l.category!, l.lifeMonths ?? a!.life_months, assetId]);
      } else {
        assetId = uid();
        db.run(
          `INSERT INTO assets (id, name, category, property_id, unit_id, room, purchase_date, cost_halalas, salvage_halalas, life_months,
             status, source, purchase_id, purchase_line_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,0,?,'in_service',?,?,?,?)`,
          [assetId, l.descr.trim(), l.category!, prop, unitId, (l.room ?? '').trim(), p.date, cost,
           l.lifeMonths ?? defaultLife(l.category!), source, p.id, lineId, now]);
      }
      db.run(`INSERT INTO asset_events (id, asset_id, kind, date, note, created_at) VALUES (?,?,?,?,?,?)`,
        [uid(), assetId, source === 'convert' ? 'convert' : 'cost', p.date, '', now]);
      out.push({ account: l.category!, descr: l.descr.trim(), debit: cost, credit: 0, dims: { assetId, unitId, propertyId: prop } });
    });
  });
  return out;
}

/** أصول الفاتورة · ما أنشأته بنودها وما أثبتت تكلفته */
export const purchaseAssets = (db: DB, purchaseId: string) =>
  db.all<AssetRow>(`SELECT * FROM assets WHERE purchase_id = ? AND deleted_at IS NULL`, [purchaseId]);

export const purchaseLinesOf = (db: DB, purchaseId: string) =>
  db.all<{ id: string; descr: string; qty: number; amount_halalas: number; is_asset: number; asset_category: string | null; life_months: number | null; unit_id: string | null; room: string }>(
    `SELECT id, descr, qty, amount_halalas, is_asset, asset_category, life_months, unit_id, room FROM purchase_lines WHERE purchase_id = ? AND deleted_at IS NULL ORDER BY sort`, [purchaseId]);

/** أصول الفاتورة بلا إهلاك ولا حركة بعد إنشائها · وإلا فالفاتورة مقفلة على التعديل والحذف */
export function requirePurchaseAssetsFree(db: DB, purchaseId: string): void {
  for (const a of purchaseAssets(db, purchaseId)) {
    const moved = db.get(`SELECT 1 FROM asset_events WHERE asset_id = ? AND kind NOT IN ('cost', 'convert')`, [a.id]);
    if (moved || postedAccum(db, a.id) > 0 || a.status === 'disposed' || a.status === 'sold') fail('purchaseLocked');
  }
}

/** قبل تعديل الفاتورة أو حذفها: أصولها التي أنشأتها تُحذف، وما أثبتت تكلفته يعود «بانتظار تكلفة» */
export function clearPurchaseAssets(db: DB, purchaseId: string, stamp: string): void {
  requirePurchaseAssetsFree(db, purchaseId);
  for (const a of purchaseAssets(db, purchaseId)) {
    if (a.source === 'purchase' || a.source === 'convert') db.run(`UPDATE assets SET deleted_at = ? WHERE id = ?`, [stamp, a.id]);
    else db.run(`UPDATE assets SET cost_halalas = NULL, purchase_id = NULL, purchase_line_id = NULL WHERE id = ?`, [a.id]);
  }
  db.run(`UPDATE purchase_lines SET deleted_at = ? WHERE purchase_id = ? AND deleted_at IS NULL`, [stamp, purchaseId]);
}

/** الاستعادة من السلة: ما حُذف مع الفاتورة يعود معها */
export function restorePurchaseAssets(db: DB, purchaseId: string, stamp: string): void {
  db.run(`UPDATE assets SET deleted_at = NULL WHERE purchase_id = ? AND deleted_at = ?`, [purchaseId, stamp]);
  db.run(`UPDATE purchase_lines SET deleted_at = NULL WHERE purchase_id = ? AND deleted_at = ?`, [purchaseId, stamp]);
}

/** فاتورةٌ بتاريخٍ مضى: إهلاك ما فات لأصولها بتاريخ اليوم (السنة الجارية 5600 وما قبلها 3200) */
export function purchaseCatchUp(db: DB, purchaseId: string, today: string, memoKey: 'catchup', what: string): void {
  const lines = purchaseAssets(db, purchaseId).flatMap((a) => catchUpLines(db, a, today));
  if (!lines.length) return;
  postEntry(db, { date: today, memo: t('assets.memo.' + memoKey, { what, lng: 'ar' }), lines, srcType: 'asset_catchup', srcId: purchaseId });
}

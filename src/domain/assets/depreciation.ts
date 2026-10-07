/**
 * إهلاك الأصول بالقسط الثابت (موجز الأصول §٢ و§٣ب، قرار المالك ٢٠٢٦-١٠-٠٤):
 *  - يبدأ من الشهر التالي لتاريخ الشراء، وآخر شهرٍ يأخذ فرق الهللات فيساوي المجموع (التكلفة − المتبقية).
 *  - المستحق حتى تاريخٍ ما يُحسب من الجدول (والشهر الجاري بالأيام)، والمرحَّل من الدفتر · فما يُرحَّل هو
 *    الفرق دائماً، فيصحّح نفسه بعد التحويل والنقل والاستبعاد ولا يتكرر.
 *  - القيمة الدفترية مشتقة من الدفتر: سطور حساب الفئة للأصل ناقص سطور المجمع 1490 له.
 */
import type { DB } from '../../db/adapter';
import { postEntry, type PostedEntry } from '../accounting/post';
import { GENERAL_COST_CENTER } from '../accounting/dimensions';
import { t } from '../../i18n';
import { ACC_ACCUM, ACC_DEPRECIATION, ACC_RETAINED, ENDED, type AssetStatus } from './catalog';

// القيم المخزّنة بالعربية حتى ترحيلة الرموز الثابتة (المرحلة الثالثة من تعدد اللغات)
const POSTED = 'مرحّل'; // i18n-exempt: حالة القيد المخزّنة
const LIVE_CONTRACT = ['سارٍ', 'منتهٍ']; // i18n-exempt: حالات العقد المخزّنة

/* ═══════════ التواريخ بالأشهر ═══════════ */

export const monthIndex = (date: string): number => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
export const monthKey = (mi: number): string => String(Math.floor(mi / 12)) + '-' + String((mi % 12) + 1).padStart(2, '0');
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (mi: number): number => { const y = Math.floor(mi / 12); const m = mi % 12; return m === 1 && leap(y) ? 29 : DAYS[m]; };
export const monthEnd = (mi: number): string => monthKey(mi) + '-' + String(daysInMonth(mi)).padStart(2, '0');
const dayOf = (date: string): number => Number(date.slice(8, 10)) || 1;

/* ═══════════ الجدول ═══════════ */

export interface DepreciableAsset {
  id: string;
  cost_halalas: number | null;
  salvage_halalas: number;
  life_months: number;
  purchase_date: string | null;
}

/** القسط الشهري وقسط الشهر الأخير (يأخذ فرق الهللات) */
export function monthlyAmounts(a: DepreciableAsset): { per: number; last: number; base: number; start: number } | null {
  if (a.cost_halalas == null || !a.purchase_date || a.life_months < 1) return null;
  const base = Number(a.cost_halalas) - Number(a.salvage_halalas || 0);
  if (base <= 0) return null;
  const per = Math.floor(base / a.life_months);
  return { per, last: base - per * (a.life_months - 1), base, start: monthIndex(a.purchase_date) + 1 };
}

/** المستحق المتراكم حتى نهاية يوم «date» · والشهر الجاري بنسبة أيامه */
export function expectedThrough(a: DepreciableAsset, date: string): number {
  const m = monthlyAmounts(a);
  if (!m) return 0;
  const k = monthIndex(date) - m.start;
  if (k < 0) return 0;
  if (k >= a.life_months) return m.base;
  const cur = k === a.life_months - 1 ? m.last : m.per;
  const dim = daysInMonth(monthIndex(date));
  const d = Math.min(dayOf(date), dim);
  const partial = d >= dim ? cur : Math.round((cur * d) / dim);
  return m.per * k + partial;
}

/** الإهلاك سنة بسنة · لشاشة الأصل ومعاينة التحويل */
export function scheduleByYear(a: DepreciableAsset): Array<{ year: number; amount: number }> {
  const m = monthlyAmounts(a);
  if (!m) return [];
  const out = new Map<number, number>();
  for (let k = 0; k < a.life_months; k++) {
    const y = Math.floor((m.start + k) / 12);
    out.set(y, (out.get(y) ?? 0) + (k === a.life_months - 1 ? m.last : m.per));
  }
  return [...out].map(([year, amount]) => ({ year, amount }));
}

/* ═══════════ من الدفتر ═══════════ */

/** المجمع المرحَّل للأصل (دائن 1490 ناقص مدينه) */
export function postedAccum(db: DB, assetId: string): number {
  return Number(db.get<{ v: number }>(
    `SELECT COALESCE(SUM(l.credit_halalas - l.debit_halalas), 0) AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.asset_id = ? AND l.account_code = ? AND e.status = ? AND e.deleted_at IS NULL`, [assetId, ACC_ACCUM, POSTED])?.v ?? 0);
}

/** تكلفة الأصل في الدفتر (مدين حساب فئته ناقص دائنه) */
export function postedCost(db: DB, assetId: string, category: string): number {
  return Number(db.get<{ v: number }>(
    `SELECT COALESCE(SUM(l.debit_halalas - l.credit_halalas), 0) AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.asset_id = ? AND l.account_code = ? AND e.status = ? AND e.deleted_at IS NULL`, [assetId, category, POSTED])?.v ?? 0);
}

export function bookValue(db: DB, a: { id: string; category: string }): { cost: number; accum: number; nbv: number } {
  const cost = postedCost(db, a.id, a.category);
  const accum = postedAccum(db, a.id);
  return { cost, accum, nbv: cost - accum };
}

/** العقد الساري على الوحدة في تاريخ · بُعد العقد في سطر الإهلاك */
export function contractAt(db: DB, unitId: string | null, date: string): string | null {
  if (!unitId) return null;
  return db.get<{ id: string }>(
    `SELECT id FROM contracts WHERE unit_id = ? AND deleted_at IS NULL AND status IN (?, ?) AND start <= ? AND end >= ?
     ORDER BY start DESC LIMIT 1`, [unitId, LIVE_CONTRACT[0], LIVE_CONTRACT[1], date, date])?.id ?? null;
}

export interface AssetLoc { id: string; name: string; category: string; unit_id: string | null; property_id: string | null }
export const assetDims = (db: DB, a: AssetLoc, date: string) => ({
  assetId: a.id, unitId: a.unit_id, propertyId: a.property_id, contractId: contractAt(db, a.unit_id, date), costCenterId: GENERAL_COST_CENTER,
});

/** آخر شهرٍ رُحِّل إهلاكه · فما قبله وما فيه مُقفلٌ على النقل والاستبعاد بتاريخٍ فيه */
export function lastRunMonth(db: DB): number | null {
  const m = db.get<{ m: string | null }>(`SELECT MAX(month) AS m FROM depreciation_runs`)?.m;
  return m ? monthIndex(m + '-01') : null;
}

type FullAsset = AssetLoc & DepreciableAsset & { status: AssetStatus };
const ACTIVE_SQL = `SELECT id, name, category, unit_id, property_id, cost_halalas, salvage_halalas, life_months, purchase_date, status
  FROM assets WHERE deleted_at IS NULL AND cost_halalas IS NOT NULL AND purchase_date IS NOT NULL`;

/**
 * الإهلاك الشهري الآلي حتى آخر شهرٍ انتهى (موجز الأصول §٣ب): قيدٌ واحد لكل شهر بسطرين لكل أصل،
 * ويلحق بالأشهر الفائتة · ويُسجَّل الشهر في depreciation_runs ولو لم يكن فيه إهلاك.
 * يعيد عدد القيود المرحّلة.
 */
export function runDepreciation(db: DB, today: string): number {
  const assets = db.all<FullAsset>(ACTIVE_SQL).filter((a) => !ENDED.includes(a.status));
  const starts = assets.map((a) => monthlyAmounts(a)?.start).filter((x): x is number => x != null);
  if (!starts.length) return 0;
  const last = lastRunMonth(db);
  const from = last != null ? last + 1 : Math.min(...starts);
  const to = monthIndex(today) - 1;
  if (from > to) return 0;
  let posted = 0;
  db.transaction(() => {
    const acc = new Map(assets.map((a) => [a.id, postedAccum(db, a.id)]));
    for (let mi = from; mi <= to; mi++) {
      const key = monthKey(mi);
      if (db.get(`SELECT 1 FROM depreciation_runs WHERE month = ?`, [key])) continue;
      const end = monthEnd(mi);
      const lines = [];
      for (const a of assets) {
        const amt = expectedThrough(a, end) - (acc.get(a.id) ?? 0);
        if (amt <= 0) continue;
        acc.set(a.id, (acc.get(a.id) ?? 0) + amt);
        const dims = assetDims(db, a, end);
        lines.push({ account: ACC_DEPRECIATION, descr: a.name, debit: amt, credit: 0, dims },
          { account: ACC_ACCUM, descr: a.name, debit: 0, credit: amt, dims });
      }
      let entry: PostedEntry | null = null;
      if (lines.length) {
        entry = postEntry(db, { date: end, memo: t('assets.memo.depreciation', { month: key, lng: 'ar' }), lines, srcType: 'depreciation', srcId: key });
        posted++;
      }
      db.run(`INSERT INTO depreciation_runs (month, entry_id, created_at) VALUES (?,?,?)`, [key, entry?.id ?? null, new Date().toISOString()]);
    }
  });
  return posted;
}

/** إهلاك أصلٍ واحد حتى تاريخ (قبل نقله أو استبعاده أو بيعه) بأبعاده الحالية · يعيد المبلغ */
export function depreciateAssetTo(db: DB, a: FullAsset, date: string, srcId: string): number {
  const amt = expectedThrough(a, date) - postedAccum(db, a.id);
  if (amt <= 0) return 0;
  const dims = assetDims(db, a, date);
  postEntry(db, {
    date, memo: t('assets.memo.partial', { name: a.name, date, lng: 'ar' }),
    lines: [
      { account: ACC_DEPRECIATION, descr: a.name, debit: amt, credit: 0, dims },
      { account: ACC_ACCUM, descr: a.name, debit: 0, credit: amt, dims },
    ],
    srcType: 'asset_dep', srcId,
  });
  return amt;
}

/**
 * إهلاك ما فات لأصلٍ أُثبتت تكلفته متأخراً (تحويل فاتورة قديمة أو تكلفة قطعة قائمة · موجز الأصول §٥):
 * حتى نهاية آخر شهرٍ انتهى، بتاريخ اليوم · ما يقع في السنة الجارية على 5600، وما قبلها على 3200.
 */
export function catchUpLines(db: DB, a: FullAsset, today: string): Array<{ account: string; descr: string; debit: number; credit: number; dims: ReturnType<typeof assetDims> }> {
  const through = monthEnd(monthIndex(today) - 1);
  const already = postedAccum(db, a.id);
  const total = expectedThrough(a, through) - already;
  if (total <= 0) return [];
  const prevYearEnd = String(Number(today.slice(0, 4)) - 1) + '-12-31';
  const prior = Math.min(total, Math.max(0, expectedThrough(a, prevYearEnd) - already));
  const current = total - prior;
  const dims = assetDims(db, a, today);
  return [
    ...(current ? [{ account: ACC_DEPRECIATION, descr: a.name, debit: current, credit: 0, dims }] : []),
    ...(prior ? [{ account: ACC_RETAINED, descr: a.name, debit: prior, credit: 0, dims }] : []),
    { account: ACC_ACCUM, descr: a.name, debit: 0, credit: total, dims },
  ];
}

/** أشهرٌ رُحِّل إهلاكها أكثر من مرة (جهازان رحّلا الشهر نفسه) · تظهر في مراجعة الدفتر */
export function duplicateDepreciation(db: DB): Array<{ month: string; entries: Array<{ id: string; no: string }> }> {
  const rows = db.all<{ src_id: string; id: string; no: string }>(
    `SELECT src_id, id, no FROM journal_entries WHERE src_type = 'depreciation' AND status = ? AND deleted_at IS NULL AND reversed_by IS NULL
     ORDER BY src_id, created_at`, [POSTED]);
  const by = new Map<string, Array<{ id: string; no: string }>>();
  for (const r of rows) by.set(r.src_id, [...(by.get(r.src_id) ?? []), { id: r.id, no: r.no }]);
  return [...by].filter(([, es]) => es.length > 1).map(([month, entries]) => ({ month, entries }));
}

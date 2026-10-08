/**
 * الإقرار الضريبي المقدَّم وتاريخ قيد التصحيح (قرارا المالك 2026-10-07):
 *  - #30: «إقرار الفترة المقدَّمة يُجمَّد» · يُسجَّل الإقرار مقدَّماً بلقطة بنوده، فيُعرض كما قُدِّم ولو تغيّرت
 *    مستندات فترته بعده، ويظهر ما تغيّر ليُصحَّح في إقرار فترةٍ لاحقة.
 *  - #29: «تاريخ قيد التصحيح: التاريخ الأصلي، إلا إن قُدِّم إقرار فترته فتاريخ اليوم.»
 */
import type { DB } from '../db/adapter';
import { today } from './dates';
import { logAudit } from './audit';
import { t } from '../i18n';
import { quarterRange, vatReturnData, type VatItem, type VatReturnData } from './vatReturn';

export type Quarter = 1 | 2 | 3 | 4;

/** ربع التاريخ بصيغة معرّف الإقرار · «2026-Q1» */
export function quarterId(date: string): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(date ?? '');
  if (!m) return null;
  return `${m[1]}-Q${Math.floor((Number(m[2]) - 1) / 3) + 1}`;
}

const hasTable = (db: DB): boolean =>
  !!db.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vat_filings'`);

/** هل قُدِّم إقرار الربع الذي فيه هذا التاريخ */
export function isFiledDate(db: DB, date: string): boolean {
  const q = quarterId(date);
  if (!q || !hasTable(db)) return false;
  return !!db.get(`SELECT 1 FROM vat_filings WHERE id = ? AND deleted_at IS NULL`, [q]);
}

/**
 * تاريخ قيد التصحيح (العكس وإعادة الترحيل) لقيدٍ أصله بتاريخ `original`: تاريخه الأصلي فيبقى أثره في فترته، ولا
 * يظهر إيرادٌ سالب في فترة وزائد في أخرى · إلا إن قُدِّم إقرار فترته فاليوم (قرار المالك على #29)
 */
export function correctionDate(db: DB, original: string | null | undefined): string {
  if (!original || !/^\d{4}-\d{2}-\d{2}/.test(original)) return today();
  return isFiledDate(db, original) ? today() : original.slice(0, 10);
}

export interface FiledReturn {
  id: string;
  filedAt: string;
  items: VatItem[];
  excluded: VatReturnData['excluded'];
}

/** الإقرار المقدَّم للربع كما قُدِّم · null إن لم يُقدَّم */
export function filedReturn(db: DB, year: number, quarter: Quarter): FiledReturn | null {
  if (!hasTable(db)) return null;
  const r = db.get<{ id: string; filed_at: string; snapshot: string }>(
    `SELECT id, filed_at, snapshot FROM vat_filings WHERE id = ? AND deleted_at IS NULL`, [`${year}-Q${quarter}`]);
  if (!r) return null;
  let snap: { items?: VatItem[]; excluded?: VatReturnData['excluded'] } = {};
  try { snap = JSON.parse(r.snapshot || '{}'); } catch { snap = {}; }
  return {
    id: r.id, filedAt: r.filed_at, items: snap.items ?? [],
    excluded: snap.excluded ?? { count: 0, amountHalalas: 0, taxWithinHalalas: 0 },
  };
}

/** تسجيل إقرار الربع مقدَّماً بتاريخ تقديمه · لقطة بنوده كما هي الآن */
export function fileVatReturn(db: DB, year: number, quarter: Quarter, filedAt: string = today()): void {
  const id = `${year}-Q${quarter}`;
  if (filedReturn(db, year, quarter)) throw new Error(t('vat.alreadyFiled'));
  const data = vatReturnData(db, year, quarter);
  const { from, to } = quarterRange(year, quarter);
  const items = JSON.stringify({ items: data.items, excluded: data.excluded });
  db.transaction(() => {
    // صفٌّ أُلغي تسجيله من قبل يعود بلقطةٍ جديدة · المعرّف للربع واحد
    if (db.get(`SELECT 1 FROM vat_filings WHERE id = ?`, [id])) {
      db.run(`UPDATE vat_filings SET filed_at = ?, snapshot = ?, deleted_at = NULL WHERE id = ?`, [filedAt, items, id]);
    } else {
      db.run(`INSERT INTO vat_filings (id, period_from, period_to, filed_at, snapshot, created_at) VALUES (?,?,?,?,?,?)`,
        [id, from, to, filedAt, items, new Date().toISOString()]);
    }
    logAudit(db, t('vat.auditSection', { lng: 'ar' }), 'create', t('vat.auditFiled', { lng: 'ar' }), id);
  });
}

/** التراجع عن تسجيل التقديم (سُجّل خطأً) · الإقرار يعود يُحسب من مستنداته */
export function unfileVatReturn(db: DB, year: number, quarter: Quarter): void {
  const id = `${year}-Q${quarter}`;
  db.transaction(() => {
    db.run(`UPDATE vat_filings SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, [new Date().toISOString(), id]);
    logAudit(db, t('vat.auditSection', { lng: 'ar' }), 'delete', t('vat.auditUnfiled', { lng: 'ar' }), id);
  });
}

export interface FiledDiff { no: string; label: string; filed: number; now: number; filedTax: number; nowTax: number }

/** ما تغيّر في بنود الإقرار المقدَّم منذ تقديمه · يُصحَّح في إقرار فترةٍ لاحقة (البند ١٤) */
export function filedDiff(db: DB, year: number, quarter: Quarter): FiledDiff[] {
  const f = filedReturn(db, year, quarter);
  if (!f) return [];
  const out: FiledDiff[] = [];
  for (const it of vatReturnData(db, year, quarter).items) {
    if (it.manual) continue;
    const was = f.items.find((x) => x.no === it.no);
    const filed = Number(was?.amountHalalas ?? 0), filedTax = Number(was?.taxHalalas ?? 0);
    if (filed !== it.amountHalalas || filedTax !== it.taxHalalas) {
      out.push({ no: it.no, label: it.label, filed, now: it.amountHalalas, filedTax, nowTax: it.taxHalalas });
    }
  }
  return out;
}

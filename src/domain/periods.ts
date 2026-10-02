/**
 * الفترات تُشتقّ من البيانات لا تُكتب في الكود: لا تُعرض سنة ولا ربع إلا وفيه مستندات.
 * المصدر: تواريخ المشتريات والفواتير والقيود المرحّلة (غير المحذوفة جميعاً).
 * فأول مستند بتاريخ ٢٠٢٨ يُظهر سنته وحده، وحذف مستندات ربع يُخفي زرّه.
 */
import type { DB } from '../db/adapter';

export interface YearWithData { year: number; count: number }
export interface QuarterWithData { q: 1 | 2 | 3 | 4; count: number }

export const QUARTER_AR: Record<1 | 2 | 3 | 4, string> = {
  1: 'الأول', 2: 'الثاني', 3: 'الثالث', 4: 'الرابع',
};

/** اتحاد تواريخ المستندات الثلاثة · يُستعمل داخل الاستعلامين */
const DOC_DATES = `
  SELECT date FROM purchases WHERE deleted_at IS NULL
  UNION ALL
  SELECT issue AS date FROM invoices WHERE deleted_at IS NULL
  UNION ALL
  SELECT date FROM journal_entries WHERE deleted_at IS NULL AND status = 'مرحّل'`;

/** السنوات التي فيها مستندات فعلاً · الأحدث أولاً · مع عدد مستندات كل سنة */
export function dataYears(db: DB): YearWithData[] {
  return db.all<{ y: string; n: number }>(
    `SELECT strftime('%Y', date) AS y, COUNT(*) AS n FROM (${DOC_DATES})
     WHERE date IS NOT NULL AND date != '' GROUP BY y ORDER BY y DESC`
  ).map((r) => ({ year: Number(r.y), count: Number(r.n) })).filter((r) => Number.isFinite(r.year) && r.year > 0);
}

/** أرباع سنة بعينها التي فيها مستندات · بترتيبها · مع عدد مستندات كل ربع */
export function dataQuarters(db: DB, year: number): QuarterWithData[] {
  return db.all<{ q: number; n: number }>(
    `SELECT CAST((CAST(strftime('%m', date) AS INTEGER) + 2) / 3 AS INTEGER) AS q, COUNT(*) AS n
     FROM (${DOC_DATES})
     WHERE strftime('%Y', date) = ? GROUP BY q ORDER BY q`, [String(year).padStart(4, '0')]
  ).map((r) => ({ q: Number(r.q) as 1 | 2 | 3 | 4, count: Number(r.n) }))
    .filter((r) => r.q >= 1 && r.q <= 4);
}

/**
 * الاختيار الافتراضي عند فتح الشاشة: السنة والربع الحاليان إن كان فيهما بيانات،
 * وإلا أحدث سنة فيها بيانات وآخر ربع فيه بيانات منها · وإن لم توجد بيانات إطلاقاً فلا شيء.
 */
export function defaultPeriod(db: DB, todayISO: string): { year: number; q: 1 | 2 | 3 | 4 } | null {
  const years = dataYears(db);
  if (!years.length) return null;
  const nowYear = Number(todayISO.slice(0, 4));
  const nowQ = (Math.floor((Number(todayISO.slice(5, 7)) - 1) / 3) + 1) as 1 | 2 | 3 | 4;
  const year = years.some((y) => y.year === nowYear) ? nowYear : years[0].year;
  const qs = dataQuarters(db, year);
  if (!qs.length) return null;
  const q = year === nowYear && qs.some((x) => x.q === nowQ) ? nowQ : qs[qs.length - 1].q;
  return { year, q };
}

/** حدا الربع للاستعلامات: من أول يومه إلى آخر يومه */
export function quarterRange(year: number, q: 1 | 2 | 3 | 4): { from: string; to: string } {
  const mFrom = (q - 1) * 3 + 1;
  const lastDay = new Date(year, q * 3, 0).getDate();
  const p = (n: number) => String(n).padStart(2, '0');
  return { from: `${year}-${p(mFrom)}-01`, to: `${year}-${p(q * 3)}-${p(lastDay)}` };
}

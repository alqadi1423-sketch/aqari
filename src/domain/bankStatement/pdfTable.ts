/**
 * جدول كشف PDF من قطع نصه بمواضعها (miniPdfText.extractPdfPages): القطع صفوفٌ بموضعها العمودي، وأعمدة الجدول بمواضع عناوينه في صف
 * العناوين (قاموس الأدوار في columns.ts) · فكل قطعةٍ في عمود أقرب عنوانٍ إليها، والكشف العربي بأعمدته من اليمين أو الإنجليزي من
 * اليسار سواء · والصفوف قبل صف العناوين (الرأس والملخص) خلاياها قطعها بترتيبها كما تُقرأ.
 */
import type { TextItem } from '../pdf/miniPdfText';
import { headerRoles } from './columns';
import { cellText } from './normalize';

interface Row { y: number; items: TextItem[] }

function rowsOf(items: TextItem[]): Row[] {
  const sorted = items.filter((i) => cellText(i.str) !== '').sort((a, b) => b.y - a.y);
  const rows: Row[] = [];
  for (const it of sorted) {
    const tol = Math.max(2, (it.size || 10) * 0.5);
    const r = rows.find((x) => Math.abs(x.y - it.y) <= tol);
    if (r) r.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  return rows;
}

/** موضع وسط القطعة تقريباً (عرض الحرف نحو نصف حجم الخط) */
const centre = (i: TextItem) => (i.x ?? 0) + (cellText(i.str).length * (i.size || 10) * 0.25);

export function gridFromPdfItems(pages: TextItem[][]): string[][] {
  const grid: string[][] = [];
  let cols: number[] | null = null;
  for (const page of pages) {
    const rows = rowsOf(page);
    // صف العناوين: أكثر الصفوف أدواراً (ثلاثة فأكثر وفيها تاريخ)
    let header: Row | null = null;
    let best = 0;
    for (const r of rows) {
      if (r.items.some((i) => i.x == null)) continue;
      const roles = headerRoles(r.items.map((i) => i.str));
      const n = new Set(roles.filter(Boolean)).size;
      if (n >= 3 && roles.includes('date') && n > best) { best = n; header = r; }
    }
    if (header) cols = [...header.items].sort((a, b) => (a.x ?? 0) - (b.x ?? 0)).map(centre);
    for (const r of rows) {
      const its = [...r.items].sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
      const before = header ? r.y > header.y + 0.5 : !cols;
      if (!cols || before || its.some((i) => i.x == null)) {
        // ترتيب القراءة: العربي من اليمين
        const arabic = its.some((i) => /[؀-ۿ]/.test(i.str));
        grid.push((arabic ? its.reverse() : its).map((i) => cellText(i.str)));
        continue;
      }
      const cells = cols.map(() => '');
      for (const it of its) {
        const c = centre(it);
        let k = 0;
        for (let j = 1; j < cols.length; j++) if (Math.abs(cols[j] - c) < Math.abs(cols[k] - c)) k = j;
        cells[k] = cells[k] ? cells[k] + ' ' + cellText(it.str) : cellText(it.str);
      }
      grid.push(cells);
    }
  }
  return grid;
}

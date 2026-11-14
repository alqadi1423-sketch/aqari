/**
 * كشف البنك (التوجيه الرابع ٦ · ٢): تطبيع المبالغ والتواريخ كما تطبعها البنوك السعودية (docs/التقارير/دراسة-كشف-البنك-2026-11-07.md):
 * الأرقام العربية الهندية والفارسية، وفاصلا الآلاف والكسور العربيان، والفاصل العشري «ﺭ» (خط ساب)، ولاحقة العملة، والإشارة بالسالب
 * أو بالأقواس أو بـCR وDR · والتاريخ بأشكاله، والهجري لا يُقرأ ميلادياً، وما بلا سنةٍ من فترة الكشف.
 */
import { latinDigits, stripInvisible } from '../zatcaQr';

/** نصّ خلية: بلا ما لا يُرى، وبأرقامٍ لاتينية، وبمسافاتٍ موحّدة */
export const cellText = (v: unknown): string => latinDigits(stripInvisible(String(v ?? ''))).replace(/\s+/g, ' ').trim();

const CURRENCY = /(SAR|S\.R\.?|SR|ر\.?\s?س\.?|ريال(?:\s*سعودي)?)/gi;

/** مبلغٌ موقَّع بالهللة، أو null لما ليس مبلغاً */
export function parseStatementAmount(raw: unknown): number | null {
  let t = cellText(raw).replace(/٬/g, ',').replace(/٫/g, '.')
    // الفاصل العشري في خط ساب يُرسم حرفاً (ﺭ) بين رقمين
    .replace(/(\d)\s*[ﺭﺮ]\s*(\d)/g, '$1.$2')
    .replace(CURRENCY, ' ').trim();
  if (!t) return null;
  let sign = 1;
  // ‏CR وDR قبل المبلغ أو بعده (دائنٌ موجب، ومدينٌ سالب)، ومفصولةً أو ملتصقةً به («500.00CR» · المدقق الخارجي D٢-٩)
  const dr = /(^|[^A-Za-z])[Dd][Rr]\.?$|^[Dd][Rr]\b/.test(t);
  const cr = /(^|[^A-Za-z])[Cc][Rr]\.?$|^[Cc][Rr]\b/.test(t);
  if (dr || cr) {
    t = t.replace(/^[CcDd][Rr]\b\.?|[CcDd][Rr]\.?$/g, '').trim();
    if (dr) sign = -1;
  }
  if (/^\(.*\)$/.test(t)) { sign = -sign; t = t.slice(1, -1).trim(); }
  if (/^[-−]/.test(t)) { sign = -sign; t = t.slice(1).trim(); } else if (/[-−]$/.test(t)) { sign = -sign; t = t.slice(0, -1).trim(); }
  if (/^\+/.test(t)) t = t.slice(1).trim();
  t = t.replace(/\s/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) t = t.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  const v = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(v) ? (v === 0 ? 0 : sign * v) : null;
}

/** المبلغ وحده بلا إشارةٍ صريحة؟ (للمبلغ الواحد الذي تحدّد إشارته الأرصدة) */
export function amountHasSign(raw: unknown): boolean {
  const t = cellText(raw).replace(CURRENCY, ' ').trim();
  return /^[-−(+]|[-−)]$|\b(CR|DR|Cr|Dr|cr|dr)\b|\d(CR|DR|Cr|Dr|cr|dr)\.?$/.test(t);
}

export type DateOrder = 'dmy' | 'mdy';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const realDay = (y: number, m: number, d: number): boolean => {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= days;
};
const iso = (y: number, m: number, d: number): string | null =>
  (realDay(y, m, d) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);

/** تسلسل إكسل (أيامٌ منذ 1899-12-30) إلى تاريخ · بحساب التقويم لا بلحظةٍ في منطقةٍ زمنية */
export function excelSerialDate(n: number): string | null {
  if (!Number.isInteger(n) || n < 20000 || n > 80000) return null;
  // أيامٌ منذ 1970-01-01 إلى سنةٍ وشهرٍ ويوم (خوارزمية civil_from_days)
  const z = n - 25569 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return iso(yoe + era * 400 + (m <= 2 ? 1 : 0), m, d);
}

/** تاريخٌ ميلادي YYYY-MM-DD أو null (والهجري null: سنته قبل 1990) */
export function parseStatementDate(raw: unknown, ctx: { order?: DateOrder; year?: number; excelSerial?: boolean } = {}): string | null {
  let t = cellText(raw);
  if (!t) return null;
  // والتسلسل بكسر الوقت (46300.4375) يومه جزؤه الصحيح (المدقق الخارجي V٩)
  if (ctx.excelSerial && /^\d{5}(\.\d+)?$/.test(t)) return excelSerialDate(Math.floor(Number(t)));
  // ووقتٌ بعد التاريخ يُهمل
  t = t.replace(/[ T]\d{1,2}:\d{2}(:\d{2})?(\s?[AaPp][Mm])?$/, '').trim();
  const order = ctx.order ?? 'dmy';
  let m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(t);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(t);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const [a, b] = [Number(m[1]), Number(m[2])];
    return order === 'dmy' ? iso(y, b, a) : iso(y, a, b);
  }
  m = /^(\d{1,2})[\s\-/]([A-Za-z]{3,9})[\s\-/,]*(\d{2}|\d{4})$/.exec(t);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3)];
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return mo ? iso(y, mo, Number(m[1])) : null;
  }
  m = /^(\d{1,2})[/\-.](\d{1,2})$/.exec(t);
  if (m && ctx.year) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return order === 'dmy' ? iso(ctx.year, b, a) : iso(ctx.year, a, b);
  }
  return null;
}

/** نصٌّ للمقارنة: بلا ما لا يُرى، وبحروفٍ صغيرة، وبلا ترقيم */
export const foldText = (v: unknown): string => cellText(v).toLowerCase()
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي') // i18n-exempt: تطبيع حروفٍ للمقارنة لا نص
  .replace(/[ً-ْـ]/g, '')
  .replace(/[.,:;()[\]{}|/\\"'`_*#-]+/g, ' ').replace(/\s+/g, ' ').trim();

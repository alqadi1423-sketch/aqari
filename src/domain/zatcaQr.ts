/**
 * قراءة QR الفاتورة الضريبية (التوجيه الرابع ٦ · ١ · «قراءة فاتورة الشراء بـQR أولاً»): حمولة الرمز في فواتير المملكة Base64 لسلسلة TLV
 * كما تشترطها هيئة الزكاة والضريبة والجمارك · وسمٌ بايتٌ واحد، ثم طولٌ بايتٌ واحد، ثم القيمة UTF-8:
 *   ١ اسم البائع · ٢ رقمه الضريبي · ٣ وقت إصدار الفاتورة · ٤ الإجمالي شاملاً الضريبة · ٥ مبلغ الضريبة
 * والمرحلة الثانية (الربط) تزيد ٦ إلى ٩: بصمة الفاتورة وتوقيعها والمفتاح العام وتوقيع الشهادة · تُتخطّى ويُعلَم بها.
 *
 * دالةٌ خالصة بلا وحدات جهاز (ولا atob ولا TextDecoder، فقد لا يحملهما المحرّك): تُفكّ Base64 وUTF-8 هنا · والنتيجة مسودةٌ للمستخدم
 * يراجعها قبل الحفظ، والتنبيهات لا تمنع القراءة.
 */

export interface ZatcaQr {
  sellerName: string;
  vatNo: string;
  /** كما في الرمز (ISO 8601 بتوقيته أو بلا توقيت) */
  issuedAt: string;
  totalHalalas: number;
  vatHalalas: number;
  /** الإجمالي ناقص الضريبة */
  subtotalHalalas: number;
  /** ١ للخمسة وحدها، و٢ إن حمل وسوم الربط */
  phase: 1 | 2;
  /** بصمة الفاتورة في المرحلة الثانية (الوسم ٦) · تميّز الفاتورة يقيناً فيُبنى منها مفتاحها (المدقق الخارجي R٤) */
  invoiceHash: string | null;
  /**
   * ما يستحق المراجعة ولا يمنع: vatNo رقمٌ ليس بصيغة الهيئة (١٥ رقماً يبدأ وينتهي بـ٣) · issuedAt وقتٌ لا يُقرأ ·
   * vatOverTotal ضريبةٌ فوق الإجمالي · rate ضريبةٌ لا تقارب ١٥٪ من الصافي (فاتورةٌ فيها معفى أو صفري، أو خطأ)
   */
  warnings: Array<'vatNo' | 'issuedAt' | 'vatOverTotal' | 'rate'>;
}

export type ZatcaQrResult = { ok: true; qr: ZatcaQr } | { ok: false; error: 'empty' | 'url' | 'format' | 'missing' };

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 (والصيغة الآمنة للروابط) إلى بايتات · null لما ليس Base64 */
function fromBase64(s: string): Uint8Array | null {
  const clean = s.replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  const body = clean.replace(/=+$/, '');
  if (body.length % 4 === 1) return null;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of body) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 إلى نص · null لتسلسلٍ لا يصح */
function utf8(b: Uint8Array): string | null {
  let s = '';
  for (let i = 0; i < b.length;) {
    const c = b[i];
    let cp: number;
    let n: number;
    if (c < 0x80) { cp = c; n = 1; }
    else if (c >= 0xc2 && c < 0xe0) { cp = c & 0x1f; n = 2; }
    else if (c >= 0xe0 && c < 0xf0) { cp = c & 0x0f; n = 3; }
    else if (c >= 0xf0 && c < 0xf5) { cp = c & 0x07; n = 4; }
    else return null;
    if (i + n > b.length) return null;
    for (let k = 1; k < n; k++) {
      const x = b[i + k];
      if ((x & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (x & 0x3f);
    }
    // ولا محرفاً فوق U+10FFFF ولا نصف زوجٍ بديل ولا ترميزاً أطول من حاجته (المدقق الخارجي L٥: كان يرمي فتسقط قراءة الصورة كلها)
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || (n === 3 && cp < 0x800) || (n === 4 && cp < 0x10000)) return null;
    s += String.fromCodePoint(cp);
    i += n;
  }
  return s;
}

/** الأرقام العربية الهندية والفارسية إلى لاتينية (المدقق الخارجي J٤: «١١٥٠٫٠٠» كانت تُرفض والتطبيق نفسه يقرؤها) */
const latinDigits = (v: string) => v.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));

/**
 * مبلغٌ نصّي إلى هللات · null لما لا يُقرأ: «1150» و«1150.00» و«1,150.00» (فاصل الآلاف لثلاث خاناتٍ وحدها) و«115,00» (فاصلةٌ عشرية
 * قبل خانةٍ أو خانتين · المدقق الخارجي J٣: كانت تُحذف كأنها فاصل آلاف فتُقرأ مئة ضعف) · وفاصلا الآلاف والكسور العربيان (U+066C وU+066B)
 */
function halalasOf(v: string): number | null {
  let t = latinDigits(v.trim()).replace(/\s/g, '').replace(/\u066C/g, ',').replace(/\u066B/g, '.');
  if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) t = t.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

const VAT_NO = /^3\d{13}3$/;
/**
 * ما لا يُرى في نصوص الرمز: علامات الاتجاه (ALM U+061C وLRM وRLM والتضمين والعزل) والمحارف الصفرية (U+200B–U+200D وضامّ الكلمات
 * وBOM والواصلة اللينة) · تُزال من الوسوم كلها قبل قراءتها (المدقق الخارجي P٣–P٥: حول الرقم كانت تجعله «ليس بصيغة الهيئة»، وحول
 * الوقت «لا يُقرأ» فلا مفتاح يرفض المكررة، واسمٌ منها وحدها كان يُقترح مورداً بلا اسمٍ مرئي)
 */
const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
export const stripInvisible = (v: string) => v.replace(INVISIBLE, '');
// والفاصل بين التاريخ والوقت حرف T أو مسافة (RFC 3339 يجيزها · المدقق الخارجي J١٣)
export { latinDigits };

/**
 * وقت الإصدار كما في الرمز: اليوم المكتوب، والوقت بالدقيقة أو بالثانية (أو null لتاريخٍ وحده)، ومنطقته إن كُتبت، ولحظته (بمنطقته، أو
 * بتوقيت المملكة +03:00 إن لم تُكتب) · null لما لا يُقرأ يوماً من التقويم بين 1990 و2100 · ويُقبل: T أو مسافة بين التاريخ والوقت،
 * والمنطقة «Z» أو «+03:00» أو «+0300» أو «+03» (بعد مسافةٍ أيضاً)، و« UTC» و« GMT» (Ruby وGo)، و«[UTC]» بعدها (Java) · المدقق
 * الخارجي J١٣ وL١ وR٧ وT٥ وT٩ (والساعة 24 لا تُقرأ)
 */
export interface IssuedTime { day: string; time: string | null; seconds: boolean; zone: number | null; instant: number | null; midnight: boolean }
const realDayYMD = (y: number, mo: number, d: number): boolean => {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= (days ?? 0);
};
export function parseIssued(raw: string): IssuedTime | null {
  let t = latinDigits(stripInvisible(String(raw ?? ''))).trim();
  t = t.replace(/\[[^\]]*\]$/, '').trim()
    .replace(/\s*([+-]\d{2}(?::?\d{2})?)\s+(UTC|GMT)$/i, '$1')
    .replace(/\s*(UTC|GMT)$/i, 'Z');
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/.exec(t);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!realDayYMD(y, mo, d)) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined) return { day, time: null, seconds: false, zone: null, instant: null, midnight: false };
  const [hh, mi, ss] = [Number(m[4]), Number(m[5]), m[6] === undefined ? 0 : Number(m[6])];
  if (hh > 23 || mi > 59 || ss > 59) return null;
  let zone: number | null = null;
  if (m[8] === 'Z') zone = 0;
  else if (m[8]) {
    const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(m[8])!;
    if (Number(z[2]) > 14 || Number(z[3] ?? 0) > 59) return null;
    zone = (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3] ?? 0));
  }
  const frac = m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0;
  const instant = Date.UTC(y, mo - 1, d, hh, mi, ss) + frac - (zone ?? 180) * 60000;
  // منتصف الليل المحشوّ: «00:00:00» كما كُتب، أو لحظةٌ هي منتصف ليل المملكة (T٤: «…T21:00:00Z» لليوم السابق)
  const midnight = (hh === 0 && mi === 0 && ss === 0 && frac === 0) || (zone !== null && (instant + 3 * 3600000) % 86400000 === 0);
  return { day, time: m[6] === undefined ? `${m[4]}:${m[5]}` : `${m[4]}:${m[5]}:${m[6]}`, seconds: m[6] !== undefined, zone, instant, midnight };
}
/** وقتٌ مقروء بالدقيقة أو بالثانية في يومٍ من التقويم · لا تاريخٌ وحده ولا نصٌّ لا يُقرأ */
export const readableTime = (iso: string) => parseIssued(iso)?.time != null;
/** المنطقة مكتوبةٌ في الوقت */
export const hasZone = (iso: string) => parseIssued(iso)?.zone != null;

/** يومٌ بتوقيت المملكة (+03:00 بلا توقيتٍ صيفي) للحظة · بحساب التقويم لا بمنطقة الجهاز */
function riyadhDay(ms: number): string {
  const z = Math.floor((ms + 3 * 3600000) / 86400000) + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/**
 * يوم الفاتورة: اليوم المكتوب لتاريخٍ وحده أو لمنتصف ليلٍ محشوٍّ كما كُتب، وبتوقيت المملكة للوقت ذي المنطقة (المدقق الخارجي R٦: لا بمنطقة
 * الهاتف · وT٤ب: «T00:00:00+04:00» تاريخٌ وحده يومه المكتوب) · null لما لا يُقرأ
 */
export function issueDayOf(p: IssuedTime | null): string | null {
  if (!p) return null;
  if (p.instant === null || p.zone === null) return p.day;
  if (p.time === '00:00:00' || p.time === '00:00') return p.day;
  return riyadhDay(p.instant);
}
export const riyadhDateOf = (iso: string): string | null => issueDayOf(parseIssued(iso));
/** تاريخٌ وحده (بلا وقت) يومه صحيح · لما لا يُقرأ وقته (R٧) */
export const leadingDay = (iso: string): string | null => {
  const p = parseIssued(iso);
  return p && p.time === null ? p.day : null;
};

/** يقرأ حمولة QR الفاتورة · ونتيجته مسودةٌ تُراجع قبل الحفظ */
export function decodeZatcaQr(payload: string): ZatcaQrResult {
  // وما يرمي في الفكّ (حمولةٌ مصنوعة) سببه الصيغة، ولا يُسقط قراءة بقية رموز الصورة (L٥)
  try { return decodeZatcaQrNow(payload); } catch { return { ok: false, error: 'format' }; }
}

function decodeZatcaQrNow(payload: string): ZatcaQrResult {
  const raw = String(payload ?? '').trim();
  if (!raw) return { ok: false, error: 'empty' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return { ok: false, error: 'url' };
  const bytes = fromBase64(raw);
  if (!bytes || bytes.length < 2) return { ok: false, error: 'format' };
  const tags = new Map<number, Uint8Array>();
  for (let i = 0; i < bytes.length;) {
    if (i + 2 > bytes.length) return { ok: false, error: 'format' };
    const tag = bytes[i];
    const len = bytes[i + 1];
    if (tag < 1 || tag > 9 || i + 2 + len > bytes.length) return { ok: false, error: 'format' };
    tags.set(tag, bytes.subarray(i + 2, i + 2 + len));
    i += 2 + len;
  }
  const text = (tag: number): string | null => { const v = tags.get(tag); const s = v ? utf8(v) : null; return s == null ? null : stripInvisible(s); };
  const [seller, vatRaw, issuedAt, totalS, vatS] = [1, 2, 3, 4, 5].map(text);
  // واسم البائع الفارغ ناقصٌ كغيابه (المدقق الخارجي N٣: كان يُقترح موردٌ بلا اسم)، ومنه ما لا يُرى وحده (P٤)
  if (seller == null || !seller.trim() || vatRaw == null || issuedAt == null || totalS == null || vatS == null) return { ok: false, error: 'missing' };
  // وعلامات الاتجاه والمسافات حول رقم البائع لا تُعدّ منه (N٢: كانت تجعله «ليس بصيغة الهيئة» فلا تُعرف بطاقته)
  const vatNo = vatRaw.replace(/\s/g, '');
  const total = halalasOf(totalS);
  const vat = halalasOf(vatS);
  if (total == null || vat == null) return { ok: false, error: 'format' };
  const warnings: ZatcaQr['warnings'] = [];
  if (!VAT_NO.test(latinDigits(vatNo.trim()))) warnings.push('vatNo');
  if (!readableTime(issuedAt)) warnings.push('issuedAt');
  if (vat > total) warnings.push('vatOverTotal');
  // ١٥٪ من الصافي بفارق هللتين للتقريب (الإجمالي والضريبة كلٌّ مقرَّب)
  else if (Math.abs(vat * 115 - total * 15) > 2 * 115) warnings.push('rate');
  return {
    ok: true,
    qr: {
      // والوقت بأرقامٍ عربية هندية يُقرأ كاللاتيني (المدقق الخارجي L٨: كانت مبالغه تُقرأ ووقته لا، فلا مفتاح ولا تاريخ)
      sellerName: seller.trim(), vatNo: latinDigits(vatNo.trim()), issuedAt: latinDigits(issuedAt.trim()),
      totalHalalas: total, vatHalalas: vat, subtotalHalalas: total - vat,
      phase: [6, 7, 8, 9].some((t) => tags.has(t)) ? 2 : 1, warnings,
      invoiceHash: (text(6) ?? '').trim() || null,
    },
  };
}

/** ترتيب أسباب الرفض من الأقرب إلى رمز الهيئة: سلسلةٌ بلا وسومها، ثم ما ليس TLV، ثم رابط، ثم لا شيء */
const CLOSER: Array<Extract<ZatcaQrResult, { ok: false }>['error']> = ['missing', 'format', 'url', 'empty'];

/**
 * صورة الفاتورة قد تحمل أكثر من رمز (رابط المتجر، ورمز الهيئة) · يُختار أول رمزٍ يُقرأ فاتورةً ·
 * وإن لم يُقرأ شيء فالسبب الأقرب إلى رمز الهيئة، وبلا رموزٍ «empty»
 */
export function pickZatcaQr(values: string[]): ZatcaQrResult {
  let best: Extract<ZatcaQrResult, { ok: false }>['error'] = 'empty';
  for (const v of values) {
    const r = decodeZatcaQr(v);
    if (r.ok) return r;
    if (CLOSER.indexOf(r.error) < CLOSER.indexOf(best)) best = r.error;
  }
  return { ok: false, error: best };
}

/**
 * مفتاح الفاتورة من رمزها (الهجرة ٥٤ · «والمكررة تُرفض»): الرقم الضريبي للبائع، ووقت الإصدار، والإجمالي والضريبة بالهللة، وبصمة المرحلة
 * الثانية (الوسم ٦) إن وُجدت · والوقت «T» ثم لحظته بالثانية، أو «D» ثم يومه لما لا يميّز فاتورتين (تاريخٌ وحده، أو دقيقةٌ بلا ثوانٍ، أو
 * منتصف ليلٍ محشوّ) · '' لما لا يُقرأ يومه · والتكرار يُحكم بحقائق المفتاح لا بنصّه (qrKeysExact)، فمفاتيح الإصدارات السابقة تُقرأ أيضاً
 * (المدقق الخارجي T١)
 */
export function zatcaQrKey(qr: ZatcaQr): string {
  const p = parseIssued(qr.issuedAt);
  const day = issueDayOf(p);
  if (!p || !day) return '';
  const time = p.seconds && !p.midnight && p.instant !== null ? 'T' + p.instant : 'D' + day;
  return [latinDigits(qr.vatNo), time, qr.totalHalalas, qr.vatHalalas, ...(qr.invoiceHash ? ['#' + qr.invoiceHash] : [])].join('|');
}

/** حقائق مفتاح الفاتورة · بصيغه كلها: «vat|T<لحظة>|…» و«vat|D<يوم>|…» (هذه)، و«vat|<الوقت كما في الرمز>|…» (e7c151c)، و«vat|#بصمة|…» (7e3b492) */
export interface QrKeyFacts { vat: string; instant: number | null; day: string | null; total: number; tax: number; hash: string | null }
export function qrKeyFacts(key: string): QrKeyFacts | null {
  const parts = String(key ?? '').split('|');
  if (parts.length < 4 || !parts[0]) return null;
  const [vat, time, total, tax] = parts;
  let hash = parts.slice(4).find((x) => x.startsWith('#'))?.slice(1) ?? null;
  let instant: number | null = null;
  let day: string | null = null;
  if (time.startsWith('#')) hash = time.slice(1);
  else if (/^T-?\d+$/.test(time)) { instant = Number(time.slice(1)); day = riyadhDay(instant); }
  else if (/^D\d{4}-\d{2}-\d{2}$/.test(time)) day = time.slice(1);
  else {
    const p = parseIssued(time);
    day = issueDayOf(p);
    if (p && p.seconds && !p.midnight) instant = p.instant;
  }
  if (!Number.isFinite(Number(total)) || !Number.isFinite(Number(tax))) return null;
  return { vat, instant, day, total: Number(total), tax: Number(tax), hash };
}
/**
 * الفاتورة نفسها يقيناً: البائع والإجمالي والضريبة نفسها، وبصمتان مختلفتان فاتورتان، واللحظة نفسها بالثانية، أو البصمة نفسها في اليوم نفسه
 * (أو بلا يومٍ معروف) · ومولّدٌ يكرّر البصمة شهراً بعد شهر فاتورتان (T٦)
 */
export function qrKeysExact(a: QrKeyFacts, b: QrKeyFacts): boolean {
  if (a.vat !== b.vat || a.total !== b.total || a.tax !== b.tax) return false;
  if (a.hash && b.hash && a.hash !== b.hash) return false;
  if (a.instant !== null && b.instant !== null) return a.instant === b.instant;
  if (a.hash && b.hash) return !a.day || !b.day || a.day === b.day;
  return false;
}
/** قد تكون الفاتورة نفسها: البائع والإجمالي والضريبة نفسها في اليوم نفسه، ولا تفرّقهما بصمتان ولا لحظتان مختلفتان */
export function qrKeysAlike(a: QrKeyFacts, b: QrKeyFacts): boolean {
  if (a.vat !== b.vat || a.total !== b.total || a.tax !== b.tax) return false;
  if (a.hash && b.hash && a.hash !== b.hash) return false;
  if (a.instant !== null && b.instant !== null && a.instant !== b.instant) return false;
  return !a.day || !b.day || a.day === b.day;
}

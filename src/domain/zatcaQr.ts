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
// والمنطقة بعد مسافةٍ أيضاً («22:15:00 +0300» · المدقق الخارجي R٧)
const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(\s?(Z|[+-]\d{2}:?\d{2}))?$/;
/** للتحليل: T بين التاريخ والوقت، ولا مسافة قبل المنطقة */
const parseable = (t: string) => t.replace(' ', 'T').replace(/\s+(?=(Z|[+-]\d{2}:?\d{2})$)/, '');
/** الوقت بلا منطقة وقتُ الفاتورة المحلي (ISO 8601) · وبمنطقة يُحوَّل */
export { latinDigits };
export const hasZone = (iso: string) => /(Z|[+-]\d{2}:?\d{2})$/.test(iso.trim());
/** يومٌ في التقويم (المدقق الخارجي L١: «2026-02-30» كان يُقرأ بلا تنبيه، وبمنطقته يصير صامتاً 2 مارس) */
const realDay = (iso: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days;
};
/** وقتٌ مقروء بالدقيقة أو بالثانية في يومٍ من التقويم · لا تاريخٌ وحده ولا نصٌّ لا يُقرأ */
export const readableTime = (iso: string) => {
  const t = latinDigits(iso.trim());
  return ISO_TIME.test(t) && realDay(t) && !Number.isNaN(Date.parse(parseable(t)));
};
/**
 * يوم الفاتورة بتوقيت المملكة (+03:00 بلا توقيتٍ صيفي) للوقت ذي المنطقة · لا بمنطقة الهاتف (المدقق الخارجي R٦: فاتورةٌ صدرت 00:30 بتوقيت
 * المملكة أول أكتوبر كانت تصير 30 سبتمبر على هاتفٍ بتوقيت لندن، فتنتقل إلى ربعٍ آخر) · بحساب التقويم لا بلحظةٍ في منطقة الجهاز
 */
export function riyadhDateOf(iso: string): string | null {
  const ms = Date.parse(parseable(latinDigits(iso.trim())));
  if (Number.isNaN(ms)) return null;
  const z = Math.floor((ms + 3 * 3600000) / 86400000) + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** يومٌ صحيح في أول الوقت (YYYY-MM-DD) ولو لم يُقرأ الوقت كله */
export const leadingDay = (iso: string): string | null => {
  const t = latinDigits(iso.trim()).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) && realDay(t) ? t : null;
};
/** والمفتاح من وقتٍ بالثانية وحده (L٢: الدقيقة وحدها لا تميّز فاتورتين في الدقيقة نفسها بالمبلغ نفسه) */
const secondsTime = (iso: string) => readableTime(iso) && /T?\d{2}:\d{2}:\d{2}/.test(latinDigits(iso.trim()).slice(10));

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
 * مفتاح الفاتورة من رمزها (الهجرة ٥٤ · «والمكررة تُرفض»): الرقم الضريبي للبائع ووقت الإصدار كما في الرمز (بالثانية) والإجمالي
 * والضريبة بالهللة · فاتورتان من البائع نفسه في اليوم نفسه بالمبلغ نفسه مفتاحان ما اختلف وقتهما
 */
export function zatcaQrKey(qr: ZatcaQr): string {
  // وبصمة المرحلة الثانية تميّز الفاتورة يقيناً فهي المفتاح (المدقق الخارجي R٤: فاتورتان في الثانية نفسها بالمبلغ نفسه كانتا مفتاحاً واحداً)
  if (qr.invoiceHash) return [latinDigits(qr.vatNo), '#' + qr.invoiceHash, qr.totalHalalas, qr.vatHalalas].join('|');
  // ووقتٌ لا يُقرأ بالثانية (تاريخٌ وحده أو نصٌّ آخر) لا يميّز فاتورتين في يومٍ واحد بالمبلغ نفسه، فلا مفتاح ولا رفض (المدقق الخارجي J١٣)
  // ومنه منتصف الليل المحشوّ «T00:00:00» (تاريخٌ وحده كما تكتبه أنظمةٌ ورمز فواتير التطبيق نفسه · المدقق الخارجي R١)
  if (!secondsTime(qr.issuedAt) || /[T ]00:00:00(\.0+)?\s?(Z|[+-]\d{2}:?\d{2})?$/.test(latinDigits(qr.issuedAt.trim()))) return '';
  return [latinDigits(qr.vatNo), qr.issuedAt.trim().replace(' ', 'T'), qr.totalHalalas, qr.vatHalalas].join('|');
}

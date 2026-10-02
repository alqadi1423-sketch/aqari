/**
 * أرشيف النسخ الاحتياطي · كتابةً وقراءةً بلا مسحٍ للبايتات.
 *
 * العلّة التي أُغلقت هنا: الكاتب المتدفق في fflate يكتب الترويسة قبل أن يعرف
 * حجم الملف، فيرفع الراية الثالثة ويترك الأحجام صفراً ويكتبها في ذيل خلفها.
 * وحينها لا يستطيع القارئ القفز فوق البيانات بالطول، فيمسحها بايتاً بايتاً
 * باحثاً عن توقيع الملف التالي `50 4B 03 04` · وأي مرفق تحوي بايتاته هذا
 * التوقيع (كل zip وdocx وxlsx وpptx، وأي ثنائي صدفةً، ومجرى الضغط نفسه)
 * يقطع المسح فيُقرأ ما بعده ترويسةً كاذبة بطريقة ضغط مجهولة، فينفجر المُنشئ.
 *
 * والعلاج بنيوي لا احتمالي:
 * ١) الكتابة: كل مدخل حاضر كاملاً في الذاكرة، فحجمه وبصمته معلومان قبل الترويسة
 *    · تُكتب فيها ولا تُرفع الراية الثالثة إطلاقاً.
 * ٢) القراءة: من الفهرس المركزي في ذيل الأرشيف · فيه أحجام كل مدخل وموضعه
 *    · فيُقرأ كل مدخل بطوله ولا يُمسح بايت واحد.
 * والقراءة من الفهرس تصلح للأرشيفات القديمة أيضاً — تلك التي كُتبت بالراية
 * الثالثة — لأن الفهرس المركزي فيها يحمل الأحجام الصحيحة دائماً.
 *
 * والتنفّس باقٍ: الخيط الرئيسي لا يُحتجز كتلة واحدة طويلة، بل يُفسح للواجهة
 * دورة رسم بين المداخل · فلا يقتل أندرويد التطبيق مهما كبر الأرشيف.
 */
import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';

/**
 * يفسح للواجهة دورة رسم بين الأشواط الثقيلة.
 *
 * والعلّة التي أُغلقت هنا: `setTimeout` وحده لا يكفي. قِيس على ١٧٧ مرفقاً أن خيط
 * الجافاسكربت يرقد على حلقة رسائله تسع دقائق بصفر استهلاك معالج، لأن المؤقّت لا
 * يُسلَّم ما دام الخيط خاملاً ولا حدثَ يوقظه · فتقف الحلقة إلى الأبد ويبقى شريط
 * التقدّم على رقمه. وأيقظها حدثٌ خارجي فأُطلقت التنفّسة المعلّقة فوراً — فالمؤقّت
 * لم يضع، بل لم يُسلَّم.
 *
 * فالتنفّسة هنا تسابق مسارَي تسليم مستقلّين ويكفي أسبقهما:
 *  ١) `setTimeout` · تقوده وحدة المؤقّتات، وهي التي تجمّدت في القياس.
 *  ٢) `requestAnimationFrame` · يقوده مُنسّق الرسم من خيط الواجهة، وهو مسارٌ آخر
 *     لا يمرّ بوحدة المؤقّتات. وخيط الواجهة كان يرسم فعلاً أثناء التعليق المقيس
 *     (٩٤٣ نبضة معالج كل خمس ثوانٍ في خيط الرسم)، فالإطار كان يُسلَّم والمؤقّت لا.
 * وما لم يسبق يُلغى فلا تتراكم المؤقّتات ولا الإطارات.
 *
 * ولا ثالث لهما من `setImmediate`: المهام الفورية في React Native تُفرَّغ في شوط
 * واحد يدور حتى يخلو طابورها، فأي ضامن يعيد جدولة نفسه فيها يصير دوراناً محموماً
 * يحجب المؤقّت الذي ينتظره · جُرّب فحوّل نسخةً من ثلاث دقائق إلى ثماني عشرة.
 */
export const yieldUi = (): Promise<void> =>
  new Promise<void>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;

    const fire = (): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) { try { clearTimeout(timer); } catch { /* مضى */ } }
      if (frame !== undefined && typeof cancelAnimationFrame === 'function') {
        try { cancelAnimationFrame(frame); } catch { /* مضى */ }
      }
      resolve();
    };

    timer = setTimeout(fire, 0);
    if (typeof requestAnimationFrame === 'function') {
      try { frame = requestAnimationFrame(fire); } catch { /* غير متاح · يكفي المؤقّت */ }
    }
  });

/**
 * التنفّس على الزمن لا على عدد المداخل · فالمقصود ألا يُحتجز الخيط أكثر من إطار،
 * والعدّ بالمداخل يفرض تنفّسة لكل ثمانية مهما صغرت فيصير التنفّس هو الكلفة:
 * قياسٌ على ٥٠٠٢ مدخل صغير أظهر ١٦ ثانية تنفّساً مقابل ثانية عملاً.
 */
function breather(everyMs = 12) {
  let last = Date.now();
  return async (): Promise<void> => {
    if (Date.now() - last < everyMs) return;
    await yieldUi();
    last = Date.now();
  };
}

/** خطأ بنية أرشيف · ثبت أن الملف نفسه لا يحمل بنية zip سليمة */
export class ZipFormatError extends Error {
  constructor(message: string) { super(message); this.name = 'ZipFormatError'; }
}

/**
 * نصّ فشل الأرشيف · لا يتّهم ملفاً لم يثبت تلفه.
 * فرقٌ لازم: بنيةُ الملف إن ثبت اختلالها تُقال صراحةً، وما عداها خطأ داخلي
 * فالمستخدم لا يُرسَل ليفحص ملفاً سليماً من ستّة أوجه بينما العلّة في الشيفرة.
 */
export function archiveFailureText(e: unknown, badFileText?: string): string {
  const detail = e instanceof Error ? e.message : String(e);
  if (e instanceof ZipFormatError) return (badFileText ? badFileText + ' · ' : 'بنية الملف غير سليمة · ') + detail;
  return 'تعذّر إتمام العملية · خطأ داخلي · ' + detail;
}

/* ─── CRC-32 · جدول قياسي (المعيار يفرضه في كل ترويسة) ─── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ─── قراءة وكتابة أعداد صغيرة الطرف كما يفرض المعيار ─── */
const w16 = (d: Uint8Array, o: number, v: number) => { d[o] = v & 255; d[o + 1] = (v >>> 8) & 255; };
const w32 = (d: Uint8Array, o: number, v: number) => {
  d[o] = v & 255; d[o + 1] = (v >>> 8) & 255; d[o + 2] = (v >>> 16) & 255; d[o + 3] = (v >>> 24) & 255;
};
const r16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);
const r32 = (d: Uint8Array, o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
/** ٦ بايتات تكفي لأي أرشيف حتى ٢٨١ تيرابايت · وتبقى ضمن عدد جافاسكربت الصحيح */
const r48 = (d: Uint8Array, o: number) => r32(d, o) + r16(d, o + 4) * 0x100000000;

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_Z64_LOC = 0x07064b50;
/** الراية ١١: الاسم بترميز UTF-8 · والراية ٣ (واصف البيانات) لا تُرفع هنا أبداً */
const FLAG_UTF8 = 0x0800;

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
  /** 0 = تخزين بلا ضغط (المرفقات مضغوطة أصلاً) · 6 = ضغط (القاعدة والبيان) */
  level: 0 | 6;
}

/** الوقت والتاريخ بصيغة DOS كما يفرض المعيار */
function dosStamp(): { time: number; date: number } {
  const d = new Date();
  const y = d.getFullYear();
  if (y < 1980 || y > 2107) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * بناء أرشيف · الأحجام والبصمات في الترويسة، والفهرس المركزي في الذيل.
 * التنفّس بعد كل مدخل فلا يُحتجز الخيط الرئيسي.
 */
export async function zipYielding(
  entries: ZipEntry[],
  onFile?: (done: number, total: number) => void
): Promise<Uint8Array> {
  if (entries.length > 0xFFFF) {
    throw new ZipFormatError('عدد المداخل يتجاوز ما يسعه الأرشيف (' + entries.length + ')');
  }
  const { time, date } = dosStamp();

  // ١) اضغط ما يُضغط، واحسب بصمة كل مدخل · التنفّس بين المداخل
  interface Prepared { name: Uint8Array; data: Uint8Array; method: number; crc: number; size: number }
  const prepared: Prepared[] = [];
  const breatheA = breather();
  let done = 0;
  for (const e of entries) {
    const data = e.level === 0 ? e.bytes : deflateSync(e.bytes, { level: e.level });
    if (data.length > 0xFFFFFFFF || e.bytes.length > 0xFFFFFFFF) {
      throw new ZipFormatError('مدخل أكبر مما يسعه الأرشيف: ' + e.name);
    }
    prepared.push({
      name: strToU8(e.name), data, method: e.level === 0 ? 0 : 8,
      crc: crc32(e.bytes), size: e.bytes.length,
    });
    done += 1;
    onFile?.(done, entries.length);
    await breatheA();
  }

  // ٢) احسب الحجم الكلي قبل التخصيص · لا لصق ولا إعادة تخصيص
  let body = 0;
  let cd = 0;
  for (const p of prepared) {
    body += 30 + p.name.length + p.data.length;
    cd += 46 + p.name.length;
  }
  const out = new Uint8Array(body + cd + 22);

  // ٣) الترويسات المحلية والبيانات
  let o = 0;
  const offsets: number[] = [];
  const breatheB = breather();
  let wrote = 0;
  for (const p of prepared) {
    offsets.push(o);
    w32(out, o, SIG_LOCAL);
    w16(out, o + 4, 20);            // أدنى إصدار يفكّها
    w16(out, o + 6, FLAG_UTF8);     // ولا راية ثالثة · الأحجام حاضرة تحت
    w16(out, o + 8, p.method);
    w16(out, o + 10, time);
    w16(out, o + 12, date);
    w32(out, o + 14, p.crc);
    w32(out, o + 18, p.data.length);
    w32(out, o + 22, p.size);
    w16(out, o + 26, p.name.length);
    w16(out, o + 28, 0);            // بلا حقول إضافية
    o += 30;
    out.set(p.name, o); o += p.name.length;
    out.set(p.data, o); o += p.data.length;
    wrote += 1;
    await breatheB();
  }

  // ٤) الفهرس المركزي
  const cdStart = o;
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    w32(out, o, SIG_CD);
    w16(out, o + 4, 20);            // أنشأه
    w16(out, o + 6, 20);            // يحتاج
    w16(out, o + 8, FLAG_UTF8);
    w16(out, o + 10, p.method);
    w16(out, o + 12, time);
    w16(out, o + 14, date);
    w32(out, o + 16, p.crc);
    w32(out, o + 20, p.data.length);
    w32(out, o + 24, p.size);
    w16(out, o + 28, p.name.length);
    w16(out, o + 30, 0);            // إضافية
    w16(out, o + 32, 0);            // تعليق
    w16(out, o + 34, 0);            // القرص
    w16(out, o + 36, 0);            // سمات داخلية
    w32(out, o + 38, 0);            // سمات خارجية
    w32(out, o + 42, offsets[i]);
    o += 46;
    out.set(p.name, o); o += p.name.length;
  }

  // ٥) خاتمة الفهرس
  w32(out, o, SIG_EOCD);
  w16(out, o + 4, 0);
  w16(out, o + 6, 0);
  w16(out, o + 8, prepared.length);
  w16(out, o + 10, prepared.length);
  w32(out, o + 12, o - cdStart);
  w32(out, o + 16, cdStart);
  w16(out, o + 20, 0);
  return out;
}

/** موضع خاتمة الفهرس · تُطلب من الذيل لا من الرأس فلا مسح للبيانات */
function findEocd(data: Uint8Array): number {
  const min = Math.max(0, data.length - 0xFFFF - 22);
  for (let i = data.length - 22; i >= min; i--) {
    if (r32(data, i) === SIG_EOCD) return i;
  }
  return -1;
}

/** الحقل الإضافي ZIP64 · يُقرأ فقط حين يُعلن الحقل الأصلي عجزه بـ0xFFFFFFFF */
function zip64Extra(
  data: Uint8Array, at: number, len: number,
  need: { size: boolean; csize: boolean; offset: boolean }
): { size?: number; csize?: number; offset?: number } {
  let p = at;
  const end = at + len;
  while (p + 4 <= end) {
    const id = r16(data, p);
    const sz = r16(data, p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      const res: { size?: number; csize?: number; offset?: number } = {};
      if (need.size) { res.size = r48(data, q); q += 8; }
      if (need.csize) { res.csize = r48(data, q); q += 8; }
      if (need.offset) { res.offset = r48(data, q); q += 8; }
      return res;
    }
    p += 4 + sz;
  }
  return {};
}

/**
 * فكّ أرشيف من فهرسه المركزي · يعيد نفس شكل unzipSync.
 * يقرأ ما كتبه هذا الملف وما كتبه الكاتب المتدفق القديم سواءً بسواء.
 */
export async function unzipYielding(
  data: Uint8Array,
  onFile?: (name: string, count: number) => void
): Promise<Record<string, Uint8Array>> {
  const eocd = findEocd(data);
  if (eocd < 0) throw new ZipFormatError('لا فهرس مركزي في الملف · ليس أرشيفاً');

  let count = r16(data, eocd + 8);
  let cdOff = r32(data, eocd + 16);
  // أرشيف ضخم: الأرقام الحقيقية في سجل ZIP64 قبل الخاتمة
  if (count === 0xFFFF || cdOff === 0xFFFFFFFF) {
    const loc = eocd - 20;
    if (loc < 0 || r32(data, loc) !== SIG_Z64_LOC) throw new ZipFormatError('فهرس ZIP64 مفقود');
    const rec = r48(data, loc + 8);
    if (rec + 56 > data.length || r32(data, rec) !== SIG_Z64_EOCD) throw new ZipFormatError('سجل ZIP64 تالف');
    count = r48(data, rec + 32);
    cdOff = r48(data, rec + 48);
  }

  const out: Record<string, Uint8Array> = {};
  const breathe = breather();
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > data.length || r32(data, p) !== SIG_CD) {
      throw new ZipFormatError('مدخل ' + (n + 1) + ' من ' + count + ' غير سليم في الفهرس المركزي');
    }
    const method = r16(data, p + 10);
    let csize = r32(data, p + 20);
    let usize = r32(data, p + 24);
    const nameLen = r16(data, p + 28);
    const extraLen = r16(data, p + 30);
    const cmtLen = r16(data, p + 32);
    let local = r32(data, p + 42);
    const name = strFromU8(data.subarray(p + 46, p + 46 + nameLen));
    if (usize === 0xFFFFFFFF || csize === 0xFFFFFFFF || local === 0xFFFFFFFF) {
      const z = zip64Extra(data, p + 46 + nameLen, extraLen, {
        size: usize === 0xFFFFFFFF, csize: csize === 0xFFFFFFFF, offset: local === 0xFFFFFFFF,
      });
      if (z.size != null) usize = z.size;
      if (z.csize != null) csize = z.csize;
      if (z.offset != null) local = z.offset;
    }

    // الترويسة المحلية تُقرأ لطولَي الاسم والحقول الإضافية وحدهما · الأحجام من الفهرس
    if (local + 30 > data.length || r32(data, local) !== SIG_LOCAL) {
      throw new ZipFormatError('ترويسة «' + name + '» غير سليمة');
    }
    const start = local + 30 + r16(data, local + 26) + r16(data, local + 28);
    if (start + csize > data.length) {
      throw new ZipFormatError('بيانات «' + name + '» تتجاوز حجم الملف');
    }
    const raw = data.subarray(start, start + csize);
    if (method === 0) {
      out[name] = raw.slice();
    } else if (method === 8) {
      const inflated = inflateSync(raw, usize ? { out: new Uint8Array(usize) } : undefined);
      out[name] = inflated;
    } else {
      throw new ZipFormatError('طريقة ضغط غير مدعومة (' + method + ') في «' + name + '»');
    }

    p += 46 + nameLen + extraLen + cmtLen;
    onFile?.(name, n + 1);
    await breathe();
  }
  return out;
}

/**
 * نزع البيانات الوصفية من الصور بالبايتات لا بإعادة ترميز: JPEG وPNG وWebP · وبيانات البكسل كما هي.
 * stripImageMetadataStrict لمسار الإرفاق: ما لا يُضمن نزعه (بنيةٌ غير متوقعة، أو HEIC وTIFF) يعود null فلا يُحفظ الأصل بصمت
 * (المتحقق المستقل، الجولة ٣٥ (د): كانت البنية غير المتوقعة تعيد الأصل كله ومعه الموقع) · وstripImageMetadata للأدوات: الأصل عند التعذّر.
 */
const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const tag = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

/** وسم الاتجاه (0x0112) في Exif صورة JPEG · ١ (طبيعي) إن غاب أو تعذّرت قراءته · بنوعيه SHORT وLONG وبالترتيبين */
export function jpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    // بايتات الحشو 0xFF قبل العلامة جائزة (T.81 B.1.1.2)
    if (bytes[i + 1] === 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) return 1;
    const s = i + 4;
    const end = i + 2 + len;
    if (marker === 0xe1 && end - s >= 14 && tag(bytes, s) === 'Exif' && bytes[s + 4] === 0 && bytes[s + 5] === 0) {
      const t = s + 6;
      const le = bytes[t] === 0x49 && bytes[t + 1] === 0x49;
      if (!le && !(bytes[t] === 0x4d && bytes[t + 1] === 0x4d)) return 1;
      const r16 = (o: number) => (o < t || o + 2 > end ? -1 : le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
      const r32 = (o: number) => (o < t || o + 4 > end ? -1 : le
        ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
        : u32(bytes, o));
      const off = r32(t + 4);
      if (off < 0) return 1;
      const ifd = t + off;
      const n = r16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (r16(e) === 0x0112) {
          const v = r16(e + 2) === 4 ? r32(e + 8) : r16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    i = end;
  }
  return 1;
}

/** APP1 Exif لا يحمل إلا وسم الاتجاه · حين يتعذّر تدوير البكسل: لا موقع ولا جهاز ولا وقت، والصورة تُعرض باتجاهها */
function orientationOnlyApp1(o: number): Uint8Array {
  return Uint8Array.from([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8,
    0, 1, 0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0]);
}

/**
 * مقطعٌ وصفي يُنزع: APPn كلها إلا APP0 (JFIF) وAPP2 لملف الألوان (ICC_PROFILE) وAPP14 (Adobe: تحويل الألوان) · والتعليق COM ·
 * فيُنزع Exif وXMP (APP1) وIPTC (APP13) وفهرس الصور المتعددة MPF (APP2) وJUMBF/C2PA (APP11) وما تكتبه الأجهزة في غيرها
 */
function isMetaSegment(b: Uint8Array, i: number, marker: number, end: number): boolean {
  if (marker === 0xfe) return true;
  if (marker < 0xe0 || marker > 0xef) return false;
  // ما يُبقى بمعرّفه وحده (المتحقق المستقل، الجولة ٣٦): JFIF لا JFXX ومصغّرته، وICC_PROFILE، وAdobe
  const keep = marker === 0xe0 ? 'JFIF' : marker === 0xe2 ? 'ICC_PROFILE' : marker === 0xee ? 'Adobe' : null;
  if (!keep) return true;
  if (end - (i + 4) < keep.length + 1) return true;
  for (let k = 0; k < keep.length; k++) if (b[i + 4 + k] !== keep.charCodeAt(k)) return true;
  return marker !== 0xee && b[i + 4 + keep.length] !== 0;
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

/**
 * JPEG بلا بياناته الوصفية · keepOrientation: وسم اتجاهٍ غير طبيعي يُعاد وحده بعد APP0 (قرار المالك 2026-10-15 «١٢») · null لبنيةٍ
 * غير متوقعة · وما بعد علامة النهاية EOI لا يُنسخ: الصور الثانوية (MPF) وذيول الأجهزة والصور المتحركة وما فيها من موقع
 */
function stripJpegStrict(bytes: Uint8Array, keepOrientation: number): Uint8Array | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const chunks: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  let changed = false;
  let afterApp0 = 1;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    // بايتات الحشو قبل العلامة
    while (i + 1 < bytes.length && bytes[i + 1] === 0xff) { i++; changed = true; }
    if (i + 1 >= bytes.length) return null;
    const marker = bytes[i + 1];
    if (marker === 0xd9) {
      chunks.push(bytes.subarray(i, i + 2));
      if (i + 2 < bytes.length) changed = true;
      i = bytes.length;
      break;
    }
    if (marker === 0x00 || marker === 0xd8) return null; // SOI ثانٍ في غير موضعه: بنيةٌ غير متوقعة
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { chunks.push(bytes.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > bytes.length) return null;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) return null;
    const end = i + 2 + len;
    if (isMetaSegment(bytes, i, marker, end)) changed = true;
    else {
      chunks.push(bytes.subarray(i, end));
      if (marker === 0xe0 && afterApp0 === 1) afterApp0 = chunks.length;
    }
    i = end;
    if (marker === 0xda) {
      // البيانات المرمّزة حتى أول علامةٍ ليست حشواً (FF00) ولا إعادة تشغيل (FFD0 إلى FFD7)
      let j = i;
      while (j + 1 < bytes.length) {
        if (bytes[j] === 0xff) {
          const n = bytes[j + 1];
          if (n !== 0x00 && n !== 0xff && !(n >= 0xd0 && n <= 0xd7)) break;
        }
        j++;
      }
      if (j + 1 >= bytes.length) { chunks.push(bytes.subarray(i)); i = bytes.length; break; } // بلا علامة نهاية: البيانات كما هي
      chunks.push(bytes.subarray(i, j));
      i = j;
    }
  }
  if (keepOrientation >= 2 && keepOrientation <= 8) { chunks.splice(afterApp0, 0, orientationOnlyApp1(keepOrientation)); changed = true; }
  return changed ? joinChunks(chunks) : bytes;
}

/** keepOrientation: وسم اتجاهٍ غير طبيعي يُعاد وحده بعد النزع · والبنية غير المتوقعة تعيد الأصل (الأدوات) */
export function stripJpegExif(bytes: Uint8Array, keepOrientation = 1): Uint8Array {
  return stripJpegStrict(bytes, keepOrientation) ?? bytes;
}

/**
 * مقاطع PNG التي تُبقى: الحرجة وما يلزم لعرض الصورة وألوانها وحركتها · وكل ما سواها يُنزع (قائمة سماحٍ لا منع: المتحقق المستقل،
 * الجولة ٣٦: بقي caBX وprVW)
 */
const PNG_KEEP = ['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT', 'cICP'];

/** PNG بما في PNG_KEEP وحده · وما بعد IEND لا يُنسخ · null لبنيةٍ غير متوقعة */
function stripPngStrict(bytes: Uint8Array): Uint8Array | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || SIG.some((v, k) => bytes[k] !== v)) return null;
  const chunks: Uint8Array[] = [bytes.subarray(0, 8)];
  let i = 8;
  let stripped = false;
  let ended = false;
  while (i + 12 <= bytes.length) {
    const len = u32(bytes, i);
    const end = i + 12 + len;
    if (end > bytes.length) return null;
    const type = tag(bytes, i + 4);
    if (!PNG_KEEP.includes(type)) stripped = true;
    else chunks.push(bytes.subarray(i, end));
    i = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended) return null;
  if (i < bytes.length) stripped = true;
  return stripped ? joinChunks(chunks) : bytes;
}

export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  return stripPngStrict(bytes) ?? bytes;
}

/** WebP بلا مقطعي EXIF وXMP، وعلامتاهما في VP8X تُمحيان، وحجم RIFF يُصحَّح · null لبنيةٍ غير متوقعة */
function stripWebpStrict(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 12 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WEBP') return null;
  const chunks: Uint8Array[] = [];
  let i = 12;
  let stripped = false;
  while (i + 8 <= bytes.length) {
    const size = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
    const end = i + 8 + size + (size & 1);
    if (i + 8 + size > bytes.length) return null;
    const type = tag(bytes, i);
    if (type === 'EXIF' || type === 'XMP ') stripped = true;
    else if (type === 'VP8X') {
      const c = bytes.slice(i, Math.min(end, bytes.length));
      c[8] &= ~(0x08 | 0x04);
      chunks.push(c);
    } else chunks.push(bytes.subarray(i, Math.min(end, bytes.length)));
    i = end;
  }
  if (!stripped) return bytes;
  const body = joinChunks(chunks);
  const out = new Uint8Array(12 + body.length);
  out.set(bytes.subarray(0, 12));
  const riff = 4 + body.length;
  out[4] = riff & 0xff; out[5] = (riff >> 8) & 0xff; out[6] = (riff >> 16) & 0xff; out[7] = (riff >>> 24) & 0xff;
  out.set(body, 12);
  return out;
}

export function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  return stripWebpStrict(bytes) ?? bytes;
}

const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'heif', 'mif1', 'msf1', 'MiHE', 'MiAF', 'avif', 'avis', 'crx '];

/** علامات ftyp كلها (الرئيسية والمتوافقة) · ما في صندوقها الأول وحده */
function ftypBrands(b: Uint8Array): string[] {
  if (b.length < 16 || tag(b, 4) !== 'ftyp') return [];
  const size = Math.min(u32(b, 0), b.length);
  const out = [tag(b, 8)];
  for (let i = 16; i + 4 <= size; i += 4) out.push(tag(b, i));
  return out;
}

const MARKERS = ['Exif  ', 'x:xmpmeta', 'XMP DataXMP', 'http://ns.adobe.com/xap/', 'Photoshop 3.0'].map((m) => Array.from(m, (c) => c.charCodeAt(0)));
const TIFF_HEADS = [[0x49, 0x49, 0x2a, 0], [0x4d, 0x4d, 0, 0x2a]];

/**
 * علامة بياناتٍ وصفية في أي موضع: Exif وXMP وIPTC، وصندوق Exif يليه رأس TIFF (JPEG XL وغيره) · لصورةٍ صيغتها غير معروفة: فيها ما
 * يُنزع فتُحوَّل أو لا تُرفق، وإلا رُفعت كما هي (المتحقق المستقل، الجولة ٣٦: بايتاتٌ قبل التوقيع، وGIF فيه XMP)
 */
export function hasMetadataMarker(b: Uint8Array): boolean {
  const at = (i: number, m: number[]) => m.every((v, k) => b[i + k] === v);
  for (let i = 0; i < b.length; i++) {
    for (const m of MARKERS) if (b[i] === m[0] && at(i, m)) return true;
    if (b[i] === 0x45 && at(i, [0x45, 0x78, 0x69, 0x66])) {
      for (let k = i + 4; k <= i + 10; k++) if (TIFF_HEADS.some((h) => at(k, h))) return true;
    }
  }
  return false;
}

/** JPEG أو PNG أو WebP: ما يُنزع بالبايتات */
export function strippableSignature(b: Uint8Array): boolean {
  return (b[0] === 0xff && b[1] === 0xd8)
    || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    || (b.length >= 12 && tag(b, 0) === 'RIFF' && tag(b, 8) === 'WEBP');
}

/** صورةٌ بتوقيعها وإن لم يُعلن نوعها: ما يحتاج التحويل، وGIF، وJPEG XL */
export function imageSignature(b: Uint8Array): boolean {
  return strippableSignature(b) || needsJpegConversion(b)
    || (b.length >= 4 && tag(b, 0) === 'GIF8')
    || (b[0] === 0xff && b[1] === 0x0a)
    || (b.length >= 12 && u32(b, 0) === 12 && tag(b, 4) === 'JXL ');
}

/**
 * صورةٌ لا يُنزع ما فيها بالبايتات: HEIC وHEIF وAVIF (بيانات Exif في صناديق ISO) وTIFF (البيانات في الصورة نفسها) · تُحوَّل إلى JPEG
 * قبل النزع أو لا تُرفق (المتحقق المستقل، الجولة ٣٥ (د))
 */
export function needsJpegConversion(bytes: Uint8Array): boolean {
  if (ftypBrands(bytes).some((x) => HEIF_BRANDS.includes(x))) return true;
  // TIFF وBigTIFF بالترتيبين، ومنها صيغ الكاميرا الخام المبنية عليه
  return bytes.length >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && (bytes[2] === 0x2a || bytes[2] === 0x2b) && bytes[3] === 0)
    || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && (bytes[3] === 0x2a || bytes[3] === 0x2b)));
}

/**
 * نزع البيانات الوصفية من صورةٍ بصيغتها (المراجعة الخارجية ٧ · النتيجة ٢٧): JPEG وPNG وWebP بالبايتات · والبكسل لا يُمسّ ·
 * وما ليس صورةً معروفة يعود كما هو · والأصل عند التعذّر
 */
export function stripImageMetadata(bytes: Uint8Array, keepJpegOrientation = 1): Uint8Array {
  return stripImageMetadataStrict(bytes, keepJpegOrientation) ?? bytes;
}

/** كالسابق لمسار الإرفاق: null لصورةٍ لا يُضمن نزع ما فيها (بنيةٌ غير متوقعة، أو صيغةٌ تحتاج التحويل) */
export function stripImageMetadataStrict(bytes: Uint8Array, keepJpegOrientation = 1): Uint8Array | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return stripJpegStrict(bytes, keepJpegOrientation);
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return stripPngStrict(bytes);
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes.length >= 12 && tag(bytes, 8) === 'WEBP') return stripWebpStrict(bytes);
  if (needsJpegConversion(bytes)) return null;
  return bytes;
}

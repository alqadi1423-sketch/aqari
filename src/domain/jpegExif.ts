/**
 * نزع بيانات EXIF (ومعها المصغّرة المدمجة) من JPEG دون أي إعادة ترميز ·
 * حذفُ مقاطع APP1 التعريفية على مستوى البايتات، وبيانات البكسل تبقى مطابقة تماماً.
 * أي بنية غير متوقعة تُعيد الأصل كما هو · لا نجازف بمستند.
 */
const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const tag = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

/** وسم الاتجاه (0x0112) في Exif صورة JPEG · ١ (طبيعي) إن غاب أو تعذّرت قراءته */
export function jpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    if (marker === 0xda) break;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) return 1;
    const s = i + 4;
    const end = i + 2 + len;
    if (marker === 0xe1 && end - s >= 14 && tag(bytes, s) === 'Exif' && bytes[s + 4] === 0 && bytes[s + 5] === 0) {
      const t = s + 6;
      const le = bytes[t] === 0x49 && bytes[t + 1] === 0x49;
      if (!le && !(bytes[t] === 0x4d && bytes[t + 1] === 0x4d)) return 1;
      const r16 = (o: number) => (o < t || o + 2 > end ? -1 : le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
      const r32 = (o: number) => (o + 4 > end ? -1 : le
        ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
        : u32(bytes, o));
      const off = r32(t + 4);
      if (off < 0) return 1;
      const ifd = t + off;
      const n = r16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
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

/** keepOrientation: وسم اتجاهٍ غير طبيعي يُعاد وحده بعد النزع (قرار المالك 2026-10-15 «١٢») */
export function stripJpegExif(bytes: Uint8Array, keepOrientation = 1): Uint8Array {
  // SOI ثم مقاطع FF xx
  if (bytes.length < 6 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const chunks: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  let stripped = false;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return bytes; // بنية غير متوقعة · الأصل أسلم
    const marker = bytes[i + 1];
    if (marker === 0xda) { // SOS: بيانات الصورة حتى النهاية · تُنسخ كما هي
      chunks.push(bytes.subarray(i));
      i = bytes.length;
      break;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) return bytes;
    const segEnd = i + 2 + len;
    // APP1 كلها (Exif وXMP) وAPP13 (IPTC) · والمراجعة الخارجية ٧ · النتيجة ٢٧: كان Exif وحده يُنزع ويبقى XMP وIPTC
    const isMeta = marker === 0xe1 || marker === 0xed;
    if (isMeta) stripped = true;
    else chunks.push(bytes.subarray(i, segEnd));
    i = segEnd;
  }
  if (!stripped) return bytes;
  if (keepOrientation >= 2 && keepOrientation <= 8) chunks.splice(1, 0, orientationOnlyApp1(keepOrientation));
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

/** PNG بلا مقاطع eXIf والنصوص (tEXt وiTXt وzTXt) والوقت · وأي بنية غير متوقعة تُعيد الأصل */
export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || SIG.some((v, k) => bytes[k] !== v)) return bytes;
  const chunks: Uint8Array[] = [bytes.subarray(0, 8)];
  let i = 8;
  let stripped = false;
  while (i + 12 <= bytes.length) {
    const len = u32(bytes, i);
    const end = i + 12 + len;
    if (end > bytes.length) return bytes;
    const type = tag(bytes, i + 4);
    if (['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'].includes(type)) stripped = true;
    else chunks.push(bytes.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return stripped ? joinChunks(chunks) : bytes;
}

/** WebP بلا مقطعي EXIF وXMP، وعلامتاهما في VP8X تُمحيان، وحجم RIFF يُصحَّح · وأي بنية غير متوقعة تُعيد الأصل */
export function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WEBP') return bytes;
  const chunks: Uint8Array[] = [];
  let i = 12;
  let stripped = false;
  while (i + 8 <= bytes.length) {
    const size = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
    const end = i + 8 + size + (size & 1);
    if (i + 8 + size > bytes.length) return bytes;
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

/**
 * نزع البيانات الوصفية من صورةٍ بصيغتها (المراجعة الخارجية ٧ · النتيجة ٢٧): JPEG وPNG وWebP بالبايتات لا بإعادة ترميز ·
 * والبكسل لا يُمسّ · وما ليس صورةً معروفة يعود كما هو
 */
export function stripImageMetadata(bytes: Uint8Array, keepJpegOrientation = 1): Uint8Array {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return stripJpegExif(bytes, keepJpegOrientation);
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return stripPngMetadata(bytes);
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return stripWebpMetadata(bytes);
  return bytes;
}

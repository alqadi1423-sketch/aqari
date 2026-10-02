/**
 * نزع بيانات EXIF (ومعها المصغّرة المدمجة) من JPEG دون أي إعادة ترميز ·
 * حذفُ مقاطع APP1 التعريفية على مستوى البايتات، وبيانات البكسل تبقى مطابقة تماماً.
 * أي بنية غير متوقعة تُعيد الأصل كما هو · لا نجازف بمستند.
 */
export function stripJpegExif(bytes: Uint8Array): Uint8Array {
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
    const isExif = marker === 0xe1
      && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78 && bytes[i + 6] === 0x69
      && bytes[i + 7] === 0x66 && bytes[i + 8] === 0x00; // 'Exif\0'
    if (isExif) stripped = true;
    else chunks.push(bytes.subarray(i, segEnd));
    i = segEnd;
  }
  if (!stripped) return bytes;
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/**
 * واجهة نظام ملفات متزامنة صغيرة · تنفيذان:
 *  - nodeFs (node:fs) للاختبارات
 *  - expoFs (expo-file-system) للتطبيق
 * كل مسارات الدوال مطلقة.
 */
export interface FS {
  read(path: string): Uint8Array;
  write(path: string, bytes: Uint8Array): void;
  exists(path: string): boolean;
  remove(path: string): void;
  mkdirp(dir: string): void;
  list(dir: string): string[];
  /** إعادة تسمية/نقل · ذرّية على نفس وحدة التخزين */
  rename(from: string, to: string): void;
  size(path: string): number;
  /**
   * المساحة التي يستطيع التطبيق كتابتها فعلاً · بالبايت.
   * لا «الحرّة» بمعناها الخام: نظام الملفات يحجز كتلاً للجذر لا يبلغها التطبيق، وقياسها
   * حرّةً أمرّ الفحصَ على جهازٍ فشل فيه النسخ بـ«لا مساحة» بعد لحظات.
   */
  usableSpace(): Promise<number>;
}

/** بصمة sha256 (hex صغيرة) · غير متزامنة لتوافق expo-crypto */
export type Hasher = (bytes: Uint8Array) => Promise<string>;

export function joinPath(...parts: string[]): string {
  const joined = parts.filter(Boolean).join('/').replace(/\\/g, '/');
  // نحافظ على لاحقة الـ scheme (مثل file:///) ونطوي التكرار في بقية المسار فقط
  const m = joined.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/+)(.*)$/);
  if (m) return m[1] + m[2].replace(/\/{2,}/g, '/');
  return joined.replace(/\/{2,}/g, '/');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => { const m = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i; return m; })();

/** فكّ base64 بلا atob (غير مضمون على Hermes) · المسافات والأسطر تُتجاوز، والحشو «=» ينهي القراءة */
export function fromBase64(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4) + 3);
  let n = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) break; // «=»
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, n);
}
/** base64 بلا اعتماد على btoa · لبصمة md5 كما يعيدها Storage في md5Hash */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (b === undefined ? '=' : B64[(n >> 6) & 63]) + (c === undefined ? '=' : B64[n & 63]);
  }
  return out;
}


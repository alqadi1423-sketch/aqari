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


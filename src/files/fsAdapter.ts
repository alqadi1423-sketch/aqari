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

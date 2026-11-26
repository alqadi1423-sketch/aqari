/**
 * قراءة النص من الصور (ق٠-٤ · قرار المالك على س٣٤ 2026-11-13: (أ) مكتبةٌ مفتوحة تقرأ العربية، و(ج) مؤقتاً إن تأخرت).
 * الخيار (ج) نافذٌ الآن: أُزيل قارئ قوقل (ML Kit) لأنه يرسل إلى قوقل بيانات استعمالٍ تقنية ولا يقرأ العربية،
 * فلا يُقرأ نصٌّ من صورة عقدٍ أو كشف، ويُطلب ملف PDF أو Excel · والقارئ المفتوح (Tesseract) يحلّ هنا لاحقاً
 * بالواجهة نفسها: كلماتٌ بمواضعها لقارئ صورة الكشف (domain/bankStatement/photo.ts) ونصٌّ لقارئ العقد.
 */

/** رمز الخطأ حين تُختار صورة: الشاشة تعرض رسالة «موقوفة الآن، فاختر PDF أو Excel» */
export const OCR_STOPPED = 'ocr-stopped';

export const isOcrStopped = (e: unknown): boolean => e instanceof Error && e.message === OCR_STOPPED;

/** نص الصورة · موقوفٌ الآن فيرمي OCR_STOPPED دائماً بلا أي وحدةٍ أصلية */
export async function readImageText(_uri: string): Promise<never> {
  throw new Error(OCR_STOPPED);
}

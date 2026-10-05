/**
 * قراءة العقد تلقائياً: PDF عبر المستخرج المصغّر الخالص (يعمل على Hermes)،
 * والصور عبر ML Kit OCR · مع تدهور رشيق حين لا تتوفر الوحدة.
 */
import { parseEjarContract, type EjarParseResult } from '../domain/pdf/parseEjar';
import { extractPdfText, PdfEncrypted } from '../domain/pdf/miniPdfText';
import type { DB } from '../db/adapter';
import { attachmentsFor, attachmentPath } from '../files/store';
import { appFilesEnv } from './filesEnv';

/**
 * استخراج نص PDF بتجميع الأسطر بفارق عمودي > 3 (منطق النموذج).
 * الأخطاء مميزة بسببها: pdf-encrypted (محمي) · pdf-empty (بلا طبقة نص) · pdf (بنية تعذّر فكها)
 */
export async function readPdfText(data: Uint8Array): Promise<string> {
  let text: string;
  try {
    text = extractPdfText(data);
  } catch (e) {
    if (e instanceof PdfEncrypted) throw e;
    throw new Error('pdf');
  }
  if (!text.trim()) throw new Error('pdf-empty');
  return text;
}

/** OCR لصورة عبر ML Kit · يتطلب بناء تطوير؛ يرمي 'ocr' حين غير متاح */
export async function readImageText(uri: string): Promise<string> {
  try {
    const mod = await import('@react-native-ml-kit/text-recognition');
    const TextRecognition = mod.default;
    const result = await TextRecognition.recognize(uri);
    return result.blocks.map((b) => b.lines.map((l) => l.text).join('\n')).join('\n');
  } catch {
    throw new Error('ocr');
  }
}

export async function scanContractFile(file: {
  uri: string;
  mimeType?: string;
  name?: string;
  bytes?: Uint8Array;
}): Promise<{ text: string; result: EjarParseResult }> {
  const isPdf = /\.pdf$/i.test(file.name ?? '') || file.mimeType === 'application/pdf';
  let text: string;
  if (isPdf) {
    if (!file.bytes) throw new Error('pdf');
    text = await readPdfText(file.bytes);
  } else {
    text = await readImageText(file.uri);
  }
  return { text, result: parseEjarContract(text) };
}

/**
 * نصّ ملف عقد إيجار المرفق بعقدٍ قائم · لأداة مقارنة الأقساط بجدول الملف (ejarScheduleRepair) ·
 * null إن لم يكن له ملف PDF أو تعذّرت قراءته.
 */
export async function readLeaseText(db: DB, contractId: string): Promise<string | null> {
  const env = appFilesEnv(db);
  const att = attachmentsFor(db, 'contract', contractId, 'lease')
    .find((a) => /pdf/i.test(a.mime || '') || /\.pdf$/i.test(a.original_name || ''));
  if (!att) return null;
  try { return await readPdfText(env.fs.read(attachmentPath(env, att))); } catch { return null; }
}

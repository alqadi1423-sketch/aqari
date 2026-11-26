/**
 * قراءة ملف كشف البنك على الجهاز (التوجيه الرابع ٦ · ٢): بايتاته إلى القارئ العام (domain/bankStatement/read.ts)، وبصمته لمنع قراءة الملف
 * نفسه مرتين · وصورة الكشف: قراءة النص من الصور موقوفةٌ الآن (ق٠-٤ · imageText.ts)، فترمي OCR_STOPPED وتطلب الشاشة PDF أو Excel ·
 * وقارئ صورة الكشف (domain/bankStatement/photo.ts · U١٢) باقٍ ينتظر قارئاً مفتوحاً يعطيه الكلمات بمواضعها ·
 * وسطور الكشف المحفوظة تتبع المزامنة كبقية البيانات (P0-10).
 */
import { File } from 'expo-file-system';
import { readStatementFile, isStatementImage, type ReadOpts, type StatementResult } from '../domain/bankStatement/read';
import { bytesHash } from '../domain/bankStatement/dedupe';
import { readImageText } from './imageText';

export interface StatementSource {
  name: string;
  /** القراءة بخياراتها (الربط المصحَّح، أو الافتتاحي والختامي من رأس الكشف) */
  read: (opts: ReadOpts) => { result: StatementResult; hash: string };
  /** قُرئ من صورة · false دائماً ما دامت قراءة الصور موقوفة (ق٠-٤) */
  photo: boolean;
}

export async function statementSource(file: { uri: string; name: string }): Promise<StatementSource> {
  let bytes: Uint8Array;
  try { bytes = new File(file.uri).bytesSync(); } catch {
    return { name: file.name, photo: false, read: () => ({ result: { ok: false, error: 'format' }, hash: '' }) };
  }
  const hash = bytesHash(bytes);
  if (!isStatementImage({ name: file.name, bytes })) {
    return { name: file.name, photo: false, read: (opts) => ({ result: readStatementFile({ name: file.name, bytes }, opts), hash }) };
  }
  // الصورة: موقوفةٌ الآن (ترمي OCR_STOPPED) · ويعود هنا readStatementPhoto بكلمات القارئ المفتوح حين يُبنى
  return readImageText(file.uri);
}

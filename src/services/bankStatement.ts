/**
 * قراءة ملف كشف البنك على الجهاز (التوجيه الرابع ٦ · ٢): بايتاته إلى القارئ العام (domain/bankStatement/read.ts)، وبصمته لمنع قراءة الملف
 * نفسه مرتين · والصورة بقارئ النص على الجهاز (ML Kit) كلماتٍ بمواضعها إلى قارئ الصورة (domain/bankStatement/photo.ts · U١٢) · ML Kit
 * لا يرسل الصورة ولا نصها، لكنه يرسل إلى قوقل بيانات استعمالٍ تقنية (F-2)، ويُستبدل في خطة الخروج من قوقل · وسطور الكشف المحفوظة
 * تتبع المزامنة كبقية البيانات (P0-10).
 */
import { File } from 'expo-file-system';
import { readStatementFile, isStatementImage, type ReadOpts, type StatementResult } from '../domain/bankStatement/read';
import { readStatementPhoto, type OcrLine } from '../domain/bankStatement/photo';
import { bytesHash } from '../domain/bankStatement/dedupe';

export interface StatementSource {
  name: string;
  /** القراءة بخياراتها (الربط المصحَّح، أو الافتتاحي والختامي من رأس الكشف) · والصورة تُقرأ بقارئ النص مرةً واحدة */
  read: (opts: ReadOpts) => { result: StatementResult; hash: string };
  photo: boolean;
}

/** كلمات الصورة بمواضعها · ترمي 'ocr' إن لم تتوفر الوحدة في هذه النسخة */
async function photoWords(uri: string): Promise<OcrLine[]> {
  let res: import('@react-native-ml-kit/text-recognition').TextRecognitionResult;
  try {
    const mod = await import('@react-native-ml-kit/text-recognition');
    res = await mod.default.recognize(uri);
  } catch {
    throw new Error('ocr');
  }
  const out: OcrLine[] = [];
  for (const b of res.blocks) {
    for (const l of b.lines) {
      const words = l.elements.filter((e) => e.frame);
      if (words.length) for (const e of words) out.push({ text: e.text, ...e.frame! });
      else if (l.frame) out.push({ text: l.text, ...l.frame });
    }
  }
  return out;
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
  const words = await photoWords(file.uri);
  return { name: file.name, photo: true, read: (opts) => ({ result: readStatementPhoto(words, opts), hash }) };
}

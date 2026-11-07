/**
 * قراءة ملف كشف البنك على الجهاز (التوجيه الرابع ٦ · ٢): بايتاته إلى القارئ العام (domain/bankStatement/read.ts)، وبصمته لمنع قراءة الملف
 * نفسه مرتين · لا شبكة ولا خادم.
 */
import { File } from 'expo-file-system';
import { readStatementFile, type ReadOpts, type StatementResult } from '../domain/bankStatement/read';
import { bytesHash } from '../domain/bankStatement/dedupe';

export function readStatementFromFile(file: { uri: string; name: string }, opts: ReadOpts = {}): { result: StatementResult; hash: string } {
  let bytes: Uint8Array;
  try { bytes = new File(file.uri).bytesSync(); } catch { return { result: { ok: false, error: 'format' }, hash: '' }; }
  return { result: readStatementFile({ name: file.name, bytes }, opts), hash: bytesHash(bytes) };
}

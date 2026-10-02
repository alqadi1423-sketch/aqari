/** مشاركة ملفات أوفيس المبنية في src/domain/officeBuild عبر حوار النظام */
import { File, Directory, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/* ═══════════ المشاركة ═══════════ */

export const OFFICE_MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

export async function shareOfficeFile(filename: string, bytes: Uint8Array, kind: keyof typeof OFFICE_MIME): Promise<void> {
  const dir = new Directory(Paths.cache.uri + 'reports/');
  if (!dir.exists) dir.create({ intermediates: true });
  const f = new File(dir.uri + filename);
  if (f.exists) f.delete();
  f.write(bytes);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(f.uri, { mimeType: OFFICE_MIME[kind], dialogTitle: filename });
  }
}

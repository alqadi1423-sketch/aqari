/**
 * المصغّرات · 200 بكسل بجانب كل صورة، تُعرض في القوائم وحدها والأصل لا يُمسّ:
 * thumbs/<sha>.jpg تُولَّد عند أول طلب، والأصل في attachments/<sha>.<ext> كما رُفع.
 */
import { File, Directory } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { joinPath } from '../files/fsAdapter';
import { appDataRoot } from '../files/expoFs';
import { thumbsDir } from './storageOps';

const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic']);

export const isImageFile = (ext: string, mime?: string): boolean =>
  IMG_EXT.has(ext.toLowerCase()) || !!mime?.startsWith('image/');

const norm = (p: string): string => (p.startsWith('file://') ? p : 'file://' + p);

/** مسار مصغّرة موجودة أو null · لا توليد */
export function existingThumbUri(sha256: string): string | null {
  const p = norm(joinPath(thumbsDir(), sha256 + '.jpg'));
  return new File(p).exists ? p : null;
}

/**
 * مصغّرة صورة (تُولَّد عند أول طلب) · يعيد null لغير الصور أو عند فشل التوليد ·
 * والفشل لا يمس الأصل بشيء.
 */
export async function thumbUri(sha256: string, ext: string, mime?: string): Promise<string | null> {
  if (!isImageFile(ext, mime)) return null;
  const cached = existingThumbUri(sha256);
  if (cached) return cached;
  const orig = norm(joinPath(appDataRoot(), 'attachments', sha256 + '.' + ext));
  if (!new File(orig).exists) return null;
  try {
    const out = await manipulateAsync(orig, [{ resize: { width: 200 } }], {
      compress: 0.6, format: SaveFormat.JPEG,
    });
    const dir = new Directory(norm(thumbsDir()));
    if (!dir.exists) dir.create({ intermediates: true });
    const dest = new File(norm(joinPath(thumbsDir(), sha256 + '.jpg')));
    if (dest.exists) dest.delete();
    new File(out.uri).moveSync(dest);
    return dest.uri;
  } catch {
    return null;
  }
}

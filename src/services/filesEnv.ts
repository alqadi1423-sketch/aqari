/** بيئة الملفات داخل التطبيق · القاعدة + القرص + وحدة التجزئة + مولّد المصغّرة الخفيفة */
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import type { DB } from '../db/adapter';
import type { FilesEnv } from '../files/store';
import { expoFs, expoHasher, appDataRoot } from '../files/expoFs';
import { joinPath } from '../files/fsAdapter';
import { isImageFile } from './thumbs';

const norm = (p: string): string => (p.startsWith('file://') ? p : 'file://' + p);

/**
 * مصغّرة خفيفة تُزامَن مع صفّ المرفق (النموذج المختلط) · ٩٦ بكسل بجودة منخفضة، بضعة كيلوبايت، فيظهر بها الملف
 * على جهازٍ لم يُنزّله · وغير الصور أو ما تعذّر توليده: بلا مصغّرة، ولا يمنع ذلك المرفق
 */
async function lightThumb(path: string, ext: string, mime: string): Promise<string | null> {
  if (!isImageFile(ext, mime)) return null;
  try {
    const out = await manipulateAsync(norm(path), [{ resize: { width: 96 } }], { compress: 0.4, format: SaveFormat.JPEG, base64: true });
    return out.base64 && out.base64.length < 24_000 ? 'data:image/jpeg;base64,' + out.base64 : null;
  } catch {
    return null;
  }
}

export function appFilesEnv(db: DB): FilesEnv {
  return {
    db,
    fs: expoFs,
    hasher: expoHasher,
    attachmentsDir: joinPath(appDataRoot(), 'attachments'),
    thumbnailer: lightThumb,
  };
}

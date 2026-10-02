/**
 * التقاط ملف وربطه بكيان بعد حفظه · المسار الواحد putAttachment.
 * تُقبل كل الأنواع · الملف يُحفظ بجودته الأصلية كما رُفع · لا ضغط تلقائي إطلاقاً.
 * المقاطع فوق ٢٥ ميغا وسائر الملفات فوق ٥٠ ميغا: سؤال بالحجم، لا منع.
 * نسخة المنتقي المؤقتة تُحذف بعد نجاح النسخ والتحقق · فلا يبقى للملف إلا نسخة واحدة.
 */
import { showDialog } from './AppDialog';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { File, Paths } from 'expo-file-system';
import type { DB } from '../db/adapter';
import { appFilesEnv } from '../services/filesEnv';
import { putAttachment } from '../files/store';
import { getSetting } from '../repos/settings';
import { stripJpegExif } from '../domain/jpegExif';
import { fmt } from '../domain/money';

export interface PickedFile {
  uri: string;
  name: string;
  mime: string;
}

const SIZE_WARN = 50 * 1024 * 1024;
const VIDEO_WARN = 25 * 1024 * 1024;

/** كل أنواع الملفات · لا ترشيح */
export async function pickFile(types: string[] = ['*/*']): Promise<PickedFile | null> {
  const res = await DocumentPicker.getDocumentAsync({ type: types, copyToCacheDirectory: true });
  if (res.canceled || !res.assets?.length) return null;
  const a = res.assets[0];
  return { uri: a.uri, name: a.name ?? 'ملف', mime: a.mimeType ?? '' };
}

/** صور ومقاطع من المعرض · بلا خيار جودة = بلا إعادة ترميز، الملف يمرّ كما هو */
export async function pickFromGallery(): Promise<PickedFile | null> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
  });
  if (res.canceled || !res.assets?.length) return null;
  const a = res.assets[0];
  const ext = a.uri.split('.').pop() || (a.type === 'video' ? 'mp4' : 'jpg');
  return {
    uri: a.uri,
    name: a.fileName ?? `${a.type === 'video' ? 'مقطع' : 'صورة'}.${ext}`,
    mime: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
  };
}

/** تصوير مباشر بالكاميرا (صورة أو مقطع) · بلا خيار جودة = بلا إعادة ترميز */
export async function captureWithCamera(): Promise<PickedFile | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return null;
  const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'] });
  if (res.canceled || !res.assets?.length) return null;
  const a = res.assets[0];
  return {
    uri: a.uri,
    name: a.fileName ?? `تصوير · ${Date.now()}.${a.type === 'video' ? 'mp4' : 'jpg'}`,
    mime: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
  };
}

const confirmSize = (title: string, message: string): Promise<boolean> =>
  new Promise((resolve) => {
    showDialog({
      title, body: message, tone: 'normal', locked: true,
      actions: [
        { label: 'تراجع', variant: 'ghost', onPress: () => resolve(false) },
        { label: 'احفظ', variant: 'primary', onPress: () => resolve(true) },
      ],
    });
  });

export async function attachPicked(
  db: DB,
  file: PickedFile,
  entityType: string,
  entityId: string,
  kind: string
): Promise<void> {
  let bytes = new File(file.uri).bytesSync();
  const mb = (n: number) => fmt(Math.round((n / (1024 * 1024)) * 100)) ;
  const isVideo = file.mime.startsWith('video/');
  if (isVideo && bytes.byteLength > VIDEO_WARN) {
    // سؤال لا منع · ولا إعادة ترميز للمقاطع إطلاقاً
    const ok = await confirmSize('مقطع كبير', `هذا المقطع ${mb(bytes.byteLength)} ميغابايت · هل تحفظه؟`);
    if (!ok) return;
  } else if (!isVideo && bytes.byteLength > SIZE_WARN) {
    const ok = await confirmSize('ملف كبير', `حجم الملف ${mb(bytes.byteLength)} ميغابايت وسيدخل في النسخ الاحتياطية · هل تحفظه؟`);
    if (!ok) return;
  }
  // نزع EXIF (خيار في الإعدادات، مطفأ افتراضياً) · حذف مقاطع تعريف فقط، البكسل لا يُمسّ
  if (getSetting(db, 'stripExif') && (file.mime === 'image/jpeg' || /\.jpe?g$/i.test(file.name))) {
    bytes = stripJpegExif(bytes);
  }
  await putAttachment(appFilesEnv(db), bytes, {
    entityType,
    entityId,
    kind,
    originalName: file.name,
    mime: file.mime,
  });
  // النسخ نجح وتُحقق منه داخل putAttachment · نسخة المنتقي المؤقتة تُحذف فلا يبقى مكرَّر
  try {
    if (file.uri.startsWith(Paths.cache.uri)) {
      const tmp = new File(file.uri);
      if (tmp.exists) tmp.delete();
    }
  } catch { /* تُكنس في الإقلاع التالي */ }
}

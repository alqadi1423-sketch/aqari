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
import { putAttachmentFile } from '../files/store';
import { fmt } from '../domain/money';
// منتقي الملفات والكاميرا والمشاركة والطباعة نوافذ يفتحها التطبيق: العودة القصيرة منها لا تُقفله (#51)
import { whilePrompting } from '../services/appLockService';

export interface PickedFile {
  uri: string;
  name: string;
  mime: string;
  /** أبعاد الصورة إن عرفها المنتقي · تُصغَّر بها صورة رمز الفاتورة قبل قراءته (ق٠-٣) */
  width?: number;
  height?: number;
}

const SIZE_WARN = 50 * 1024 * 1024;
const VIDEO_WARN = 25 * 1024 * 1024;

/** كل أنواع الملفات · لا ترشيح */
export async function pickFile(types: string[] = ['*/*']): Promise<PickedFile | null> {
  const res = await whilePrompting(() => DocumentPicker.getDocumentAsync({ type: types, copyToCacheDirectory: true }));
  if (res.canceled || !res.assets?.length) return null;
  const a = res.assets[0];
  return { uri: a.uri, name: a.name ?? 'ملف', mime: a.mimeType ?? '' };
}

/** صور ومقاطع من المعرض · بلا خيار جودة = بلا إعادة ترميز، الملف يمرّ كما هو */
export async function pickFromGallery(mediaTypes: ImagePicker.MediaType[] = ['images', 'videos']): Promise<PickedFile | null> {
  const res = await whilePrompting(() => ImagePicker.launchImageLibraryAsync({
    mediaTypes,
  }));
  if (res.canceled || !res.assets?.length) return null;
  const a = res.assets[0];
  const ext = a.uri.split('.').pop() || (a.type === 'video' ? 'mp4' : 'jpg');
  return {
    uri: a.uri,
    name: a.fileName ?? `${a.type === 'video' ? 'مقطع' : 'صورة'}.${ext}`,
    mime: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
    ...(a.width && a.height ? { width: a.width, height: a.height } : {}),
  };
}

/** تصوير مباشر بالكاميرا (صورة أو مقطع) · بلا خيار جودة = بلا إعادة ترميز */
export async function captureWithCamera(mediaTypes: ImagePicker.MediaType[] = ['images', 'videos']): Promise<PickedFile | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return null;
  const res = await whilePrompting(() => ImagePicker.launchCameraAsync({ mediaTypes }));
  if (res.canceled || !res.assets?.length) return null;
  const a = res.assets[0];
  return {
    uri: a.uri,
    name: a.fileName ?? `تصوير · ${Date.now()}.${a.type === 'video' ? 'mp4' : 'jpg'}`,
    mime: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
    ...(a.width && a.height ? { width: a.width, height: a.height } : {}),
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

/** نسخة المنتقي المؤقتة تُحذف · بعد الحفظ، وحين يتراجع المستخدم عن سؤال الحجم (E-9: كانت تبقى حتى الإقلاع التالي) */
function dropPickerCopy(uri: string): void {
  try {
    if (uri.startsWith(Paths.cache.uri)) {
      const tmp = new File(uri);
      if (tmp.exists) tmp.delete();
    }
  } catch { /* تُكنس في الإقلاع التالي */ }
}

/**
 * إرفاق الملف المختار · يعيد true إن حُفظ (المراجعة الشاملة 2026-11-13 · E-9): الحجم من النظام قبل أي قراءة فيُسأل عنه أولاً، والملف
 * يُنسخ إلى المرفقات نسخاً وبصمته على قطع (putAttachmentFile)، فلا يُقرأ المقطع الكبير كله في الذاكرة
 */
export async function attachPicked(
  db: DB,
  file: PickedFile,
  entityType: string,
  entityId: string,
  kind: string
): Promise<boolean> {
  const size = new File(file.uri).size ?? 0;
  const mb = (n: number) => fmt(Math.round((n / (1024 * 1024)) * 100)) ;
  const isVideo = file.mime.startsWith('video/');
  if (isVideo && size > VIDEO_WARN) {
    // سؤال لا منع · ولا إعادة ترميز للمقاطع إطلاقاً
    const ok = await confirmSize('مقطع كبير', `هذا المقطع ${mb(size)} ميغابايت · هل تحفظه؟`);
    if (!ok) { dropPickerCopy(file.uri); return false; }
  } else if (!isVideo && size > SIZE_WARN) {
    const ok = await confirmSize('ملف كبير', `حجم الملف ${mb(size)} ميغابايت وسيدخل في النسخ الاحتياطية · هل تحفظه؟`);
    if (!ok) { dropPickerCopy(file.uri); return false; }
  }
  // نزع البيانات الوصفية في putAttachment نفسها لكل مسار (المراجعة الخارجية ٧ · النتيجة ٢٧) · ويمرّ بها putAttachmentFile للصور
  await putAttachmentFile(appFilesEnv(db), file.uri, {
    entityType,
    entityId,
    kind,
    originalName: file.name,
    mime: file.mime,
  });
  // النسخ نجح وتُحقق منه داخل putAttachmentFile · نسخة المنتقي المؤقتة تُحذف فلا يبقى مكرَّر
  dropPickerCopy(file.uri);
  return true;
}

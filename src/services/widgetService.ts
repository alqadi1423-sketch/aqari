/**
 * كتابة لقطة الودجت إلى ملف يقرؤه أندرويد · الطرف التطبيقي من الجسر.
 *
 * والكتابة **مؤجَّلة مجمَّعة** لا فورية: بناء اللقطة يمسح كل الأقساط ويحسب
 * الإشغال والنقد، وهذا ثقيل لا يجوز أن يركب كل `bump` — والتحصيل الواحد
 * يستدعي `bump` أكثر من مرة. فتُجدول الكتابة بعد سكون قصير، وتُلغى الجدولة
 * السابقة كلما جاء تغيير جديد، فتقع كتابة واحدة بعد آخر تغيير لا عشر.
 *
 * وأي فشل يُسجَّل ولا يُرمى: الودجت زينة لا شرط لعمل التطبيق.
 */
import { Platform } from 'react-native';
import { appDataRoot, expoFs } from '../files/expoFs';
import { joinPath } from '../files/fsAdapter';
import { buildWidgetSnapshot, WIDGET_FILE, type WidgetSnapshot } from './widgetSnapshot';
import type { DB } from '../db/adapter';

const enc = new TextEncoder();

/** سكونٌ بعد آخر تغيير قبل الكتابة · يجمع رشقة التغييرات في كتابة واحدة */
const QUIET_MS = 1200;

let timer: ReturnType<typeof setTimeout> | null = null;

/** مسار ملف اللقطة · مجلد التطبيق الداخلي لا مجلداً عاماً */
export function widgetFilePath(): string {
  return joinPath(appDataRoot(), WIDGET_FILE);
}

/** الكتابة الفعلية · تُستدعى من الجدولة أو من الإقلاع مباشرةً */
export function writeWidgetSnapshot(db: DB): WidgetSnapshot | null {
  if (Platform.OS !== 'android') return null;
  try {
    const snap = buildWidgetSnapshot(db);
    expoFs.write(widgetFilePath(), enc.encode(JSON.stringify(snap)));
    return snap;
  } catch (e) {
    console.error('[عقاري] تعذّرت كتابة لقطة الودجت · '
      + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
    return null;
  }
}

/** جدولة كتابة بعد سكون · تُلغي جدولةً سابقة فلا تتراكم */
export function scheduleWidgetSnapshot(db: DB): void {
  if (Platform.OS !== 'android') return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; writeWidgetSnapshot(db); }, QUIET_MS);
}

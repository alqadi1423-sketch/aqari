/**
 * كتابة لقطة الودجت إلى ملف يقرؤه أندرويد · الطرف التطبيقي من الجسر.
 *
 * والكتابة **مؤجَّلة مجمَّعة** لا فورية: بناء اللقطة يمسح كل الأقساط ويحسب
 * الإشغال والنقد، وهذا ثقيل لا يجوز أن يركب كل `bump` — والتحصيل الواحد
 * يستدعي `bump` أكثر من مرة. فتُجدول الكتابة بعد سكون قصير، وتُلغى الجدولة
 * السابقة كلما جاء تغيير جديد، فتقع كتابة واحدة بعد آخر تغيير لا عشر.
 *
 * وأي فشل يُسجَّل ولا يُرمى: الودجت زينة لا شرط لعمل التطبيق.
 *
 * وحال قفل التطبيق تُقرأ عند كل كتابة من علامته (lockMaybeOn · تعذّر فحصها يُعدّ «مفعّل»)، فالقفل المفعّل يكتب لقطةً
 * بلا مبالغ (المراجعة الشاملة · البند ٢٣) · وتفعيله أو إطفاؤه يعيد الكتابة فوراً ولا ينتظر تغييراً في البيانات.
 */
import { Platform } from 'react-native';
import { appDataRoot, expoFs } from '../files/expoFs';
import { joinPath } from '../files/fsAdapter';
import { buildWidgetSnapshot, WIDGET_FILE, type WidgetSnapshot } from './widgetSnapshot';
import { lockMaybeOn, onLockChange } from './appLockService';
import { readAccess } from './access';
import { today } from '../domain/dates';
import type { DB } from '../db/adapter';

const enc = new TextEncoder();

/** سكونٌ بعد آخر تغيير قبل الكتابة · يجمع رشقة التغييرات في كتابة واحدة */
const QUIET_MS = 1200;

let timer: ReturnType<typeof setTimeout> | null = null;
/** آخر قاعدة كُتبت منها اللقطة وحال القفل فيها · ليُعاد بناؤها حين يتغيّر القفل وحده */
let lastDb: DB | null = null;
let lastLocked: boolean | null = null;

/** مسار ملف اللقطة · مجلد التطبيق الداخلي لا مجلداً عاماً */
export function widgetFilePath(): string {
  return joinPath(appDataRoot(), WIDGET_FILE);
}

/** الكتابة الفعلية · تُستدعى من الجدولة أو من الإقلاع مباشرةً */
export function writeWidgetSnapshot(db: DB): WidgetSnapshot | null {
  if (Platform.OS !== 'android') return null;
  lastDb = db;
  const locked = lockMaybeOn();
  try {
    const snap = buildWidgetSnapshot(db, today(), readAccess(db), { locked });
    expoFs.write(widgetFilePath(), enc.encode(JSON.stringify(snap)));
    lastLocked = locked;
    return snap;
  } catch (e) {
    console.error('[عقاري] تعذّرت كتابة لقطة الودجت · '
      + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
    // والقفل مفعّل: لقطةٌ سابقة كُتبت والتطبيق مفتوح لا تبقى بمبالغها · بلا ملف تعرض الودجت «لا بيانات بعد»
    if (locked) { try { expoFs.remove(widgetFilePath()); lastLocked = locked; } catch { /* لا يُرمى */ } }
    return null;
  }
}

// تفعيل القفل أو إطفاؤه يعيد كتابة اللقطة فوراً · وما لا يغيّر حاله (محاولة رمز، تغيير المهلة) لا يعيد بناءها
onLockChange(() => {
  if (lastDb && lockMaybeOn() !== lastLocked) writeWidgetSnapshot(lastDb);
});

/** جدولة كتابة بعد سكون · تُلغي جدولةً سابقة فلا تتراكم */
export function scheduleWidgetSnapshot(db: DB): void {
  if (Platform.OS !== 'android') return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; writeWidgetSnapshot(db); }, QUIET_MS);
}

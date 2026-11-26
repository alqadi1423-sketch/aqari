/**
 * التنبيهات · تُبنى فعلياً بـ expo-notifications:
 * مهل قابلة للاختيار، تذكير أسبوعي بالتصدير، وإعادة الجدولة عند كل تغيير.
 */
import * as Notifications from 'expo-notifications';
import type { DB } from '../db/adapter';
import { computeSchedule, planReminderDelivery } from '../domain/reminders';
import { getMeta, getSetting, setMeta } from '../repos/settings';
import { uid } from '../domain/ids';
import { t } from '../i18n';

/** مواعيد ما فات موعده فجُدول بعد دقيقة · في meta هذا الجهاز (E-12) */
const CATCH_UP_KEY = 'reminders_catch_up';

/**
 * هل اختار المستخدم مجلد النسخ على هذا الجهاز · يُحمَّل عند الحاجة: وحدة المجلد تحمل وحدات الملفات الأصلية، والجدولة تُختبر بدونها
 * (وتعذّر قراءته يُعامل كأن لا مجلد، فيطلب التذكير اختياره)
 */
function hasBackupFolder(): boolean {
  try { return !!(require('./backupFolder') as typeof import('./backupFolder')).backupFolder(); } catch { return false; }
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * قناة التذكيرات بخصوصية شاشة القفل · المحتوى يُخفى على القفل الآمن حين يطلب النظام ذلك ·
 * ونصّ التنبيه نفسه بلا اسم مستأجر (reminders.ts) فلا يكشف أحداً ولو عُرض كاملاً.
 */
const CHANNEL = 'reminders';
async function ensureChannel(): Promise<void> {
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: 'التذكيرات',
      importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      sound: null,
    });
  } catch { /* منصة بلا قنوات */ }
}

export async function ensurePermission(): Promise<boolean> {
  try {
    const cur = await Notifications.getPermissionsAsync();
    if (cur.granted) return true;
    const req = await Notifications.requestPermissionsAsync();
    return req.granted;
  } catch {
    return false;
  }
}

const WEEKLY_ID = 'weekly-export-reminder';

/**
 * إلغاء التذكيرات المجدولة عند النظام وسجلّها (المراجعة الخارجية ٧ · النتيجة ٣٠): بعد التفريغ والإزالة والخروج كانت تبقى فتُظهر
 * أسماء وحدات حسابٍ لم يعد على الجهاز حتى يُفتح التطبيق · وتُعاد جدولتها من بيانات الجهاز عند الإقلاع وبعد كل تغيير
 */
export function cancelAllNotifications(db?: DB | null): Promise<void> {
  return serial(async () => {
    try { await Notifications.cancelAllScheduledNotificationsAsync(); } catch { /* لا إذن */ }
    try { db?.run(`DELETE FROM scheduled_notifications`); } catch { /* مغلقة */ }
  });
}

/**
 * تشغيلٌ واحد في كل لحظة (المراجعة الشاملة · البند ١٩): جدولتان متزامنتان كانتا تمسحان ثم تجدولان فتتداخلان بعد المسح فتتكرر
 * التنبيهات · فكل تشغيلٍ ينتظر الذي قبله، وفشل أحدها لا يوقف ما بعده
 */
let chain: Promise<void> = Promise.resolve();
function serial(fn: () => Promise<void>): Promise<void> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/**
 * إعادة الجدولة الكاملة · تُستدعى بعد كل تغيير في العقود أو الدفعات
 * أو المستندات أو الإعدادات، وعند إقلاع التطبيق.
 */
export function rescheduleAllNotifications(db: DB, o: { ask?: boolean } = {}): Promise<void> {
  return serial(() => rescheduleNow(db, o.ask !== false));
}

/** سكونٌ بعد آخر كتابة قبل الجدولة · إعادة الجدولة نحو خمسين نداء جسر، فلا تركب كل كتابة */
const AFTER_WRITE_QUIET_MS = 8000;
let afterWriteTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * جدولةٌ مؤجلة مجمَّعة بعد كل كتابة (المراجعة الشاملة 2026-11-13 · E-2) · تُنادى من `bump` نفسه، فتشمل كل تغيير في الشاشات
 * وكل ما يصل بالمزامنة وكشف البنك وإلغاء الدفعة والموعد المتفق عليه ومستندات المنشأة · وتُلغي جدولةً سابقة فلا تتراكم.
 * ولا تسأل عن الإذن في الخلفية: بلا إذنٍ لا تفعل شيئاً، والسؤال من مفتاح التذكيرات في الإعدادات.
 */
export function scheduleNotificationsAfterWrite(db: DB, quietMs: number = AFTER_WRITE_QUIET_MS): void {
  if (afterWriteTimer) clearTimeout(afterWriteTimer);
  afterWriteTimer = setTimeout(() => {
    afterWriteTimer = null;
    rescheduleAllNotifications(db, { ask: false }).catch(() => {});
  }, quietMs);
}

/** تنتهي حين تنتهي الجدولة الجارية وما قبلها (للاختبار ولمن ينتظر) */
export function whenNotificationsIdle(): Promise<void> {
  return chain;
}

async function rescheduleNow(db: DB, ask: boolean): Promise<void> {
  let ok: boolean;
  if (ask) ok = await ensurePermission();
  else { try { ok = (await Notifications.getPermissionsAsync()).granted; } catch { ok = false; } }
  if (!ok) return;
  await ensureChannel();
  await Notifications.cancelAllScheduledNotificationsAsync();
  db.transaction(() => {
    db.run(`DELETE FROM scheduled_notifications`);
  });

  const schedule = computeSchedule(db);
  // حد نظامي معقول لعدد المجدولات (iOS يسمح بـ64)
  const limited = schedule.sort((a, b) => (a.fireDate < b.fireDate ? -1 : 1)).slice(0, 50);
  // ما فات موعده يُطلق بعد دقيقة مرةً واحدة، وموعده محفوظٌ على هذا الجهاز بين الجدولات (E-12)
  let caught: Record<string, number> = {};
  try { caught = JSON.parse(getMeta(db, CATCH_UP_KEY) || '{}') as Record<string, number>; } catch { caught = {}; }
  const { plan, caught: nextCaught } = planReminderDelivery(limited, Date.now(), caught);
  try { setMeta(db, CATCH_UP_KEY, JSON.stringify(nextCaught)); } catch { /* مغلقة */ }
  for (const { item: s, at } of plan) {
    const when = new Date(at);
    try {
      const osId = await Notifications.scheduleNotificationAsync({
        content: { title: s.title, body: s.body },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when, channelId: CHANNEL },
      });
      db.run(
        `INSERT INTO scheduled_notifications (id, kind, entity_id, fire_at, os_id) VALUES (?,?,?,?,?)`,
        [uid(), s.kind, s.entityId, s.fireDate, osId]
      );
    } catch { /* منصة لا تدعم الجدولة */ }
  }

  // التذكير الأسبوعي بالتصدير خارج الجهاز
  if (getSetting(db, 'backupWeekly')) {
    try {
      const osId = await Notifications.scheduleNotificationAsync({
        identifier: WEEKLY_ID,
        // النسخ لم تعد تُرفع إلى Drive (ق٠-١): يذكّر بالحفظ في المجلد المختار، وبلا مجلدٍ يطلب اختياره
        content: { title: t('folder.reminderTitle'), body: t(hasBackupFolder() ? 'folder.reminderSave' : 'folder.reminderPick') },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
          weekday: 6, // الجمعة
          hour: 10,
          minute: 0,
          channelId: CHANNEL,
        },
      });
      db.run(
        `INSERT INTO scheduled_notifications (id, kind, entity_id, fire_at, os_id) VALUES (?,?,?,?,?)`,
        [uid(), 'weekly-export', '-', 'weekly', osId]
      );
    } catch { /* تجاهل */ }
  }
}

/**
 * التنبيهات · تُبنى فعلياً بـ expo-notifications:
 * مهل قابلة للاختيار، تذكير أسبوعي بالتصدير، وإعادة الجدولة عند كل تغيير.
 */
import * as Notifications from 'expo-notifications';
import type { DB } from '../db/adapter';
import { computeSchedule } from '../domain/reminders';
import { getSetting } from '../repos/settings';
import { uid } from '../domain/ids';

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
 * إعادة الجدولة الكاملة · تُستدعى بعد كل تغيير في العقود أو الدفعات
 * أو المستندات أو الإعدادات، وعند إقلاع التطبيق.
 */
export async function rescheduleAllNotifications(db: DB): Promise<void> {
  const ok = await ensurePermission();
  if (!ok) return;
  await ensureChannel();
  await Notifications.cancelAllScheduledNotificationsAsync();
  db.transaction(() => {
    db.run(`DELETE FROM scheduled_notifications`);
  });

  const schedule = computeSchedule(db);
  // حد نظامي معقول لعدد المجدولات (iOS يسمح بـ64)
  const limited = schedule.sort((a, b) => (a.fireDate < b.fireDate ? -1 : 1)).slice(0, 50);
  for (const s of limited) {
    const when = new Date(s.fireDate + 'T09:00:00');
    if (when.getTime() <= Date.now()) continue;
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
        content: {
          title: 'تذكير النسخ الاحتياطي',
          body: 'صدّر نسخة احتياطية خارج الجهاز · النسخة التي تجلس بجوار البيانات لا تحميك من جوال ضائع.',
        },
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

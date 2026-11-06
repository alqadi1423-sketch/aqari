/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ١٩: إعادة جدولة التنبيهات مرتين في وقتٍ واحد كانت تكرر التنبيهات: كلٌّ يمسح ثم يجدول،
 * فيتداخلان بعد المسح · الآن تُسلسل فلا يبدأ تشغيلٌ قبل انتهاء الذي قبله · بيانات مصطنعة وتنبيهات نظامٍ مصطنعة.
 */
const mockOs: Array<{ id: string; title: string }> = [];
let mockSeq = 0;
jest.mock('expo-notifications', () => ({
  setNotificationHandler: () => undefined,
  getPermissionsAsync: async () => ({ granted: true }),
  requestPermissionsAsync: async () => ({ granted: true }),
  setNotificationChannelAsync: async () => undefined,
  cancelAllScheduledNotificationsAsync: async () => { await new Promise((r) => setTimeout(r, 2)); mockOs.length = 0; },
  scheduleNotificationAsync: async (req: { content: { title: string } }) => {
    await new Promise((r) => setTimeout(r, 1));
    const id = 'os-' + ++mockSeq;
    mockOs.push({ id, title: req.content.title });
    return id;
  },
  AndroidImportance: { DEFAULT: 3 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
  SchedulableTriggerInputTypes: { DATE: 'date', WEEKLY: 'weekly' },
}), { virtual: true });

import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { setSetting } from '@/repos/settings';
import { addMonthsClamped, today } from '@/domain/dates';
import { computeSchedule } from '@/domain/reminders';
import { rescheduleAllNotifications } from '@/services/notifications';

test('١٩ جدولتان متزامنتان لا تكرران التنبيهات: ما عند النظام بعدد المجدول مرةً واحدة', async () => {
  const db = memDb();
  setSetting(db, 'remindersOn', true);
  const start = addMonthsClamped(today(), 1);
  confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'N-1' }),
    { start, end: addMonthsClamped(start, 6), depositHalalas: 0 }));
  const want = computeSchedule(db).length;
  expect(want).toBeGreaterThan(1);
  await Promise.all([rescheduleAllNotifications(db), rescheduleAllNotifications(db), rescheduleAllNotifications(db)]);
  const rows = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM scheduled_notifications`)!.n);
  expect(mockOs.length).toBe(rows);
  expect(new Set(mockOs.map((o) => o.id)).size).toBe(mockOs.length);
  expect(rows).toBeLessThanOrEqual(Math.min(50, want) + 1);
  db.close();
});

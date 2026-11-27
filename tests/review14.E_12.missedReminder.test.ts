/**
 * المراجعة الشاملة 2026-11-13 · E-12 · منخفض · التذكير الذي فات موعد إطلاقه لا يُجدول أبداً.
 * السيناريو: مهلة الدفعة ٧ أيام، وعقدٌ يُنشأ اليوم وأول قسطٍ بعد ٣ أيام ← موعد الإطلاق قبل ٤ أيام فيُسقط ← لا تذكير أبداً.
 * ومثله ما موعده اليوم والساعة بعد التاسعة، ورفع المهلة من ٣ إلى ١٤.
 * الصحيح: ما فات موعده والاستحقاق لم يأتِ يُطلق اليوم، بعد دقيقةٍ إن جاوزت التاسعة · مرةً واحدة: الجدولة التالية (بعد كل كتابة)
 * تُبقي موعده إن لم يحن بعد، ولا تعيده بعد أن أُطلق. بيانات مصطنعة.
 */
const mockOs: Array<{ id: string; title: string; date: number }> = [];
let mockSeq = 0;
jest.mock('expo-notifications', () => ({
  setNotificationHandler: () => undefined,
  getPermissionsAsync: async () => ({ granted: true }),
  requestPermissionsAsync: async () => ({ granted: true }),
  setNotificationChannelAsync: async () => undefined,
  cancelAllScheduledNotificationsAsync: async () => { mockOs.length = 0; },
  scheduleNotificationAsync: async (req: { content: { title: string }; trigger: { date?: Date } }) => {
    const id = 'os-' + ++mockSeq;
    mockOs.push({ id, title: req.content.title, date: req.trigger.date ? req.trigger.date.getTime() : 0 });
    return id;
  },
  AndroidImportance: { DEFAULT: 3 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
  SchedulableTriggerInputTypes: { DATE: 'date', WEEKLY: 'weekly' },
}));

import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import { confirmContract } from '@/domain/contracts/service';
import { setSetting } from '@/repos/settings';
import { addDays, addMonthsClamped, today } from '@/domain/dates';
import { computeSchedule, planReminderDelivery, type ScheduledReminder } from '@/domain/reminders';
import { rescheduleAllNotifications } from '@/services/notifications';

const item = (fireDate: string, dueDate: string): ScheduledReminder =>
  ({ kind: 'payment', entityId: 'I-1', fireDate, dueDate, title: 'دفعة تقترب', body: 'وحدة مصطنعة' });

test('E-12 قسطٌ بعد ٣ أيام ومهلته ٧: التذكير اليوم لا يُسقط', () => {
  const db = memDb();
  setSetting(db, 'remindersOn', true);
  setSetting(db, 'remindPayment', 7);
  const T = '2026-03-01';
  confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'E-12' }),
    { start: '2026-03-04', end: '2026-08-31', depositHalalas: 0 }));
  const pay = computeSchedule(db, T).filter((s) => s.kind === 'payment');
  const first = pay.find((s) => s.dueDate === '2026-03-04');
  expect(first).toBeDefined();
  expect(first!.fireDate).toBe(T);
  db.close();
});

test('E-12 ما فات موعده يُطلق بعد دقيقة مرةً واحدة، ويبقى موعده إن أُعيدت الجدولة قبله', () => {
  const now = new Date('2026-03-01T10:30:00').getTime();
  const it = item('2026-03-01', '2026-03-04');
  const a = planReminderDelivery([it], now, {});
  expect(a.plan).toHaveLength(1);
  expect(a.plan[0].at).toBe(now + 60_000);
  // جدولةٌ ثانية بعد ٨ ثوانٍ (كتابةٌ أخرى) قبل الإطلاق: الموعد نفسه لا يضيع
  const b = planReminderDelivery([it], now + 8_000, a.caught);
  expect(b.plan.map((p) => p.at)).toEqual([now + 60_000]);
  // بعد الإطلاق: لا يُعاد
  const c = planReminderDelivery([it], now + 120_000, b.caught);
  expect(c.plan).toEqual([]);
  // وما موعده آتٍ يُجدول في التاسعة كما كان
  const d = planReminderDelivery([item('2026-03-02', '2026-03-09')], now, {});
  expect(d.plan[0].at).toBe(new Date('2026-03-02T09:00:00').getTime());
  // والقسط الذي سُدِّد أو مضى يخرج من الذاكرة
  expect(planReminderDelivery([], now, c.caught).caught).toEqual({});
});

// الساعة مثبّتة: كان الاختبار يقرأ ساعة الجهاز فيسقط قبل التاسعة بتوقيت الرياض (الفائت حينها يُجدول في تاسعة اليوم نفسه، وهو
// المقصود: لا تنبيه بعد منتصف الليل) · سقط على جيت هب في التشغيل 45898085309 عند ٠٠:٤٤ (فقط Date مزيَّف، والمؤقتات حقيقية)
const atClock = (iso: string) => jest.useFakeTimers({ now: new Date(iso), doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask'] });
afterEach(() => { jest.useRealTimers(); });

test('E-12 الخدمة قبل التاسعة: الفائت يُجدول في تاسعة اليوم نفسه لا بعد دقيقة', async () => {
  atClock('2026-03-01T00:44:00');
  const db = memDb();
  setSetting(db, 'remindersOn', true);
  setSetting(db, 'remindPayment', 14);
  const T = today();
  expect(T).toBe('2026-03-01');
  const start = addDays(T, 3);
  confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'E-12c' }),
    { start, end: addMonthsClamped(start, 2), depositHalalas: 0 }));
  const before = Date.now();
  await rescheduleAllNotifications(db, { ask: false });
  const nine = new Date('2026-03-01T09:00:00').getTime();
  expect(mockOs.filter((o) => o.date > before && o.date <= before + 61_000)).toHaveLength(0);
  expect(mockOs.some((o) => o.date === nine)).toBe(true);
  db.close();
});

test('E-12 الخدمة تجدول الفائت بعد دقيقة ولا تكرره بإعادة الجدولة', async () => {
  atClock('2026-03-01T10:30:00');
  const db = memDb();
  setSetting(db, 'remindersOn', true);
  setSetting(db, 'remindPayment', 14);
  const T = today();
  const start = addDays(T, 3);
  confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'E-12b' }),
    { start, end: addMonthsClamped(start, 2), depositHalalas: 0 }));
  const before = Date.now();
  await rescheduleAllNotifications(db, { ask: false });
  const soon = mockOs.filter((o) => o.date > before && o.date <= Date.now() + 61_000);
  expect(soon.length).toBeGreaterThanOrEqual(1);
  await rescheduleAllNotifications(db, { ask: false });
  const again = mockOs.filter((o) => o.date > before && o.date <= Date.now() + 61_000);
  expect(again.length).toBe(soon.length);
  db.close();
});

test('E-12 (المدقق المستقل): مرةً واحدة عبر الأيام · ولا يُعاد ما أُطلق في التاسعة إن أُعيدت الجدولة بعدها', () => {
  const db = memDb();
  setSetting(db, 'remindersOn', true);
  setSetting(db, 'remindPayment', 7);
  confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: 'E-12b' }),
    { start: '2026-03-05', end: '2026-08-31', depositHalalas: 0 }));
  // كل فتحٍ للتطبيق يعيد الجدولة كلها، وما خُطِّط بموعدٍ قبل الفتح التالي أُطلق فعلاً
  const opens = ['2026-03-01T10:00:00', '2026-03-01T18:00:00', '2026-03-02T08:00:00', '2026-03-02T12:00:00',
    '2026-03-03T08:30:00', '2026-03-03T13:00:00', '2026-03-04T20:00:00'];
  let caught: Record<string, number> = {};
  let pending: number[] = [];
  const fired: number[] = [];
  for (const o of opens) {
    const now = new Date(o).getTime();
    fired.push(...pending.filter((at) => at <= now));
    const items = computeSchedule(db, o.slice(0, 10)).filter((s) => s.kind === 'payment' && s.dueDate === '2026-03-05');
    const r = planReminderDelivery(items, now, caught);
    caught = r.caught;
    pending = r.plan.map((p) => p.at);
  }
  fired.push(...pending);
  expect(fired).toEqual([new Date('2026-03-01T10:01:00').getTime()]);

  // قسطٌ يحين تذكيره في التاسعة: يُطلق، ثم جدولةٌ في الظهر لا تعيده بعد دقيقة
  const it = item('2026-03-10', '2026-03-17');
  const a = planReminderDelivery([it], new Date('2026-03-10T08:00:00').getTime(), {});
  expect(a.plan.map((p) => p.at)).toEqual([new Date('2026-03-10T09:00:00').getTime()]);
  expect(planReminderDelivery([it], new Date('2026-03-10T12:00:00').getTime(), a.caught).plan).toEqual([]);
  // ومهلةٌ رُفعت قبل الإطلاق تُقدّم موعده
  const later = planReminderDelivery([item('2026-03-12', '2026-03-17')], new Date('2026-03-10T08:00:00').getTime(), {});
  const raised = planReminderDelivery([item('2026-03-10', '2026-03-17')], new Date('2026-03-10T10:00:00').getTime(), later.caught);
  expect(raised.plan.map((p) => p.at)).toEqual([new Date('2026-03-10T10:01:00').getTime()]);
  db.close();
});

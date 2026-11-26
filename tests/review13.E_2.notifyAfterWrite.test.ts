/**
 * المراجعة الشاملة 2026-11-13 · E-2: التنبيهات لا تُعاد جدولتها بعد أغلب التغييرات (المزامنة وكشف البنك وإلغاء الدفعة والموعد المتفق
 * عليه ومستندات المنشأة وتبديل الحساب) · الآن جدولةٌ مؤجلة مجمَّعة في `bump` نفسه، وتبديل نسخة الحساب يلغي تنبيهات المركونة.
 * بيانات مصطنعة وتنبيهات نظامٍ مصطنعة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const mockOs: Array<{ id: string; title: string; body: string }> = [];
let mockSeq = 0;
let mockGranted = true;
let mockAsked = 0;
jest.mock('expo-notifications', () => ({
  setNotificationHandler: () => undefined,
  getPermissionsAsync: async () => ({ granted: mockGranted }),
  requestPermissionsAsync: async () => { mockAsked++; return { granted: mockGranted }; },
  setNotificationChannelAsync: async () => undefined,
  cancelAllScheduledNotificationsAsync: async () => { mockOs.length = 0; },
  scheduleNotificationAsync: async (req: { content: { title: string; body: string } }) => {
    const id = 'os-' + ++mockSeq;
    mockOs.push({ id, title: req.content.title, body: req.content.body });
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
import { addMonthsClamped, addDays, today } from '@/domain/dates';
import * as notif from '@/services/notifications';

const ROOT = path.join(__dirname, '..');
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

type Sched = { scheduleNotificationsAfterWrite(db: unknown, quietMs?: number): void; whenNotificationsIdle(): Promise<void> };
const api = notif as unknown as Sched;

function setup() {
  const db = memDb();
  setSetting(db, 'remindersOn', true);
  setSetting(db, 'remindPayment', 7);
  const start = addDays(today(), 20);
  confirmContract(db, contractInput(addUnit(db, addProperty(db, { name: 'عقار مصطنع' }), { unit_no: '12' }),
    { start, end: addMonthsClamped(start, 6), depositHalalas: 0 }));
  return db;
}

const scheduledFor = (db: ReturnType<typeof memDb>, id: string) =>
  Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM scheduled_notifications WHERE entity_id = ?`, [id])!.n);

test('E-2 دفعةٌ تصل بالمزامنة ثم bump: يخلو الجدول من القسط المسدَّد بعد السكون', async () => {
  const db = setup();
  await notif.rescheduleAllNotifications(db);
  const first = db.get<{ id: string; amount_halalas: number }>(
    `SELECT id, amount_halalas FROM contract_installments ORDER BY due_date LIMIT 1`)!;
  expect(scheduledFor(db, first.id)).toBe(1);
  // ما تكتبه المزامنة: القسط مسدَّد كاملاً من جهاز موظف التحصيل
  db.run(`UPDATE contract_installments SET paid_halalas = amount_halalas, status = 'مدفوعة' WHERE id = ?`, [first.id]);
  expect(typeof api.scheduleNotificationsAfterWrite).toBe('function');
  api.scheduleNotificationsAfterWrite(db, 5);
  // رشقة تغييرات تُجمع في جدولةٍ واحدة
  api.scheduleNotificationsAfterWrite(db, 5);
  await new Promise((r) => setTimeout(r, 30));
  await api.whenNotificationsIdle();
  expect(scheduledFor(db, first.id)).toBe(0);
  const rows = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM scheduled_notifications`)!.n);
  expect(mockOs.length).toBe(rows);
  db.close();
});

test('E-2 الجدولة بعد الكتابة لا تطلب الإذن في الخلفية: بلا إذنٍ لا سؤال ولا جدولة', async () => {
  const db = setup();
  mockGranted = false;
  const before = mockAsked;
  api.scheduleNotificationsAfterWrite(db, 1);
  await new Promise((r) => setTimeout(r, 20));
  await api.whenNotificationsIdle();
  expect(mockAsked).toBe(before);
  mockGranted = true;
  db.close();
});

test('E-2 bump يجدول التنبيهات، وتبديل نسخة الحساب يلغي تنبيهات المركونة، ولا نداءات متفرقة بعد bump', () => {
  const store = src('src/ui/store.tsx');
  const bump = store.slice(store.indexOf('const bump = useCallback'), store.indexOf('}, [db]);', store.indexOf('const bump = useCallback')));
  expect(bump).toMatch(/scheduleNotificationsAfterWrite\(db\)/);
  const cloud = src('src/services/cloud.ts');
  const act = cloud.slice(cloud.indexOf('export async function activateAccount'), cloud.indexOf('/** بيانات بلا حساب على الجهاز'));
  expect(act).toMatch(/switchTo\(env, u\.uid\)[\s\S]*cancelAllNotifications\(db\)/);
  expect(src('app/(tabs)/contracts.tsx')).not.toMatch(/rescheduleAllNotifications/);
  expect(src('app/(tabs)/collect.tsx')).not.toMatch(/rescheduleAllNotifications/);
});

/**
 * ق٠-١ · النسخ الجديدة لا تذهب إلى Drive: لا رفع في التطبيق خارج وحدة Drive نفسها (لم يكن رفعٌ تلقائي، وزرّ «نسخ إلى Google Drive» أُزيل)،
 * والتذكير الأسبوعي يطلب الحفظ في المجلد، وبلا مجلدٍ يطلب اختياره · وشاشة «نسخك على Google Drive» للمالك والمدير الداخلَين وحدهما،
 * وتختفي بعد سحب الإذن · بيانات مصطنعة وتنبيهات نظامٍ مصطنعة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const mockOs: Array<{ id?: string; title: string; body: string }> = [];
jest.mock('expo-notifications', () => ({
  setNotificationHandler: () => undefined,
  getPermissionsAsync: async () => ({ granted: true }),
  requestPermissionsAsync: async () => ({ granted: true }),
  setNotificationChannelAsync: async () => undefined,
  cancelAllScheduledNotificationsAsync: async () => { mockOs.length = 0; },
  scheduleNotificationAsync: async (req: { identifier?: string; content: { title: string; body: string } }) => {
    mockOs.push({ id: req.identifier, title: req.content.title, body: req.content.body });
    return 'os-' + mockOs.length;
  },
  AndroidImportance: { DEFAULT: 3 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
  SchedulableTriggerInputTypes: { DATE: 'date', WEEKLY: 'weekly' },
}));
const mockFolder = { uri: null as string | null };
jest.mock('@/services/backupFolder', () => ({ backupFolder: () => mockFolder.uri }));

/* eslint-disable import/first */
import { memDb } from './helpers/testDb';
import { setSetting } from '@/repos/settings';
import { rescheduleAllNotifications } from '@/services/notifications';
import { driveExitVisible } from '@/cloud/driveExit';
import { t } from '@/i18n';
/* eslint-enable import/first */

const ROOT = path.resolve(__dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

test('لا رفع نسخةٍ إلى Drive من أي مكانٍ في التطبيق: لا رفعٌ تلقائي، وزرّ الرفع أُزيل فلا يناديه شيء (والكود باقٍ حتى إزالة الشاشة)', () => {
  const rel = (f: string) => f.split(path.sep).join('/');
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const all = [...walk('src'), ...walk('app')];
  // الرفع نفسه: في وحدة Drive، ولا يناديه إلا backupToDrive
  expect(all.filter((f) => rel(f) !== 'src/cloud/drive.ts' && /\b(uploadBackupToDrive|uploadVisibleCopy)\b/.test(read(f))).map(rel))
    .toEqual(['src/services/cloud.ts']);
  const cloud = read('src/services/cloud.ts');
  const body = /export async function backupToDrive[\s\S]*?\n}\n/.exec(cloud)![0];
  expect(cloud.replace(body, '').replace(/^import .*$/gm, '')).not.toMatch(/\b(uploadBackupToDrive|uploadVisibleCopy|addScopes)\b/);
  // وbackupToDrive لا يناديه إلا doDriveBackup في الإعدادات · وdoDriveBackup لا يناديه شيءٌ خارج نفسه (لا زرّ ولا إقلاع ولا جدولة)
  expect(all.filter((f) => rel(f) !== 'src/services/cloud.ts' && /\bbackupToDrive\(/.test(read(f))).map(rel)).toEqual(['app/settings.tsx']);
  const ui = read('app/settings.tsx');
  const fn = /const doDriveBackup = async \(\) => \{[\s\S]*?\n {2}\};\n/.exec(ui)![0];
  expect(fn).toMatch(/backupToDrive\(/);
  expect(ui.replace(fn, '')).not.toMatch(/doDriveBackup|backupToDrive\(/);
});

describe('التذكير الأسبوعي', () => {
  test('بلا مجلدٍ مختار: يطلب اختيار المجلد والحفظ فيه، ويقول إن النسخ لم تعد تُرفع إلى Drive', async () => {
    const db = memDb();
    setSetting(db, 'backupWeekly', true);
    mockFolder.uri = null;
    await rescheduleAllNotifications(db);
    const w = mockOs.filter((o) => o.id === 'weekly-export-reminder');
    expect(w).toHaveLength(1);
    expect(w[0].title).toBe(t('folder.reminderTitle'));
    expect(w[0].body).toBe(t('folder.reminderPick'));
    db.close();
  });

  test('بمجلدٍ مختار: يذكّر بالحفظ فيه', async () => {
    const db = memDb();
    setSetting(db, 'backupWeekly', true);
    mockFolder.uri = 'content://com.android.externalstorage.documents/tree/primary%3AAqari';
    await rescheduleAllNotifications(db);
    const w = mockOs.filter((o) => o.id === 'weekly-export-reminder');
    expect(w).toHaveLength(1);
    expect(w[0].body).toBe(t('folder.reminderSave'));
    expect(w[0].body).not.toMatch(/Drive/);
    db.close();
  });

  test('التذكير المطفأ لا يُجدول', async () => {
    const db = memDb();
    setSetting(db, 'backupWeekly', false);
    await rescheduleAllNotifications(db);
    expect(mockOs.filter((o) => o.id === 'weekly-export-reminder')).toEqual([]);
    db.close();
  });
});

test('شاشة «نسخك على Google Drive»: للمالك أو المدير الداخل المتصل وحده · والعضو لا يراها · وتختفي بعد سحب الإذن', () => {
  const base = { admin: true, signedIn: true, online: true, retired: false };
  expect(driveExitVisible(base)).toBe(true);
  expect(driveExitVisible({ ...base, admin: false })).toBe(false);   // العضو: لم يكن له نسخٌ على Drive (بطاقة النسخ للمالك والمدير)
  expect(driveExitVisible({ ...base, signedIn: false })).toBe(false); // بلا دخول: لا Drive أصلاً
  expect(driveExitVisible({ ...base, online: false })).toBe(false);
  expect(driveExitVisible({ ...base, retired: true })).toBe(false);   // حُذفت وسُحب الإذن: لا يُطلب Drive بعدها
});

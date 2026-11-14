/**
 * مراجعة إصلاح B-2 وB-4 (المراجعة الشاملة 2026-11-13) · منخفض · نسخ الجهاز «منذ الانضمام» تُعرف بساعة الجهاز لا بما فيها، فتبقى نسخةٌ كاملة
 *
 * السيناريو (بيانات مصطنعة): انضمّ العضو وساعة جواله متقدمة (ضُبطت يدوياً أو قبل مزامنة الوقت) فحُفظ member_since بها، ثم صُحّحت الساعة.
 * صنع الجهاز وهو عضو نسخة أمانٍ كاملة (تفريغ تغيّر الصلاحية، أو مسح محادثات المنشأة، أو «فرّغ هذا الجهاز» في قرار العهد، أو نسخة ما قبل
 * الترقية)، واسمها بوقتٍ أقدم من member_since. أزاله المالك: dropMemberBackups (memberExit.ts) يقارن وقت الاسم بـ member_since فيعدّها «قبل
 * انضمامه» ويُبقيها، فتبقى على جواله نسخةٌ كاملة غير مشفّرة من بيانات المنشأة بعضويتها. حارس الاستعادة يمنع استعادتها من داخل التطبيق،
 * لكن الملف نفسه باقٍ، وهو ما نفاه الإصلاح («تُحذف نسخ الجهاز التي صُنعت منذ الانضمام» · «لا تبقى عليه نسخةٌ منها» في ورقة الخروج).
 *
 * لماذا يهم: قرارا المالك س٩ وس١٠ (2026-11-13) وقرار 2026-11-07 (٢ أ) «لا نسخة للعضو المُزال إلا بما لم يُرفع من عمله».
 *
 * السلوك الصحيح: ما يُحذف عند الخروج يُعرف بما في النسخة (عضوية المنشأة في sync_state داخلها) أو بتسجيله عند صنعها، لا بمقارنة ساعة الجهاز ·
 * فلا تبقى بعد الإزالة نسخةٌ فيها عضوية تلك المنشأة مهما كان وقت اسمها، وتبقى نسخ ما قبل الانضمام (بلا عضوية) كما هي.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const kv = new Map<string, string>();
const cloudSide = { calls: [] as string[] };

jest.mock('react-native', () => ({
  Platform: { OS: 'android' }, NativeModules: {}, I18nManager: { isRTL: true, allowRTL: () => {}, forceRTL: () => {} },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => kv.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { kv.set(k, v); },
  deleteItemAsync: async (k: string) => { kv.delete(k); },
}));
jest.mock('expo-network', () => ({ getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }), addNetworkStateListener: () => ({ remove: () => {} }) }));
jest.mock('expo-file-system', () => {
  class F { uri: string; constructor(p: string) { this.uri = String(p); } get exists() { return false; } write() {} delete() {} textSync() { return ''; } }
  return { File: F, Directory: F, Paths: { document: { uri: '/doc' }, cache: { uri: '/cache' } } };
});
jest.mock('expo-file-system/legacy', () => ({ FileSystemUploadType: { BINARY_CONTENT: 0 }, getFreeDiskStorageAsync: async () => 1e12 }));
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: () => {}, getTokens: async () => ({ accessToken: 'T' }), signInSilently: async () => ({ type: 'success' }),
    hasPlayServices: async () => true, signIn: async () => null, signOut: async () => {} },
  isSuccessResponse: () => false,
}));
jest.mock('expo-crypto', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getRandomBytes: (n: number) => new Uint8Array(require('node:crypto').randomBytes(n)),
  digest: async () => new ArrayBuffer(32), CryptoDigestAlgorithm: {},
}));
jest.mock('expo-document-picker', () => ({}));
jest.mock('expo-image-manipulator', () => ({}));
jest.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => ({ success: false }) }));
jest.mock('expo-notifications', () => ({ cancelAllScheduledNotificationsAsync: async () => {}, setNotificationHandler: () => {} }));
jest.mock('expo-print', () => ({}));
jest.mock('expo-sharing', () => ({}));
jest.mock('expo-sqlite', () => ({}));
jest.mock('@/services/notifications', () => ({ cancelAllNotifications: async () => {}, rescheduleAllNotifications: async () => {} }));
jest.mock('@/services/appLockService', () => ({ whilePrompting: (f: () => unknown) => f() }));
jest.mock('@/i18n/device', () => ({ syncLanguageWithAccount: async () => {} }));
jest.mock('@/files/expoFs', () => {
  const nodeFs = jest.requireActual('@/files/nodeFs');
  return { expoFs: nodeFs.nodeFs, expoHasher: nodeFs.nodeHasher, appDataRoot: () => '/doc', expoMd5Base64: async () => '' };
});
const mockEnvHolder: { env: { db: unknown; root: string } | null } = { env: null };
jest.mock('@/services/backupService', () => ({ appBackupEnv: () => mockEnvHolder.env, shareUnsyncedFile: async () => {} }));
jest.mock('@/services/slotsApp', () => {
  const nodeFs = jest.requireActual('@/files/nodeFs');
  return { appSlotEnv: () => ({ db: () => mockEnvHolder.env!.db, fs: nodeFs.nodeFs, root: mockEnvHolder.env!.root }) };
});
jest.mock('@/services/backupPassword', () => ({ backupSecretForSealing: async () => 'NWRZN7XGZB5ZXZVQ5K9254RE2' }));

const ORG = 'ORG-R11B4C';
const MEMBER = 'MEMBER-R11B4C';

(global as unknown as { fetch: unknown }).fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
  const res = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => null } });
  cloudSide.calls.push((init.method ?? 'GET') + ' ' + url.replace(/^https:\/\/[^/]+/, '').replace(/\?.*$/, ''));
  if (url.includes('securetoken.googleapis.com')) return res(200, { user_id: MEMBER, id_token: 'ID', refresh_token: 'R', expires_in: '3600' });
  if (url.includes(`/orgs/${ORG}/members/${MEMBER}`)) return res(404, { error: { code: 404, status: 'NOT_FOUND' } });
  return res(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } });
};

import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addProperty } from './helpers/fixtures';
import { makeSafetyBackup, safetyBackupsDir } from '@/domain/backup/create';
import { deviceBackups } from '@/domain/backup/deviceBackups';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
beforeAll(() => {
  process.env.EXPO_PUBLIC_FIREBASE_API_KEY = 'k';
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'p';
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'w';
});

function memberPhone(prefix: string) {
  const root = tempDir(prefix).replace(/\\/g, '/');
  dirs.push(root);
  const env = makeBackupEnv(root);
  const db = env.db;
  addProperty(db, { id: 'P1', name: 'عقار مصطنع أول' });
  const set = (k: string, v: string) => db.run(`INSERT INTO sync_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [k, v]);
  set('uid', MEMBER); set('email', 'm@example.test'); set('org', ORG); set('org_name', 'منشأة مصطنعة');
  set('membership', JSON.stringify({ org: ORG, uid: MEMBER, perms: { collect: 1 }, allProps: true, props: [], profile: { name: 'عضو مصطنع', phone: '0500000000', nid: '', title: '' } }));
  db.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'capture'`);
  db.run(`DELETE FROM sync_outbox`);
  mockEnvHolder.env = env as never;
  const sessSrc = fs.readFileSync(path.join(__dirname, '..', 'src/cloud/session.ts'), 'utf8');
  const keys = /KEYS\s*=\s*\{([^}]*)\}/.exec(sessSrc)?.[1] ?? '';
  for (const m of keys.matchAll(/(\w+):\s*'([^']+)'/g)) kv.set(m[2], m[1] === 'uid' ? MEMBER : m[1] === 'email' ? 'm@example.test' : 'R');
  return env;
}

async function runCycles(env: ReturnType<typeof makeBackupEnv>, n: number) {
  let cloud!: typeof import('@/services/cloud');
  await jest.isolateModulesAsync(async () => { cloud = await import('@/services/cloud'); });
  const stop = cloud.startCloud(env.db as never);
  const settle = async () => { for (let i = 0; i < 100 && (cloud.cloudState().syncing || !cloud.cloudState().restored); i++) await new Promise((r) => setTimeout(r, 30)); };
  await new Promise((r) => setTimeout(r, 100));
  await settle();
  for (let i = 0; i < n; i++) { await cloud.syncNow(); await settle(); }
  stop();
  return cloud.cloudState();
}

test('نسخة أمانٍ كاملة صُنعت والجهاز عضو لا تبقى بعد إزالته ولو سبق اسمُها member_since (ساعةٌ تقدّمت عند الانضمام ثم صُحّحت)', async () => {
  const env = memberPhone('aqari-r11b4-clock-');
  // الساعة كانت متقدمة عند قبول الدعوة · ثم صُحّحت فصارت كل نسخةٍ بعدها «أقدم» من وقت الانضمام المحفوظ
  env.db.run(`INSERT INTO sync_state (k, v) VALUES ('member_since', '2099-01-01T00:00:00.000Z') ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
  const memberCopy = await makeSafetyBackup(env, 'pre-wipe');
  expect(deviceBackups(env).map((b) => b.name)).toEqual([path.basename(memberCopy)]);

  const st = await runCycles(env, 1);
  expect(st.decision?.kind).toBe('removed');
  expect(env.live().get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n).toBe(0);
  // eslint-disable-next-line no-console
  console.log('B-4 · بعد الإزالة: نسخ الجهاز =', fs.existsSync(safetyBackupsDir(env)) ? fs.readdirSync(safetyBackupsDir(env)) : []);
  // لا تبقى نسخةٌ فيها بيانات المنشأة بعضويتها
  expect(fs.existsSync(memberCopy)).toBe(false);
});

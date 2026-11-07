/**
 * المدقق الخارجي D · الجولة الثانية · نسخة Drive المخفية تُرفع ثم يُعلَن فشل العملية كلها إن تعذّرت النسخة الظاهرة.
 *
 * backupToDrive (src/services/cloud.ts) يرفع المخفية في appDataFolder أولاً، ثم الظاهرة في «عقاري · نسخ احتياطية» · وأي تعذّرٍ في
 * الظاهرة (403 بعد طلب النطاق إن رفضه المستخدم، أو 5xx، أو إلغاء بينهما) يُرمى من backupToDrive بعد أن نجحت المخفية، فتقول الواجهة
 * «تعذّر النسخ على Google Drive» والنسخة في Drive فعلاً · ومن رفض نطاق drive.file مرةً لا تنجح له نسخة Drive أبداً، وكل محاولةٍ تترك
 * نسخةً مخفية أخرى. الخدمة الحقيقية تُشغَّل بقرصٍ مؤقت وDrive وهمي، ووحدات الجهاز ببدائل · بيانات مصطنعة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const kv = new Map<string, string>();
const mockDrive = {
  files: new Map<string, { name: string; parents: string[] }>(),
  pending: null as { name: string; parents: string[] } | null,
  n: 0,
  /** يرفض كل ما يمسّ المجلد الظاهر (نطاق drive.file لم يُمنح · المستخدم رفضه في نافذة addScopes) */
  denyVisible: true,
  addScopesCalls: 0,
};

jest.mock('react-native', () => ({
  Platform: { OS: 'android' }, NativeModules: {},
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}), { virtual: true });
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => kv.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { kv.set(k, v); },
  deleteItemAsync: async (k: string) => { kv.delete(k); },
}), { virtual: true });
jest.mock('expo-network', () => ({ getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }), addNetworkStateListener: () => ({ remove: () => {} }) }), { virtual: true });
jest.mock('expo-file-system', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nfs = require('node:fs');
  class F {
    uri: string;
    constructor(p: string) { this.uri = String(p); }
    get exists() { return nfs.existsSync(this.uri.replace(/^file:\/\//, '')); }
    get size() { return nfs.statSync(this.uri.replace(/^file:\/\//, '')).size; }
    bytesSync() { return new Uint8Array(nfs.readFileSync(this.uri.replace(/^file:\/\//, ''))); }
    write() {} delete() {} textSync() { return ''; }
  }
  return { File: F, Directory: F, Paths: { document: { uri: '/doc' }, cache: { uri: '/cache' } } };
}, { virtual: true });
jest.mock('expo-file-system/legacy', () => ({
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  getFreeDiskStorageAsync: async () => 1e12,
  createUploadTask: (_url: string, uri: string) => ({
    cancelAsync: async () => {},
    uploadAsync: async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bytes = require('node:fs').readFileSync(uri.replace(/^file:\/\//, ''));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sha = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
      const id = 'F' + (++mockDrive.n);
      mockDrive.files.set(id, mockDrive.pending!);
      return { status: 200, body: JSON.stringify({ id, name: mockDrive.pending!.name, size: String(bytes.length), sha256Checksum: sha }) };
    },
  }),
  createDownloadResumable: () => ({ downloadAsync: async () => ({ status: 200 }), cancelAsync: async () => {} }),
}), { virtual: true });
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: () => {},
    getTokens: async () => ({ accessToken: 'TOKEN' }),
    signInSilently: async () => ({ type: 'success' }),
    // المستخدم يرفض النطاق في النافذة: لا رمي، والنطاق لم يُمنح
    addScopes: async () => { mockDrive.addScopesCalls++; return null; },
    hasPlayServices: async () => true, signIn: async () => null, signOut: async () => {},
  },
  isSuccessResponse: () => false,
}), { virtual: true });
jest.mock('expo-crypto', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getRandomBytes: (n: number) => new Uint8Array(require('node:crypto').randomBytes(n)),
  digest: async () => new ArrayBuffer(32), CryptoDigestAlgorithm: {},
}), { virtual: true });
jest.mock('expo-document-picker', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });
jest.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => ({ success: false }) }), { virtual: true });
jest.mock('expo-notifications', () => ({ cancelAllScheduledNotificationsAsync: async () => {}, setNotificationHandler: () => {} }), { virtual: true });
jest.mock('expo-print', () => ({}), { virtual: true });
jest.mock('expo-sharing', () => ({}), { virtual: true });
jest.mock('expo-sqlite', () => ({}), { virtual: true });
jest.mock('@/services/notifications', () => ({ cancelAllNotifications: async () => {}, rescheduleAllNotifications: async () => {} }));
jest.mock('@/services/appLockService', () => ({ whilePrompting: (f: () => unknown) => f() }));
// وحدات الملفات على القرص الحقيقي
jest.mock('@/files/expoFs', () => {
  const nodeFs = jest.requireActual('@/files/nodeFs');
  return { expoFs: nodeFs.nodeFs, expoHasher: nodeFs.nodeHasher, appDataRoot: () => '/doc', expoMd5Base64: async () => '' };
});
// بيئة النسخ الحقيقية فوق قاعدة مؤقتة · والسرّ مفتاح استرداد محفوظ
const mockEnvHolder: { env: unknown } = { env: null };
jest.mock('@/services/backupService', () => ({ appBackupEnv: () => mockEnvHolder.env }));
jest.mock('@/services/backupPassword', () => ({ backupSecretForSealing: async () => 'NWRZN7XGZB5ZXZVQ5K9254RE2' }));

// Drive نفسه: fetch العام
(global as unknown as { fetch: unknown }).fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
  const res = (status: number, body: unknown, location?: string) => ({
    ok: status < 300, status, text: async () => JSON.stringify(body), headers: { get: () => location ?? null },
  });
  if (url.includes('uploadType=resumable')) {
    mockDrive.pending = JSON.parse(init.body!);
    return res(200, {}, 'https://upload/session');
  }
  // المجلد الظاهر: البحث عنه وإنشاؤه يحتاجان drive.file
  if (url.includes('/files?q=') || (url.includes('/files?fields=id') && init.method === 'POST')) {
    if (mockDrive.denyVisible) return res(403, { error: { message: 'Request had insufficient authentication scopes.' } });
  }
  return res(404, {});
};

import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addProperty } from './helpers/fixtures';
import { primeSession, backupToDrive } from '@/services/cloud';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

beforeAll(() => {
  process.env.EXPO_PUBLIC_FIREBASE_API_KEY = 'k';
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'p';
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'w';
});

test('رفض نطاق المجلد الظاهر: النسخة المخفية رُفعت، فلا يُعلَن فشل النسخ على Drive', async () => {
  const root = tempDir('aqari-auditD-drive-').replace(/\\/g, '/');
  dirs.push(root);
  const env = makeBackupEnv(root);
  addProperty(env.db, { name: 'عقار مصطنع للنسخ على Drive' });
  mockEnvHolder.env = env;
  // جلسة محفوظة كما بعد دخولٍ سابق (session.ts: restore) · بمفاتيحها كما يكتبها session.ts (KEYS)
  const sessSrc = fs.readFileSync(path.join(__dirname, '..', 'src/cloud/session.ts'), 'utf8');
  const keys = /KEYS\s*=\s*\{([^}]*)\}/.exec(sessSrc)?.[1] ?? '';
  for (const m of keys.matchAll(/(\w+):\s*'([^']+)'/g)) kv.set(m[2], m[1] === 'uid' ? 'ACC-1' : m[1] === 'email' ? 'a@example.com' : 'R');
  primeSession();
  await new Promise((r) => setTimeout(r, 50));

  const err = await backupToDrive(env.db as never).then(() => null, (e: Error) => e);
  const hidden = [...mockDrive.files.values()].filter((f) => f.parents.includes('appDataFolder'));
  // eslint-disable-next-line no-console
  console.log('نتيجة backupToDrive:', err ? 'رمى «' + err.message + '»' : 'نجح',
    '· نسخ مخفية رُفعت فعلاً:', hidden.length, '· طلبات النطاق:', mockDrive.addScopesCalls);

  // المحاولة الثانية بعد الرفض: نسخةٌ مخفية أخرى وفشلٌ آخر
  const err2 = await backupToDrive(env.db as never).then(() => null, (e: Error) => e);
  const hidden2 = [...mockDrive.files.values()].filter((f) => f.parents.includes('appDataFolder')).length;
  // eslint-disable-next-line no-console
  console.log('المحاولة الثانية:', err2 ? 'رمت' : 'نجحت', '· نسخ مخفية الآن:', hidden2);

  expect(hidden.length).toBe(1);
  // المتوقع: ما دامت النسخة رُفعت وطابقت بصمتها فلا يُقال للمستخدم «تعذّر النسخ على Google Drive»
  expect(err).toBeNull();
  env.live().close();
});


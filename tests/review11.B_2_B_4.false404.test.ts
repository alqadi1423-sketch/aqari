/**
 * مراجعة إصلاح B-2 وB-4 (المراجعة الشاملة 2026-11-13) · متوسط · «404» من غير مستند العضوية يُقرأ إزالةً فيُفرَّغ جوال عضوٍ قائم بلا رجعة
 *
 * السيناريو (بيانات مصطنعة): عضوٌ قائم، طابوره فارغ. السحابة كلها ترجع 404 على مستوى القاعدة لا المستند: «The database (default) does
 * not exist for project …» (قاعدةٌ حُذفت أو أُعيد إنشاؤها في نقلٍ أو تغيير منطقة، أو بناءٌ بمعرّف مشروعٍ خاطئ). الإصلاح نقل فحص العضوية إلى
 * أول الدورة قبل أي طلبٍ يثبت أن الخادم يجيب فعلاً: checkUnitMoves ← getDoc(meta/moves) 404 ← null ← 'none'، ثم refreshMembership ←
 * getDoc(members/{uid}) 404 ← null ← 'removed' (firestore.ts:443 «res.status === 404 ← null» بلا نظرٍ في سببه) ← exitRemoved: تفريغٌ
 * بلا نسخة أمان (B-4) وتُمحى العضوية من الجهاز، فلا يعود العضو إلى منشأته إلا بدعوةٍ جديدة، وما لم يُرفع من ملفاته يتلف
 * (tests/review11.B_2_B_4.memberAttachments.test.ts).
 * قبل الإصلاح كان الترتيب نفسه يحميه: العهد والحد الأدنى يقرآن null، ثم السحب (runQuery) يرمي 404 فتتوقف الدورة قبل فحص العضوية.
 *
 * لماذا يهم: التفريغ بالإزالة صار بلا نسخة أمان ولا قرار (س٩)، فلا رجعة فيه · وقاعدة المالك 2026-10-05 «لا يُمسح شيء من الجهاز إلا
 * بأمر صريح من المستخدم في تلك اللحظة، أو بإزالة عضويته» تشترط إزالةً حقيقية لا عطلاً في الخادم يشبهها.
 *
 * السلوك الصحيح: لا يُعدّ العضو مُزالاً إلا بدليلٍ لا يحتمل غير ذلك: مستند العضوية «غير موجود» على مستوى المستند (لا القاعدة ولا المشروع)،
 * ويوافقه رفض الخادم (403) لمستندٍ للأعضاء وحدهم في الدورة نفسها (كما تقضي القواعد لمن أُزيل: meta/moves أو meta/epoch) · وغير ذلك خطأ
 * اتصالٍ يُعرض ويُعاد، والجهاز وعضويته كما هما. والضابط في آخر الملف: الإزالة الحقيقية تبقى تفرّغ في أول دورة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const kv = new Map<string, string>();
const cloudSide = { mode: 'dbGone' as 'dbGone' | 'removed', calls: [] as string[] };

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

const ORG = 'ORG-R11B2F';
const MEMBER = 'MEMBER-R11B2F';

(global as unknown as { fetch: unknown }).fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
  const res = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => null } });
  cloudSide.calls.push((init.method ?? 'GET') + ' ' + url.replace(/^https:\/\/[^/]+/, '').replace(/\?.*$/, ''));
  if (url.includes('securetoken.googleapis.com')) return res(200, { user_id: MEMBER, id_token: 'ID', refresh_token: 'R', expires_in: '3600' });
  if (cloudSide.mode === 'dbGone') {
    // كل طلبٍ إلى Firestore: القاعدة نفسها غير موجودة (نص الخادم كما يرجعه لقاعدةٍ محذوفة)
    return res(404, { error: { code: 404, status: 'NOT_FOUND',
      message: 'The database (default) does not exist for project p Please visit https://console.cloud.google.com/datastore/setup?project=p to add a Cloud Datastore or Cloud Firestore database.' } });
  }
  // الإزالة الحقيقية كما تقضي firestore.rules: مستند عضويته «غير موجود»، وما سواه للمالك والأعضاء (403)
  if (url.includes(`/orgs/${ORG}/members/${MEMBER}`)) {
    return res(404, { error: { code: 404, status: 'NOT_FOUND', message: `Document "projects/p/databases/(default)/documents/orgs/${ORG}/members/${MEMBER}" not found.` } });
  }
  return res(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } });
};

import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addProperty } from './helpers/fixtures';

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
  addProperty(db, { id: 'P2', name: 'عقار مصطنع ثانٍ' });
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

test('404 على مستوى القاعدة (لا المستند) لا يُقرأ إزالة: الجهاز وعضويته كما هما، ويظهر خطأ اتصالٍ يُعاد', async () => {
  cloudSide.mode = 'dbGone';
  cloudSide.calls = [];
  const env = memberPhone('aqari-r11b2-dbgone-');
  const st = await runCycles(env, 2);
  const live = env.live();
  const { readMembership } = await import('@/services/access');
  // eslint-disable-next-line no-console
  console.log('B-2 · كل الطلبات 404 للقاعدة: العضوية باقية =', !!readMembership(live), '· عقارات على الجوال =',
    live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n, '· الإشعار =', st.decision, '· آخر خطأ =', st.lastError, '· الطلبات:', cloudSide.calls.slice(0, 4));
  expect(readMembership(live)?.org).toBe(ORG);
  expect(live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n).toBe(2);
  expect(live.get<{ v: string }>(`SELECT v FROM sync_state WHERE k = 'exit_notice'`)?.v ?? null).toBeNull();
  expect(st.decision?.kind).not.toBe('removed');
  expect(st.lastError).toBeTruthy();
});

test('ضابط: الإزالة الحقيقية (مستند العضوية غير موجود، وما للأعضاء مرفوض 403) تفرّغ في أول دورة كما أصلحها B-2', async () => {
  cloudSide.mode = 'removed';
  cloudSide.calls = [];
  const env = memberPhone('aqari-r11b2-real-');
  const st = await runCycles(env, 1);
  const live = env.live();
  const { readMembership } = await import('@/services/access');
  expect(readMembership(live)).toBeNull();
  expect(live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n).toBe(0);
  expect(st.decision?.kind).toBe('removed');
});

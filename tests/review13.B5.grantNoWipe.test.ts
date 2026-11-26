/**
 * B-5 · متوسط · src/services/org.ts (refreshMembership) · src/services/cloud.ts (syncNow · permWipeDue)
 *
 * السيناريو (بيانات مصطنعة، والسحابة fetch يحاكي قواعد firestore.rules كما في tests/review9.B.revokedMember.test.ts):
 *  أضاف المالك لموظفٍ صلاحية (رفع مستوى قسمه، أو قسماً جديداً، أو «كل العقارات» بعد عقارٍ واحد). refreshMembership كانت ترجع 'changed'
 *  لأي تغيّر، فيُسجَّل تفريغٌ منتظر ويقع في الدورة نفسها: نسخة أمانٍ كاملة على جواله، ثم تُمسح قاعدته ويُعاد سحب المنشأة من أولها.
 *
 * السلوك الصحيح (المحسوم بالقاعدة ٩٩ في 2026-11-07، والمالك قرر أن يُبنى): «نقص الصلاحية يفرّغ ما لم يعد يحق له رؤيته، والزيادة سحبٌ بلا
 * تفريغ» · الزيادة: كل مستوى أكبر من القديم أو يساويه، والعقارات تشمل القديمة · عندها تُحفظ العضوية، ويُصفَّر مؤشر السحب وحده فيُسحب
 * ما صار يراه، ولا تفريغ ولا نسخة أمان · والإنقاص (ولو مع زيادةٍ في غيره) يفرّغ كما هو.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const kv = new Map<string, string>();
type Grant = { perm: Record<string, number>; all: boolean; props: string[] };
const cloudSide = { grant: null as Grant | null, calls: [] as string[], queries: [] as string[] };


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
jest.mock('@/services/backupService', () => ({ appBackupEnv: () => mockEnvHolder.env }));
jest.mock('@/services/slotsApp', () => {
  const nodeFs = jest.requireActual('@/files/nodeFs');
  return { appSlotEnv: () => ({ db: () => mockEnvHolder.env!.db, fs: nodeFs.nodeFs, root: mockEnvHolder.env!.root }) };
});
jest.mock('@/services/backupPassword', () => ({ backupSecretForSealing: async () => 'NWRZN7XGZB5ZXZVQ5K9254RE2' }));

const ORG = 'ORG-R13B5';
const MEMBER = 'MEMBER-R13B5';
const OLD_TS = '2026-11-01T00:00:00.000Z';

const fsVal = (v: unknown): unknown => {
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsVal) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fsVal(x)])) } };
};

// السحابة: مستند العضوية بالصلاحية الجديدة ورموزها · والسحب يُقبل برموزه الحالية وحدها (firestore.rules)
(global as unknown as { fetch: unknown }).fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
  const res = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => null } });
  cloudSide.calls.push((init.method ?? 'GET') + ' ' + url.replace(/^https:\/\/[^/]+/, '').replace(/\?.*$/, ''));
  if (url.includes('securetoken.googleapis.com')) return res(200, { user_id: MEMBER, id_token: 'ID', refresh_token: 'R', expires_in: '3600' });
  const denied = { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } };
  const g = cloudSide.grant!;
  const { memberTokens } = jest.requireActual('@/sync/acl') as typeof import('@/sync/acl');
  const tokens = memberTokens({ owner: false, perms: g.perm as never, allProps: g.all, props: g.props });
  if (url.includes(`/orgs/${ORG}/members/${MEMBER}`)) {
    return res(200, { fields: { email: fsVal('m@example.test'), perm: fsVal(g.perm), all: fsVal(g.all), props: fsVal(g.props), tokens: fsVal(tokens) } });
  }
  if (/\/orgs\/[^/]+\/meta\//.test(url)) return res(404, { error: { code: 404 } });
  if (url.includes(':runQuery')) {
    cloudSide.queries.push(init.body ?? '');
    const q = JSON.parse(init.body ?? '{}') as { structuredQuery?: { where?: { fieldFilter?: { value?: { arrayValue?: { values?: Array<{ stringValue: string }> } } } } } };
    const toks = q.structuredQuery?.where?.fieldFilter?.value?.arrayValue?.values?.map((v) => v.stringValue) ?? [];
    return toks.every((t) => tokens.includes(t)) ? res(200, []) : res(403, denied);
  }
  if (url.includes(':commit')) return res(200, { commitTime: new Date().toISOString() });
  return res(404, { error: { code: 404 } });
};

import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addProperty } from './helpers/fixtures';
import { safetyBackupsDir } from '@/domain/backup/create';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
beforeAll(() => {
  process.env.EXPO_PUBLIC_FIREBASE_API_KEY = 'k';
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'p';
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'w';
});

type Old = { perms: Record<string, number>; allProps: boolean; props: string[] };

/** جوال عضوٍ بصلاحيته القديمة وعليه بيانات المنشأة، وطابوره فارغ، ومؤشر سحبه قائم من دورةٍ سابقة */
function memberPhone(prefix: string, old: Old) {
  const root = tempDir(prefix).replace(/\\/g, '/');
  dirs.push(root);
  const env = makeBackupEnv(root);
  const db = env.db;
  addProperty(db, { id: 'P1', name: 'عقار مصطنع أول' });
  addProperty(db, { id: 'P2', name: 'عقار مصطنع ثانٍ' });
  const set = (k: string, v: string) => db.run(`INSERT INTO sync_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [k, v]);
  set('uid', MEMBER); set('email', 'm@example.test'); set('org', ORG); set('org_name', 'منشأة مصطنعة');
  set('membership', JSON.stringify({ org: ORG, uid: MEMBER, ...old, profile: { name: 'عضو مصطنع', phone: '0500000000', nid: '', title: '' } }));
  const { memberTokens } = jest.requireActual('@/sync/acl') as typeof import('@/sync/acl');
  const key = memberTokens({ owner: false, perms: old.perms as never, allProps: old.allProps, props: old.props }).join(',');
  set('cursor', JSON.stringify({ parts: { [key]: { ts: OLD_TS, id: 'properties__P1' } } }));
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

/** ما يدل على التفريغ: عدد العقارات، وسطر «تفريغ الجهاز»، ونسخ الأمان، والتفريغ المنتظر */
function afterState(env: ReturnType<typeof makeBackupEnv>) {
  const live = env.live();
  const dir = safetyBackupsDir(env);
  return {
    props: live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n,
    wipes: live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'تفريغ الجهاز'`)!.n,
    backups: fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.aqbk')).length : 0,
    pending: live.get<{ v: string }>(`SELECT v FROM sync_state WHERE k = 'perm_wipe_pending'`)?.v ?? null,
  };
}

test('B-5 · رفع مستوى القسم (الرموز نفسها): لا تفريغ ولا نسخة أمان، والصلاحية تُحفظ، والسحب من أوله', async () => {
  cloudSide.grant = { perm: { collect: 3 }, all: true, props: [] };
  cloudSide.queries = [];
  const env = memberPhone('aqari-r13b5-level-', { perms: { collect: 1 }, allProps: true, props: [] });
  const st = await runCycles(env, 2);
  const { readMembership } = await import('@/services/access');
  expect(st.lastError).toBeNull();
  expect(afterState(env)).toEqual({ props: 2, wipes: 0, backups: 0, pending: null });
  expect(readMembership(env.live())?.perms).toEqual({ collect: 3 });
  // المؤشر صُفّر: أول استعلام سحبٍ بلا موضع البداية القديم، فيصل ما صار يراه بمستواه الجديد (المبالغ مثلاً)
  expect(cloudSide.queries.length).toBeGreaterThan(0);
  expect(cloudSide.queries[0]).not.toContain(OLD_TS);
  expect(JSON.parse(cloudSide.queries[0]).structuredQuery.startAt).toBeUndefined();
});

test('B-5 · قسمٌ جديد و«كل العقارات» بعد عقارٍ واحد: لا تفريغ', async () => {
  cloudSide.grant = { perm: { collect: 1, reports: 1 }, all: true, props: [] };
  const env = memberPhone('aqari-r13b5-props-', { perms: { collect: 1 }, allProps: false, props: ['P1'] });
  const st = await runCycles(env, 2);
  const { readMembership } = await import('@/services/access');
  expect(st.lastError).toBeNull();
  expect(afterState(env)).toEqual({ props: 2, wipes: 0, backups: 0, pending: null });
  const m = readMembership(env.live())!;
  expect([m.perms, m.allProps]).toEqual([{ collect: 1, reports: 1 }, true]);
});

test('B-5 · عقارٌ مضاف إلى عقاراته: لا تفريغ', async () => {
  cloudSide.grant = { perm: { collect: 1 }, all: false, props: ['P1', 'P2'] };
  const env = memberPhone('aqari-r13b5-addprop-', { perms: { collect: 1 }, allProps: false, props: ['P1'] });
  await runCycles(env, 2);
  expect(afterState(env)).toEqual({ props: 2, wipes: 0, backups: 0, pending: null });
});

test('B-5 · زيادةٌ في قسم مع إنقاصٍ في آخر: يُفرَّغ كما هو (ليس زيادة)', async () => {
  cloudSide.grant = { perm: { collect: 1, reports: 1 }, all: true, props: [] };
  const env = memberPhone('aqari-r13b5-mixed-', { perms: { collect: 1, claims: 2 }, allProps: true, props: [] });
  await runCycles(env, 2);
  const s = afterState(env);
  expect([s.props, s.wipes, s.pending]).toEqual([0, 1, null]);
});

test('B-5 · «كل العقارات» إلى عقارٍ واحد: يُفرَّغ كما هو', async () => {
  cloudSide.grant = { perm: { collect: 1 }, all: false, props: ['P1'] };
  const env = memberPhone('aqari-r13b5-reduce-', { perms: { collect: 1 }, allProps: true, props: [] });
  await runCycles(env, 2);
  const s = afterState(env);
  expect([s.props, s.wipes, s.pending]).toEqual([0, 1, null]);
});

test('B-5 · تفريغٌ منتظر من إنقاصٍ سابق لا تلغيه زيادةٌ بعده', async () => {
  cloudSide.grant = { perm: { collect: 2 }, all: true, props: [] };
  const env = memberPhone('aqari-r13b5-pending-', { perms: { collect: 1 }, allProps: true, props: [] });
  env.db.run(`INSERT INTO sync_state (k, v) VALUES ('perm_wipe_pending', 'changed')`);
  await runCycles(env, 2);
  const s = afterState(env);
  expect([s.props, s.wipes, s.pending]).toEqual([0, 1, null]);
});

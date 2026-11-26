/**
 * B-5b · متوسط · الخصوصية · src/services/cloud.ts (syncNow · تفريغ تغيّر الصلاحية) · src/domain/wipe.ts · src/domain/memberExit.ts
 *
 * السيناريو (بيانات مصطنعة، والسحابة fetch يحاكي firestore.rules كما في tests/review13.B5.grantNoWipe.test.ts):
 *  أنقص المالك صلاحية موظفٍ («كل العقارات» إلى عقارٍ واحد). أول دورةٍ متصلة: refreshMembership ← 'changed' ← permWipeDue ← wipeLocal بلا
 *  safety ← wipeAllData يصنع نسخة أمانٍ كاملة (pre-wipe .aqbk) فيها كل بيانات المنشأة ومرفقاتها كما رآها قبل الإنقاص، وتبقى على جواله
 *  ويستعيدها (حزام الاستعادة يقارن المنشأة والعضو لا الصلاحية) · فيبقى عنده ما أُخذ منه للتو.
 *
 * السلوك الصحيح (كخروج العضو B-4 · قرارا المالك س٩ وس١٠): لا نسخة أمان كاملة على جوال العضو عند الإنقاص · ما لم يُرفع من عمله وحده
 * (ما رفضته السحابة مما كتبه، ومرفقاته التي لم تُرفع ونسختها الوحيدة على جواله) في ملف ما لم يُرفع، ولا ملف إن لم يبقَ له شيء · ونسخ
 * جهازه التي صُنعت وهو عضو (فيها ما كان يراه) تُحذف · ويُبلَّغ بإشعار B-4 · والزيادة (B-5) والمالك كما هما.
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
jest.mock('@/services/backupService', () => ({ appBackupEnv: () => mockEnvHolder.env, shareUnsyncedFile: async () => {} }));
jest.mock('@/services/slotsApp', () => {
  const nodeFs = jest.requireActual('@/files/nodeFs');
  return { appSlotEnv: () => ({ db: () => mockEnvHolder.env!.db, fs: nodeFs.nodeFs, root: mockEnvHolder.env!.root }) };
});
jest.mock('@/services/backupPassword', () => ({ backupSecretForSealing: async () => 'NWRZN7XGZB5ZXZVQ5K9254RE2' }));

const ORG = 'ORG-R13B5B';
const MEMBER = 'MEMBER-R13B5B';
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
import { makeSafetyBackup, safetyBackupsDir } from '@/domain/backup/create';
import { putAttachment } from '@/files/store';
import { wipeAllData } from '@/domain/wipe';
import { SCHEMA_VERSION } from '@/db/schema';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
beforeAll(() => {
  process.env.EXPO_PUBLIC_FIREBASE_API_KEY = 'k';
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'p';
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'w';
});

type Old = { perms: Record<string, number>; allProps: boolean; props: string[] };
const PRE_JOIN = 'pre-upgrade-2020-01-01T00-00-00-000Z-v50.aqbk';

/** جوال عضوٍ بصلاحيته القديمة وعليه بيانات المنشأة، وطابوره فارغ، ومؤشر سحبه قائم، ونسخةٌ قبل انضمامه ونسخة أمانٍ وهو عضو */
async function memberPhone(prefix: string, old: Old) {
  const root = tempDir(prefix).replace(/\\/g, '/');
  dirs.push(root);
  const env = makeBackupEnv(root);
  const db = env.db;
  addProperty(db, { id: 'P1', name: 'عقار مصطنع أول' });
  addProperty(db, { id: 'P2', name: 'عقار مصطنع ثانٍ' });
  const set = (k: string, v: string) => db.run(`INSERT INTO sync_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [k, v]);
  set('uid', MEMBER); set('email', 'm@example.test'); set('org', ORG); set('org_name', 'منشأة مصطنعة');
  set('member_since', '2021-01-01T00:00:00.000Z');
  // أُعيد المرفوض بعد ترقية هذا الإصدار من قبل (engine.ts · replayRejectsAfterUpgrade) · فيبقى ما رُفض مرفوضاً
  set('rejects_replayed_sv', String(SCHEMA_VERSION));
  set('membership', JSON.stringify({ org: ORG, uid: MEMBER, ...old, profile: { name: 'عضو مصطنع', phone: '0500000000', nid: '', title: '' } }));
  const { memberTokens } = jest.requireActual('@/sync/acl') as typeof import('@/sync/acl');
  const key = memberTokens({ owner: false, perms: old.perms as never, allProps: old.allProps, props: old.props }).join(',');
  set('cursor', JSON.stringify({ parts: { [key]: { ts: OLD_TS, id: 'properties__P1' } } }));
  db.run(`UPDATE sync_ctl SET v = 1 WHERE k = 'capture'`);
  db.run(`DELETE FROM sync_outbox`);
  const backups = safetyBackupsDir(env);
  fs.mkdirSync(backups, { recursive: true });
  fs.writeFileSync(path.join(backups, PRE_JOIN), 'نسخة مصطنعة قبل الانضمام');
  // نسخة أمانٍ صُنعت وهو عضو (فيها العقاران كما رآهما) · كما يبقى من تفريغٍ سابق أو ترقية
  await makeSafetyBackup(env, 'pre-wipe');
  mockEnvHolder.env = env as never;
  const sessSrc = fs.readFileSync(path.join(__dirname, '..', 'src/cloud/session.ts'), 'utf8');
  const keys = /KEYS\s*=\s*\{([^}]*)\}/.exec(sessSrc)?.[1] ?? '';
  for (const m of keys.matchAll(/(\w+):\s*'([^']+)'/g)) kv.set(m[2], m[1] === 'uid' ? MEMBER : m[1] === 'email' ? 'm@example.test' : 'R');
  return env;
}

async function startCycles(env: ReturnType<typeof makeBackupEnv>, n: number) {
  let cloud!: typeof import('@/services/cloud');
  await jest.isolateModulesAsync(async () => { cloud = await import('@/services/cloud'); });
  const stop = cloud.startCloud(env.db as never);
  const settle = async () => { for (let i = 0; i < 100 && (cloud.cloudState().syncing || !cloud.cloudState().restored); i++) await new Promise((r) => setTimeout(r, 30)); };
  await new Promise((r) => setTimeout(r, 100));
  await settle();
  const more = async (k: number) => { for (let i = 0; i < k; i++) { await cloud.syncNow(); await settle(); } };
  await more(n);
  return { cloud, stop, settle, more };
}

/** كل ملفٍ تحت المجلد */
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const aqbks = (env: ReturnType<typeof makeBackupEnv>) => walk(env.root).filter((p) => p.endsWith('.aqbk')).map((p) => path.basename(p)).sort();
const unsyncedFiles = (env: ReturnType<typeof makeBackupEnv>) => walk(path.join(safetyBackupsDir(env), 'unsynced'));
const wipeLine = (env: ReturnType<typeof makeBackupEnv>) =>
  env.live().get<{ entity_name: string }>(`SELECT entity_name FROM audit_log WHERE entity_type = 'تفريغ الجهاز'`)?.entity_name ?? null;

test('B-5b · إنقاص الصلاحية وعنده ما لم يُرفع (رفضٌ لعمله وإيصالٌ على جواله وحده): لا نسخة أمان فيها ما فقده، وعمله وحده في ملف ما لم يُرفع، وإشعارٌ بذلك والمزامنة ماضية', async () => {
  cloudSide.grant = { perm: { collect: 1 }, all: false, props: ['P1'] };
  cloudSide.queries = [];
  const env = await memberPhone('aqari-r13b5b-work-', { perms: { collect: 1 }, allProps: true, props: [] });
  const db = env.db;
  const dev = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'device_id'`)!.value;
  const at = '2026-11-13T08:00:00.000Z';
  db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`, ['properties__P2', 'properties', 'P2',
    'خارج صلاحيتك · بقي على هذا الجهاز ولم يُرفع', JSON.stringify({ id: 'properties__P2', t: 'properties', k: 'P2', d: { id: 'P2', name: 'تعديل مرفوض مصطنع' }, u: at, dev, del: false }), at]);
  const receipt = new Uint8Array(4096).map((_, k) => (k * 31 + 7) % 251);
  const att = await putAttachment(env.filesEnv, receipt, { entityType: 'property', entityId: 'P1', kind: 'إيصال', originalName: 'إيصال تحصيل مصطنع.pdf', mime: 'application/pdf' });
  expect(db.get<{ uploaded: number }>(`SELECT uploaded FROM file_cache WHERE sha256 = ?`, [att.sha256])?.uploaded).toBe(0);
  expect(aqbks(env)).toHaveLength(2);

  const { cloud, stop, settle, more } = await startCycles(env, 1);
  const live = env.live();
  const st = cloud.cloudState();
  // فُرّغ الجهاز، والصلاحية الجديدة محفوظة
  expect(live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n).toBe(0);
  const { readMembership } = await import('@/services/access');
  expect(readMembership(live)?.props).toEqual(['P1']);
  // لا نسخة أمانٍ كاملة صُنعت، ونسخته وهو عضو حُذفت · وما قبل انضمامه باقٍ
  expect(aqbks(env)).toEqual([PRE_JOIN]);
  // عمله وحده في ملف ما لم يُرفع: الرفض والإيصال ببايتاته · لا العقار الذي فقده كما هو في المنشأة
  const files = unsyncedFiles(env);
  expect(files).toHaveLength(1);
  const text = fs.readFileSync(files[0], 'utf8');
  const work = JSON.parse(text);
  expect(work.format).toBe('aqari-unsynced-work');
  expect(work.reason).toBe('reduced');
  expect(work.org).toBe(ORG);
  expect(work.docs).toEqual([]);
  expect(work.rejected.map((r: { doc: { id: string } }) => r.doc.id)).toEqual(['properties__P2']);
  expect(work.files.map((f: { sha256: string }) => f.sha256)).toEqual([att.sha256]);
  expect(text).toContain(Buffer.from(receipt).toString('base64'));
  expect(text).not.toContain('عقار مصطنع ثانٍ');
  // سطر السجل: بلا نسخة أمان، وما حُفظ
  const line = wipeLine(env)!;
  expect(line).toContain('بلا نسخة أمان');
  expect(line).toContain(path.basename(files[0]));
  // إشعار B-4 بعدد ما حُفظ وزرّ إرساله · ولا يوقف المزامنة: العضو باقٍ ويُسحب له بصلاحيته الجديدة
  expect(st.decision).toEqual({ kind: 'removed', pending: 2, reduced: true });
  expect(st.lastError).toBeNull();
  const before = cloudSide.queries.length;
  await more(1);
  expect(cloudSide.queries.length).toBeGreaterThan(before);
  expect(cloud.cloudState().decision).toEqual({ kind: 'removed', pending: 2, reduced: true });
  expect(aqbks(env)).toEqual([PRE_JOIN]);
  // «تم»: يُمحى الإشعار ويُحذف الملف بأمره
  await cloud.resolveDecision('done');
  await settle();
  expect(unsyncedFiles(env)).toEqual([]);
  expect(cloud.cloudState().decision).toBeNull();
  stop();
});

test('B-5b · إنقاص الصلاحية بلا ما لم يُرفع: لا نسخة أمان ولا ملف، وإشعارٌ بالتفريغ', async () => {
  cloudSide.grant = { perm: { collect: 1 }, all: false, props: ['P1'] };
  const env = await memberPhone('aqari-r13b5b-none-', { perms: { collect: 1 }, allProps: true, props: [] });
  const { cloud, stop } = await startCycles(env, 2);
  expect(env.live().get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n).toBe(0);
  expect(aqbks(env)).toEqual([PRE_JOIN]);
  expect(unsyncedFiles(env)).toEqual([]);
  expect(wipeLine(env)).toContain('بلا نسخة أمان');
  expect(cloud.cloudState().decision).toEqual({ kind: 'removed', pending: 0, reduced: true });
  expect(cloud.cloudState().lastError).toBeNull();
  stop();
});

test('B-5b · الزيادة (B-5) كما هي: لا تفريغ ولا ملف ولا إشعار، ونسخ الجهاز باقية', async () => {
  cloudSide.grant = { perm: { collect: 3 }, all: true, props: [] };
  const env = await memberPhone('aqari-r13b5b-grant-', { perms: { collect: 1 }, allProps: true, props: [] });
  const { cloud, stop } = await startCycles(env, 2);
  expect(env.live().get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n).toBe(2);
  expect(wipeLine(env)).toBeNull();
  expect(aqbks(env)).toHaveLength(2);
  expect(unsyncedFiles(env)).toEqual([]);
  expect(cloud.cloudState().decision).toBeNull();
  stop();
});

test('B-5b · المالك كما هو: تفريغه بنسخة أمانٍ كاملة (wipeAllData و«امسح كل البيانات»)', async () => {
  const root = tempDir('aqari-r13b5b-owner-').replace(/\\/g, '/');
  dirs.push(root);
  const env = makeBackupEnv(root);
  addProperty(env.db, { id: 'P1', name: 'عقار مصطنع للمالك' });
  const safety = await wipeAllData(env);
  expect(path.basename(safety)).toMatch(/^pre-wipe-.*\.aqbk$/);
  expect(fs.existsSync(safety)).toBe(true);
  expect(wipeLine(env)).toContain('نسخة الأمان: ' + path.basename(safety));
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/cloud.ts'), 'utf8');
  const everything = src.slice(src.indexOf('export async function wipeEverything('), src.indexOf('/* ═══════════ المنشأة والأعضاء'));
  expect(everything).toMatch(/const safety = await makeSafetyBackup\(env, 'pre-wipe', onProgress\);/);
  expect(everything).toMatch(/await wipeLocal\(db, onProgress, safety\);/);
});

test('B-5b · تفريغٌ ثانٍ قبل «تم» (إنقاصٌ ثم إنقاصٌ أو إزالة): ملف الأول لا يُترك بلا إرسال ولا حذف', async () => {
  const { stackExitNotice, noticeFiles, writeExitNotice, readExitNotice, clearExitNotice, unsyncedDir } = await import('@/domain/memberExit');
  const root = tempDir('aqari-r13b5b-stack-').replace(/\\/g, '/');
  dirs.push(root);
  const env = makeBackupEnv(root);
  const dir = unsyncedDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const a = 'unsynced-work-2026-11-20T08-00-00-000Z.json';
  const b = 'unsynced-work-2026-11-21T08-00-00-000Z.json';
  for (const n of [a, b]) fs.writeFileSync(path.join(dir, n), '{}');
  const first = { why: 'reduced' as const, count: 2, file: a, at: '2026-11-20T08:00:00.000Z' };
  // الثاني بلا ملف: يبقى ملف الأول وعدده
  expect(stackExitNotice(first, { why: 'removed', count: 0, file: null, at: 'x' })).toEqual({ why: 'removed', count: 2, file: null, at: 'x', earlier: [a] });
  const both = stackExitNotice(first, { why: 'reduced', count: 1, file: b, at: 'y' });
  expect(noticeFiles(both)).toEqual([a, b]);
  expect(both.count).toBe(3);
  writeExitNotice(env.db, both);
  expect(noticeFiles(readExitNotice(env.db))).toEqual([a, b]);
  clearExitNotice(env, env.db);
  expect(fs.readdirSync(dir)).toEqual([]);
  expect(readExitNotice(env.db)).toBeNull();
});

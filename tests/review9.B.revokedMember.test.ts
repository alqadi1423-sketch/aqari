/**
 * B-2 · حرج · src/services/cloud.ts:279 (checkEpoch قبل العضوية) و:307 (syncOnce يسحب برموز العضوية المحفوظة) و:318-345 (فحص العضوية
 * لا يُبلغ إلا بعد نجاحهما) · firestore.rules:809-811 (عهد المسح للمالك والأعضاء وحدهم) و:740 (الصفوف برموز العضو الحالية) و:776 (مستند العضوية يقرؤه صاحبه دائماً)
 *
 * السيناريو (بيانات مصطنعة، والسحابة fetch يحاكي قواعد firestore.rules كما يثبتها tests/orgRules.emulator.test.ts:130-135):
 *  (أ) المالك أزال العضو. جهاز العضو متصل وطابوره فارغ. في كل دورة: قراءة meta/epoch ترجع 403 (القاعدة للمالك والأعضاء وحدهم)،
 *      فترمي syncNow قبل أن تبلغ refreshMembership التي كانت ستقرأ مستند عضويته (يقرؤه صاحبه ولو حُذف: 404) فتعرف الإزالة.
 *  (ب) المالك أنقص صلاحية العضو من «كل العقارات» إلى عقارٍ واحد. السحب يجري برموزه القديمة (s|@) فيرفض الخادم الاستعلام كله (403)،
 *      فلا تبلغ الدورة فحص العضوية، ولا يعرف الجهاز صلاحيته الجديدة أبداً.
 *
 * لماذا يهم: قرار المالك 2026-10-03 «عند الحذف: تُمسح بيانات المنشأة من جهازه عند أول اتصال» و2026-10-05 «تُمسح بياناتها من جهازه عند
 * أول اتصال» (نقل الوحدة) · والمحسوم بالقاعدة ٩٩ في 2026-11-07 «نقص الصلاحية يفرّغ ما لم يعد يحق له رؤيته». بالكود الحالي يبقى
 * جوال المُزال أو من أُنقصت صلاحيته يعرض كل ما كان يراه بلا حدّ زمني، ويظهر له «تعذّرت المزامنة» وحدها، ولا يُرفع ما في طابوره أبداً.
 *
 * السلوك الصحيح: فحص العضوية (مستند العضو يقرؤه صاحبه دائماً) يسبق كل قراءةٍ تشترط العضوية في الدورة، فأول دورةٍ متصلة بعد الإزالة
 * تفرّغ الجهاز (أو تسأل إن بقي في طابوره شيء)، وبعد الإنقاص تُحفظ الصلاحية الجديدة ويُسحب بها.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const kv = new Map<string, string>();
const cloudSide = { mode: 'removed' as 'removed' | 'reduced', calls: [] as string[] };

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

const ORG = 'ORG-R9B2';
const MEMBER = 'MEMBER-R9B2';

// السحابة كما تقضي firestore.rules لهذا العضو: (أ) لا عضوية · (ب) عضويته بعقارٍ واحد بعد أن كانت لكل العقارات
(global as unknown as { fetch: unknown }).fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
  const res = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => null } });
  cloudSide.calls.push((init.method ?? 'GET') + ' ' + url.replace(/^https:\/\/[^/]+/, '').replace(/\?.*$/, ''));
  if (url.includes('securetoken.googleapis.com')) return res(200, { user_id: MEMBER, id_token: 'ID', refresh_token: 'R', expires_in: '3600' });
  const denied = { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } };
  const member = cloudSide.mode === 'reduced';
  // مستند العضوية: يقرؤه صاحبه دائماً (firestore.rules · members/{uid} read)
  if (url.includes(`/orgs/${ORG}/members/${MEMBER}`)) {
    return member
      ? res(200, { fields: { email: { stringValue: 'm@example.test' }, perm: { mapValue: { fields: { collect: { integerValue: '1' } } } },
        all: { booleanValue: false }, props: { arrayValue: { values: [{ stringValue: 'P1' }] } },
        tokens: { arrayValue: { values: [{ stringValue: 'collect|P1' }, { stringValue: 'collect|*' }] } } } })
      : res(404, { error: { code: 404, status: 'NOT_FOUND' } });
  }
  // meta/epoch وcompat وmoves وcounters: للمالك والأعضاء
  if (/\/orgs\/[^/]+\/meta\//.test(url)) return member ? res(404, { error: { code: 404 } }) : res(403, denied);
  // السحب: الاستعلام برموزٍ ليست كلها من رموزه الحالية يُرفض كله
  if (url.includes(':runQuery')) {
    if (!member) return res(403, denied);
    const q = JSON.parse(init.body ?? '{}') as { structuredQuery?: { where?: { fieldFilter?: { value?: { arrayValue?: { values?: Array<{ stringValue: string }> } } } } } };
    const toks = q.structuredQuery?.where?.fieldFilter?.value?.arrayValue?.values?.map((v) => v.stringValue) ?? [];
    return toks.every((t) => ['collect|P1', 'collect|*'].includes(t)) ? res(200, []) : res(403, denied);
  }
  if (url.includes(':commit')) return member ? res(200, { commitTime: new Date().toISOString() }) : res(403, denied);
  return res(404, { error: { code: 404 } });
};

import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addProperty } from './helpers/fixtures';
import { makeSafetyBackup, safetyBackupsDir } from '@/domain/backup/create';
import { prepareRestore } from '@/domain/backup/restore';
import { t } from '@/i18n';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
beforeAll(() => {
  process.env.EXPO_PUBLIC_FIREBASE_API_KEY = 'k';
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID = 'p';
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'w';
});

/** جوال عضوٍ بكل العقارات في قسم التحصيل وعليه بيانات المنشأة · وطابوره فارغ (كل شيءٍ رُفع) */
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

test('B-2 (أ) · العضو المُزال: أول دورةٍ متصلة تعرف الإزالة ولا تُبقي بيانات المنشأة على جواله', async () => {
  cloudSide.mode = 'removed';
  const env = memberPhone('aqari-r9b2-removed-');
  const st = await runCycles(env, 3);
  const { readMembership } = await import('@/services/access');
  const live = env.live();
  const props = live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n;
  const knows = readMembership(live) === null || st.decision?.kind === 'removed'
    || live.get<{ v: string }>(`SELECT v FROM sync_state WHERE k = 'removal_pending'`)?.v === '1';
  // eslint-disable-next-line no-console
  console.log('B-2 (أ) · بعد ثلاث دورات متصلة: آخر خطأ =', st.lastError, '· العضوية باقية =', !!readMembership(live), '· عقارات المنشأة على الجوال =', props,
    '· آخر الطلبات:', cloudSide.calls.slice(-4));
  expect(knows).toBe(true);
});

test('B-2 (ب) · إنقاص الصلاحية: الجهاز يعرف صلاحيته الجديدة ولا يبقى يسحب بالقديمة فيُرفض', async () => {
  cloudSide.mode = 'reduced';
  cloudSide.calls = [];
  const env = memberPhone('aqari-r9b2-reduced-');
  const st = await runCycles(env, 3);
  const { readMembership } = await import('@/services/access');
  const live = env.live();
  const m = readMembership(live);
  const pending = live.get<{ v: string }>(`SELECT v FROM sync_state WHERE k = 'perm_wipe_pending'`)?.v ?? null;
  // eslint-disable-next-line no-console
  console.log('B-2 (ب) · بعد ثلاث دورات: آخر خطأ =', st.lastError, '· كل العقارات ما زالت =', m?.allProps, '· تفريغٌ منتظر =', pending,
    '· عقارات على الجوال =', live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n, '· طلب مستند العضوية:', cloudSide.calls.some((c) => c.includes('/members/')));
  // عرف الصلاحية الجديدة (حفظها أو فرّغ الجهاز لها)
  expect(m === null || (m.allProps === false && m.props.join() === 'P1') || pending !== null).toBe(true);
});

/* ─── B-4 · ما يبقى على جوال المُزال (المراجعة الشاملة 2026-11-13 · قرارا المالك س٩ وس١٠ تطبيقاً لقرار 2026-11-07 (٢ أ)) ───
 * «يُفرَّغ جواله عند أول اتصال بعد حفظ ذلك التعديل وحده في ملفٍ صغير يُرسل لك، بلا خيار «أبقِ بياناتي»» · كان مسار الإزالة يصنع نسخة أمانٍ
 * كاملة غير مشفّرة يستعيدها من «البيانات والمساحة» بعد أن يصير جهازه «مالكاً» لحسابه، و«أبقِ بياناتي» يُبقي الجهاز كما هو بلا حد. */

/** الدورات كما في runCycles، والوحدة نفسها تبقى بيد الاختبار (لقرار «تم» بعدها) */
async function startCycles(env: ReturnType<typeof makeBackupEnv>, n: number) {
  let cloud!: typeof import('@/services/cloud');
  await jest.isolateModulesAsync(async () => { cloud = await import('@/services/cloud'); });
  const stop = cloud.startCloud(env.db as never);
  const settle = async () => { for (let i = 0; i < 100 && (cloud.cloudState().syncing || !cloud.cloudState().restored); i++) await new Promise((r) => setTimeout(r, 30)); };
  await new Promise((r) => setTimeout(r, 100));
  await settle();
  for (let i = 0; i < n; i++) { await cloud.syncNow(); await settle(); }
  return { cloud, stop, settle };
}

/** عملٌ لم يُرفع على جوال العضو: تعديلٌ في الطابور، ورفضٌ لعمله، وواردٌ من غيره رُفض تطبيقه (ليس من عمله) */
function unsyncedOn(db: import('@/db/adapter').DB) {
  const dev = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'device_id'`)!.value;
  db.run(`UPDATE properties SET name = 'عقار مصطنع معدَّل' WHERE id = 'P1'`);
  const at = '2026-11-13T08:00:00.000Z';
  db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`, ['properties__P2', 'properties', 'P2',
    'خارج صلاحيتك · بقي على هذا الجهاز ولم يُرفع', JSON.stringify({ id: 'properties__P2', t: 'properties', k: 'P2', d: { id: 'P2', name: 'تعديل مرفوض مصطنع' }, u: at, dev, del: false }), at]);
  db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`, ['properties__PX', 'properties', 'PX',
    'سجل أب غير موجود بعد محاولات متكررة', JSON.stringify({ id: 'properties__PX', t: 'properties', k: 'PX', d: { id: 'PX', name: 'وارد مصطنع' }, u: at, dev: 'OTHER-DEVICE', del: false }), at]);
}

test('B-4 · المُزال وعنده ما لم يُرفع: يُحفظ عمله وحده في ملفٍ صغير، ويُفرَّغ بلا نسخة أمان، وتُحذف نسخ جهازه منذ انضمامه، ولا تُستعاد نسخةٌ صُدّرت قبل خروجه', async () => {
  cloudSide.mode = 'removed';
  cloudSide.calls = [];
  const env = memberPhone('aqari-r9b4-removed-');
  const db = env.db;
  const backups = safetyBackupsDir(env);
  // نسخةٌ قبل انضمامه (بياناته هو) تبقى له · ونسخة أمانٍ وهو عضو (فيها بيانات المنشأة) تُحذف
  db.run(`INSERT INTO sync_state (k, v) VALUES ('member_since', '2021-01-01T00:00:00.000Z') ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
  fs.mkdirSync(backups, { recursive: true });
  fs.writeFileSync(path.join(backups, 'pre-upgrade-2020-01-01T00-00-00-000Z-v50.aqbk'), 'نسخة مصطنعة قبل الانضمام');
  const memberCopy = await makeSafetyBackup(env, 'pre-wipe');
  const exported = path.join(env.root, 'exported-before-exit.aqbk');
  fs.copyFileSync(memberCopy, exported);
  unsyncedOn(db);
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_outbox`)!.n).toBe(1);

  const { cloud, stop, settle } = await startCycles(env, 2);
  const live = env.live();
  const st = cloud.cloudState();
  // أول دورةٍ متصلة: لا رفع بعد الإزالة، والجهاز فُرّغ، والإشعار بعدد ما حُفظ
  expect(cloudSide.calls.some((c) => c.includes(':commit'))).toBe(false);
  expect(live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n).toBe(0);
  const { readMembership } = await import('@/services/access');
  expect(readMembership(live)).toBeNull();
  expect(st.decision).toEqual({ kind: 'removed', pending: 2 });
  // لا نسخة أمانٍ صُنعت، ونسخ الجهاز منذ انضمامه حُذفت · وما قبله باقٍ
  expect(fs.readdirSync(backups).filter((n) => n.endsWith('.aqbk'))).toEqual(['pre-upgrade-2020-01-01T00-00-00-000Z-v50.aqbk']);
  // الملف الصغير: التعديل الذي في الطابور والرفض لعمله وحدهما · لا الوارد من غيره ولا بقية المنشأة
  const dir = path.join(backups, 'unsynced');
  const files = fs.readdirSync(dir);
  expect(files).toHaveLength(1);
  const work = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  expect(work.format).toBe('aqari-unsynced-work');
  expect(work.reason).toBe('removed');
  expect(work.org).toBe(ORG);
  expect(work.docs.map((d: { id: string }) => d.id)).toEqual(['properties__P1']);
  expect(work.docs[0].d.name).toBe('عقار مصطنع معدَّل');
  expect(work.rejected.map((r: { doc: { id: string } }) => r.doc.id)).toEqual(['properties__P2']);
  // سطر السجل: التفريغ بسببه، بلا نسخة أمان، وما حُفظ
  const line = live.get<{ entity_name: string }>(`SELECT entity_name FROM audit_log WHERE entity_type = 'تفريغ الجهاز'`)!.entity_name;
  expect(line).toContain('بلا نسخة أمان');
  expect(line).toContain(files[0]);
  // نسخةٌ صُدّرت أو بقيت من وقت عضويته لا تُستعاد على جهازه بعد خروجه
  await expect(prepareRestore(env, exported)).rejects.toThrow(t('restore.foreignMembership'));
  // الدورة التالية لا تنشئ منشأة ولا ترفع: الإشعار ينتظر قراءته
  expect(cloud.cloudState().decision?.kind).toBe('removed');
  // «تم»: يُمحى الإشعار ويُحذف الملف بأمره
  await cloud.resolveDecision('done');
  await settle();
  expect(fs.readdirSync(dir)).toEqual([]);
  expect(env.live().get<{ v: string }>(`SELECT v FROM sync_state WHERE k = 'exit_notice'`)?.v ?? null).toBeNull();
  stop();
});

test('B-4 · لا «أبقِ بياناتي» للمُزال: القرار بعد الإزالة لا يُبقي ولا يفرّغ من جديد · وبلا ما لم يُرفع لا ملف', async () => {
  cloudSide.mode = 'removed';
  cloudSide.calls = [];
  const env = memberPhone('aqari-r9b4-nothing-');
  const { cloud, stop } = await startCycles(env, 1);
  expect(cloud.cloudState().decision).toEqual({ kind: 'removed', pending: 0 });
  expect(fs.existsSync(path.join(safetyBackupsDir(env), 'unsynced'))).toBe(false);
  await cloud.resolveDecision('keep');
  expect(cloud.cloudState().decision).toEqual({ kind: 'removed', pending: 0 });
  stop();
});

test('B-2 · رفضٌ (403) في أثناء الدورة بعد فحص العضوية: تُفحص من جديد فيُعرف أنه أُزيل ولا يظهر «تعذّر الاتصال»', async () => {
  cloudSide.mode = 'removed';
  cloudSide.calls = [];
  const env = memberPhone('aqari-r9b2-race-');
  // أول قراءةٍ لمستند العضوية تجده كما هو (أُزيل بعدها بلحظة) · وما بعدها كما تقضي القواعد
  const real = (global as unknown as { fetch: (u: string, i?: unknown) => Promise<unknown> }).fetch;
  let first = true;
  (global as unknown as { fetch: unknown }).fetch = async (url: string, init?: unknown) => {
    if (first && url.includes(`/orgs/${ORG}/members/${MEMBER}`)) {
      first = false;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}),
        text: async () => JSON.stringify({ fields: { email: { stringValue: 'm@example.test' }, perm: { mapValue: { fields: { collect: { integerValue: '1' } } } },
          all: { booleanValue: true }, props: { arrayValue: { values: [] } }, tokens: { arrayValue: { values: [{ stringValue: 'collect|*' }] } } } }) };
    }
    return real(url, init);
  };
  try {
    const { cloud, stop } = await startCycles(env, 0);
    const st = cloud.cloudState();
    expect(st.lastError).toBeNull();
    expect(st.decision?.kind).toBe('removed');
    const { readMembership } = await import('@/services/access');
    expect(readMembership(env.live())).toBeNull();
    stop();
  } finally {
    (global as unknown as { fetch: unknown }).fetch = real;
  }
});

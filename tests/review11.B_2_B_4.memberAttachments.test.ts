/**
 * مراجعة إصلاح B-2 وB-4 (المراجعة الشاملة 2026-11-13) · متوسط · مرفقات العضو التي لم تبلغ صاحب المنشأة تُتلف عند إزالته بلا أثر
 *
 * السيناريو (بيانات مصطنعة، والسحابة fetch يحاكي firestore.rules كما في tests/review9.B.revokedMember.test.ts):
 *  عضوٌ محصِّل صوّر إيصال تحصيلٍ (أو صورة عقدٍ أو هوية) فأرفقه على جواله. تخزين الملفات مطفأ اليوم (EXPO_PUBLIC_FILES_CLOUD لا يُضبط في
 *  أي بناء · F-الاستقلال-عن-قوقل.md G-06)، فصفّ المرفق لا يُلتقط ولا يُرفع (sync_ctl.capture_files = 0) والملف لا يُرفع: نسخته الوحيدة على
 *  جوال العضو، و«ينتظر الرفع» في file_cache · وكذلك حين يعمل التخزين وبقي الملف في طابوره (file_cache.uploaded = 0) لم يُرفع بعد.
 *  أزاله المالك. أول دورةٍ متصلة: exitRemoved ← saveUnsyncedWork يجمع sync_outbox وsync_rejects وحدهما (memberExit.ts:collectUnsyncedWork)
 *  فلا ملف (لا شيء في الطابور) ← wipeForRemoval يحذف مجلد المرفقات بلا نسخة أمان ← الإيصال تلف، والورقة تقول «فُرّغ هذا الجهاز من
 *  بيانات المنشأة، ولا تبقى عليه نسخةٌ منها» بلا زر إرسال (pending = 0).
 *
 * لماذا يهم: قرار المالك س٩ (2026-11-13) «يُفرَّغ جواله عند أول اتصال بعد حفظ ذلك التعديل وحده في ملفٍ صغير يُرسل لك» وتوصية المراجع التي
 * وافق عليها «ولا يضيع عمله» · وقرار 2026-11-07 (٢ أ) «لا نسخة للعضو المُزال إلا بما لم يُرفع من عمله». الإيصال مما لم يُرفع من عمله،
 * وكان قبل الإصلاح باقياً في نسخة الأمان الكاملة (وهو ما أزاله B-4 بحق)، فصار الإصلاح يتلف النسخة الوحيدة من مستندٍ للمنشأة لم يبلغ
 * صاحبها قط. والمغادرة الطوعية (leaveOrgNow) كذلك: شرطها طابورٌ فارغ (outboxCount) لا ملفاتٌ رُفعت.
 *
 * السلوك الصحيح: ما لم يُرفع من ملفات العضو (مرفقاتٌ في file_cache بـ uploaded = 0، ومعها صفوفها) يُحفظ مع «ما لم يُرفع من عمله» قبل
 * التفريغ (في الملف نفسه أو بجواره في مجلده)، فيُعرض على العضو زرّ إرساله إلى صاحب المنشأة (pending > 0) · أو يقرر المالك صراحةً أن
 * الملفات لا تدخل «الملف الصغير» ويُقال ذلك للعضو قبل الإتلاف. والاختبار يقبل أي تصميمٍ يُبقي بايتات الإيصال على الجهاز ضمن ما يُرسل:
 * ملفاً بالبايتات نفسها، أو نصاً فيه ترميزها base64.
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

const ORG = 'ORG-R11B4A';
const MEMBER = 'MEMBER-R11B4A';

// السحابة كما تقضي firestore.rules لعضوٍ أُزيل: مستند عضويته يقرؤه صاحبه (404 بعد حذفه)، وما سواه للمالك والأعضاء (403)
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
import { putAttachment } from '@/files/store';

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
  set('member_since', '2026-01-01T00:00:00.000Z');
  set('membership', JSON.stringify({ org: ORG, uid: MEMBER, perms: { collect: 2 }, allProps: true, props: [], profile: { name: 'عضو مصطنع', phone: '0500000000', nid: '', title: '' } }));
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

/** كل ملفٍ تحت المجلد (بلا اتّباع روابط) */
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

test('العضو المُزال: إيصالٌ أرفقه ولم يُرفع لا يُتلف بالتفريغ بلا أثر · يُحفظ مع ما لم يُرفع من عمله ويُعرض زرّ إرساله', async () => {
  const env = memberPhone('aqari-r11b4-att-');
  // إيصال تحصيلٍ مصطنع صوّره العضو على جواله · لم يُرفع (تخزين الملفات مطفأ، أو في طابوره)
  const receipt = new Uint8Array(4096).map((_, k) => (k * 31 + 7) % 251);
  const att = await putAttachment(env.filesEnv, receipt, { entityType: 'property', entityId: 'P1', kind: 'إيصال', originalName: 'إيصال تحصيل مصطنع.pdf', mime: 'application/pdf' });
  expect(env.db.get<{ uploaded: number }>(`SELECT uploaded FROM file_cache WHERE sha256 = ?`, [att.sha256])?.uploaded).toBe(0);
  expect(fs.existsSync(path.join(env.attachmentsDir, att.sha256 + '.pdf'))).toBe(true);

  const st = await runCycles(env, 2);
  const live = env.live();
  // الإزالة نفسها كما أصلحها B-2 وB-4: فُرّغ الجهاز في أول دورة
  expect(live.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties`)!.n).toBe(0);
  expect(st.decision?.kind).toBe('removed');

  // ما لم يُرفع من عمله يشمل الإيصال: بايتاته باقيةٌ على الجهاز ضمن ما يُرسل إلى صاحب المنشأة (بالبايتات نفسها أو بترميز base64)
  const b64 = Buffer.from(receipt).toString('base64');
  const kept = walk(env.root).filter((p) => {
    const buf = fs.readFileSync(p);
    return Buffer.compare(buf, Buffer.from(receipt)) === 0 || buf.toString('utf8').includes(b64);
  });
  // eslint-disable-next-line no-console
  console.log('B-4 · بعد الإزالة: ملفات الجهاز =', walk(env.root).map((p) => path.relative(env.root, p)), '· الإشعار =', st.decision);
  expect(kept.length).toBeGreaterThan(0);
  // ويُعرض على العضو زرّ إرساله (الورقة تعرضه حين pending > 0)
  expect(st.decision!.pending).toBeGreaterThan(0);
});

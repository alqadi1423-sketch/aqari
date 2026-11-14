/**
 * ق٠-٦ · الجزء الأول: مزوّد الهوية (cloud/authProvider.ts) · قوقل خلف الواجهة بلا تغيير في السلوك، وطبقة الربط (services/cloud.ts)
 * تمرّ بالواجهة وحدها فيعمل «نسيت الرمز» و«تأكيد حسابي» والجلسة بمزوّدٍ مصطنع لا يعرف قوقل · حساباتٌ ورموزٌ مصطنعة.
 */
import { mockKv, mockGoogleCalls } from './helpers/cloudNativeMocks';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createSession, KEYS } from '@/cloud/session';
import { googleAuthProvider } from '@/cloud/googleAuth';
import { FreshProofRequiredError, type AuthIdentity, type AuthProvider, type FreshProof, type FreshPurpose } from '@/cloud/authProvider';
import { checkAccountProof, jwtClaims } from '@/domain/lockReset';
import * as cloud from '@/services/cloud';

const ROOT = join(__dirname, '..');
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sec = (ms: number) => Math.floor(ms / 1000);
const fbToken = (uid: string, provider = 'google.com', at = Date.now()) =>
  b64({ alg: 'RS256' }) + '.' + b64({ user_id: uid, sub: uid, auth_time: sec(at), iat: sec(at), firebase: { sign_in_provider: provider } }) + '.c2ln';

function googleOver(chosen = 'uid-owner-a') {
  const store = new Map<string, string>([[KEYS.uid, 'uid-owner-a'], [KEYS.refresh, 'r-owner-a'], [KEYS.email, 'a@example.test']]);
  const calls: string[] = [];
  const session = createSession({
    google: {
      signIn: async () => { calls.push('signIn'); return { idToken: 'g-' + chosen, email: chosen + '@example.test' }; },
      signInSilently: async () => true,
      accessToken: async () => 'drive-acc',
      signOut: async () => { calls.push('signOut'); },
    },
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, del: async (k) => { store.delete(k); } },
    signInWithIdp: async (g) => {
      calls.push('idp');
      const uid = g.replace('g-', '');
      return { uid, email: uid + '@example.test', idToken: fbToken(uid), refreshToken: 'r-new', expiresAt: 9e15 };
    },
    refresh: async (r) => ({ uid: 'uid-owner-a', idToken: 'fb-refreshed', refreshToken: r, expiresAt: 9e15 }),
  });
  const deleted: string[] = [];
  const p = googleAuthProvider({ session, deleteFirebaseAccount: async (tok) => { deleted.push(tok); } });
  return { p, store, calls, deleted };
}

describe('مزوّد قوقل خلف الواجهة: السلوك كما هو', () => {
  test('الهوية تحمل المزوّد ورقم الجهاز · ورمز الخادم من الجلسة نفسها · ورمز Drive لقوقل وحده', async () => {
    const { p } = googleOver();
    expect(p.id).toBe('google');
    expect(p.current()).toBeNull();
    const who = await p.restore();
    expect(who).toEqual<AuthIdentity>({ uid: 'uid-owner-a', email: 'a@example.test', provider: 'google', deviceId: null });
    expect(p.current()).toEqual(who);
    expect(await p.accessToken()).toBe('fb-refreshed');
    expect(await p.driveToken()).toBe('drive-acc');
  });

  test('«نسيت الرمز»: خروجٌ من قوقل ثم دخولٌ جديد يُفحص · والجلسة المحفوظة لا تُمسّ', async () => {
    const { p, store, calls } = googleOver();
    await p.restore();
    const before = JSON.stringify([...store]);
    const r = await p.freshProof('lockReset');
    expect(r).toMatchObject({ ok: true });
    expect(calls).toEqual(['signOut', 'signIn', 'idp']);
    expect(JSON.stringify([...store])).toBe(before);
    const other = googleOver('uid-intruder-b');
    await other.p.restore();
    expect(await other.p.freshProof('lockReset')).toEqual({ ok: false, why: 'mismatch' });
  });

  test('«حذف حسابي»: إثباتٌ لغرض الحذف يحفظ رمزه الحديث ثم يُحذف حساب Firebase به · وبلا إثباتٍ أو بإثبات القفل لا حذف', async () => {
    const { p, store, deleted } = googleOver();
    await p.restore();
    await expect(p.deleteAccount({ ok: true, serverMs: Date.now() })).rejects.toBeInstanceOf(FreshProofRequiredError);
    const lock = await p.freshProof('lockReset');
    await expect(p.deleteAccount(lock)).rejects.toBeInstanceOf(FreshProofRequiredError);
    expect(deleted).toEqual([]);
    const proof = await p.freshProof('deleteAccount');
    expect(proof.ok).toBe(true);
    expect(store.get(KEYS.refresh)).toBe('r-new');
    await p.deleteAccount(proof);
    // الرمز الحديث من الدخول الجديد لا رمزٌ مجدَّد
    expect(deleted.length).toBe(1);
    expect(deleted[0]).not.toBe('fb-refreshed');
    expect(jwtClaims(deleted[0])).toMatchObject({ user_id: 'uid-owner-a', firebase: { sign_in_provider: 'google.com' } });
    await expect(p.deleteAccount(proof)).rejects.toBeInstanceOf(FreshProofRequiredError);
  });

  test('فحص رمز Firebase يأخذ مزوّده من المنادي: الجلسة تطلب قوقل، والفحص نفسه لا يحصره فيه', () => {
    expect(checkAccountProof(fbToken('u1', 'password'), 'u1', 'password')).toMatchObject({ ok: true });
    expect(checkAccountProof(fbToken('u1', 'password'), 'u1', 'google.com')).toEqual({ ok: false, why: 'provider' });
    expect(src('src/cloud/session.ts')).toMatch(/checkAccountProof\(fb\.idToken, uid, GOOGLE_SIGN_IN\)/);
  });
});

/* ═══ طبقة الربط الحقيقية بمزوّدٍ مصطنع لا يعرف قوقل ═══ */

function fakeProvider(o: { proof?: FreshProof } = {}) {
  const log: string[] = [];
  const me: AuthIdentity = { uid: 'uid-device-owner', email: '', provider: 'device', deviceId: 'dev-1' };
  let cur: AuthIdentity | null = null;
  const p: AuthProvider = {
    id: 'device',
    restore: async () => { log.push('restore'); cur = me; return me; },
    signIn: async () => { log.push('signIn'); cur = me; return me; },
    current: () => cur,
    accessToken: async () => { log.push('accessToken'); return 'server-access'; },
    freshProof: async (purpose: FreshPurpose) => { log.push('fresh:' + purpose); return o.proof ?? { ok: true, serverMs: 1_790_000_000_000 }; },
    signOut: async () => { log.push('signOut'); cur = null; },
    deleteAccount: async () => { log.push('deleteAccount'); },
  };
  return { p, log };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('طبقة الربط تمرّ بالمزوّد وحده', () => {
  beforeEach(() => { mockKv.clear(); mockGoogleCalls.length = 0; cloud.setAuthProvider(null); });
  afterAll(() => cloud.setAuthProvider(null));

  test('بلا إعداد Firebase ولا قوقل: الجلسة تُستعاد من المزوّد، و«نسيت الرمز» يأخذ إثباته منه بغرض القفل', async () => {
    expect(cloud.accountConfirmable()).toBe(false);
    const { p, log } = fakeProvider();
    cloud.setAuthProvider(p);
    expect(cloud.cloudState().configured).toBe(true);
    cloud.primeSession();
    await settle();
    expect(cloud.cloudState().user).toMatchObject({ uid: 'uid-device-owner', provider: 'device', deviceId: 'dev-1' });
    expect(cloud.accountConfirmable()).toBe(true);
    expect(await cloud.confirmSameAccount()).toEqual({ ok: true, serverMs: 1_790_000_000_000 });
    expect(log).toEqual(['restore', 'fresh:lockReset']);
    expect(mockGoogleCalls).toEqual([]);
  });

  test('رفض المزوّد يصل كما هو (سُحب الجهاز، أو بلغ الحدّ بساعة الخادم) · وبلا حساب لا يُسأل', async () => {
    const { p, log } = fakeProvider({ proof: { ok: false, why: 'limit', waitMs: 5 * 3_600_000 } });
    cloud.setAuthProvider(p);
    expect(await cloud.confirmSameAccount()).toEqual({ ok: false, why: 'none' });
    expect(log).toEqual([]);
    cloud.primeSession();
    await settle();
    expect(await cloud.confirmSameAccount()).toEqual({ ok: false, why: 'limit', waitMs: 5 * 3_600_000 });
    expect(mockGoogleCalls).toEqual([]);
  });

  test('المنادون لا يعرفون قوقل: لا «google.com» ولا نداء جلسة قوقل مباشرة خارج مزوّد قوقل', () => {
    const files = (d: string): string[] => readdirSync(join(ROOT, d)).flatMap((n) => {
      const rel = d + '/' + n;
      return statSync(join(ROOT, rel)).isDirectory() ? files(rel) : /\.tsx?$/.test(n) ? [rel] : [];
    });
    const google = new Set(['src/cloud/session.ts', 'src/cloud/authRest.ts', 'src/cloud/googleAuth.ts', 'src/domain/lockReset.ts']);
    const offenders = [...files('src'), ...files('app')].filter((f) => !google.has(f) && /google\.com['"`]/.test(src(f)));
    expect(offenders).toEqual([]);
    const c = src('src/services/cloud.ts');
    expect(c).not.toMatch(/\.(confirmSameAccount|reauthSameAccount)\(\)/);
    expect(c).toMatch(/s\.freshProof\('lockReset'\)/);
    expect(c).toMatch(/s\.freshProof\('deleteAccount'\)/);
    expect(c).toMatch(/s\.deleteAccount\(proof\)/);
    expect(c).not.toMatch(/deleteFirebaseAccount\(\{/);
    // مزوّد قوقل يربط الغرضين بنداءي الجلسة القائمين
    const g = src('src/cloud/googleAuth.ts');
    expect(g).toMatch(/purpose === 'lockReset'\) return s\.confirmSameAccount\(\)/);
    expect(g).toMatch(/s\.reauthSameAccount\(\)/);
  });
});

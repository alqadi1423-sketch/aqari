/**
 * ق٠-٦ · الجزء الرابع: «حذف حسابي» عبر الإثبات الحديث من مزوّد الهوية بلا افتراض قوقل (cloud/deleteAccountFlow.ts) · بقوقل كما كان
 * خطوةً خطوة ونصّاً نصّاً · وبمزوّد الجهاز أمام خادم الهوية الحقيقي في الذاكرة · وطبقة الربط الحقيقية بمزوّدٍ مصطنع بلا قوقل ولا
 * Firebase · حساباتٌ مصطنعة.
 */
import { mockGoogleCalls, mockHolder } from './helpers/cloudNativeMocks';
jest.mock('@/services/deviceReset', () => ({ resetDeviceData: async () => { mockReset.n++; } }));
const mockReset = { n: 0 };

import { randomBytes } from 'crypto';
import ar from '@/i18n/locales/ar.json';
import { createSession, KEYS } from '@/cloud/session';
import { googleAuthProvider } from '@/cloud/googleAuth';
import { deviceAuthProvider, DEVICE_KEYS, type DeviceAuthClient } from '@/cloud/deviceAuth';
import { deleteAccountFlow, type DeleteFlowDeps } from '@/cloud/deleteAccountFlow';
import { FreshProofRequiredError, type AuthIdentity, type AuthProvider, type FreshPurpose, type FreshProof } from '@/cloud/authProvider';
import { jwtClaims } from '@/domain/lockReset';
import type { SecureKV } from '@/cloud/session';
import { createAuthServer, MemoryAuthStorage, type AuthServer } from '../server/auth';
import * as cloud from '@/services/cloud';
import { memDb } from './helpers/testDb';

/** النصّ العربي كما يراه المستخدم */
const tAr = (k: string): string => k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], ar) as string ?? k;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sec = (ms: number) => Math.floor(ms / 1000);
const fbToken = (uid: string, at = Date.now()) =>
  b64({ alg: 'RS256' }) + '.' + b64({ user_id: uid, sub: uid, auth_time: sec(at), iat: sec(at), firebase: { sign_in_provider: 'google.com' } }) + '.c2ln';

function recorder(over: Partial<DeleteFlowDeps> = {}) {
  const log: string[] = [];
  const deps: Omit<DeleteFlowDeps, 'auth'> = {
    signedIn: true, online: true, t: tAr,
    progress: (m) => log.push('progress:' + m),
    pause: async () => { log.push('pause'); },
    resume: () => { log.push('resume'); },
    wipeAccountCloud: async () => { log.push('wipeAccountCloud'); },
    wipeDrive: async (tok) => { log.push('wipeDrive:' + tok); },
    driveRetired: false,
    resetDevice: async () => { log.push('resetDevice'); },
    done: () => { log.push('done'); },
    ...over,
  };
  return { log, deps };
}

function google(chosen = 'uid-owner-a', cancel = false) {
  const store = new Map<string, string>([[KEYS.uid, 'uid-owner-a'], [KEYS.refresh, 'r-owner-a'], [KEYS.email, 'a@example.test']]);
  const calls: string[] = [];
  const session = createSession({
    google: {
      signIn: async () => { calls.push('signIn'); return cancel ? null : { idToken: 'g-' + chosen, email: chosen + '@example.test' }; },
      signInSilently: async () => true,
      accessToken: async () => 'drive-acc',
      signOut: async () => { calls.push('signOut'); },
    },
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, del: async (k) => { store.delete(k); } },
    signInWithIdp: async (g) => { const uid = g.replace('g-', ''); calls.push('idp'); return { uid, email: uid + '@example.test', idToken: fbToken(uid), refreshToken: 'r-new', expiresAt: 9e15 }; },
    refresh: async (r) => ({ uid: 'uid-owner-a', idToken: 'fb-refreshed', refreshToken: r, expiresAt: 9e15 }),
  });
  const deleted: string[] = [];
  const p = googleAuthProvider({ session, deleteFirebaseAccount: async (tok) => { calls.push('deleteFirebase'); deleted.push(tok); } });
  return { p, store, calls, deleted };
}

describe('بقوقل: كما كان خطوةً خطوة ونصّاً نصّاً', () => {
  test('خروجٌ ثم دخولٌ جديد للحساب نفسه ثم السحابة ثم Drive ثم حساب Firebase برمزه الحديث ثم الجهاز ثم الخروج', async () => {
    const g = google();
    await g.p.restore();
    const { log, deps } = recorder();
    await deleteAccountFlow({ ...deps, auth: g.p });
    expect(log).toEqual([
      'progress:جاري تأكيد هويتك بقوقل', 'pause',
      'progress:جاري حذف بياناتك من السحابة', 'wipeAccountCloud',
      'progress:جاري حذف نسخك على Google Drive', 'wipeDrive:drive-acc',
      'progress:جاري حذف الحساب',
      'progress:جاري تفريغ هذا الجهاز', 'resetDevice', 'done', 'resume',
    ]);
    expect(g.calls).toEqual(['signOut', 'signIn', 'idp', 'deleteFirebase', 'signOut']);
    expect(jwtClaims(g.deleted[0])).toMatchObject({ user_id: 'uid-owner-a' });
    expect(g.store.size).toBe(0);
    // قفل الجهاز لا يُسأل في مسار قوقل (نافذة الدخول تشهد)
    const asked = { n: 0 };
    const g2 = google();
    await g2.p.restore();
    await deleteAccountFlow({ ...recorder({ confirmHolder: async () => { asked.n++; return false; } }).deps, auth: g2.p });
    expect(asked.n).toBe(0);
  });

  test('رسائل الرفض كما كانت · ولا يُحذف شيء ولا تتوقف المزامنة', async () => {
    const cases: Array<[ReturnType<typeof google>, string]> = [
      [google('uid-owner-a', true), 'أُلغي تأكيد الهوية'],
      [google('uid-intruder-b'), 'اخترت حساباً آخر · اختر الحساب نفسه لحذفه'],
    ];
    for (const [g, msg] of cases) {
      await g.p.restore();
      const { log, deps } = recorder();
      await expect(deleteAccountFlow({ ...deps, auth: g.p })).rejects.toThrow(msg);
      expect(log).toEqual(['progress:جاري تأكيد هويتك بقوقل']);
      expect(g.deleted).toEqual([]);
    }
    const stale = recorder();
    const p = { ...google().p, freshProof: async (): Promise<FreshProof> => ({ ok: false, why: 'stale' }) };
    await expect(deleteAccountFlow({ ...stale.deps, auth: p })).rejects.toThrow(tAr('auth.reauthFailed'));
    await expect(deleteAccountFlow({ ...recorder({ signedIn: false }).deps, auth: google().p })).rejects.toThrow('سجّل الدخول أولاً');
    await expect(deleteAccountFlow({ ...recorder({ online: false }).deps, auth: google().p })).rejects.toThrow('حذف الحساب يحتاج اتصالاً بالإنترنت');
    await expect(deleteAccountFlow({ ...recorder().deps, auth: null })).rejects.toThrow('سجّل الدخول أولاً');
  });

  test('بعد إخراج نسخ Drive (ق٠-١) لا يُطلب Drive · وفشل خطوةٍ يوقف ما بعدها وتُستأنف المزامنة', async () => {
    const g = google();
    await g.p.restore();
    const { log, deps } = recorder({ driveRetired: true });
    await deleteAccountFlow({ ...deps, auth: g.p });
    expect(log.some((x) => x.startsWith('wipeDrive'))).toBe(false);
    const g2 = google();
    await g2.p.restore();
    const failing = recorder({ wipeAccountCloud: async () => { throw new Error('cloud down'); } });
    await expect(deleteAccountFlow({ ...failing.deps, auth: g2.p })).rejects.toThrow('cloud down');
    expect(g2.deleted).toEqual([]);
    expect(failing.log.at(-1)).toBe('resume');
    expect(failing.log).not.toContain('resetDevice');
  });
});

/* ═══ مزوّد الجهاز أمام خادم الهوية الحقيقي ═══ */

const SETUP = 'SETUP-CODE-MASNOO-2026-ABCDEFGH';
function clientOf(srv: AuthServer): DeviceAuthClient {
  return {
    redeem: (r) => (r.kind === 'invite' ? srv.redeemInvite({ ...r, source: 't' })
      : srv.bootstrapOwner({ setupCode: r.code, uid: r.uid ?? '', name: r.name ?? '', deviceKey: r.deviceKey, source: 't' })),
    refresh: (t) => srv.refresh({ refreshToken: t }),
    attestLockReset: (a, r) => srv.attestLockReset(a, r),
    freshProof: (a, r) => srv.freshProof(a, r),
    deleteAccount: (a, r) => srv.deleteAccount(a, r),
    revokeDevice: (a, d) => srv.revokeDevice(a, d),
  };
}
const memKV = (): SecureKV & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); } };
};
async function org() {
  const srv = createAuthServer({ storage: new MemoryAuthStorage(), clock: () => Date.now(), signingKey: new Uint8Array(randomBytes(32)), setupCode: SETUP });
  const client = clientOf(srv);
  const random = (n: number) => new Uint8Array(randomBytes(n));
  const owner = deviceAuthProvider({ client, store: memKV(), random, askCode: async () => ({ kind: 'setup', code: SETUP, uid: 'uid-owner-x', name: 'مالك مصطنع' }) });
  await owner.signIn();
  const inv = await srv.createInvite(await owner.accessToken(), { uid: 'uid-member-y', name: 'عضو مصطنع', phone: '0500000002', role: 'staff' });
  if (!inv.ok) throw new Error('invite');
  const store = memKV();
  const member = deviceAuthProvider({ client, store, random, askCode: async () => ({ kind: 'invite', code: inv.code }) });
  await member.signIn();
  return { srv, owner, member, store };
}

describe('بمزوّد الجهاز: إثبات الخادم بقفل الجهاز · بلا قوقل ولا Drive', () => {
  test('قفل الجهاز أولاً ثم إثبات الخادم ثم الحذف عنده · لا خطوة Drive · ويُشعَر المالك · وتُمسح رموز الجهاز', async () => {
    const { srv, owner, member, store } = await org();
    const closed = recorder({ confirmHolder: async () => false });
    await expect(deleteAccountFlow({ ...closed.deps, auth: member })).rejects.toThrow(tAr('accountDelete.deviceLock'));
    expect(closed.log).toEqual([]);
    const access = await member.accessToken();
    const { log, deps } = recorder({ confirmHolder: async () => true });
    await deleteAccountFlow({ ...deps, auth: member });
    expect(log).toEqual([
      'progress:' + tAr('accountDelete.confirmDevice'), 'pause',
      'progress:جاري حذف بياناتك من السحابة', 'wipeAccountCloud',
      'progress:جاري حذف الحساب',
      'progress:جاري تفريغ هذا الجهاز', 'resetDevice', 'done', 'resume',
    ]);
    expect(await srv.verifyAccess(access)).toMatchObject({ ok: false, status: 401 });
    expect(store.m.size).toBe(0);
    const notes = await srv.listNotifications(await owner.accessToken());
    expect(notes.ok && notes.items.some((n) => n.kind === 'account_deleted' && n.uid === 'uid-member-y')).toBe(true);
  });

  test('جوالٌ سحبه المالك أو مفتاح جهازٍ لا يطابق: رسالته ولا يُحذف شيء', async () => {
    const { srv, owner, member, store } = await org();
    store.m.set(DEVICE_KEYS.key, 'B'.repeat(43));
    const bad = recorder();
    await expect(deleteAccountFlow({ ...bad.deps, auth: member })).rejects.toThrow(tAr('accountDelete.mismatchDevice'));
    expect(bad.log).toEqual(['progress:' + tAr('accountDelete.confirmDevice')]);
    const devId = (await member.restore())!.deviceId!;
    expect((await srv.revokeDevice(await owner.accessToken(), devId)).ok).toBe(true);
    await expect(deleteAccountFlow({ ...recorder().deps, auth: member })).rejects.toThrow(tAr('accountDelete.revoked'));
  });

  test('إثبات «نسيت الرمز» لا يصلح للحذف · ولا إثباتٌ مصنوع', async () => {
    const { member } = await org();
    const lock = await member.freshProof('lockReset');
    expect(lock.ok).toBe(true);
    await expect(member.deleteAccount(lock)).rejects.toBeInstanceOf(FreshProofRequiredError);
    await expect(member.deleteAccount({ ok: true, serverMs: Date.now() })).rejects.toBeInstanceOf(FreshProofRequiredError);
    await expect(member.deleteAccount({ ok: true, serverMs: Date.now(), ticket: 'delete:v1.e30.AAAA' })).rejects.toThrow(/401/);
  });

  test('المالك يحذف حسابه: تُحذف المنشأة عند الخادم فتسقط جلسة العضو', async () => {
    const { owner, member } = await org();
    await deleteAccountFlow({ ...recorder().deps, auth: owner });
    await expect(member.accessToken().then(() => member.freshProof('lockReset'))).resolves.toEqual({ ok: false, why: 'revoked' });
  });
});

/* ═══ طبقة الربط الحقيقية بمزوّدٍ مصطنع ═══ */

describe('services/cloud.ts deleteMyAccount بلا قوقل', () => {
  afterAll(() => cloud.setAuthProvider(null));

  test('بلا إعداد Firebase: لا خطوة Firestore ولا Drive ولا نداء لقوقل · قفل الجهاز يُسأل · والمزوّد يحذف بإثباته', async () => {
    const log: string[] = [];
    const me: AuthIdentity = { uid: 'uid-device-owner', email: '', provider: 'device', deviceId: 'dev-1' };
    let cur: AuthIdentity | null = null;
    const p: AuthProvider = {
      id: 'device',
      restore: async () => { cur = me; return me; },
      signIn: async () => me,
      current: () => cur,
      accessToken: async () => 'server-access',
      freshProof: async (purpose: FreshPurpose) => { log.push('fresh:' + purpose); return { ok: true, serverMs: 1, ticket: 'delete:T' }; },
      signOut: async () => { log.push('signOut'); cur = null; },
      deleteAccount: async (proof) => { log.push('delete:' + (proof.ok ? proof.ticket : '')); },
    };
    cloud.setAuthProvider(p);
    cloud.primeSession();
    await new Promise((r) => setTimeout(r, 30));
    expect(cloud.cloudState().user).toMatchObject({ uid: 'uid-device-owner' });
    mockHolder.lock = true; mockHolder.opens = true; mockHolder.asked = 0;
    const db = memDb();
    const progress: string[] = [];
    await cloud.deleteMyAccount(db as never, (m) => progress.push(m));
    expect(mockHolder.asked).toBe(1);
    expect(log).toEqual(['fresh:deleteAccount', 'delete:delete:T', 'signOut']);
    expect(mockReset.n).toBe(1);
    expect(cloud.cloudState().user).toBeNull();
    expect(mockGoogleCalls).toEqual([]);
    expect(progress.length).toBe(3);
    db.close();
  });
});

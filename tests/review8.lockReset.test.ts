/**
 * المراجعة الشاملة · البند ٥ (الأولوية الأولى): «نسيت الرمز» كان يتجاوز قفل التطبيق · إعادة الضبط تكتفي باختيار حساب قوقل
 * الموجود على الجهاز (بلا خروجٍ قبله يعود الحساب نفسه بلا نافذة) ولا حدّ لها ولا إشعار · رموزٌ وحسابات مصطنعة.
 */
const kv = new Map<string, string>();
const files = new Map<string, string>();
const fsFail = { read: false, write: false };
const nativeClock = { ms: 50_000_000 };
const device = { level: 0, pass: false, asked: 0 };

jest.mock('react-native', () => ({ NativeModules: { AqariClock: { elapsedRealtime: () => nativeClock.ms } } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => kv.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { kv.set(k, v); },
  deleteItemAsync: async (k: string) => { kv.delete(k); },
}));
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0 },
  getEnrolledLevelAsync: async () => device.level,
  authenticateAsync: async () => { device.asked++; return { success: device.pass }; },
}));
jest.mock('expo-file-system', () => ({
  Paths: { document: '/doc' },
  File: class {
    name: string;
    constructor(_dir: string, name: string) { this.name = name; }
    get exists() { return files.has(this.name); }
    textSync() { if (fsFail.read) throw new Error('fs'); return files.get(this.name) ?? ''; }
    write(v: string) { if (fsFail.write) throw new Error('fs'); files.set(this.name, v); }
    delete() { files.delete(this.name); }
  },
}));
jest.mock('@/services/cipher', () => ({ deviceCipher: jest.requireActual('@/files/nodeCipher').nodeCipher }));
jest.mock('@/i18n', () => ({ t: (k: string) => k }));

import { readFileSync } from 'fs';
import { join } from 'path';
import { createSession, KEYS, type AccountProof } from '@/cloud/session';
import {
  checkAccountProof, jwtClaims, resetWaitMs, serverWaitMs, attemptAge, recordReset, mergeResetLogs, emptyResetLog, resetWhen,
  logLockReset, RESET_LIMIT, RESET_WINDOW_MS, AUTH_FRESH_MS, type ClockNow, type ResetLog,
} from '@/domain/lockReset';
import { SELF_AUDIT_ENTITY, SELF_AUDIT_MODULE } from '@/domain/access/opWrites';
import { memDb } from './helpers/testDb';

const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** رمز هويةٍ من Firebase مصطنع (التوقيع لا يُفحص على الجهاز) */
function fbToken(p: Record<string, unknown>): string {
  return b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64(p) + '.c2ln';
}
const sec = (ms: number) => Math.floor(ms / 1000);
const fresh = (uid: string, at = Date.now()) =>
  fbToken({ user_id: uid, sub: uid, auth_time: sec(at), iat: sec(at), exp: sec(at) + 3600, name: 'سالم المصطنع', firebase: { sign_in_provider: 'google.com' } });

/* ═══ الجلسة: خروجٌ من قوقل ثم دخولٌ جديد · وحداثة الدخول ورقم الحساب من رمز الهوية ═══ */

function session(opts: { chosen?: string; token?: (uid: string) => string; signOutThrows?: boolean; now?: () => number } = {}) {
  const store = new Map<string, string>([[KEYS.uid, 'uid-owner-a'], [KEYS.refresh, 'r-owner-a'], [KEYS.email, 'a@example.test']]);
  const calls: string[] = [];
  const chosen = opts.chosen ?? 'uid-owner-a';
  const s = createSession({
    google: {
      signIn: async () => { calls.push('signIn'); return { idToken: 'g-' + chosen, email: chosen + '@example.test' }; },
      signInSilently: async () => true,
      accessToken: async () => 'acc',
      signOut: async () => { calls.push('signOut'); if (opts.signOutThrows) throw new Error('x'); },
    },
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, del: async (k) => { store.delete(k); } },
    signInWithIdp: async (g) => {
      calls.push('idp');
      const uid = g.replace('g-', '');
      return { uid, email: uid + '@example.test', idToken: (opts.token ?? fresh)(uid), refreshToken: 'r-new', expiresAt: 9e15 };
    },
    refresh: async (r) => ({ uid: 'x', idToken: 'id', refreshToken: r, expiresAt: 9e15 }),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { s, store, calls };
}

test('٥ «نسيت الرمز»: يخرج من قوقل أولاً فيُفرض اختيار الحساب ثم دخولٌ جديد · ولا يمسّ الجلسة المحفوظة', async () => {
  const { s, store, calls } = session();
  await s.restore();
  const before = JSON.stringify([...store]);
  const r = await s.confirmSameAccount();
  expect(r.ok).toBe(true);
  // كان signIn وحده: يعود حساب قوقل الحالي بلا نافذة
  expect(calls).toEqual(['signOut', 'signIn', 'idp']);
  expect(JSON.stringify([...store])).toBe(before);
});

test('٥ رمزٌ من دخولٍ قديم (auth_time قبل ساعتين، كرمزٍ مجدَّد) لا يُعدّ تأكيداً للحساب', async () => {
  const old = Date.now() - 2 * 3_600_000;
  const { s } = session({ token: (uid) => fbToken({ user_id: uid, auth_time: sec(old), iat: sec(Date.now()), firebase: { sign_in_provider: 'google.com' } }) });
  await s.restore();
  expect(await s.confirmSameAccount()).toEqual({ ok: false, why: 'stale' });
});

test('٥ رقم الحساب في رمز الهوية يطابق المحفوظ · وحسابٌ آخر يُرفض ويُخرج من قوقل بعده', async () => {
  // رمزٌ لحسابٍ غير الذي أعلنه الرد
  const forged = session({ token: () => fresh('uid-intruder-b') });
  await forged.s.restore();
  expect((await forged.s.confirmSameAccount()).ok).toBe(false);
  const other = session({ chosen: 'uid-intruder-b' });
  await other.s.restore();
  expect(await other.s.confirmSameAccount()).toEqual({ ok: false, why: 'mismatch' });
  expect(other.calls).toEqual(['signOut', 'signIn', 'idp', 'signOut']);
});

test('٥ تعذّر الخروج من قوقل قبل الدخول: لا تأكيد ولا نافذة', async () => {
  const { s, calls } = session({ signOutThrows: true });
  await s.restore();
  expect((await s.confirmSameAccount()).ok).toBe(false);
  expect(calls).toEqual(['signOut']);
});

test('٥ ساعة الجهاز المنحرفة لا تردّ دخولاً حديثاً: الحداثة بساعة الخادم في الرمز وحده (iat وauth_time)', async () => {
  // الخادم أصدر الرمز عند الدخول الآن · وساعة الجهاز متأخرة ثلاث دقائق أو متقدمة ثماني
  for (const skew of [-3 * 60_000, 8 * 60_000, -6 * 3_600_000]) {
    const { s } = session({ now: () => Date.now() + skew });
    await s.restore();
    const r = await s.confirmSameAccount();
    expect(r.ok).toBe(true);
  }
});

/** جسر قوقل يحفظ حالته كالمكتبة: الخروج يمحو اختيار التطبيق، ورمز Drive لا يُعطى بلا حسابٍ مختار، والاستعادة الصامتة لا تعيده */
function statefulSession(pick: () => string | null) {
  const store = new Map<string, string>([[KEYS.uid, 'uid-owner-a'], [KEYS.refresh, 'r-owner-a'], [KEYS.email, 'a@example.test']]);
  const g = { signed: 'uid-owner-a' as string | null, windows: 0 };
  const s = createSession({
    google: {
      signIn: async () => { g.windows++; const c = pick(); if (!c) return null; g.signed = c; return { idToken: 'g-' + c, email: c + '@example.test' }; },
      signInSilently: async () => g.signed !== null,
      accessToken: async () => { if (!g.signed) throw new Error('getTokens requires a user to be signed in'); return 'acc-' + g.signed; },
      signOut: async () => { g.signed = null; },
    },
    store: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, del: async (k) => { store.delete(k); } },
    signInWithIdp: async (t) => { const uid = t.replace('g-', ''); return { uid, email: uid + '@example.test', idToken: fresh(uid), refreshToken: 'r-new-' + uid, expiresAt: 9e15 }; },
    refresh: async (r) => ({ uid: 'x', idToken: 'id', refreshToken: r, expiresAt: 9e15 }),
  });
  return { s, store, g };
}

test('٥ إلغاء نافذة تأكيد الحساب لا يقطع Drive: رمزه يُطلب بنافذة اختيار الحساب نفسه · وحسابٌ آخر يُرفض ولا يمسّ الجلسة', async () => {
  let choice: string | null = null;
  const { s, store, g } = statefulSession(() => choice);
  await s.restore();
  expect(await s.driveToken()).toBe('acc-uid-owner-a');
  // «نسيت الرمز» ثم أُلغيت النافذة: خرج التطبيق من قوقل
  expect(await s.confirmSameAccount()).toEqual({ ok: false, why: 'cancel' });
  expect(g.signed).toBeNull();
  // تذكّر رمزه وفتح · ثم النسخ إلى Drive: نافذة اختيار الحساب ثم الرمز (كان يرمي «انتهت جلسة قوقل» ولا طريق في الواجهة للدخول)
  choice = 'uid-owner-a';
  const before = g.windows;
  expect(await s.driveToken()).toBe('acc-uid-owner-a');
  expect(g.windows).toBe(before + 1);
  // حسابٌ آخر في النافذة: يُرفض ويُخرج منه ولا تُكتب الجلسة
  await s.confirmSameAccount();
  choice = null;
  await s.confirmSameAccount();
  choice = 'uid-intruder-b';
  const kept = JSON.stringify([...store]);
  await expect(s.driveToken()).rejects.toThrow();
  expect(g.signed).toBeNull();
  expect(JSON.stringify([...store])).toBe(kept);
});

test('٥ «حذف حسابي» يؤكد الهوية بخروجٍ من قوقل ثم دخولٍ جديد (كان signIn وحده يعيد الحساب الحالي بلا نافذة) · وحسابٌ آخر لا يستبدل الجلسة', async () => {
  const same = session();
  await same.s.restore();
  expect(await same.s.reauthSameAccount()).toMatchObject({ ok: true });
  expect(same.calls).toEqual(['signOut', 'signIn', 'idp']);
  // الحساب نفسه: رمز التحديث الجديد يُحفظ (رمز دخولٍ حديث لحذف حساب Firebase) والحساب كما هو
  expect(same.store.get(KEYS.refresh)).toBe('r-new');
  expect(same.store.get(KEYS.uid)).toBe('uid-owner-a');
  const other = session({ chosen: 'uid-intruder-b' });
  await other.s.restore();
  const kept = JSON.stringify([...other.store]);
  expect(await other.s.reauthSameAccount()).toEqual({ ok: false, why: 'mismatch' });
  expect(JSON.stringify([...other.store])).toBe(kept);
  expect(other.s.current()?.uid).toBe('uid-owner-a');
  // وخدمة الحذف تمرّ بهذا التأكيد لا بالدخول الكامل
  const del = src('src/services/cloud.ts').match(/export async function deleteMyAccount[^]*?\n}\n/)![0];
  expect(del).toContain('s.reauthSameAccount()');
  expect(del).not.toMatch(/s\.signIn\(\)/);
});

/* ═══ المنطق الخالص: حداثة الدخول من رمز JWT ═══ */

test('٥ فحص رمز الهوية: حديثٌ بحسابه ومزوّده يُقبل وساعته من الخادم · وما سواه يُرفض بسببه', () => {
  const at = 1_790_000_000_000;
  expect(checkAccountProof(fresh('uid-owner-a', at), 'uid-owner-a')).toEqual({ ok: true, serverMs: sec(at) * 1000 });
  // الحمولة بالعربية تُقرأ (UTF-8 بلا Buffer)
  expect(jwtClaims(fresh('uid-owner-a', at))?.name).toBe('سالم المصطنع');
  // رمزٌ مجدَّد: صدر بعد الدخول بأكثر من المهلة (الخادم وحده يشهد، لا ساعة الجهاز)
  const refreshed = (gap: number) => fbToken({ user_id: 'uid-owner-a', auth_time: sec(at - gap), iat: sec(at), firebase: { sign_in_provider: 'google.com' } });
  expect(checkAccountProof(refreshed(3_600_000), 'uid-owner-a')).toEqual({ ok: false, why: 'stale' });
  expect(checkAccountProof(refreshed(AUTH_FRESH_MS + 1000), 'uid-owner-a')).toEqual({ ok: false, why: 'stale' });
  expect(checkAccountProof(refreshed(-60_000), 'uid-owner-a')).toEqual({ ok: false, why: 'stale' });
  expect(checkAccountProof(refreshed(60_000), 'uid-owner-a')).toMatchObject({ ok: true });
  expect(checkAccountProof(fresh('uid-other', at), 'uid-owner-a')).toEqual({ ok: false, why: 'uid' });
  const anon = fbToken({ user_id: 'uid-owner-a', auth_time: sec(at), iat: sec(at), firebase: { sign_in_provider: 'anonymous' } });
  expect(checkAccountProof(anon, 'uid-owner-a')).toEqual({ ok: false, why: 'provider' });
  for (const bad of ['', 'abc', 'a.b.c', 'id-uid-owner-a', fbToken({ user_id: 'uid-owner-a' })]) {
    expect(checkAccountProof(bad, 'uid-owner-a')).toEqual({ ok: false, why: 'bad' });
  }
});

/* ═══ المنطق الخالص: ثلاث إعادات ضبطٍ في ٢٤ ساعة بساعة الخادم · وتقدير الجهاز قبل النافذة ═══ */

const H = 3_600_000;
/** ثلاث إعادات ضبطٍ بفارق ثانية · uptime: كم مضى على إقلاع الجهاز عند أولاها */
function threeResets(uptime: number): { log: ResetLog; t0: ClockNow; server0: number } {
  const t0 = { wall: 1_790_000_000_000, mono: uptime, trusted: true };
  const server0 = t0.wall + 40_000; // ساعة الجهاز متأخرة عن الخادم ٤٠ ثانية
  let log = emptyResetLog();
  for (let i = 0; i < RESET_LIMIT; i++) {
    const now = { ...t0, wall: t0.wall + i * 1000, mono: t0.mono + i * 1000 };
    expect(resetWaitMs(log, now)).toBe(0);
    expect(serverWaitMs(log, server0 + i * 1000)).toBe(0);
    log = recordReset(log, now, server0 + i * 1000);
  }
  return { log, t0, server0 };
}

test('٥ حدّ إعادة الضبط: ثلاثٌ في ٢٤ ساعة · بساعة الخادم بعد الدخول · وقبل النافذة تقديم ساعة الجهاز في التشغيل نفسه لا يرفعه', () => {
  const { log, t0, server0 } = threeResets(5 * 24 * H);
  const later = { wall: t0.wall + H, mono: t0.mono + H, trusted: true };
  expect(resetWaitMs(log, later)).toBe(RESET_WINDOW_MS - H);
  // ساعة الجهاز قُدِّمت يوماً والرتيبة تشهد بساعةٍ وحدها
  expect(resetWaitMs(log, { ...later, wall: t0.wall + RESET_WINDOW_MS })).toBe(RESET_WINDOW_MS - H);
  // مضى يومٌ بالساعتين: يُرفع
  expect(resetWaitMs(log, { wall: t0.wall + RESET_WINDOW_MS + 5_000, mono: t0.mono + RESET_WINDOW_MS + 5_000, trusted: true })).toBe(0);
  // الخادم يحسم بعد الدخول: بعد ساعةٍ بساعته يُحجب، وبعد يومٍ يُرفع
  expect(serverWaitMs(log, server0 + H)).toBe(RESET_WINDOW_MS - H);
  expect(serverWaitMs(log, server0 + RESET_WINDOW_MS + 9_000)).toBe(0);
  // أُعيد تشغيل الجهاز (الرتيبة من الصفر) وقُدِّمت ساعته يوماً: يُعرض الزر بساعة الجهاز · وساعة الخادم بعد الدخول ترفض
  const rebooted = { wall: t0.wall + RESET_WINDOW_MS + 60_000, mono: 120_000, trusted: true };
  expect(resetWaitMs(log, rebooted)).toBe(0);
  expect(serverWaitMs(log, server0 + 2 * H)).toBeGreaterThan(0);
  // ساعةٌ أُرجعت إلى ما قبل الإعادات (بلا رتيبة موثوقة): تُحسب حديثة
  expect(resetWaitMs(log, { wall: t0.wall - RESET_WINDOW_MS, mono: 0, trusted: false })).toBeGreaterThan(0);
  // نسختان (المخزن الآمن والملف) تُدمجان ولا تُسقط إحداهما الأخرى
  const one = recordReset(emptyResetLog(), t0, server0);
  expect(mergeResetLogs(log, one).attempts.length).toBe(RESET_LIMIT);
  expect(mergeResetLogs(emptyResetLog(), log).attempts.map((a) => a.n)).toEqual(log.attempts.map((a) => a.n));
});

test('٥ إعادة تشغيل الجهاز: ساعته الرتيبة الجديدة إذا تجاوزت قيمتها القديمة لا تُطرح منها (كانت تحجب المالك من جديد بلا محاولة)', () => {
  // ثلاث إعادات والجهاز يعمل منذ ٢٠ ساعة · ثم أُعيد تشغيله بعدها بعشر ساعات
  const { log, t0 } = threeResets(20 * H);
  const at = (h: number) => ({ wall: t0.wall + h * H, mono: (h - 10) * H, trusted: true });
  expect(resetWaitMs(log, at(23))).toBeGreaterThan(0);
  expect(resetWaitMs(log, at(25))).toBe(0);
  // بعد ٣١ ساعة: الرتيبة (٢١ ساعة) فوق قيمتها عند الإعادات (٢٠) والإقلاع بعدها · كان يُحجب أكثر من ٢٠ ساعة
  expect(resetWaitMs(log, at(31))).toBe(0);
  expect(attemptAge(log.attempts[0], at(31))).toBeGreaterThanOrEqual(31 * H - 5_000);
  // والتشغيل نفسه بلا إعادة: الرتيبة تحسم
  expect(attemptAge(log.attempts[0], { wall: t0.wall + 2 * H, mono: t0.mono + 2 * H, trusted: true })).toBe(2 * H);
});

test('٥ وقت إعادة الضبط في التنبيه بصيغة التطبيق: اليوم dd/mm/yyyy ثم الساعة', () => {
  expect(resetWhen(new Date(2026, 9, 5, 9, 7).getTime())).toBe('05/10/2026 09:07');
});

/* ═══ الخدمة: الحدّ محفوظ على الجهاز · وإشعار المالك ═══ */

type Svc = typeof import('@/services/appLockService');
const loadSvc = (): Svc => {
  let m!: Svc;
  jest.isolateModules(() => { m = require('@/services/appLockService') as Svc; });
  return m;
};
const proveOk = (): Promise<AccountProof> => Promise.resolve({ ok: true, serverMs: Date.now() });

beforeEach(() => {
  kv.clear(); files.clear(); fsFail.read = false; fsFail.write = false;
  nativeClock.ms += 10_000_000; device.level = 0; device.pass = false; device.asked = 0;
});

test('٥ ثلاث إعادات ضبطٍ في اليوم ثم تُحجب · والحدّ لا يُلغيه إيقاف القفل ولا إعادة التشغيل ولا مسح إحدى نسختيه', async () => {
  let svc = loadSvc();
  await svc.enablePinLock('4826', 0);
  const audited: number[] = [];
  for (let i = 0; i < RESET_LIMIT; i++) expect(await svc.recoverByAccount(proveOk, () => { audited.push(i); })).toEqual({ ok: true });
  expect(audited).toEqual([0, 1, 2]);
  let proved = 0;
  const r = await svc.recoverByAccount(() => { proved++; return proveOk(); }, () => undefined);
  expect(r).toMatchObject({ ok: false, why: 'limit' });
  expect(proved).toBe(0);
  expect((await svc.resetStatus()).waitMs).toBeGreaterThan(0);
  // إيقاف القفل وإعادته برمزٍ جديد · ثم إعادة تشغيل التطبيق
  await svc.disableLock();
  await svc.enablePinLock('1357', 0);
  svc = loadSvc();
  expect(await svc.recoverByAccount(proveOk, () => undefined)).toMatchObject({ ok: false, why: 'limit' });
  // مسح نسخة المخزن الآمن وحدها، ثم نسخة الملف وحدها
  const secure = [...kv.keys()].filter((k) => k !== 'aqari_app_lock');
  expect(secure.length).toBe(1);
  const keep = kv.get(secure[0])!;
  kv.delete(secure[0]);
  expect((await svc.resetStatus()).waitMs).toBeGreaterThan(0);
  kv.set(secure[0], keep);
  files.clear();
  expect((await svc.resetStatus()).waitMs).toBeGreaterThan(0);
  // وتعذّر قراءة النسختين معاً يحجب ولا يفتح
  kv.delete(secure[0]); kv.set(secure[0], '{bad'); fsFail.read = true;
  expect(await svc.recoverByAccount(proveOk, () => undefined)).toMatchObject({ ok: false, why: 'store' });
});

test('٥ إعادة تشغيل الجهاز مع تقديم ساعته لا تتجاوز الحدّ: ساعة الخادم في رمز الهوية تحسم', async () => {
  const svc = loadSvc();
  const server0 = Date.now();
  for (let i = 0; i < RESET_LIMIT; i++) expect(await svc.recoverByAccount(proveOk, () => undefined)).toEqual({ ok: true });
  // أُعيد تشغيل الجهاز (الساعة الرتيبة من جديد) وقُدِّمت ساعته يوماً ونصفاً · والخادم يشهد بساعةٍ وحدها
  nativeClock.ms = 60_000;
  jest.spyOn(Date, 'now').mockReturnValue(server0 + 36 * 3_600_000);
  const r = await svc.recoverByAccount(() => Promise.resolve({ ok: true, serverMs: server0 + 3_600_000 }), () => undefined);
  expect(r).toMatchObject({ ok: false, why: 'limit' });
  jest.restoreAllMocks();
});

test('٥ إعادة الضبط تُكتب في سجل العمليات (وتُعاد إن تعذّرت) وتُنبَّه عند الفتح التالي حتى يُقرّ بها', async () => {
  const svc = loadSvc();
  expect((await svc.resetStatus()).notice).toBeNull();
  let fail = true;
  const rows: string[] = [];
  const audit = () => { if (fail) throw new Error('db'); rows.push('row'); };
  expect(await svc.recoverByAccount(proveOk, audit)).toEqual({ ok: true });
  expect(rows).toEqual([]);
  const st = await svc.resetStatus();
  expect(st.notice?.at).toBeGreaterThan(0);
  // الفتح التالي يعيد كتابة السطر · مرةً واحدة
  fail = false;
  await svc.flushResetAudit(audit);
  await svc.flushResetAudit(audit);
  expect(rows).toEqual(['row']);
  // التنبيه باقٍ حتى يُقرّ به
  expect((await loadSvc().resetStatus()).notice).not.toBeNull();
  await svc.ackResetNotice();
  expect((await svc.resetStatus()).notice).toBeNull();
});

test('٥ ما لم يبلغ الدخول لا يُحسب: فشل الشبكة وغياب الحساب والإلغاء وحسابٌ آخر لا تحبس المالك يوماً · وقفل الجهاز يُطلب قبل قوقل', async () => {
  const svc = loadSvc();
  const fails: Array<() => Promise<AccountProof>> = [
    () => Promise.reject(new Error('Network request failed')),
    () => Promise.resolve({ ok: false, why: 'none' }),
    () => Promise.resolve({ ok: false, why: 'cancel' }),
    () => Promise.resolve({ ok: false, why: 'stale' }),
    () => Promise.resolve({ ok: false, why: 'mismatch' }),
  ];
  for (const f of fails) expect((await svc.recoverByAccount(f, () => undefined)).ok).toBe(false);
  // كانت الثلاث الأولى تُخفي الزر ٢٤ ساعة والرابعة «limit» بلا نافذة
  expect((await svc.resetStatus()).waitMs).toBe(0);
  expect((await svc.resetStatus()).notice).toBeNull();
  device.level = 2;
  let proved = 0;
  expect(await svc.recoverByAccount(() => { proved++; return proveOk(); }, () => undefined)).toEqual({ ok: false, why: 'device' });
  expect(device.asked).toBe(1);
  expect(proved).toBe(0);
  device.pass = true;
  for (let i = 0; i < RESET_LIMIT; i++) expect(await svc.recoverByAccount(proveOk, () => undefined)).toEqual({ ok: true });
  expect(await svc.recoverByAccount(proveOk, () => undefined)).toMatchObject({ ok: false, why: 'limit' });
});

test('٥ رفض الخادم بعد الدخول يعطي كم بقي بساعته · ولا يُحسب · وتعذّر قراءة السجل يُقال كما هو لا «بعد ٢٤ ساعة»', async () => {
  const svc = loadSvc();
  const server0 = Date.now();
  for (let i = 0; i < RESET_LIMIT; i++) expect(await svc.recoverByAccount(proveOk, () => undefined)).toEqual({ ok: true });
  nativeClock.ms = 60_000;
  jest.spyOn(Date, 'now').mockReturnValue(server0 + 36 * 3_600_000);
  const r = await svc.recoverByAccount(() => Promise.resolve({ ok: true, serverMs: server0 + 2 * 3_600_000 }), () => undefined);
  jest.restoreAllMocks();
  expect(r).toMatchObject({ ok: false, why: 'limit' });
  if (r.ok) return;
  expect(r.waitMs).toBeGreaterThan(21.9 * 3_600_000);
  expect(r.waitMs).toBeLessThan(22 * 3_600_000 + 60_000);
  const secure = [...kv.keys()].find((k) => k !== 'aqari_app_lock')!;
  expect((JSON.parse(kv.get(secure)!) as ResetLog).attempts.length).toBe(RESET_LIMIT);
  kv.set(secure, '{bad'); fsFail.read = true;
  expect(await svc.resetStatus()).toEqual({ waitMs: null, notice: null });
});

/* ═══ سطر سجل العمليات يُزامَن: العضو يكتبه بالنوع الذي تجيزه القواعد لكل عضو ═══ */

test('٥ سطر إعادة الضبط في سجل العمليات · وللعضو بنوع «بيانات عضو» الذي تقبله القواعد بلا قسم', () => {
  const db = memDb();
  logLockReset(db, 1_790_000_000_000);
  const own = db.get<{ module: string; entity_type: string; action_type: string }>(`SELECT module, entity_type, action_type FROM audit_log ORDER BY rowid DESC LIMIT 1`)!;
  expect(own.action_type).toBe('update');
  expect(own.module).not.toBe(SELF_AUDIT_MODULE);
  db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'org-x', profile: { name: 'عضو مصطنع' } })]);
  logLockReset(db, 1_790_000_000_000);
  const mem = db.get<{ module: string; entity_type: string; user_name: string }>(`SELECT module, entity_type, user_name FROM audit_log ORDER BY rowid DESC LIMIT 1`)!;
  expect(mem).toEqual({ module: SELF_AUDIT_MODULE, entity_type: SELF_AUDIT_ENTITY, user_name: 'عضو مصطنع' });
  db.close();
});

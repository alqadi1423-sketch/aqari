/**
 * ق٠-٦ · الجزء الثالث (F-3): «نسيت رمز القفل» بلا قوقل · (أ) شهادة الخادم أن هذا الجوال المربوط عبر مزوّد الجهاز (cloud/deviceAuth.ts)
 * أمام خادم الهوية الحقيقي (server/auth) في الذاكرة عميلاً مصطنعاً · و(ب) للمالك مفتاح الاسترداد على الجهاز وحده، يعمل الآن ·
 * والحدّ (ثلاثٌ في ٢٤ ساعة) والسجل والتنبيه كما هي · حساباتٌ ورموزٌ ومفاتيح مصطنعة.
 */
const kv = new Map<string, string>();
const files = new Map<string, string>();
const nativeClock = { ms: 70_000_000 };
const device = { level: 0, pass: false };
const mockDb: { db: unknown } = { db: null };

jest.mock('react-native', () => ({ NativeModules: { AqariClock: { elapsedRealtime: () => nativeClock.ms } } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => kv.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { kv.set(k, v); },
  deleteItemAsync: async (k: string) => { kv.delete(k); },
}));
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0 },
  getEnrolledLevelAsync: async () => device.level,
  authenticateAsync: async () => ({ success: device.pass }),
}));
jest.mock('expo-file-system', () => ({
  Paths: { document: '/doc' },
  File: class {
    name: string;
    constructor(_dir: string, name: string) { this.name = name; }
    get exists() { return files.has(this.name); }
    textSync() { return files.get(this.name) ?? ''; }
    write(v: string) { files.set(this.name, v); }
    delete() { files.delete(this.name); }
  },
}));
jest.mock('expo-crypto', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getRandomBytes: (n: number) => new Uint8Array(require('node:crypto').randomBytes(n)),
}));
jest.mock('@/services/cipher', () => ({ deviceCipher: jest.requireActual('@/files/nodeCipher').nodeCipher }));
jest.mock('@/i18n', () => ({ t: (k: string) => k }));
jest.mock('@/db/expoAdapter', () => ({ appDb: () => mockDb.db }));

import { randomBytes } from 'crypto';
import { createAuthServer, MemoryAuthStorage, LOCK_RESET_WINDOW_MS, type AuthServer } from '../server/auth';
import { deviceAuthProvider, DEVICE_KEYS, type DeviceAuthClient, type CodeEntry } from '@/cloud/deviceAuth';
import type { SecureKV } from '@/cloud/session';
import { RESET_LIMIT, logLockReset, type ResetVia } from '@/domain/lockReset';
import { generateRecoveryKey, formatRecoveryKey } from '@/domain/backup/recoveryKey';
import { saveRecoveryKey } from '@/services/backupPassword';
import { keyResetOffered, checkRecoveryKey } from '@/services/lockRecovery';
import { memDb } from './helpers/testDb';
import type { DB } from '@/db/adapter';

type Svc = typeof import('@/services/appLockService');
const loadSvc = (): Svc => {
  let m!: Svc;
  jest.isolateModules(() => { m = require('@/services/appLockService') as Svc; });
  return m;
};

const H = 3_600_000;
const SETUP = 'SETUP-CODE-MASNOO-2026-ABCDEFGH';

/** العميل المصطنع: خادم الهوية الحقيقي في الذاكرة · بلا شبكة */
function clientOf(srv: AuthServer): DeviceAuthClient {
  return {
    redeem: (r) => (r.kind === 'invite' ? srv.redeemInvite({ ...r, source: 'test' }) : r.kind === 'link' ? srv.redeemLinkCode({ ...r, source: 'test' })
      : r.kind === 'setup' ? srv.bootstrapOwner({ setupCode: r.code, uid: r.uid ?? '', name: r.name ?? '', deviceKey: r.deviceKey, source: 'test' })
        : srv.recoverOwner({ code: r.code, deviceKey: r.deviceKey, source: 'test' })),
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

/** منشأةٌ مصطنعة على خادم الهوية · ساعة الخادم متقدمة يومين عن ساعة الجهاز (لا أثر لها: الحدّ بساعة الخادم) */
async function orgWithMember() {
  const server = { now: Date.now() + 2 * 24 * H };
  const srv = createAuthServer({ storage: new MemoryAuthStorage(), clock: () => server.now, signingKey: new Uint8Array(randomBytes(32)), setupCode: SETUP });
  const client = clientOf(srv);
  const random = (n: number) => new Uint8Array(randomBytes(n));
  const ownerP = deviceAuthProvider({ client, store: memKV(), random, askCode: async () => ({ kind: 'setup', code: SETUP, uid: 'uid-owner-masnoo', name: 'مالك مصطنع' }), now: () => server.now });
  expect(await ownerP.signIn()).toMatchObject({ uid: 'uid-owner-masnoo', provider: 'device' });
  const inv = await srv.createInvite(await ownerP.accessToken(), { uid: 'uid-member-old', name: 'عضو مصطنع', phone: '0500000001', role: 'staff' });
  if (!inv.ok) throw new Error('invite');
  const store = memKV();
  let entry: CodeEntry | null = { kind: 'invite', code: inv.code };
  const memberP = deviceAuthProvider({ client, store, random, askCode: async () => entry, now: () => server.now });
  const who = await memberP.signIn();
  entry = null;
  return { srv, server, ownerP, memberP, store, who };
}

beforeEach(() => {
  kv.clear(); files.clear(); nativeClock.ms += 10_000_000; device.level = 0; device.pass = false;
});

describe('(أ) شهادة الخادم عبر مزوّد الجهاز · بلا قوقل', () => {
  test('العضو يدخل برمز الدعوة فيُربط جواله بمعرّفه القديم · ومفتاح جهازه ورمز تحديثه في المخزن الآمن وحده', async () => {
    const { who, store, memberP } = await orgWithMember();
    expect(who).toEqual({ uid: 'uid-member-old', email: '', provider: 'device', deviceId: expect.stringMatching(/^dev_/) });
    expect(store.m.get(DEVICE_KEYS.key)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.m.get(DEVICE_KEYS.refresh)).toBeTruthy();
    // إعادة التشغيل: الجلسة من المخزن بلا شبكة
    expect(await memberP.restore()).toEqual(who);
  });

  test('ثلاث إعادات ضبطٍ في ٢٤ ساعة بساعة الخادم والرابعة تُرفض · ويُكتب سطر السجل بطريقه ويُشعَر المالك', async () => {
    const svc = loadSvc();
    const { srv, server, ownerP, memberP } = await orgWithMember();
    await svc.enablePinLock('4826', 0);
    const rows: Array<[number, ResetVia]> = [];
    for (let i = 0; i < RESET_LIMIT; i++) {
      expect(await svc.recoverByAccount(() => memberP.freshProof('lockReset'), (at, via) => { rows.push([at, via]); }, 'device')).toEqual({ ok: true });
      server.now += 60_000;
    }
    expect(rows.map(([, v]) => v)).toEqual(['device', 'device', 'device']);
    // وقت السطر بساعة الخادم لا الجهاز
    expect(rows[0][0]).toBeGreaterThan(Date.now() + 24 * H);
    expect((await svc.resetStatus()).notice).toMatchObject({ via: 'device' });
    const fourth = await svc.recoverByAccount(() => memberP.freshProof('lockReset'), () => undefined, 'device');
    expect(fourth).toMatchObject({ ok: false, why: 'limit' });
    const notes = await srv.listNotifications(await ownerP.accessToken());
    if (!notes.ok) throw new Error('notes');
    expect(notes.items.filter((n) => n.kind === 'lock_reset' && n.uid === 'uid-member-old').length).toBe(RESET_LIMIT);
  });

  test('الخادم يعدّ الحدّ ولو مُسح سجلّ الجهاز: يُرفض بكم بقي بساعته فيختفي الزر · ويُرفع بمرور يومٍ بساعته', async () => {
    const svc = loadSvc();
    const { server, memberP } = await orgWithMember();
    for (let i = 0; i < RESET_LIMIT; i++) expect(await svc.recoverByAccount(() => memberP.freshProof('lockReset'), () => undefined, 'device')).toEqual({ ok: true });
    // مُسحت بيانات التطبيق على الجهاز (السجل بنسختيه) · والحساب نفسه
    kv.clear(); files.clear();
    expect((await svc.resetStatus()).waitMs).toBe(0);
    server.now += 2 * H;
    const r = await svc.recoverByAccount(() => memberP.freshProof('lockReset'), () => undefined, 'device');
    expect(r).toMatchObject({ ok: false, why: 'limit' });
    if (r.ok) return;
    expect(r.waitMs).toBe(LOCK_RESET_WINDOW_MS - 2 * H);
    server.now += LOCK_RESET_WINDOW_MS;
    expect(await svc.recoverByAccount(() => memberP.freshProof('lockReset'), () => undefined, 'device')).toEqual({ ok: true });
  });

  test('جوالٌ سحبه المالك: «سُحب الجهاز» ولا يُحسب · ومفتاح جهازٍ غير المربوط: لا شهادة ولا يُحسب', async () => {
    const svc = loadSvc();
    const { srv, ownerP, memberP, store, who } = await orgWithMember();
    const forged = new Map(store.m);
    store.m.set(DEVICE_KEYS.key, 'A'.repeat(43));
    expect(await svc.recoverByAccount(() => memberP.freshProof('lockReset'), () => undefined, 'device')).toEqual({ ok: false, why: 'mismatch' });
    for (const [k, v] of forged) store.m.set(k, v);
    const rev = await srv.revokeDevice(await ownerP.accessToken(), who!.deviceId!);
    expect(rev.ok).toBe(true);
    expect(await svc.recoverByAccount(() => memberP.freshProof('lockReset'), () => undefined, 'device')).toEqual({ ok: false, why: 'revoked' });
    expect((await svc.resetStatus()).waitMs).toBe(0);
    expect((await svc.resetStatus()).notice).toBeNull();
  });

  test('بلا جلسة على الجهاز: «لا حساب» بلا طلب', async () => {
    const p = deviceAuthProvider({ client: {} as DeviceAuthClient, store: memKV(), random: () => new Uint8Array(32), askCode: async () => null });
    expect(await p.freshProof('lockReset')).toEqual({ ok: false, why: 'none' });
    expect(await p.signIn()).toBeNull();
  });
});

describe('(ب) مفتاح الاسترداد للمالك · على الجهاز وحده الآن', () => {
  const ownerDb = (uid: string | null): DB => {
    const db = memDb();
    if (uid) db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('uid', ?)`, [uid]);
    return db;
  };
  const newKey = () => generateRecoveryKey((n) => new Uint8Array(randomBytes(n)));

  test('للمالك ومفتاحه محفوظ: يُعرض · ويُقبل بأي كتابة · ومفتاحٌ آخر أو سابقٌ استُبدل لا يُقبل', async () => {
    const db = ownerDb('uid-owner-masnoo');
    expect(await keyResetOffered(db)).toBe(false);
    const old = newKey();
    await saveRecoveryKey(old, 'uid-owner-masnoo');
    const key = newKey();
    await saveRecoveryKey(key, 'uid-owner-masnoo');
    expect(await keyResetOffered(db)).toBe(true);
    expect(await checkRecoveryKey(formatRecoveryKey(key).toLowerCase().replace(/-/g, ' '), db)).toBe(true);
    expect(await checkRecoveryKey(old, db)).toBe(false);
    expect(await checkRecoveryKey(newKey(), db)).toBe(false);
    expect(await checkRecoveryKey(key.slice(0, -1) + (key.endsWith('0') ? '1' : '0'), db)).toBe(false);
    // مفتاح حسابٍ آخر على الجهاز لا يفتح هذا الحساب
    const other = newKey();
    await saveRecoveryKey(other, 'uid-other-account');
    expect(await checkRecoveryKey(other, db)).toBe(false);
    db.close();
  });

  test('العضو لا يُعرض عليه ولو حُفظ مفتاحٌ لحسابه: طريقه شهادة الخادم', async () => {
    const db = ownerDb('uid-member-x');
    const key = newKey();
    await saveRecoveryKey(key, 'uid-member-x');
    db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', ?)`, [JSON.stringify({ org: 'org-x', profile: { name: 'عضو مصطنع' } })]);
    expect(await keyResetOffered(db)).toBe(false);
    expect(await checkRecoveryKey(key, db)).toBe(false);
    db.close();
  });

  test('كلمة مرورٍ قديمة لا مفتاح: لا يُعرض', async () => {
    const db = ownerDb('uid-owner-pw');
    kv.set('aqari_backup_secret_uid-owner-pw', 'كلمة قديمة مصطنعة');
    files.set('backup-secret-uid-owner-pw.flag', 'pw');
    expect(await keyResetOffered(db)).toBe(false);
    expect(await checkRecoveryKey('كلمة قديمة مصطنعة', db)).toBe(false);
    db.close();
  });

  test('البناء المحلي بلا سحابة ولا قوقل: ثلاث إعادات ضبطٍ بالمفتاح والرابعة تُرفض · والخاطئ لا يُحسب · والسجل والتنبيه بطريقه', async () => {
    const db = ownerDb(null);
    mockDb.db = db;
    const key = newKey();
    await saveRecoveryKey(key, null);
    expect(await keyResetOffered(db)).toBe(true);
    const svc = loadSvc();
    await svc.enablePinLock('4826', 0);
    const audit = (at: number, via: ResetVia) => logLockReset(db, at, via);
    for (let i = 0; i < 4; i++) expect(await svc.recoverByKey(() => checkRecoveryKey(newKey(), db), audit)).toEqual({ ok: false, why: 'wrongKey' });
    expect((await svc.resetStatus()).waitMs).toBe(0);
    for (let i = 0; i < RESET_LIMIT; i++) expect(await svc.recoverByKey(() => checkRecoveryKey(key, db), audit)).toEqual({ ok: true });
    let verified = 0;
    expect(await svc.recoverByKey(() => { verified++; return checkRecoveryKey(key, db); }, audit)).toMatchObject({ ok: false, why: 'limit' });
    expect(verified).toBe(0);
    const rows = db.all<{ entity_name: string }>(`SELECT entity_name FROM audit_log WHERE entity_name LIKE '%أُعيد ضبط رمزه%'`);
    expect(rows.length).toBe(RESET_LIMIT);
    expect(rows.every((r) => r.entity_name.includes('بمفتاح الاسترداد'))).toBe(true);
    expect((await svc.resetStatus()).notice).toMatchObject({ via: 'key' });
    // وقفل الجهاز إن وُجد يُطلب قبله كما في تأكيد الحساب
    kv.delete('aqari_lock_resets'); files.delete('app-lock-resets.json');
    device.level = 2;
    expect(await svc.recoverByKey(() => checkRecoveryKey(key, db), audit)).toEqual({ ok: false, why: 'device' });
    db.close();
    mockDb.db = null;
  });

  test('سجلٌّ قديم (قبل ق٠-٦) بلا طريق يُقرأ قوقل · وسطر قوقل كما كان حرفاً', async () => {
    const svc = loadSvc();
    kv.set('aqari_lock_resets', JSON.stringify({ attempts: [{ n: 1, wall: 1, mono: 1, trusted: true, server: Date.now() }], notice: 1, noticeAt: Date.now(), seen: 0, audited: 1 }));
    expect((await svc.resetStatus()).notice).toMatchObject({ via: 'google' });
    const db = memDb();
    logLockReset(db, Date.now());
    expect(db.get<{ entity_name: string }>(`SELECT entity_name FROM audit_log ORDER BY rowid DESC LIMIT 1`)!.entity_name).toBe('قفل التطبيق · أُعيد ضبط رمزه بتأكيد حساب قوقل');
    db.close();
  });
});

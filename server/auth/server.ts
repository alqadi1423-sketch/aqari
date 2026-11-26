/**
 * خادم الهوية بلا قوقل (ق٠-٦ · F الاستقلال عن قوقل §٥.١ (أ) · قرارا المالك 2026-11-13 س٦ (أ) وس٥ (أ)) · منطقٌ خالص يُختبر على Node
 * ويُنقل إلى كائن المنشأة الدائم على Cloudflare في ق٢ بلا تغيير: لا واجهات Cloudflare، وWebCrypto القياسية وحدها، والتخزين خلف
 * AuthStorage، والساعة تُحقن (ساعة الخادم وحدها: لا يقبل أي طلبٍ وقتاً من الجهاز).
 *
 *  - **تأسيس المالك:** أول دخولٍ برمز التأسيس الذي يضعه المالك سراً في إعداد الخادم، بمعرّفه القديم نصاً (§٧.٢) · ويُعطى «رمز
 *    طوارئ» يُعرض مرة · وضياعهما معاً: رمز تأسيسٍ جديد في الإعداد (المستعمل لا يُقبل ثانية).
 *  - **الدعوة:** المالك يصدر لكل عضو رمزاً من ١٢ محرفاً كروكفورد (٦٠ بتاً) يرسله التطبيق بالواتساب · يُحفظ بصمته SHA-256 وحدها،
 *    ويصلح ٧٢ ساعة، ولاستعمالٍ واحد · ومحاولات إدخال الرموز خمسٌ في الساعة لكل مصدر، ولو صحّ الرمز بعدها.
 *  - **ربط الجهاز:** الجهاز يولّد مفتاحاً عشوائياً (٢٥٦ بتاً) في مخزنه الآمن ويُحفظ هنا بصمته · ويقدّمه لما يشهد أنه الجوال المربوط.
 *  - **الجلسة:** رمز دخولٍ لساعة بتوقيع HMAC-SHA256 · ورمز تحديثٍ عشوائي ٢٥٦ بتاً يُحفظ بصمةً ويُبدَّل عند كل استعمال · وإعادة
 *    استعمال رمزٍ مُبدَّل (سرقة) تسحب الجهاز كله · إلا ردّاً ضاع في الشبكة: الرمز نفسه خلال دقيقة وخلفه لم يُستعمل.
 *  - **جهازٌ ثانٍ:** رمز ربطٍ قصير العمر من جهازٍ داخل · **وسحب الجهاز** يجعل كل طلبٍ منه 401 فيعمل مسار «أُزيلت عضويته».
 *  - **إشعار المالك:** سجلٌّ بكل جهازٍ جديد، وكل إعادة ضبطٍ لرمز القفل، وكل سحبٍ وسرقةٍ واستردادٍ وحذف.
 *  - **«نسيت رمز القفل»:** الخادم يشهد أن الطالب هو الجوال المربوط (رمز الدخول ومفتاح الجهاز معاً)، والحدّ ثلاثٌ في ٢٤ ساعة للحساب
 *    بساعة الخادم.
 *  - **«حذف حسابي»:** بإثباتٍ حديث لغرض الحذف (٥ دقائق، لاستعمالٍ واحد) · وحذف المالك يحذف المنشأة كلها.
 *
 * الطلبات تُنفَّذ واحداً بعد واحد (قفلٌ في الذاكرة) فلا يتداخل تبديل الرموز وعدّ المحاولات · وفي الكائن الدائم كذلك.
 * والردود رموز أخطاءٍ لا نصوص (status كرمز HTTP، وcode للتطبيق يترجمه).
 */
import { hmacSigner, isCode, normalizeCode, randomBytes, randomCode, sameText, sha256Hex, b64url } from './crypto';
import type { AuthStorage } from './storage';

/* ═══ الضوابط ═══ */

export const INVITE_CODE_LENGTH = 12;
export const INVITE_TTL_MS = 72 * 3_600_000;
export const LINK_CODE_LENGTH = 10;
export const LINK_TTL_MS = 10 * 60_000;
export const EMERGENCY_CODE_LENGTH = 20;
export const CODE_ATTEMPTS = 5;
export const CODE_WINDOW_MS = 3_600_000;
export const ACCESS_TTL_MS = 3_600_000;
/** رمز تحديثٍ لم يُستعمل هذه المدة لا يجدّد (الجوال الغائب أسابيع يجدّد) */
export const REFRESH_IDLE_MS = 180 * 24 * 3_600_000;
/** إعادة الرمز نفسه خلال هذه المهلة وخلفه لم يُستعمل: ردٌّ ضاع في الشبكة لا سرقة */
export const REFRESH_GRACE_MS = 60_000;
/** ما يُحفظ من رموز التحديث المُبدَّلة لكل جهاز لكشف إعادة استعمالها */
const KEEP_USED_REFRESH = 50;
export const LOCK_RESET_LIMIT = 3;
export const LOCK_RESET_WINDOW_MS = 24 * 3_600_000;
export const FRESH_TTL_MS = 5 * 60_000;
const MIN_SETUP_CODE = 16;
const DEVICE_KEY = /^[A-Za-z0-9_-]{43,128}$/;

/* ═══ الأنواع ═══ */

export type Fail = { ok: false; status: 400 | 401 | 403 | 404 | 409 | 429; code: string; waitMs?: number };
export type Result<T> = ({ ok: true } & T) | Fail;

export interface Tokens { accessToken: string; accessExpiresAt: number; refreshToken: string }
export interface Session { uid: string; deviceId: string; role: string; tokens: Tokens }
export interface Access { uid: string; deviceId: string; role: string }
export type NoteKind = 'new_device' | 'lock_reset' | 'refresh_reuse' | 'device_revoked' | 'owner_recovered' | 'account_deleted' | 'member_removed';
export interface Note { id: string; at: number; kind: NoteKind; uid: string; deviceId: string | null; seen: boolean }
export interface DeviceInfo { deviceId: string; uid: string; label: string; createdAt: number; revokedAt: number | null }

interface Org { ownerUid: string; emergencyHash: string; createdAt: number }
interface Account { uid: string; role: string; name: string; phone: string | null; createdAt: number }
interface Device { deviceId: string; uid: string; keyHash: string; label: string; createdAt: number; revokedAt: number | null; refreshHashes: string[] }
interface Invite { inviteId: string; uid: string; name: string; phone: string; role: string; createdAt: number; expiresAt: number; usedAt: number | null; revokedAt: number | null }
interface LinkCode { uid: string; byDevice: string; createdAt: number; expiresAt: number; usedAt: number | null }
interface RefreshRec { uid: string; deviceId: string; issuedAt: number; usedAt: number | null; next: string | null }

export interface AuthServerOptions {
  storage: AuthStorage;
  /** ساعة الخادم بالملّي ثانية · وحدها تحسم كل مدة وحدّ */
  clock: () => number;
  /** مفتاح توقيع الرموز (سرٌّ في إعداد الخادم · ٣٢ بايتاً فأكثر) */
  signingKey: Uint8Array;
  /** رمز التأسيس الذي يضعه المالك في إعداد الخادم */
  setupCode: string;
  random?: (n: number) => Uint8Array;
}

const fail = (status: Fail['status'], code: string, waitMs?: number): Fail => (waitMs === undefined ? { ok: false, status, code } : { ok: false, status, code, waitMs });
const K = {
  org: 'org', tomb: 'tomb:setup', seq: 'seq',
  acct: (u: string) => 'acct:' + u, dev: (d: string) => 'dev:' + d, inv: (h: string) => 'inv:' + h, invId: (i: string) => 'invid:' + i,
  link: (h: string) => 'link:' + h, rt: (h: string) => 'rt:' + h, rate: (s: string) => 'rl:code:' + s, resets: (u: string) => 'lr:' + u,
  jti: (j: string) => 'jti:' + j, note: (n: number) => 'note:' + String(n).padStart(12, '0'),
};

export function createAuthServer(o: AuthServerOptions) {
  if (!(o.signingKey instanceof Uint8Array) || o.signingKey.length < 32) throw new Error('signing key must be at least 32 bytes');
  if (normalizeCode(o.setupCode).length < MIN_SETUP_CODE) throw new Error('setup code must be at least ' + MIN_SETUP_CODE + ' characters');
  const st = o.storage;
  const now = o.clock;
  const random = o.random ?? randomBytes;
  const signer = hmacSigner(o.signingKey);
  const hashCode = (c: string) => sha256Hex(normalizeCode(c));

  // طلبٌ بعد طلب
  let chain: Promise<unknown> = Promise.resolve();
  function serial<A extends unknown[], R>(f: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
    return (...a: A) => {
      const run = chain.then(() => f(...a));
      chain = run.catch(() => undefined);
      return run;
    };
  }

  /* ═══ أدوات داخلية ═══ */

  /** محاولة إدخال رمز (تأسيس، طوارئ، دعوة، ربط) تُحسب لمصدرها قبل فحصها · خمسٌ في الساعة ثم يُحجب ولو صحّ */
  async function attempt(source: string): Promise<Fail | null> {
    const key = K.rate(String(source || 'unknown').slice(0, 128));
    const t = now();
    const recent = ((await st.get<number[]>(key)) ?? []).filter((x) => t - x < CODE_WINDOW_MS && x <= t);
    if (recent.length >= CODE_ATTEMPTS) return fail(429, 'rate_limited', Math.max(1, recent[0] + CODE_WINDOW_MS - t));
    recent.push(t);
    await st.put(key, recent);
    return null;
  }

  async function note(kind: NoteKind, uid: string, deviceId: string | null): Promise<void> {
    const n = ((await st.get<number>(K.seq)) ?? 0) + 1;
    await st.put(K.seq, n);
    await st.put<Note>(K.note(n), { id: String(n), at: now(), kind, uid, deviceId, seen: false });
  }

  async function issue(uid: string, deviceId: string, role: string): Promise<Tokens> {
    const t = now();
    const accessToken = await signer.sign({ typ: 'access', sub: uid, dev: deviceId, role, iat: t, exp: t + ACCESS_TTL_MS, jti: b64url(random(12)) });
    const refreshToken = b64url(random(32));
    await st.put<RefreshRec>(K.rt(await sha256Hex(refreshToken)), { uid, deviceId, issuedAt: t, usedAt: null, next: null });
    return { accessToken, accessExpiresAt: t + ACCESS_TTL_MS, refreshToken };
  }

  async function bind(uid: string, role: string, deviceKey: string, label: string): Promise<Session> {
    let deviceId = '';
    do deviceId = 'dev_' + b64url(random(12)); while (await st.get(K.dev(deviceId)));
    await st.put<Device>(K.dev(deviceId), {
      deviceId, uid, keyHash: await sha256Hex(deviceKey), label: String(label ?? '').slice(0, 80), createdAt: now(), revokedAt: null, refreshHashes: [],
    });
    await note('new_device', uid, deviceId);
    return { uid, deviceId, role, tokens: await issue(uid, deviceId, role) };
  }

  async function revoke(d: Device, kind: NoteKind | null): Promise<void> {
    if (d.revokedAt) return;
    d.revokedAt = now();
    await st.put(K.dev(d.deviceId), d);
    for (const h of d.refreshHashes) await st.delete(K.rt(h));
    if (kind) await note(kind, d.uid, d.deviceId);
  }

  async function devicesOf(uid: string): Promise<Device[]> {
    return [...(await st.list<Device>('dev:')).values()].filter((d) => d.uid === uid);
  }

  /** رمز الدخول: توقيعه ومدته بساعة الخادم، وجهازه قائمٌ لحسابه · والصلاحية من الحساب نفسه لا من الرمز */
  async function access(token: string): Promise<Result<Access & { device: Device; account: Account }>> {
    const c = await signer.verify(token);
    if (!c || c.typ !== 'access' || typeof c.sub !== 'string' || typeof c.dev !== 'string' || typeof c.exp !== 'number' || typeof c.iat !== 'number') return fail(401, 'invalid');
    const t = now();
    if (t >= c.exp) return fail(401, 'expired');
    if (c.iat > t + 5_000) return fail(401, 'invalid');
    const device = await st.get<Device>(K.dev(c.dev));
    const account = await st.get<Account>(K.acct(c.sub));
    if (!device || device.uid !== c.sub || device.revokedAt || !account) return fail(401, 'revoked');
    return { ok: true, uid: c.sub, deviceId: c.dev, role: account.role, device, account };
  }

  const isOwner = async (uid: string) => (await st.get<Org>(K.org))?.ownerUid === uid;

  async function deviceKeyOk(d: Device, deviceKey: string): Promise<boolean> {
    return typeof deviceKey === 'string' && DEVICE_KEY.test(deviceKey) && sameText(await sha256Hex(deviceKey), d.keyHash);
  }

  /* ═══ تأسيس المالك واسترداده ═══ */

  async function bootstrapOwner(r: { setupCode: string; uid: string; name: string; deviceKey: string; label?: string; source: string }): Promise<Result<Session & { emergencyCode: string }>> {
    if (!DEVICE_KEY.test(String(r.deviceKey ?? ''))) return fail(400, 'device_key');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(r.uid ?? ''))) return fail(400, 'uid');
    const limited = await attempt(r.source);
    if (limited) return limited;
    if (await st.get<Org>(K.org)) return fail(409, 'owner_exists');
    const h = await hashCode(r.setupCode);
    const used = (await st.get<string[]>(K.tomb)) ?? [];
    if (!sameText(h, await hashCode(o.setupCode)) || used.includes(h)) return fail(403, 'invalid');
    const emergencyCode = randomCode(EMERGENCY_CODE_LENGTH, random);
    await st.put(K.tomb, [...used, h]);
    await st.put<Org>(K.org, { ownerUid: r.uid, emergencyHash: await hashCode(emergencyCode), createdAt: now() });
    await st.put<Account>(K.acct(r.uid), { uid: r.uid, role: 'owner', name: String(r.name ?? '').slice(0, 120), phone: null, createdAt: now() });
    return { ok: true, ...(await bind(r.uid, 'owner', r.deviceKey, r.label ?? '')), emergencyCode };
  }

  /** رمز الطوارئ (يُستبدل بجديد) أو رمز تأسيسٍ جديد لم يُستعمل · يربط جهازاً جديداً للمالك ويُشعره */
  async function recoverOwner(r: { code: string; deviceKey: string; label?: string; source: string }): Promise<Result<Session & { emergencyCode: string }>> {
    if (!DEVICE_KEY.test(String(r.deviceKey ?? ''))) return fail(400, 'device_key');
    const limited = await attempt(r.source);
    if (limited) return limited;
    const org = await st.get<Org>(K.org);
    if (!org) return fail(404, 'no_owner');
    const h = await hashCode(r.code);
    const used = (await st.get<string[]>(K.tomb)) ?? [];
    const byEmergency = sameText(h, org.emergencyHash);
    const bySetup = !byEmergency && sameText(h, await hashCode(o.setupCode)) && !used.includes(h);
    if (!byEmergency && !bySetup) return fail(403, 'invalid');
    if (bySetup) await st.put(K.tomb, [...used, h]);
    const emergencyCode = randomCode(EMERGENCY_CODE_LENGTH, random);
    await st.put<Org>(K.org, { ...org, emergencyHash: await hashCode(emergencyCode) });
    await note('owner_recovered', org.ownerUid, null);
    return { ok: true, ...(await bind(org.ownerUid, 'owner', r.deviceKey, r.label ?? '')), emergencyCode };
  }

  /* ═══ الدعوات ═══ */

  async function createInvite(token: string, r: { uid?: string; name: string; phone: string; role: string }): Promise<Result<{ inviteId: string; code: string; expiresAt: number; uid: string }>> {
    const a = await access(token);
    if (!a.ok) return a;
    if (!(await isOwner(a.uid))) return fail(403, 'owner_only');
    const uid = r.uid ?? 'm_' + b64url(random(15));
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return fail(400, 'uid');
    if (!r.role || r.role === 'owner') return fail(400, 'role');
    if (uid === a.uid) return fail(409, 'owner_uid');
    const code = randomCode(INVITE_CODE_LENGTH, random);
    const inviteId = 'inv_' + b64url(random(9));
    const t = now();
    const h = await hashCode(code);
    await st.put<Invite>(K.inv(h), {
      inviteId, uid, name: String(r.name ?? '').slice(0, 120), phone: String(r.phone ?? '').slice(0, 32), role: r.role, createdAt: t, expiresAt: t + INVITE_TTL_MS, usedAt: null, revokedAt: null,
    });
    await st.put(K.invId(inviteId), h);
    return { ok: true, inviteId, code, expiresAt: t + INVITE_TTL_MS, uid };
  }

  async function revokeInvite(token: string, inviteId: string): Promise<Result<object>> {
    const a = await access(token);
    if (!a.ok) return a;
    if (!(await isOwner(a.uid))) return fail(403, 'owner_only');
    const h = await st.get<string>(K.invId(inviteId));
    const inv = h ? await st.get<Invite>(K.inv(h)) : undefined;
    if (!h || !inv) return fail(404, 'not_found');
    await st.put<Invite>(K.inv(h), { ...inv, revokedAt: now() });
    return { ok: true };
  }

  /** المدعوّ يكتب رمزه في أول فتح فيُربط جواله بحسابه (بمعرّفه القديم إن كان) */
  async function redeemInvite(r: { code: string; deviceKey: string; label?: string; source: string }): Promise<Result<Session>> {
    if (!DEVICE_KEY.test(String(r.deviceKey ?? ''))) return fail(400, 'device_key');
    const limited = await attempt(r.source);
    if (limited) return limited;
    const code = normalizeCode(r.code);
    if (!isCode(code, INVITE_CODE_LENGTH)) return fail(403, 'invalid');
    const h = await sha256Hex(code);
    const inv = await st.get<Invite>(K.inv(h));
    if (!inv || inv.revokedAt) return fail(403, 'invalid');
    if (inv.usedAt) return fail(403, 'used');
    if (now() >= inv.expiresAt) return fail(403, 'expired');
    if (!(await st.get<Org>(K.org))) return fail(403, 'invalid');
    await st.put<Invite>(K.inv(h), { ...inv, usedAt: now() });
    const prev = await st.get<Account>(K.acct(inv.uid));
    await st.put<Account>(K.acct(inv.uid), { uid: inv.uid, role: inv.role, name: inv.name, phone: inv.phone, createdAt: prev?.createdAt ?? now() });
    return { ok: true, ...(await bind(inv.uid, inv.role, r.deviceKey, r.label ?? '')) };
  }

  /* ═══ الجلسة ═══ */

  async function verifyAccess(token: string): Promise<Result<Access>> {
    const a = await access(token);
    return a.ok ? { ok: true, uid: a.uid, deviceId: a.deviceId, role: a.role } : a;
  }

  async function refresh(r: { refreshToken: string }): Promise<Result<Tokens>> {
    const h = await sha256Hex(String(r.refreshToken ?? ''));
    const rec = await st.get<RefreshRec>(K.rt(h));
    if (!rec) return fail(401, 'invalid');
    const device = await st.get<Device>(K.dev(rec.deviceId));
    const account = await st.get<Account>(K.acct(rec.uid));
    if (!device || device.revokedAt || device.uid !== rec.uid || !account) return fail(401, 'revoked');
    const t = now();
    if (rec.usedAt !== null) {
      const next = rec.next ? await st.get<RefreshRec>(K.rt(rec.next)) : undefined;
      // ردٌّ ضاع: الرمز نفسه خلال المهلة وخلفه لم يُستعمل · يُبطل الخلف ويُعطى زوجٌ جديد
      if (t - rec.usedAt <= REFRESH_GRACE_MS && next && next.usedAt === null) {
        await st.delete(K.rt(rec.next!));
      } else {
        await revoke(device, 'refresh_reuse');
        return fail(401, 'reuse');
      }
    } else if (t - rec.issuedAt > REFRESH_IDLE_MS) {
      return fail(401, 'expired');
    }
    const tokens = await issue(rec.uid, rec.deviceId, account.role);
    const nh = await sha256Hex(tokens.refreshToken);
    await st.put<RefreshRec>(K.rt(h), { ...rec, usedAt: t, next: nh });
    const fresh = (await st.get<Device>(K.dev(rec.deviceId)))!;
    const used = [...fresh.refreshHashes.filter((x) => x !== h), h];
    for (const old of used.splice(0, Math.max(0, used.length - KEEP_USED_REFRESH))) await st.delete(K.rt(old));
    await st.put<Device>(K.dev(rec.deviceId), { ...fresh, refreshHashes: [...used, nh] });
    return { ok: true, ...tokens };
  }

  /* ═══ جهازٌ ثانٍ وسحب الأجهزة ═══ */

  async function createLinkCode(token: string): Promise<Result<{ code: string; expiresAt: number }>> {
    const a = await access(token);
    if (!a.ok) return a;
    const code = randomCode(LINK_CODE_LENGTH, random);
    const t = now();
    await st.put<LinkCode>(K.link(await hashCode(code)), { uid: a.uid, byDevice: a.deviceId, createdAt: t, expiresAt: t + LINK_TTL_MS, usedAt: null });
    return { ok: true, code, expiresAt: t + LINK_TTL_MS };
  }

  async function redeemLinkCode(r: { code: string; deviceKey: string; label?: string; source: string }): Promise<Result<Session>> {
    if (!DEVICE_KEY.test(String(r.deviceKey ?? ''))) return fail(400, 'device_key');
    const limited = await attempt(r.source);
    if (limited) return limited;
    const code = normalizeCode(r.code);
    if (!isCode(code, LINK_CODE_LENGTH)) return fail(403, 'invalid');
    const h = await sha256Hex(code);
    const link = await st.get<LinkCode>(K.link(h));
    if (!link) return fail(403, 'invalid');
    if (link.usedAt) return fail(403, 'used');
    if (now() >= link.expiresAt) return fail(403, 'expired');
    const by = await st.get<Device>(K.dev(link.byDevice));
    const account = await st.get<Account>(K.acct(link.uid));
    if (!by || by.revokedAt || !account) return fail(403, 'invalid');
    await st.put<LinkCode>(K.link(h), { ...link, usedAt: now() });
    return { ok: true, ...(await bind(link.uid, account.role, r.deviceKey, r.label ?? '')) };
  }

  async function listDevices(token: string): Promise<Result<{ items: DeviceInfo[] }>> {
    const a = await access(token);
    if (!a.ok) return a;
    const owner = await isOwner(a.uid);
    const items = [...(await st.list<Device>('dev:')).values()]
      .filter((d) => owner || d.uid === a.uid)
      .map(({ deviceId, uid, label, createdAt, revokedAt }) => ({ deviceId, uid, label, createdAt, revokedAt }));
    return { ok: true, items };
  }

  /** ضياع الجوال: المالك يسحب أي جهاز، والعضو أجهزته وحدها · وكل طلبٍ منه بعدها 401 */
  async function revokeDevice(token: string, deviceId: string): Promise<Result<object>> {
    const a = await access(token);
    if (!a.ok) return a;
    const d = await st.get<Device>(K.dev(deviceId));
    if (!d) return fail(404, 'not_found');
    if (d.uid !== a.uid && !(await isOwner(a.uid))) return fail(403, 'not_yours');
    await revoke(d, 'device_revoked');
    return { ok: true };
  }

  async function removeMember(token: string, uid: string): Promise<Result<object>> {
    const a = await access(token);
    if (!a.ok) return a;
    if (!(await isOwner(a.uid))) return fail(403, 'owner_only');
    if (uid === a.uid) return fail(403, 'owner_uid');
    for (const d of await devicesOf(uid)) await revoke(d, null);
    await st.delete(K.acct(uid));
    await note('member_removed', uid, null);
    return { ok: true };
  }

  /* ═══ إشعار المالك ═══ */

  async function listNotifications(token: string): Promise<Result<{ items: Note[] }>> {
    const a = await access(token);
    if (!a.ok) return a;
    if (!(await isOwner(a.uid))) return fail(403, 'owner_only');
    return { ok: true, items: [...(await st.list<Note>('note:')).values()] };
  }

  async function ackNotification(token: string, id: string): Promise<Result<object>> {
    const a = await access(token);
    if (!a.ok) return a;
    if (!(await isOwner(a.uid))) return fail(403, 'owner_only');
    const key = K.note(Number(id));
    const n = await st.get<Note>(key);
    if (!n) return fail(404, 'not_found');
    await st.put<Note>(key, { ...n, seen: true });
    return { ok: true };
  }

  /* ═══ «نسيت رمز القفل» و«حذف حسابي» ═══ */

  /**
   * الخادم يشهد أن الطالب هو الجوال المربوط: رمز دخولٍ قائم ومفتاح الجهاز نفسه · ثلاثٌ في ٢٤ ساعة للحساب بساعة الخادم ·
   * serverMs وقت الشهادة بساعته، وticket شهادةٌ موقّعة بها · ويُشعَر المالك بكل واحدة
   */
  async function attestLockReset(token: string, r: { deviceKey: string }): Promise<Result<{ serverMs: number; ticket: string }>> {
    const a = await access(token);
    if (!a.ok) return a;
    if (!(await deviceKeyOk(a.device, r.deviceKey))) return fail(403, 'device_key');
    const t = now();
    const recent = ((await st.get<number[]>(K.resets(a.uid))) ?? []).filter((x) => t - x < LOCK_RESET_WINDOW_MS && x <= t);
    if (recent.length >= LOCK_RESET_LIMIT) return fail(429, 'limit', Math.max(1, recent[recent.length - LOCK_RESET_LIMIT] + LOCK_RESET_WINDOW_MS - t));
    await st.put(K.resets(a.uid), [...recent, t]);
    await note('lock_reset', a.uid, a.deviceId);
    const ticket = await signer.sign({ typ: 'lockReset', sub: a.uid, dev: a.deviceId, iat: t, exp: t + FRESH_TTL_MS, jti: b64url(random(12)) });
    return { ok: true, serverMs: t, ticket };
  }

  /** إثباتٌ حديث لعملٍ حساس (الحذف) · بمفتاح الجهاز · خمس دقائق ولاستعمالٍ واحد */
  async function freshProof(token: string, r: { deviceKey: string; purpose: 'deleteAccount' }): Promise<Result<{ serverMs: number; ticket: string }>> {
    const a = await access(token);
    if (!a.ok) return a;
    if (r.purpose !== 'deleteAccount') return fail(400, 'purpose');
    if (!(await deviceKeyOk(a.device, r.deviceKey))) return fail(403, 'device_key');
    const t = now();
    const ticket = await signer.sign({ typ: 'fresh', purpose: r.purpose, sub: a.uid, dev: a.deviceId, iat: t, exp: t + FRESH_TTL_MS, jti: b64url(random(12)) });
    return { ok: true, serverMs: t, ticket };
  }

  async function useTicket(a: Access, ticket: string, purpose: string): Promise<Fail | null> {
    const c = await signer.verify(ticket);
    if (!c) return fail(401, 'invalid');
    if (c.typ !== 'fresh' || c.purpose !== purpose || c.sub !== a.uid || c.dev !== a.deviceId || typeof c.exp !== 'number' || typeof c.jti !== 'string') return fail(403, 'wrong_proof');
    if (now() >= c.exp) return fail(403, 'stale');
    if (await st.get(K.jti(c.jti))) return fail(403, 'used');
    await st.put(K.jti(c.jti), c.exp);
    return null;
  }

  /** العضو: يُحذف حسابه وتُسحب أجهزته ويُشعَر المالك · المالك: تُحذف المنشأة كلها (ويبقى أثر رموز التأسيس المستعملة وحده) */
  async function deleteAccount(token: string, r: { ticket: string }): Promise<Result<object>> {
    const a = await access(token);
    if (!a.ok) return a;
    const bad = await useTicket(a, r.ticket, 'deleteAccount');
    if (bad) return bad;
    if (await isOwner(a.uid)) {
      for (const k of (await st.list('')).keys()) if (k !== K.tomb) await st.delete(k);
      return { ok: true };
    }
    for (const d of await devicesOf(a.uid)) await revoke(d, null);
    await st.delete(K.acct(a.uid));
    await note('account_deleted', a.uid, a.deviceId);
    return { ok: true };
  }

  return {
    bootstrapOwner: serial(bootstrapOwner), recoverOwner: serial(recoverOwner),
    createInvite: serial(createInvite), revokeInvite: serial(revokeInvite), redeemInvite: serial(redeemInvite),
    verifyAccess: serial(verifyAccess), refresh: serial(refresh),
    createLinkCode: serial(createLinkCode), redeemLinkCode: serial(redeemLinkCode),
    listDevices: serial(listDevices), revokeDevice: serial(revokeDevice), removeMember: serial(removeMember),
    listNotifications: serial(listNotifications), ackNotification: serial(ackNotification),
    attestLockReset: serial(attestLockReset), freshProof: serial(freshProof), deleteAccount: serial(deleteAccount),
  };
}

export type AuthServer = ReturnType<typeof createAuthServer>;

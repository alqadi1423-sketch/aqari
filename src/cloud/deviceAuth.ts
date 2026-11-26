/**
 * مزوّد الجهاز (ق٠-٦ · F §٥.١ (أ) · قرار المالك س٦ (أ)): الهوية من خادم الهوية (server/auth) لا من قوقل ·
 *  - الدخول برمز دعوةٍ يصدره المالك ويرسله التطبيق بالواتساب (أو رمز ربط جهازٍ ثانٍ، أو رمز التأسيس للمالك) فيُربط هذا الجوال بحسابه.
 *  - مفتاح الجهاز (٢٥٦ بتاً) ورمز التحديث في المخزن الآمن وحده · رمز الدخول القصير في الذاكرة ويُجدَّد بلا دخولٍ جديد ولو غاب أسابيع.
 *  - «نسيت الرمز»: الخادم يشهد أن هذا الجوال المربوط ويعدّ الحدّ بساعته (ثلاثٌ في ٢٤ ساعة) ويُشعر المالك.
 *  - «حذف حسابي»: إثباتٌ حديث من الخادم لغرض الحذف ثم الحذف به.
 * لا يُشغَّل في التطبيق قبل التحويل (بإذن المالك) · والعميل الشبكي (HTTP) يُكتب مع الخادم في ق٢ على واجهة DeviceAuthClient.
 */
import type { AuthIdentity, AuthProvider, FreshProof, FreshPurpose } from './authProvider';
import { FreshProofRequiredError } from './authProvider';
import type { SecureKV } from './session';

export interface DeviceTokens { accessToken: string; accessExpiresAt: number; refreshToken: string }
export type ClientFail = { ok: false; status: number; code: string; waitMs?: number };
export type ClientResult<T> = ({ ok: true } & T) | ClientFail;
export type CodeKind = 'invite' | 'link' | 'setup' | 'recover';
/** ما يكتبه المستخدم ليدخل · للتأسيس معرّفه القديم واسمه (§٧.٢) */
export interface CodeEntry { kind: CodeKind; code: string; uid?: string; name?: string }

/** عميل خادم الهوية · شكل ردوده كردود الخادم (status كرمز HTTP، وcode للتطبيق) */
export interface DeviceAuthClient {
  redeem(r: CodeEntry & { deviceKey: string; label?: string }): Promise<ClientResult<{ uid: string; deviceId: string; role: string; tokens: DeviceTokens }>>;
  refresh(refreshToken: string): Promise<ClientResult<DeviceTokens>>;
  attestLockReset(access: string, r: { deviceKey: string }): Promise<ClientResult<{ serverMs: number; ticket: string }>>;
  freshProof(access: string, r: { deviceKey: string; purpose: 'deleteAccount' }): Promise<ClientResult<{ serverMs: number; ticket: string }>>;
  deleteAccount(access: string, r: { ticket: string }): Promise<ClientResult<object>>;
  revokeDevice(access: string, deviceId: string): Promise<ClientResult<object>>;
}

export interface DeviceAuthDeps {
  client: DeviceAuthClient;
  store: SecureKV;
  random(n: number): Uint8Array;
  /** نافذة كتابة الرمز · null عند الإلغاء */
  askCode(): Promise<CodeEntry | null>;
  label?: string;
  now?: () => number;
}

export const DEVICE_KEYS = {
  refresh: 'aqari.dev.refresh', uid: 'aqari.dev.uid', device: 'aqari.dev.device', key: 'aqari.dev.key', role: 'aqari.dev.role',
} as const;

/** رفض الخادم (401: سُحب الجهاز أو انتهت الجلسة) · status لمسار «أُزيلت عضويته» القائم */
export class DeviceAuthError extends Error {
  constructor(public status: number, public code: string) {
    super('device auth ' + status + ' ' + code);
    this.name = 'DeviceAuthError';
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64url(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '') + (i + 2 < b.length ? B64[n & 63] : '');
  }
  return s;
}

export function deviceAuthProvider(deps: DeviceAuthDeps): AuthProvider {
  const st = deps.store;
  const now = deps.now ?? Date.now;
  let user: AuthIdentity | null = null;
  let token: { value: string; exp: number } | null = null;

  async function restore(): Promise<AuthIdentity | null> {
    const [uid, device, refresh] = await Promise.all([st.get(DEVICE_KEYS.uid), st.get(DEVICE_KEYS.device), st.get(DEVICE_KEYS.refresh)]);
    user = uid && device && refresh ? { uid, email: '', provider: 'device', deviceId: device } : null;
    return user;
  }

  async function signIn(): Promise<AuthIdentity | null> {
    const entry = await deps.askCode();
    if (!entry) return null;
    // مفتاحٌ جديد لكل ربط: لا يُعاد مفتاح جهازٍ سُحب
    const deviceKey = b64url(deps.random(32));
    const r = await deps.client.redeem({ ...entry, deviceKey, label: deps.label });
    if (!r.ok) throw new DeviceAuthError(r.status, r.code);
    await st.set(DEVICE_KEYS.key, deviceKey);
    await st.set(DEVICE_KEYS.refresh, r.tokens.refreshToken);
    await st.set(DEVICE_KEYS.uid, r.uid);
    await st.set(DEVICE_KEYS.device, r.deviceId);
    await st.set(DEVICE_KEYS.role, r.role);
    token = { value: r.tokens.accessToken, exp: r.tokens.accessExpiresAt };
    user = { uid: r.uid, email: '', provider: 'device', deviceId: r.deviceId };
    return user;
  }

  /** رمز الدخول · يُجدَّد قبل انتهائه بدقيقة (بساعة الجهاز تقديراً · والخادم يحسم بساعته فيرفض المنتهي) */
  async function accessToken(): Promise<string> {
    if (token && token.exp - now() > 60_000) return token.value;
    const refresh = await st.get(DEVICE_KEYS.refresh);
    if (!refresh) throw new DeviceAuthError(401, 'no_session');
    const r = await deps.client.refresh(refresh);
    if (!r.ok) {
      token = null;
      throw new DeviceAuthError(r.status, r.code);
    }
    await st.set(DEVICE_KEYS.refresh, r.refreshToken);
    token = { value: r.accessToken, exp: r.accessExpiresAt };
    return r.accessToken;
  }

  const failOf = (r: ClientFail): FreshProof => {
    if (r.status === 429) return r.waitMs ? { ok: false, why: 'limit', waitMs: r.waitMs } : { ok: false, why: 'limit' };
    if (r.status === 401) return { ok: false, why: 'revoked' };
    if (r.status === 403) return { ok: false, why: 'mismatch' };
    return { ok: false, why: 'error' };
  };

  async function freshProof(purpose: FreshPurpose): Promise<FreshProof> {
    const [uid, deviceKey] = await Promise.all([st.get(DEVICE_KEYS.uid), st.get(DEVICE_KEYS.key)]);
    if (!uid || !deviceKey) return { ok: false, why: 'none' };
    let access: string;
    try { access = await accessToken(); } catch (e) { return e instanceof DeviceAuthError && e.status === 401 ? { ok: false, why: 'revoked' } : { ok: false, why: 'error' }; }
    let r: ClientResult<{ serverMs: number; ticket: string }>;
    try {
      r = purpose === 'lockReset'
        ? await deps.client.attestLockReset(access, { deviceKey })
        : await deps.client.freshProof(access, { deviceKey, purpose: 'deleteAccount' });
    } catch { return { ok: false, why: 'error' }; }
    if (!r.ok) return failOf(r);
    return { ok: true, serverMs: r.serverMs, ticket: (purpose === 'lockReset' ? 'lock:' : 'delete:') + r.ticket };
  }

  async function clear(): Promise<void> {
    for (const k of Object.values(DEVICE_KEYS)) await st.del(k);
    token = null;
    user = null;
  }

  return {
    id: 'device',
    restore,
    signIn,
    current: () => user,
    accessToken,
    freshProof,
    /** الخروج: يُسحب هذا الجهاز من الحساب إن أمكن (فلا يبقى مربوطاً بلا مالكه) ثم تُمسح الرموز · البيانات لا تُمسّ */
    async signOut() {
      const device = await st.get(DEVICE_KEYS.device);
      if (device) {
        try { await deps.client.revokeDevice(await accessToken(), device); } catch { /* بلا اتصال: يسحبه المالك من «الأعضاء» */ }
      }
      await clear();
    },
    async deleteAccount(proof: FreshProof) {
      if (!proof.ok || !proof.ticket?.startsWith('delete:')) throw new FreshProofRequiredError();
      const r = await deps.client.deleteAccount(await accessToken(), { ticket: proof.ticket.slice('delete:'.length) });
      if (!r.ok) throw new DeviceAuthError(r.status, r.code);
      await clear();
    },
  };
}

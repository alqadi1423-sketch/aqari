/**
 * جلسة الحساب · منطق خالص بلا اعتماد مباشر على وحدات الجهاز (تُحقن)، فيُختبر على Node.
 *
 *  - الدخول اختياري: قوقل يعطي رمز هوية ← Firebase يعطي uid ورمز تحديث.
 *  - رمز التحديث والهوية والبريد في المخزن الآمن وحده (expo-secure-store).
 *  - الخروج يمسح الرموز وحدها · البيانات المحلية لا تُمسّ.
 */
import { AuthError, type FirebaseUser } from './authRest';
import { checkAccountProof } from '../domain/lockReset';
import { t } from '../i18n';

export interface SecureKV {
  get(k: string): Promise<string | null>;
  set(k: string, v: string): Promise<void>;
  del(k: string): Promise<void>;
}

export interface GoogleBridge {
  /** نافذة الدخول · null عند إلغاء المستخدم */
  signIn(): Promise<{ idToken: string; email: string } | null>;
  /** استعادة الجلسة بصمت بعد إعادة تشغيل التطبيق */
  signInSilently(): Promise<boolean>;
  /** رمز وصول Drive (نطاق appdata) · يجدّده قوقل بنفسه */
  accessToken(): Promise<string>;
  signOut(): Promise<void>;
}

export interface SessionDeps {
  google: GoogleBridge;
  store: SecureKV;
  signInWithIdp(googleIdToken: string): Promise<FirebaseUser>;
  refresh(refreshToken: string): Promise<Omit<FirebaseUser, 'email'>>;
  now?: () => number;
}

export const KEYS = { refresh: 'aqari.auth.refresh', uid: 'aqari.auth.uid', email: 'aqari.auth.email' } as const;

export interface SessionUser { uid: string; email: string }

/**
 * تأكيد الحساب لقفل التطبيق · serverMs وقت رمز الهوية بساعة الخادم (لحدّ إعادة الضبط) · none: لا حساب محفوظ ·
 * signout: تعذّر الخروج من قوقل قبله · cancel: أُلغيت النافذة · mismatch: حسابٌ آخر · stale: رمزٌ لا يشهد بدخولٍ جديد
 */
export type AccountProof = { ok: true; serverMs: number } | { ok: false; why: 'none' | 'signout' | 'cancel' | 'mismatch' | 'stale' | 'error' };

export function createSession(deps: SessionDeps) {
  const now = deps.now ?? Date.now;
  let token: { idToken: string; expiresAt: number } | null = null;
  let user: SessionUser | null = null;

  async function restore(): Promise<SessionUser | null> {
    const uid = await deps.store.get(KEYS.uid);
    const refresh = await deps.store.get(KEYS.refresh);
    if (!uid || !refresh) { user = null; return null; }
    user = { uid, email: (await deps.store.get(KEYS.email)) ?? '' };
    return user;
  }

  async function signIn(): Promise<SessionUser | null> {
    const g = await deps.google.signIn();
    if (!g) return null;
    const fb = await deps.signInWithIdp(g.idToken);
    await deps.store.set(KEYS.refresh, fb.refreshToken);
    await deps.store.set(KEYS.uid, fb.uid);
    await deps.store.set(KEYS.email, fb.email || g.email);
    token = { idToken: fb.idToken, expiresAt: fb.expiresAt };
    user = { uid: fb.uid, email: fb.email || g.email };
    return user;
  }

  /**
   * دخولٌ جديد بقوقل للحساب المحفوظ ولا يُكتب شيء · المراجعة الشاملة · البند ٥: خروجٌ من قوقل أولاً، فلا يعود الحساب الحالي بلا
   * نافذة ويُفرض اختياره من جديد، ثم يُفحص رمز هويته: لرقم الحساب المحفوظ وصادرٌ عند الدخول لا بتجديد (domain/lockReset.ts) ·
   * وتعذّر الخروج لا تأكيد · وحسابٌ مختلف يُخرج من قوقل فلا يبقى هو الحساب الحالي لرموز Drive (وتُعاد بنافذة: driveToken)
   */
  async function proveAccount(): Promise<{ proof: AccountProof; fb?: FirebaseUser }> {
    const uid = user?.uid ?? (await deps.store.get(KEYS.uid));
    if (!uid) return { proof: { ok: false, why: 'none' } };
    try { await deps.google.signOut(); } catch { return { proof: { ok: false, why: 'signout' } }; }
    const g = await deps.google.signIn();
    if (!g) return { proof: { ok: false, why: 'cancel' } };
    const fb = await deps.signInWithIdp(g.idToken);
    const proof = fb.uid === uid ? checkAccountProof(fb.idToken, uid) : ({ ok: false, why: 'uid' } as const);
    if (proof.ok) return { proof, fb };
    if (proof.why !== 'uid') return { proof: { ok: false, why: 'stale' } };
    try { await deps.google.signOut(); } catch { /* يبقى مرفوضاً على كل حال */ }
    return { proof: { ok: false, why: 'mismatch' } };
  }

  /**
   * قفل التطبيق (#51): تأكيد أن من يفتح هو صاحب الحساب المسجّل · ولا يُكتب شيء في الجلسة (المتحقق المستقل: الدخول الكامل كان
   * يستبدل الجلسة بحسابٍ آخر قبل المقارنة)
   */
  async function confirmSameAccount(): Promise<AccountProof> {
    return (await proveAccount()).proof;
  }

  /**
   * «حذف حسابي»: تأكيد الهوية بدخولٍ جديد للحساب نفسه (المراجعة الشاملة · البند ٥: كان signIn وحده يعيد الحساب الحالي بلا نافذة،
   * وحسابٌ آخر فيه يُكتب في الجلسة قبل المقارنة) · الحساب نفسه: رمز الدخول الحديث في الذاكرة ورمز تحديثه في المخزن (حذف حساب
   * Firebase وقواعد الحذف تطلب دخولاً حديثاً) · وغيره لا يُكتب
   */
  async function reauthSameAccount(): Promise<AccountProof> {
    const { proof, fb } = await proveAccount();
    if (proof.ok && fb) {
      await deps.store.set(KEYS.refresh, fb.refreshToken);
      token = { idToken: fb.idToken, expiresAt: fb.expiresAt };
    }
    return proof;
  }

  /** الخروج: الرموز وحدها تُمسح · لا قاعدة ولا ملف يُمسّ */
  async function signOut(): Promise<void> {
    try { await deps.google.signOut(); } catch { /* الخروج من قوقل ترف · الرموز تُمسح على كل حال */ }
    for (const k of Object.values(KEYS)) await deps.store.del(k);
    token = null;
    user = null;
  }

  async function idToken(): Promise<string> {
    if (token && token.expiresAt - now() > 60_000) return token.idToken;
    const refresh = await deps.store.get(KEYS.refresh);
    if (!refresh) throw new AuthError('لا جلسة محفوظة · سجّل الدخول');
    const r = await deps.refresh(refresh);
    if (r.refreshToken !== refresh) await deps.store.set(KEYS.refresh, r.refreshToken);
    token = { idToken: r.idToken, expiresAt: r.expiresAt };
    return r.idToken;
  }

  /**
   * رمز Drive · وجلسة قوقل سقطت والحساب باقٍ (أُلغيت نافذة تأكيد الحساب بعد الخروج منه، أو أُخرج حسابٌ آخر): نافذة اختيار الحساب
   * ثم يُطابق رقمه بالمحفوظ ولا يُكتب شيء (المتحقق المستقل: كانت Drive تفشل بـ«انتهت جلسة قوقل» ولا طريق في الواجهة للدخول ما
   * دامت جلسة الحساب باقية) · وحسابٌ آخر يُخرج منه ويُرفض
   */
  async function driveToken(): Promise<string> {
    try { return await deps.google.accessToken(); } catch { /* يُستعاد أدناه */ }
    if (await deps.google.signInSilently().catch(() => false)) return deps.google.accessToken();
    const uid = user?.uid ?? (await deps.store.get(KEYS.uid));
    if (!uid) throw new AuthError('انتهت جلسة قوقل · سجّل الدخول من جديد');
    const g = await deps.google.signIn();
    if (!g) throw new AuthError(t('auth.driveCancelled'));
    const fb = await deps.signInWithIdp(g.idToken);
    if (fb.uid !== uid) {
      try { await deps.google.signOut(); } catch { /* يبقى مرفوضاً */ }
      throw new AuthError(t('auth.driveOtherAccount'));
    }
    return deps.google.accessToken();
  }

  return { restore, signIn, signOut, idToken, driveToken, confirmSameAccount, reauthSameAccount, current: () => user };
}

export type Session = ReturnType<typeof createSession>;

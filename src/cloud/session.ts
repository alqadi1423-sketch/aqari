/**
 * جلسة الحساب · منطق خالص بلا اعتماد مباشر على وحدات الجهاز (تُحقن)، فيُختبر على Node.
 *
 *  - الدخول اختياري: قوقل يعطي رمز هوية ← Firebase يعطي uid ورمز تحديث.
 *  - رمز التحديث والهوية والبريد في المخزن الآمن وحده (expo-secure-store).
 *  - الخروج يمسح الرموز وحدها · البيانات المحلية لا تُمسّ.
 */
import { AuthError, type FirebaseUser } from './authRest';

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

  async function driveToken(): Promise<string> {
    try { return await deps.google.accessToken(); }
    catch {
      if (await deps.google.signInSilently()) return deps.google.accessToken();
      throw new AuthError('انتهت جلسة قوقل · سجّل الدخول من جديد');
    }
  }

  return { restore, signIn, signOut, idToken, driveToken, current: () => user };
}

export type Session = ReturnType<typeof createSession>;

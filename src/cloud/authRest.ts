/**
 * Firebase Auth عبر REST · رمز قوقل يُبدَّل بهوية Firebase (uid) ورمز تحديث طويل يُحفظ في
 * المخزن الآمن، ورمز الدخول القصير (ساعة) يُجدَّد منه عند الحاجة.
 */
export interface FirebaseUser {
  uid: string;
  email: string;
  idToken: string;
  refreshToken: string;
  /** وقت انتهاء رمز الدخول بالملّي ثانية */
  expiresAt: number;
}

export interface AuthRestOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** للمحاكي في الاختبارات: http://127.0.0.1:9099 */
  emulatorBase?: string;
  now?: () => number;
}

export class AuthError extends Error {
  constructor(detail: string) {
    super('تعذّر الدخول: ' + detail);
    this.name = 'AuthError';
  }
}

function urls(o: AuthRestOptions) {
  const e = o.emulatorBase?.replace(/\/$/, '');
  return {
    idp: (e ? `${e}/identitytoolkit.googleapis.com` : 'https://identitytoolkit.googleapis.com') + `/v1/accounts:signInWithIdp?key=${o.apiKey}`,
    token: (e ? `${e}/securetoken.googleapis.com` : 'https://securetoken.googleapis.com') + `/v1/token?key=${o.apiKey}`,
  };
}

/** رسالة عربية لأشهر رموز الرفض · والنصّ الأصلي يذهب للسجل لا للمستخدم */
function reason(text: string): string {
  if (/TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_NOT_FOUND|USER_DISABLED/.test(text)) return 'انتهت الجلسة · سجّل الدخول من جديد';
  if (/INVALID_IDP_RESPONSE|INVALID_ID_TOKEN/.test(text)) return 'رفضت قوقل رمز الدخول';
  if (/API_KEY|PROJECT/.test(text)) return 'إعداد مشروع Firebase في هذا البناء غير صحيح';
  return 'استجابة غير متوقعة من الخادم';
}

export async function signInWithGoogleIdToken(o: AuthRestOptions, googleIdToken: string): Promise<FirebaseUser> {
  const f = o.fetchImpl ?? fetch;
  const now = (o.now ?? Date.now)();
  const res = await f(urls(o).idp, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody: `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`,
      requestUri: 'http://localhost',
      returnSecureToken: true,
      returnIdpCredential: true,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new AuthError(reason(text));
  const j = JSON.parse(text) as { localId: string; email?: string; idToken: string; refreshToken: string; expiresIn: string };
  return { uid: j.localId, email: j.email ?? '', idToken: j.idToken, refreshToken: j.refreshToken, expiresAt: now + Number(j.expiresIn) * 1000 };
}

export async function refreshIdToken(o: AuthRestOptions, refreshToken: string): Promise<Omit<FirebaseUser, 'email'>> {
  const f = o.fetchImpl ?? fetch;
  const now = (o.now ?? Date.now)();
  const res = await f(urls(o).token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });
  const text = await res.text();
  if (!res.ok) throw new AuthError(reason(text));
  const j = JSON.parse(text) as { user_id: string; id_token: string; refresh_token: string; expires_in: string };
  return { uid: j.user_id, idToken: j.id_token, refreshToken: j.refresh_token, expiresAt: now + Number(j.expires_in) * 1000 };
}

/**
 * مزوّد قوقل (ق٠-٦): الجلسة القائمة (cloud/session.ts) خلف واجهة AuthProvider كما هي بلا تغيير في السلوك ·
 *  - «نسيت الرمز»: confirmSameAccount (خروجٌ من قوقل ثم دخولٌ جديد يُفحص رمز هويته ولا يُكتب شيء).
 *  - «حذف حسابي»: reauthSameAccount (الدخول الجديد نفسه، ورمزه الحديث يُحفظ للحذف) ثم حذف حساب Firebase بذلك الرمز.
 * وهذا الملف وحده (مع session.ts وauthRest.ts) يعرف أن الهوية من قوقل.
 */
import type { AuthIdentity, AuthProvider, FreshProof, FreshPurpose } from './authProvider';
import { FreshProofRequiredError } from './authProvider';
import type { Session, SessionUser } from './session';

export interface GoogleAuthDeps {
  session: Session;
  /** حذف حساب Firebase برمز دخولٍ حديث (authRest.deleteFirebaseAccount) */
  deleteFirebaseAccount(idToken: string): Promise<void>;
}

const identity = (u: SessionUser | null): AuthIdentity | null => (u ? { uid: u.uid, email: u.email, provider: 'google', deviceId: null } : null);

export function googleAuthProvider(deps: GoogleAuthDeps): AuthProvider & { driveToken(): Promise<string> } {
  const s = deps.session;
  // رمز الحذف لا يُعطى إلا بعد إثباتٍ لغرض الحذف نفسه في هذا التشغيل
  let deleteProven = false;
  return {
    id: 'google',
    restore: async () => identity(await s.restore()),
    signIn: async () => identity(await s.signIn()),
    current: () => identity(s.current()),
    accessToken: () => s.idToken(),
    async freshProof(purpose: FreshPurpose): Promise<FreshProof> {
      if (purpose === 'lockReset') return s.confirmSameAccount();
      const p = await s.reauthSameAccount();
      deleteProven = p.ok;
      return p;
    },
    async signOut() {
      deleteProven = false;
      await s.signOut();
    },
    async deleteAccount(proof: FreshProof) {
      if (!proof.ok || !deleteProven) throw new FreshProofRequiredError();
      await deps.deleteFirebaseAccount(await s.idToken());
      deleteProven = false;
    },
    driveToken: () => s.driveToken(),
  };
}

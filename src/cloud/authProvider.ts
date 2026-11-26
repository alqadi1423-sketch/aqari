/**
 * مزوّد الهوية (ق٠-٦ · F الاستقلال عن قوقل §٥.١): واجهةٌ واحدة يمرّ بها كل ما يحتاج الحساب في التطبيق (الجلسة، و«نسيت الرمز»، و«حذف
 * حسابي»، والمزامنة) فلا يعرف أحدٌ منهم من أين جاءت الهوية.
 *
 *  - اليوم: مزوّد قوقل وحده (cloud/googleAuth.ts) فوق الجلسة القائمة (cloud/session.ts) بلا أي تغيير في السلوك.
 *  - بعد التحويل: مزوّد الجهاز المربوط برمز دعوة (cloud/deviceAuth.ts) أمام خادم الهوية (server/auth) · ولا يُشغَّل قبل إذن المالك.
 *
 * الإثبات الحديث (freshProof) لا يُكتب في الجلسة إلا لغرضه: «حذف حسابي» يحتاج رمزاً حديثاً للحذف نفسه، و«نسيت الرمز» لا يمسّ
 * الجلسة أبداً · وserverMs وقت الإثبات بساعة الخادم وحدها (لا ساعة الجهاز)، فحدّ إعادة الضبط يُعدّ بها.
 */

/** من أين الهوية: قوقل عبر Firebase اليوم، أو جهازٌ مربوط بخادم الهوية بعد التحويل */
export type AuthProviderId = 'google' | 'device';

/** الهوية الحالية على هذا الجهاز · deviceId رقم الجهاز المربوط عند خادم الهوية (null لقوقل: لا ربط للجهاز فيه) */
export interface AuthIdentity {
  uid: string;
  email: string;
  provider: AuthProviderId;
  deviceId: string | null;
}

/** غرض الإثبات الحديث: يُطلب لكلٍّ منهما على حدة فلا يُستعمل إثبات أحدهما للآخر */
export type FreshPurpose = 'lockReset' | 'deleteAccount';

/**
 * أسباب تعذّر الإثبات الحديث · none: لا حساب محفوظ · signout: تعذّر الخروج قبله (قوقل) · cancel: أُلغيت النافذة · mismatch: حسابٌ آخر ·
 * stale: رمزٌ لا يشهد بدخولٍ جديد · revoked: سُحب الجهاز (401) · limit: بلغ الحدّ بساعة الخادم (waitMs كم بقي) · error: غير ذلك
 */
export type FreshFail = 'none' | 'signout' | 'cancel' | 'mismatch' | 'stale' | 'error' | 'revoked' | 'limit';

/** الإثبات الحديث · serverMs وقته بساعة الخادم · ticket ما يقدّمه التطبيق للخادم مع العملية الحساسة (مزوّد الجهاز وحده) */
export type FreshProof = { ok: true; serverMs: number; ticket?: string } | { ok: false; why: FreshFail; waitMs?: number };

export interface AuthProvider {
  readonly id: AuthProviderId;
  /** الجلسة المحفوظة بلا شبكة · null إن لم يُدخل من قبل */
  restore(): Promise<AuthIdentity | null>;
  /** الدخول · null عند الإلغاء */
  signIn(): Promise<AuthIdentity | null>;
  current(): AuthIdentity | null;
  /** رمز الدخول القصير للخادم (Firestore اليوم) · يُجدَّد من رمز التحديث في المخزن الآمن */
  accessToken(): Promise<string>;
  /** إثباتٌ حديث أن من يحمل الجهاز صاحب الحساب المحفوظ نفسه · لا يُكتب في الجلسة إلا رمز الحذف لغرضه */
  freshProof(purpose: FreshPurpose): Promise<FreshProof>;
  /** الخروج: الرموز وحدها تُمسح · لا قاعدة ولا ملف يُمسّ */
  signOut(): Promise<void>;
  /** حذف الهوية نفسها عند مزوّدها · بإثباتٍ حديثٍ لغرض الحذف (يرمي بدونه) */
  deleteAccount(proof: FreshProof): Promise<void>;
  /** رمز Google Drive · لمزوّد قوقل وحده (نسخ Drive القديمة حتى إخراجها · ق٠-١) */
  driveToken?(): Promise<string>;
}

/** الإثبات لا يصلح لما يطلبه (غرضه أو مزوّده) */
export class FreshProofRequiredError extends Error {
  constructor() {
    super('fresh proof required');
    this.name = 'FreshProofRequiredError';
  }
}

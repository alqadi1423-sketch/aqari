/**
 * «حذف حسابي» (الدراسة أ، معتمدة · ق٠-٦: عبر مزوّد الهوية بلا افتراض قوقل) · منطقٌ خالص تُحقن خطواته فيُختبر على Node:
 *  إثباتٌ حديث لغرض الحذف من المزوّد (قوقل: خروجٌ ثم دخولٌ جديد للحساب نفسه · الجهاز: قفل الجهاز ثم إثبات الخادم بمفتاح الجهاز) ·
 *  ثم بالترتيب: بيانات السحابة · نسخ Drive (لمزوّد قوقل وحده وما لم تُخرج) · الهوية نفسها عند مزوّدها بذلك الإثبات · ثم الجهاز ·
 *  ثم الخروج. فشل خطوةٍ يوقف ما بعدها ويُبلَّغ.
 */
import type { AuthProvider, FreshProof } from './authProvider';

export interface DeleteFlowDeps {
  auth: AuthProvider | null;
  signedIn: boolean;
  online: boolean;
  t(key: string): string;
  progress?(m: string): void;
  /** صاحب الجهاز يفتح قفله قبل إثبات الخادم (مزوّد الجهاز · لا نافذة دخولٍ تشهد به) · true إن فُتح أو لا قفل */
  confirmHolder?(): Promise<boolean>;
  pause(): Promise<void>;
  resume(): void;
  /** بيانات السحابة (Firestore اليوم) · بلا إعدادها لا خطوة */
  wipeAccountCloud?(): Promise<void>;
  /** نسخ Drive برمز Drive من المزوّد · تُتخطّى إن أُخرجت (ق٠-١) أو لا Drive للمزوّد */
  wipeDrive?(driveToken: string): Promise<void>;
  driveRetired: boolean;
  resetDevice(): Promise<void>;
  /** بعد الخروج: حالة الواجهة */
  done(): void;
}

function proofError(p: Exclude<FreshProof, { ok: true }>, google: boolean, t: (k: string) => string): Error {
  if (p.why === 'cancel') return new Error(t('accountDelete.cancelled'));
  if (p.why === 'mismatch') return new Error(t(google ? 'accountDelete.mismatch' : 'accountDelete.mismatchDevice'));
  if (p.why === 'revoked') return new Error(t('accountDelete.revoked'));
  return new Error(t(google ? 'auth.reauthFailed' : 'accountDelete.reauthFailed'));
}

export async function deleteAccountFlow(d: DeleteFlowDeps): Promise<void> {
  const auth = d.auth;
  if (!auth || !d.signedIn) throw new Error(d.t('accountDelete.needSignIn'));
  if (!d.online) throw new Error(d.t('accountDelete.needOnline'));
  const google = auth.id === 'google';
  if (!google && d.confirmHolder && !(await d.confirmHolder())) throw new Error(d.t('accountDelete.deviceLock'));
  d.progress?.(d.t(google ? 'accountDelete.confirmGoogle' : 'accountDelete.confirmDevice'));
  const proof = await auth.freshProof('deleteAccount');
  if (!proof.ok) throw proofError(proof, google, d.t);
  await d.pause();
  try {
    if (d.wipeAccountCloud) {
      d.progress?.(d.t('accountDelete.wipingCloud'));
      await d.wipeAccountCloud();
    }
    if (d.wipeDrive && auth.driveToken && !d.driveRetired) {
      d.progress?.(d.t('accountDelete.wipingDrive'));
      await d.wipeDrive(await auth.driveToken());
    }
    d.progress?.(d.t('accountDelete.deleting'));
    await auth.deleteAccount(proof);
    d.progress?.(d.t('accountDelete.resetting'));
    await d.resetDevice();
    await auth.signOut();
    d.done();
  } finally {
    d.resume();
  }
}

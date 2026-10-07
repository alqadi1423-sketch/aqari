/**
 * لغة المستخدم تتبعه على أجهزته وتُزامَن مع حسابه (قرار المالك ٢٠٢٦-١٠-٠٧)، والافتراضي لغة الجهاز.
 * الحال على الجهاز: الاختيار ووقته وصاحبه وهل ينتظر الرفع · وفي حساب المستخدم: الاختيار ووقته.
 * الأحدث يغلب · ومستخدمٌ آخر على الجهاز لا يرث اختيار من قبله.
 */
import type { LangPref } from './index';

export interface LangState { pref: LangPref; at: string | null; uid: string | null; pending: boolean }
export interface CloudLang { pref: LangPref; at: string }

export const EMPTY_LANG_STATE: LangState = { pref: 'device', at: null, uid: null, pending: false };

/** ما يُستعمل الآن، وهل يُرفع اختيار الجهاز، والحال الجديدة على الجهاز */
export function reconcileLang(local: LangState, cloud: CloudLang | null, uid: string): { use: LangPref; push: boolean; state: LangState } {
  // اختيارٌ قبل أول دخول على الجهاز يصير لهذا المستخدم
  if (local.uid === null && local.pending) local = { ...local, uid };
  if (local.uid !== uid) {
    // مستخدمٌ آخر (أو أول دخول بلا اختيار): اختياره من حسابه، وإلا لغة الجهاز
    if (cloud) return { use: cloud.pref, push: false, state: { pref: cloud.pref, at: cloud.at, uid, pending: false } };
    return { use: 'device', push: false, state: { pref: 'device', at: null, uid, pending: false } };
  }
  if (local.pending) {
    // اختيارٌ على هذا الجهاز لم يُرفع: يُرفع إلا إن سبقه في الحساب اختيارٌ أحدث من جهاز آخر
    if (cloud && local.at && cloud.at > local.at) return { use: cloud.pref, push: false, state: { pref: cloud.pref, at: cloud.at, uid, pending: false } };
    return { use: local.pref, push: true, state: local };
  }
  if (cloud && (!local.at || cloud.at > local.at)) {
    return { use: cloud.pref, push: false, state: { pref: cloud.pref, at: cloud.at, uid, pending: false } };
  }
  return { use: local.pref, push: false, state: local };
}

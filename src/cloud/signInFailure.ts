/**
 * سبب تعذّر إكمال الدخول بنصه الفعلي (رسالة المالك 2026-10-08) · لا يُنسب كل فشل إلى الاتصال:
 * الشبكة، أو إعداد السحابة (فهرس ناقص)، أو رفض القواعد، أو الرمز، أو إعداد قوقل في البناء، أو خطأ الخادم برمزه،
 * أو خطأ على الجهاز باسمه · والتفاصيل الكاملة تُنسخ بزر «نسخ تفاصيل الخطأ» (قرار 2026-09-02).
 */
import { t } from '../i18n';
import { FirestoreHttpError } from './firestore';
import { errorReportText } from '../services/errorReport';

export type SignInFailureKind =
  | 'network' | 'index' | 'denied' | 'token' | 'googleConfig' | 'playServices' | 'google' | 'server' | 'device';

const AR = /[؀-ۿ]/;
const codeOf = (e: unknown) => String((e as { code?: unknown } | null)?.code ?? '');

export function signInFailureKind(e: unknown): SignInFailureKind {
  if (e instanceof FirestoreHttpError) {
    if ((e.status === 400 || e.status === 412) && /FAILED_PRECONDITION/.test(e.message) && /\bindex\b/i.test(e.message)) return 'index';
    if (e.status === 403) return 'denied';
    if (e.status === 401) return 'token';
    return 'server';
  }
  const code = codeOf(e);
  const m = e instanceof Error ? e.message : String(e ?? '');
  // قوقل على أندرويد: 10 = بصمة التوقيع أو معرّف العميل لا يطابقان المشروع · 7 = الشبكة
  if (code === '10' || /DEVELOPER_ERROR/.test(code + ' ' + m)) return 'googleConfig';
  if (/PLAY_SERVICES/.test(code)) return 'playServices';
  if (code === '7' || /Network request failed|fetch failed|timed? ?out|ENOTFOUND|ECONN/i.test(m)) return 'network';
  if (/\btoken\b|UNAUTHENTICATED/i.test(m)) return 'token';
  // رمزٌ من قوقل لم يُفصَّل (عملية جارية، 12500، 8…) يُذكر برمزه · وغيره (ERR_ من وحدات الجهاز كالقاعدة والخزنة) أو بلا رمز خطأ على الجهاز برمزه أو اسمه
  if (/^\d+$|^(ASYNC_OP_IN_PROGRESS|NULL_PRESENTER|SIGN_IN_REQUIRED|SIGN_IN_CANCELLED)$/.test(code)) return 'google';
  return 'device';
}

/** السبب سطراً للمستخدم بلغته · رسالة عربية كتبها التطبيق للمستخدم تُعرض كما هي، ورمز الخادم أو قوقل أو اسم الخطأ */
export function signInFailureText(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (!(e instanceof FirestoreHttpError) && AR.test(m)) return m;
  const kind = signInFailureKind(e);
  const status = e instanceof FirestoreHttpError ? String(e.status)
    : codeOf(e) || (e instanceof Error ? e.name : typeof e);
  return t('auth.fail.' + kind, { status });
}

/** سبب شاشة «لم يكتمل التحقق» وتفاصيلها للنسخ · بلا اتصال يُقال ذلك وحده، وإلا فالخطأ نفسه */
export function gateFailure(where: string, online: boolean, e?: unknown): { lead: string; full: string } {
  if (!online) return { lead: t('auth.fail.network', { status: '' }), full: errorReportText(where, new Error('offline')) };
  return { lead: signInFailureText(e), full: errorReportText(where, e) };
}

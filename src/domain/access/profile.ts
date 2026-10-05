/**
 * بيانات العضو (توجيه المالك ٢٠٢٦-١٠-٠٥ · ثانياً): الاسم الكامل والجوال إلزاميان، والهوية/الإقامة والمسمى
 * الوظيفي اختياريان. الجوال سعودي موحَّد 05XXXXXXXX، والهوية عشرة أرقام أولها ١ أو ٢.
 * الهوية لا يراها إلا المالك والعضو نفسه (الواجهة وقواعد الأمان) · فتبقى في مستند العضوية وحده.
 */
import { normalizePhone } from '../phone';

export interface MemberProfile {
  /** الاسم الكامل */
  name: string;
  /** الجوال موحَّداً 05XXXXXXXX */
  phone: string;
  /** الهوية أو الإقامة · فارغ إن لم تُدخل */
  nid: string;
  /** المسمى الوظيفي · فارغ إن لم يُدخل */
  title: string;
}

export const EMPTY_PROFILE: MemberProfile = { name: '', phone: '', nid: '', title: '' };

/** الأرقام العربية والفارسية إلى لاتينية */
const latinDigits = (s: string) =>
  s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/** الهوية بعد التوحيد: أرقام لاتينية بلا مسافات */
export function normalizeNid(raw: string): string {
  return latinDigits(String(raw ?? '')).replace(/[\s-]/g, '');
}

export const NID_RE = /^[12][0-9]{9}$/;
export const PHONE_RE = /^05[0-9]{8}$/;

/**
 * يتحقق ويوحّد · يعيد الملف الموحَّد أو أول خطأ بلغة المستخدم.
 * required: الاسم والجوال إلزاميان (عند الإكمال)، وعند الدعوة قد يُترك الملف كله فارغاً ليكمله العضو.
 */
export function validateProfile(input: Partial<MemberProfile>, required: boolean): { ok: true; profile: MemberProfile } | { ok: false; error: string; field: keyof MemberProfile } {
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  const rawPhone = String(input.phone ?? '').trim();
  const nid = normalizeNid(String(input.nid ?? ''));
  const title = String(input.title ?? '').trim().replace(/\s+/g, ' ');
  if (required || name) {
    if (name.length < 2) return { ok: false, field: 'name', error: 'اكتب الاسم الكامل' };
    if (name.length > 80) return { ok: false, field: 'name', error: 'الاسم أطول من ٨٠ حرفاً' };
  }
  let phone = '';
  if (required || rawPhone) {
    const p = normalizePhone(rawPhone);
    if (!p || !PHONE_RE.test(p)) return { ok: false, field: 'phone', error: 'اكتب جوالاً سعودياً صحيحاً يبدأ بـ05 (عشرة أرقام)' };
    phone = p;
  }
  if (nid && !NID_RE.test(nid)) return { ok: false, field: 'nid', error: 'الهوية أو الإقامة عشرة أرقام أولها ١ أو ٢' };
  if (title.length > 60) return { ok: false, field: 'title', error: 'المسمى الوظيفي أطول من ٦٠ حرفاً' };
  return { ok: true, profile: { name, phone, nid, title } };
}

/** ينقص الملفَ ما يلزم · فتظهر للعضو شاشة الإكمال بعد قبوله الدعوة */
export function profileIncomplete(p: Partial<MemberProfile> | null | undefined): boolean {
  if (!p) return true;
  const r = validateProfile(p, true);
  return !r.ok;
}

import { OWNER_ACTOR } from './opWrites';
import { t } from '../../i18n';
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
/**
 * ما يحاكي شارة دور أو فاصلها لا يكون اسماً (المراجعة الخارجية ٧ · النتيجة ١٧ · قرار المالك «رابعاً ١٠») · يطابق memberNameOk في
 * القواعد · والفيصل شارة الدور من المعرّف (src/chat/roles.ts)
 */
export const RESERVED_NAME_RE = /المالك|مالك المنشأة|·|:|owner|supervis/i; // i18n-exempt: نصٌّ محجوز تطابقه القواعد
export const reservedName = (name: string): boolean => RESERVED_NAME_RE.test(name) || !NAME_CHARS_RE.test(name);
/** حروف الاسم المقبولة · تطابق profileComplete في القواعد (المتحقق المستقل، الجولة ٢٨: التطويل والتشكيل والحرف الشبيه) */
export const NAME_CHARS_RE = /^[\u0621-\u063A\u0641-\u064A\u0660-\u0669\u0671-\u06D3a-zA-Z0-9 .'-]+$/;
/** التطويل والتشكيل يُنزعان من الاسم قبل الحفظ · فلا يُرفض اسمٌ كُتب بهما */
export const stripArabicMarks = (s: string): string => s.replace(/[\u0640\u064B-\u065F\u0670]/g, '');
export const PHONE_RE = /^05[0-9]{8}$/;

/**
 * يتحقق ويوحّد · يعيد الملف الموحَّد أو أول خطأ بلغة المستخدم.
 * required: الاسم والجوال إلزاميان (عند الإكمال)، وعند الدعوة قد يُترك الملف كله فارغاً ليكمله العضو.
 */
export function validateProfile(input: Partial<MemberProfile>, required: boolean): { ok: true; profile: MemberProfile } | { ok: false; error: string; field: keyof MemberProfile } {
  const name = stripArabicMarks(String(input.name ?? '')).trim().replace(/\s+/g, ' ');
  const rawPhone = String(input.phone ?? '').trim();
  const nid = normalizeNid(String(input.nid ?? ''));
  const title = String(input.title ?? '').trim().replace(/\s+/g, ' ');
  if (required || name) {
    if (name.length < 2) return { ok: false, field: 'name', error: 'اكتب الاسم الكامل' };
    if (name.length > 80) return { ok: false, field: 'name', error: 'الاسم أطول من ٨٠ حرفاً' };
    // يُنتحل به المالك في سجل العمليات، وترفض القواعد سطور من يحمله (مراجعة التثبيت #54)
    if (name === OWNER_ACTOR) return { ok: false, field: 'name', error: t('members.ownerNameReserved') };
    if (reservedName(name)) return { ok: false, field: 'name', error: t('members.roleNameReserved') };
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

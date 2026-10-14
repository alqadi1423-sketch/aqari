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
/**
 * المحجوز كلمةً كاملة لا جزءاً من كلمة (المتحقق المستقل، الجولة ٣١: «عبد المالك» و«Downer» كانا يُرفضان) · والفاصلان «·» و«:» في
 * أي موضع · وحدّ الكلمة حرفٌ ليس عربياً ولا لاتينياً · ومنه نمط القواعد (rulesGen.ts profileComplete) ونمط الجهاز
 */
const LETTERS = String.fromCharCode(0x0621) + '-' + String.fromCharCode(0x064a) + 'a-z';
const WORDS = 'المالك|مالك المنشأة|owner|supervis[a-z]*'; // i18n-exempt: نصٌّ محجوز تطابقه القواعد
export const RESERVED_CORE = '.*[·:].*|(.*[^' + LETTERS + '])?(' + WORDS + ')([^' + LETTERS + '].*)?';
export const RESERVED_NAME_RE = new RegExp('^(?:' + RESERVED_CORE + ')$', 's');
/**
 * طيّ الحروف الشبيهة قبل فحص المحجوز (المتحقق المستقل، الجولة ٢٩): الكافان الفارسية والمزخرفة كافٌ، وألف الوصل ألف، والأرقام
 * الشبيهة باللاتينية حروفها (والمتحقق المستقل، الجولة ٣٠: 1 وl تشبهان i، وvv تشبه w) · و«عبد المالك» كلمةٌ واحدة فلا يُعدّ «المالك» فيه
 * محجوزاً (الجولة ٣١) · ويطابقها طيّ القواعد (rulesGen.ts profileComplete)
 */
export const FOLD_PAIRS: Array<[string, string]> = [['\u0639\u0628\u062f +\u0627\u0644\u0645\u0627\u0644\u0643', '\u0639\u0628\u062f\u0627\u0644\u0645\u0627\u0644\u0643'], ['[\u06A9\u06AA]', '\u0643'], ['[\u0671]', '\u0627'], ['[0]', 'o'], ['[5]', 's'], ['[1l|]', 'i'], ['[3]', 'e'], ['vv', 'w']]; // i18n-exempt: حروفٌ تُطوى لا نصٌّ يظهر
export const foldName = (name: string): string => FOLD_PAIRS.reduce((s, [re, to]) => s.replace(new RegExp(re, 'g'), to), name.toLowerCase());
export const reservedName = (name: string): boolean => RESERVED_NAME_RE.test(foldName(name)) || !NAME_CHARS_RE.test(name);
/** حروف الاسم المقبولة · تطابق profileComplete في القواعد (المتحقق المستقل، الجولة ٢٨: التطويل والتشكيل والحرف الشبيه) */
const NAME_RANGES: Array<[number, number]> = [[0x0621, 0x063a], [0x0641, 0x064a], [0x0660, 0x0669], [0x0671, 0x06d3]];
/** صنف حروف الاسم · منه صنف الجهاز وصنف القواعد (rulesGen.ts profileComplete) */
export const NAME_CLASS = '[' + NAME_RANGES.map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + "a-zA-Z0-9 .'-]";
export const NAME_CHARS_RE = new RegExp('^' + NAME_CLASS + '+$');
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

/**
 * بيانات العضو كما تُكتب في سجل العمليات المزامَن (يقرؤه كل من له قسم السجل): الاسم والمسمى، والهوية والجوال بحالهما لا بقيمتهما
 * (المراجعة الخارجية ٧ · النتيجة ٢٩ (ج): الجوال كان يُكتب صريحاً) · newer: للنسخة السابقة ما بعدها، فما تغيّر فيها «قديم»
 */
export function profileForAudit(p: MemberProfile | null, newer: MemberProfile | null): Record<string, string> | null {
  if (!p) return null;
  const state = (v: string, o: string | undefined, fresh: string, old: string) => (!v ? '' : o && o !== v ? old : fresh);
  return {
    الاسم: p.name, 'المسمى الوظيفي': p.title, // i18n-exempt: مفتاحٌ مخزَّن في سجل العمليات
    الجوال: state(p.phone, newer?.phone, 'مُدخل', 'قديم'), // i18n-exempt: قيمة مخزّنة في سجل العمليات
    الهوية: state(p.nid, newer?.nid, 'مُدخلة', 'قديمة'), // i18n-exempt: قيمة مخزّنة في سجل العمليات
  };
}

/** ينقص الملفَ ما يلزم · فتظهر للعضو شاشة الإكمال بعد قبوله الدعوة */
export function profileIncomplete(p: Partial<MemberProfile> | null | undefined): boolean {
  if (!p) return true;
  const r = validateProfile(p, true);
  return !r.ok;
}

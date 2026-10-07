/**
 * اللغة على الجهاز: حالها في ملفٍ صغير خارج قاعدة البيانات (يسبق الدخول)، ولغة الجهاز من النظام،
 * والاتجاه الأصلي لأندرويد للفتح التالي · والاختيار يتبع المستخدم على أجهزته ويُزامَن مع حسابه
 * (قرار المالك ٢٠٢٦-١٠-٠٧ · i18n/sync.ts).
 */
import { I18nManager } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { initI18n, isRtlLang, parseLangPref, resolveLang, type Lang, type LangPref } from './index';
import { EMPTY_LANG_STATE, reconcileLang, type CloudLang, type LangState } from './sync';

const PREF_FILE = 'lang-pref.txt';
const prefFile = () => new File(Paths.document, PREF_FILE);

const LEGACY_AT = '1970-01-01T00:00:00.000Z';

/** الحال المحفوظة · والملف القديم (اختيارٌ نصّي وحده) يُقرأ اختياراً بلا صاحب */
export function readLangState(): LangState {
  try {
    const f = prefFile();
    if (!f.exists) return { ...EMPTY_LANG_STATE };
    const raw = f.textSync().trim();
    if (!raw.startsWith('{')) {
      // اختيارٌ صريح قبل المزامنة يُرفع للحساب بأقدم وقت، فاختيارٌ في الحساب من جهاز آخر يغلبه
      const pref = parseLangPref(raw);
      return pref === 'device' ? { ...EMPTY_LANG_STATE } : { pref, at: LEGACY_AT, uid: null, pending: true };
    }
    const j = JSON.parse(raw) as Partial<LangState>;
    return { pref: parseLangPref(j.pref), at: j.at ?? null, uid: j.uid ?? null, pending: !!j.pending };
  } catch { return { ...EMPTY_LANG_STATE }; }
}

export function writeLangState(s: LangState): void {
  const f = prefFile();
  if (!f.exists) f.create();
  f.write(JSON.stringify(s));
}

export const readLangPref = (): LangPref => readLangState().pref;

/** لغة النظام (ar-SA، en-US…) */
export function deviceLocale(): string {
  try {
    const c = (I18nManager as unknown as { getConstants?: () => { localeIdentifier?: string } }).getConstants?.();
    if (c?.localeIdentifier) return c.localeIdentifier;
  } catch { /* لا شيء */ }
  try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return 'ar'; }
}

/**
 * الاتجاه الأصلي للغة · يسري كاملاً في الفتح التالي (أندرويد يقرؤه عند إنشاء الواجهة) ·
 * ويعيد true إن اختلف عمّا تعمل به الواجهة الآن
 */
export function applyNativeDirection(lang: Lang): boolean {
  const rtl = isRtlLang(lang);
  try {
    I18nManager.allowRTL(rtl);
    I18nManager.forceRTL(rtl);
  } catch { /* على الويب لا يلزم */ }
  return I18nManager.isRTL !== rtl;
}

/** الإقلاع: الاختيار المحفوظ ← اللغة ← الترجمة والاتجاه */
export function bootLanguage(): Lang {
  const lang = resolveLang(readLangPref(), deviceLocale());
  initI18n(lang);
  applyNativeDirection(lang);
  return lang;
}

/** تطبيق اختيارٍ على الجهاز · النصوص فوراً، ويعيد هل يلزم فتحٌ جديد لاكتمال الاتجاه */
function applyPref(p: LangPref): { lang: Lang; reopen: boolean } {
  const lang = resolveLang(p, deviceLocale());
  initI18n(lang);
  return { lang, reopen: applyNativeDirection(lang) };
}

/** تغيير اللغة من الإعدادات · يُحفظ بوقته وينتظر الرفع إلى حساب المستخدم */
export function changeLanguage(p: LangPref): { lang: Lang; reopen: boolean } {
  const s = readLangState();
  writeLangState({ pref: p, at: new Date().toISOString(), uid: s.uid, pending: true });
  return applyPref(p);
}

/**
 * مع كل دورة مزامنة: اختيار المستخدم في حسابه والجهاز · الأحدث يغلب، ويُرفع ما ينتظر ·
 * يعيد اللغة إن تغيّرت على هذا الجهاز (لتُرسم الشاشات بها)
 */
export async function syncLanguageWithAccount(uid: string, io: {
  get: () => Promise<CloudLang | null>;
  put: (c: CloudLang) => Promise<void>;
}): Promise<Lang | null> {
  const local = readLangState();
  const cloud = await io.get();
  const r = reconcileLang(local, cloud, uid);
  if (r.push && r.state.at) {
    await io.put({ pref: r.state.pref, at: r.state.at });
    r.state = { ...r.state, pending: false };
  }
  writeLangState(r.state);
  if (r.use !== local.pref) return applyPref(r.use).lang;
  return null;
}

/**
 * اللغة على الجهاز: اختيار المستخدم في ملفٍ صغير خارج قاعدة البيانات (يسبق الدخول ولا يتبع الحساب
 * ولا يُزامَن)، ولغة الجهاز من النظام، والاتجاه الأصلي لأندرويد للفتح التالي.
 */
import { I18nManager } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { initI18n, isRtlLang, parseLangPref, resolveLang, type Lang, type LangPref } from './index';

const PREF_FILE = 'lang-pref.txt';
const prefFile = () => new File(Paths.document, PREF_FILE);

export function readLangPref(): LangPref {
  try {
    const f = prefFile();
    return f.exists ? parseLangPref(f.textSync().trim()) : 'device';
  } catch { return 'device'; }
}

export function writeLangPref(p: LangPref): void {
  const f = prefFile();
  if (!f.exists) f.create();
  f.write(p);
}

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

/** تغيير اللغة من الإعدادات · النصوص فوراً، ويعيد هل يلزم فتحٌ جديد لاكتمال الاتجاه */
export function changeLanguage(p: LangPref): { lang: Lang; reopen: boolean } {
  writeLangPref(p);
  const lang = resolveLang(p, deviceLocale());
  initI18n(lang);
  return { lang, reopen: applyNativeDirection(lang) };
}

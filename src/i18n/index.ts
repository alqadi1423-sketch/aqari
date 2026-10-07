/**
 * طبقة الترجمة (قرار المالك ٢٠٢٦-١٠-٠٧ · المرحلة الأولى): i18next بملفّي ترجمة ar وen بمفاتيح موحّدة.
 *  - اللغة إعدادٌ لكل جهاز لا يُزامَن: لغة الجهاز (الافتراضي) أو العربية أو الإنجليزية.
 *  - إضافة لغة ثالثة: ملف ترجمتها وسطرها في LANGUAGES، بلا مسّ للشاشات.
 *  - كل شاشة أو رسالة جديدة تُكتب بمفاتيح الترجمة باللغتين (اختبار i18nLiterals يمنع غيره).
 */
import 'intl-pluralrules';
import React from 'react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './locales/ar.json';
import en from './locales/en.json';

export type Lang = 'ar' | 'en';
export type LangPref = 'device' | Lang;

/**
 * complete: ترجمة الواجهة كاملة · «لغة الجهاز» لا تختار إلا لغةً كاملة، فلا تنقلب الواجهة يساراً
 * ونصوصها عربية بعدُ على جهازٍ لغته الإنجليزية (حتى تكتمل مرحلة نقل النصوص) · والاختيار الصريح متاح دائماً
 */
export const LANGUAGES: ReadonlyArray<{ code: Lang; rtl: boolean; complete: boolean; resources: Record<string, unknown> }> = [
  { code: 'ar', rtl: true, complete: true, resources: ar },
  { code: 'en', rtl: false, complete: false, resources: en },
];
export const DEFAULT_LANG: Lang = 'ar';

export const isRtlLang = (l: Lang): boolean => LANGUAGES.find((x) => x.code === l)?.rtl ?? true;

/** لغة الواجهة من الاختيار ولغة الجهاز · لغة جهاز غير مدعومة تعطي العربية */
export function resolveLang(pref: LangPref | null | undefined, deviceLocale: string | null | undefined): Lang {
  if (pref && pref !== 'device' && LANGUAGES.some((x) => x.code === pref)) return pref;
  const base = String(deviceLocale ?? '').toLowerCase().split(/[-_]/)[0];
  return (LANGUAGES.find((x) => x.code === base && x.complete)?.code) ?? DEFAULT_LANG;
}

export const parseLangPref = (v: string | null | undefined): LangPref =>
  v === 'ar' || v === 'en' ? v : 'device';

let ready = false;
/** تهيئة متزامنة بلغة معلومة · تُستدعى مرة عند الإقلاع وفي الاختبارات */
export function initI18n(lang: Lang = DEFAULT_LANG): typeof i18next {
  if (!ready) {
    ready = true;
    i18next.use(initReactI18next).init({
      resources: Object.fromEntries(LANGUAGES.map((x) => [x.code, { translation: x.resources }])),
      lng: lang,
      fallbackLng: DEFAULT_LANG,
      interpolation: { escapeValue: false },
      returnNull: false,
      initAsync: false,
    });
  } else if (i18next.language !== lang) {
    i18next.changeLanguage(lang);
  }
  return i18next;
}

export const currentLang = (): Lang => (i18next.language as Lang) || DEFAULT_LANG;

/** النص بمفتاحه خارج المكوّنات (الرسائل والأخطاء) */
export function t(key: string, opts?: Record<string, unknown>): string {
  if (!ready) initI18n();
  return i18next.t(key, opts) as string;
}

export interface LangCtx { lang: Lang; rtl: boolean; t: (key: string, opts?: Record<string, unknown>) => string }
const ctxOf = (lang: Lang): LangCtx => ({ lang, rtl: isRtlLang(lang), t: (k, o) => t(k, { ...(o ?? {}), lng: lang }) });
const Ctx = React.createContext<LangCtx>(ctxOf(DEFAULT_LANG));

/**
 * مزوّد اللغة في جذر التطبيق · مستمعٌ واحد لتغيير اللغة لا مستمعٌ لكل نص (مكوّن النص يُرسم آلاف المرات)
 */
export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = React.useState<Lang>(() => (ready ? currentLang() : DEFAULT_LANG));
  React.useEffect(() => {
    const on = (l: string) => setLang((l as Lang) || DEFAULT_LANG);
    i18next.on('languageChanged', on);
    if (ready) setLang(currentLang());
    return () => { i18next.off('languageChanged', on); };
  }, []);
  const value = React.useMemo(() => ctxOf(lang), [lang]);
  return React.createElement(Ctx.Provider, { value }, children);
}

/** اللغة واتجاهها والمترجم داخل المكوّنات · يعاد الرسم عند تغيير اللغة */
export const useLang = (): LangCtx => React.useContext(Ctx);

/** اسم اللغة بلغتها (العربية · English) */
export const langName = (l: Lang): string => t('names.' + l);

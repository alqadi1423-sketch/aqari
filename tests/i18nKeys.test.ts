/**
 * ملفا الترجمة (المرحلة الأولى من تعدد اللغات): كل مفتاح في اللغتين بنصٍّ غير فارغ، ومتغيراته نفسها،
 * وصيغ الجمع كاملة لكل لغة · واختيار اللغة من الجهاز والإعداد.
 */
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { LANGUAGES, resolveLang, parseLangPref, initI18n, t, isRtlLang } from '@/i18n';

type Tree = { [k: string]: string | Tree };
function flat(o: Tree, pre = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(o)) {
    const key = pre ? pre + '.' + k : k;
    if (typeof v === 'string') out.set(key, v);
    else for (const [k2, v2] of flat(v, key)) out.set(k2, v2);
  }
  return out;
}
const PLURAL = /_(zero|one|two|few|many|other)$/;
const base = (k: string) => k.replace(PLURAL, '');
const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

const files: Record<string, Map<string, string>> = { ar: flat(ar as Tree), en: flat(en as Tree) };

test('كل لغةٍ في القائمة لها ملف ترجمة · والعربية الأصل', () => {
  expect(LANGUAGES.map((l) => l.code).sort()).toEqual(Object.keys(files).sort());
  expect(LANGUAGES[0].code).toBe('ar');
});

test('كل مفتاح في اللغتين · بلا نصٍّ فارغ', () => {
  const keys = (m: Map<string, string>) => new Set([...m.keys()].map(base));
  const a = keys(files.ar);
  const e = keys(files.en);
  expect([...a].filter((k) => !e.has(k))).toEqual([]);
  expect([...e].filter((k) => !a.has(k))).toEqual([]);
  for (const [lang, m] of Object.entries(files)) {
    expect([...m].filter(([, v]) => !v.trim()).map(([k]) => lang + ':' + k)).toEqual([]);
  }
});

test('متغيرات كل نص واحدة في اللغتين', () => {
  const bad: string[] = [];
  const merged = (m: Map<string, string>) => {
    const out = new Map<string, Set<string>>();
    for (const [k, v] of m) {
      const s = out.get(base(k)) ?? new Set<string>();
      vars(v).forEach((x) => s.add(x));
      out.set(base(k), s);
    }
    return out;
  };
  const a = merged(files.ar);
  const e = merged(files.en);
  for (const [k, s] of a) {
    const o = e.get(k);
    if (o && [...s].sort().join() !== [...o].sort().join()) bad.push(k);
  }
  expect(bad).toEqual([]);
});

test('صيغ الجمع كاملة: العربية بستٍّ والإنجليزية باثنتين', () => {
  const need: Record<string, string[]> = { ar: ['zero', 'one', 'two', 'few', 'many', 'other'], en: ['one', 'other'] };
  for (const [lang, m] of Object.entries(files)) {
    const groups = new Map<string, Set<string>>();
    for (const k of m.keys()) {
      const mm = k.match(PLURAL);
      if (!mm) continue;
      const g = groups.get(base(k)) ?? new Set<string>();
      g.add(mm[1]);
      groups.set(base(k), g);
    }
    for (const [k, g] of groups) expect({ k, lang, missing: need[lang].filter((x) => !g.has(x)) }).toEqual({ k, lang, missing: [] });
  }
});

test('اللغة: الاختيار يغلب لغة الجهاز · ولغة جهاز غير مدعومة تعطي العربية', () => {
  expect(resolveLang('en', 'ar-SA')).toBe('en');
  expect(resolveLang('ar', 'en-US')).toBe('ar');
  expect(resolveLang('device', 'en_GB')).toBe('en');
  expect(resolveLang('device', 'ar-SA')).toBe('ar');
  expect(resolveLang('device', 'fr-FR')).toBe('ar');
  expect(resolveLang(null, '')).toBe('ar');
  expect(parseLangPref('en')).toBe('en');
  expect(parseLangPref('xx')).toBe('device');
  expect(isRtlLang('ar')).toBe(true);
  expect(isRtlLang('en')).toBe(false);
});

test('النص يتبع اللغة · ومتغيراته تُملأ', () => {
  initI18n('en');
  expect(t('language.title')).toBe('Language');
  expect(t('language.changed', { name: 'English' })).toBe('Language changed to English');
  initI18n('ar');
  expect(t('language.title')).toBe('اللغة');
  expect(t('names.en')).toBe('English');
});

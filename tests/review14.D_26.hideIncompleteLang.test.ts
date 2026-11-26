/**
 * المراجعة الشاملة 2026-11-13 · D-26 · منخفض · خيار English متاح وواجهته أغلبها عربية بمحاذاة يمين ثابتة.
 * قرار المالك (س٢٦ · «موافق على التوصيات»): يُخفى خيار «English» من الإعدادات حتى تكتمل الترجمة · و2026-08-20:
 * «إمّا أن يعمل أو يُخفى حتى يعمل».
 * الصحيح: الإعدادات لا تعرض إلا لغةً مكتملة · ومن اختار الإنجليزية قبل هذا يبقى له طريق العودة إلى العربية.
 */
import fs from 'fs';
import path from 'path';
import { pickableLangs, LANGUAGES } from '../src/i18n';

test('D-26 اللغات المعروضة للاختيار: المكتملة وحدها', () => {
  expect(LANGUAGES.find((l) => l.code === 'en')?.complete).toBe(false);
  expect(pickableLangs('device')).toEqual(['ar']);
  expect(pickableLangs('ar')).toEqual(['ar']);
});

test('D-26 من اختار الإنجليزية من قبل يرى العربية ليعود', () => {
  expect(pickableLangs('en')).toEqual(['ar', 'en']);
});

test('D-26 الإعدادات تبني الخيارات من اللغات المعروضة، وتُخفي الصف إن لم يبقَ إلا لغة واحدة', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'settings.tsx'), 'utf8');
  expect(src).not.toMatch(/\[\[0, 'device'\], \[1, 'ar'\], \[2, 'en'\]\]/);
  expect(src).toMatch(/pickableLangs\(langPref\)/);
  expect(src).toMatch(/LANG_OPTS\.length > 1 \?/);
});

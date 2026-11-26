/**
 * المراجعة الشاملة 2026-11-13 · E-11 · منخفض · تقارير PDF بلا «صفحة X من Y».
 * قرار المالك 2026-08-20: «ورقم الصفحة من الإجمالي إلزامي».
 * السيناريو: القوائم المالية والإقرار وتقارير الوحدات والعقارات والموردين تُطبع عبر printHtmlDoc وblocksToHtml، وطولها
 * غير معلوم قبل الطباعة، فلا ترقيم فيها.
 * الصحيح: صندوق هامش الصفحة (@page @bottom-center) يعدّه المتصفح نفسه: «صفحة counter(page) من counter(pages)» ·
 * ولا يُضاف للمستندات المرقّمة يدوياً (العقد والكشف) فلا يتكرر الرقم.
 */
import fs from 'fs';
import path from 'path';
import { initI18n } from '../src/i18n';
import { reportPageCss } from '../src/domain/printDocs';

beforeAll(() => { initI18n('ar'); });

test('E-11 صندوق هامش الصفحة: «صفحة X من Y» بعدّاد المتصفح', () => {
  const css = reportPageCss();
  expect(css).toMatch(/@page\s*\{\s*@bottom-center\s*\{/);
  expect(css).toMatch(/content:"صفحة " counter\(page\) " من " counter\(pages\)/);
});

test('E-11 التقارير تُطبع به، والمستندات المرقّمة يدوياً بلا تكرار', () => {
  const print = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'services', 'print.ts'), 'utf8');
  const fn = print.slice(print.indexOf('export async function printHtmlDoc('));
  expect(fn.slice(0, fn.indexOf('\n}\n'))).toMatch(/reportPageCss\(\)/);
  expect((print.match(/reportPageCss\(\)/g) ?? []).length).toBe(1);
});

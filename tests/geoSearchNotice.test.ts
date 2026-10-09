/**
 * مراجعة التثبيت #46 · قرار المالك 2026-10-07: «البحث عن موقع العقار: أ. تنبيه تحت الخانة، وذكره في سياسة الخصوصية.»
 * كل موضعٍ يرسل نص العنوان إلى خدمة الخرائط خارج التطبيق يعرض التنبيه تحت خانته، والتنبيه في ملفي الترجمة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';

const ROOT = path.join(__dirname, '..');
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

test('#46 البحث بالعنوان في خدمة الخرائط يعرض تنبيهه تحت الخانة', () => {
  const users = [...files(path.join(ROOT, 'app')), ...files(path.join(ROOT, 'src'))]
    .filter((f) => fs.readFileSync(f, 'utf8').includes('nominatim.openstreetmap.org'));
  expect(users.length).toBeGreaterThan(0);
  for (const f of users) expect([path.relative(ROOT, f), fs.readFileSync(f, 'utf8').includes("t('props.geoSearchNote')")]).toEqual([path.relative(ROOT, f), true]);
  expect((ar as { props?: { geoSearchNote?: string } }).props?.geoSearchNote).toBeTruthy();
  expect((en as { props?: { geoSearchNote?: string } }).props?.geoSearchNote).toBeTruthy();
});

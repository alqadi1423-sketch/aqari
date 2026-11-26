/**
 * المراجعة الشاملة 2026-11-13 · E-20 · منخفض · خط المطبوعات ليس خط الهوية.
 * السيناريو: PRINT_CSS يطلب «IBM Plex Sans Arabic» بلا @font-face، وWebView الطباعة لا يرى خطوط التطبيق المحمّلة بـexpo-font،
 * فتُطبع العقود والسندات والفواتير بخط النظام.
 * الصحيح: @font-face بالوزنين ٤٠٠ و٧٠٠ مضمَّنين Base64 من ملفات الخط نفسها (assets/fonts · ق٠-٢) في كل PDF.
 */
import fs from 'fs';
import path from 'path';
import { printFontFaceCss, PRINT_CSS } from '@/domain/printDocs';

const ROOT = path.resolve(__dirname, '..');

test('E-20 @font-face بالوزنين مضمَّنين، والعائلة نفسها التي يطلبها PRINT_CSS', () => {
  const css = printFontFaceCss({ regular: 'UkVH', bold: 'Qk9MRA==' });
  expect(css).toMatch(/@font-face\{font-family:'IBM Plex Sans Arabic';[^}]*font-weight:400;[^}]*src:url\(data:font\/ttf;base64,UkVH\) format\('truetype'\)\}/);
  expect(css).toMatch(/@font-face\{font-family:'IBM Plex Sans Arabic';[^}]*font-weight:700;[^}]*base64,Qk9MRA==/);
  expect(PRINT_CSS).toMatch(/font-family:'IBM Plex Sans Arabic'/);
  // تعذّر قراءة الملف لا يكتب وجهاً فارغاً
  expect(printFontFaceCss({ regular: null, bold: null })).toBe('');
});

test('E-20 كل PDF يُبنى بخط الهوية من assets/fonts', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'print.ts'), 'utf8');
  const render = src.slice(src.indexOf('async function renderPdf('));
  expect(render.slice(0, render.indexOf('\n}\n'))).toMatch(/await printFontCss\(\)/);
  for (const f of ['IBMPlexSansArabic_400Regular.ttf', 'IBMPlexSansArabic_700Bold.ttf']) {
    expect(src).toContain(`require('../../assets/fonts/${f}')`);
    expect(fs.existsSync(path.join(ROOT, 'assets', 'fonts', f))).toBe(true);
  }
});

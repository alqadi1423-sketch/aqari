/**
 * المراجعة الشاملة 2026-11-13 · D-18 · منخفض · الوصول.
 * السيناريو: قارئ الشاشة على ✕ النافذة السفلية وقلم التاريخ لا يسمع اسماً · النص الرمادي #77808F تباينه 3.62:1 على الورقي،
 * ونص «اختر» و«اختر التاريخ» #B9BFC9 تباينه 1.77:1 · والأزرار الصغيرة ٣٠ والرقائق ٣٤ بلا توسعة لمس.
 * الصحيح: تسميات للأزرار، ورماديٌّ لا يقل تباينه عن 4.5:1، ومنطقة لمسٍ غير مرئية تكمل ٤٤ (س٢٧ · «نُبقي الشكل ونوسّع اللمس»).
 */
import fs from 'fs';
import path from 'path';
import { C } from '../src/ui/theme';

const ROOT = path.resolve(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test('D-18 الرمادي ونص الاختيار الفارغ بتباينٍ لا يقل عن 4.5:1', () => {
  for (const bg of [C.paper, C.card, '#FAFAF7']) expect(contrast(C.muted, bg)).toBeGreaterThanOrEqual(4.5);
  const ph = (C as Record<string, string>).placeholder;
  expect(ph).toBeDefined();
  for (const bg of [C.card, '#FAFAF7']) expect(contrast(ph, bg)).toBeGreaterThanOrEqual(4.5);
});

test('D-18 لا لون الاختيار الفارغ القديم في الواجهة', () => {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name) && /#B9BFC9|#77808F/i.test(read(rel))) hits.push(rel);
    }
  };
  walk('app'); walk(path.join('src', 'ui'));
  expect(hits).toEqual([]);
});

test('D-18 ✕ النافذة وقلم التاريخ بتسميةٍ ودورٍ لقارئ الشاشة', () => {
  const sheet = read('src', 'ui', 'Sheet.tsx');
  const close = sheet.slice(sheet.indexOf('<Pressable onPress={requestClose} style={st.close}'), sheet.indexOf('<Icon name="x"'));
  expect(close).toMatch(/accessibilityRole="button"/);
  expect(close).toMatch(/accessibilityLabel=\{t\('common\.close'\)\}/);
  const date = read('src', 'ui', 'DateField.tsx');
  const pen = date.slice(date.indexOf('setManual((m) => !m)'), date.indexOf("<Icon name={manual ? 'calendar' : 'edit'}"));
  expect(pen).toMatch(/accessibilityRole="button"/);
  expect(pen).toMatch(/accessibilityLabel=/);
});

test('D-18 الأزرار والرقائق: الشكل كما هو ومنطقة اللمس ٤٤', () => {
  // ts-jest لا يحمّل react-native · المقاييس تُقرأ نصاً من components.tsx
  const src = read('src', 'ui', 'components.tsx');
  const num = (re: RegExp) => { const m = re.exec(src); expect(m).not.toBeNull(); return Number(m![1]); };
  const smallH = num(/small: \{ minHeight: (\d+)/);
  const smallSlop = num(/small: \{[^}]*hitSlop: (\d+)/);
  expect(smallH).toBe(30);
  expect(smallH + 2 * smallSlop).toBeGreaterThanOrEqual(44);
  const normalH = num(/normal: \{ minHeight: (\d+)/);
  const normalSlop = num(/normal: \{[^}]*hitSlop: (\d+)/);
  expect(normalH + 2 * normalSlop).toBeGreaterThanOrEqual(44);
  const chipH = num(/CHIP_SIZES = \{ minHeight: (\d+)/);
  const chipSlop = num(/CHIP_SIZES = \{[^}]*hitSlop: (\d+)/);
  expect(chipH).toBe(34);
  expect(chipH + 2 * chipSlop).toBeGreaterThanOrEqual(44);
  // كل زرٍّ ورقيقة يطبّقها
  const pressables = (name: string) => src.slice(src.indexOf(`export function ${name}(`), src.indexOf('</Pressable>', src.indexOf(`export function ${name}(`)));
  for (const b of ['BtnPrimary', 'BtnGhost', 'Chip']) {
    expect(pressables(b)).toMatch(/hitSlop=/);
    expect(pressables(b)).toMatch(/accessibilityRole="button"/);
  }
});

/**
 * مكتبة الخريطة مضمّنة في التطبيق (القرار ٧) · لا سكربت ولا ورقة أنماط من الشبكة في صفحة الخريطة،
 * والشبكة لصور الخريطة وحدها.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LEAFLET_JS, LEAFLET_CSS, LEAFLET_VERSION } from '@/ui/leafletBundle';

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'LeafletMap.tsx'), 'utf8');

test('صفحة الخريطة لا تحمّل شيفرة من الشبكة', () => {
  expect(src).not.toMatch(/<script[^>]+src=/i);
  expect(src).not.toMatch(/<link[^>]+href=/i);
  expect(src).not.toMatch(/unpkg|cdnjs|jsdelivr/i);
  // الرابط الوحيد: صور الخريطة
  expect([...src.matchAll(/https:\/\/[^'"`\s]+/g)].map((m) => m[0])).toEqual(['https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png']);
});

test('المكتبة المضمّنة كاملة ولا تُنهي وسمها قبل أوانه', () => {
  expect(LEAFLET_VERSION).toBe('1.9.4');
  expect(LEAFLET_JS).toContain('Leaflet 1.9.4');
  expect(LEAFLET_JS.length).toBeGreaterThan(100_000);
  expect(LEAFLET_CSS).toContain('.leaflet-container');
  expect(LEAFLET_JS).not.toMatch(/<\/script/i);
  expect(LEAFLET_CSS).not.toMatch(/<\/style/i);
});

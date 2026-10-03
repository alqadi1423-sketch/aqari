/**
 * يولّد src/ui/leafletBundle.ts من حزمة leaflet المثبّتة · فتُحمَّل المكتبة من التطبيق لا من الشبكة.
 * يُعاد تشغيله عند ترقية leaflet فقط:  node scripts/gen-leaflet.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules', 'leaflet');
const dist = path.join(root, 'dist');
const version = require(path.join(root, 'package.json')).version;
// لا ينتهي الوسم المضمَّن قبل أوانه
const safe = (s) => s.replace(/<\/(script|style)/gi, '<\\/$1');
const js = safe(fs.readFileSync(path.join(dist, 'leaflet.js'), 'utf8'));
const css = safe(fs.readFileSync(path.join(dist, 'leaflet.css'), 'utf8'));
// الرخصة كاملة كما تشترط BSD-2-Clause عند إعادة التوزيع
const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').trim()
  .split(/\r?\n/).map((l) => (' * ' + l).trimEnd()).join('\n');

const out = `/* eslint-disable */
// مولَّد من node_modules/leaflet ${version} بـ scripts/gen-leaflet.js · لا يُعدَّل يدوياً.
/*
 * Leaflet ${version}
 *
${license}
 */
export const LEAFLET_LICENSE = 'BSD-2-Clause · © 2010-2023 Volodymyr Agafonkin · © 2010-2011 CloudMade';
export const LEAFLET_VERSION = ${JSON.stringify(version)};
export const LEAFLET_JS = ${JSON.stringify(js)};
export const LEAFLET_CSS = ${JSON.stringify(css)};
`;
fs.writeFileSync(path.join(__dirname, '..', 'src', 'ui', 'leafletBundle.ts'), out);
console.log('leaflet ' + version + ' · ' + out.length + ' bytes');

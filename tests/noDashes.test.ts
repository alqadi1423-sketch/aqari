/**
 * حارس المحارف: لا شرطة في نصّ يظهر للمستخدم · النقطة الوسطى · هي الفاصل.
 * الشرطة تكسر اتجاه السطر، وقد لا يحويها الخط، ولا يكتبها العربي فلا يبحث بها.
 *
 * ما تغيّر بعد نفاذ شرطة من الحارس القديم:
 * ١) المحارف: كانت أربعة، وصارت كل شرطات يونيكود ومنها الشرطة اللاتينية العادية
 *    ورسم الجداول (─) والشرطة العربية المتوافقة (﹘ ﹣ －).
 * ٢) المسارات: كانت مجلدين بامتدادين، وصارت كل ملف في src/ و app/ بأربعة امتدادات،
 *    فيدخل فيها التصدير (src/services) والمطبوعات (src/domain/printDocs.ts)
 *    وملفات البيانات (src/db/seed.ts).
 * ٣) المدى: كان يفحص الملف كله فيسقط على التعليقات، وصار يفحص السلاسل النصية وحدها،
 *    ويشترط أن تكون الشرطة ملاصقة لحرف عربي · فلا يسقط على `font-size` ولا على
 *    `class="doc-no"` ولا على طرح حسابي داخل قالب نصّي.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** كل شرطات يونيكود ورسوم الخطوط الأفقية */
const DASHES = [
  '-', '֊', '־', '᐀', '᠆',
  '‐', '‑', '‒', '–', '—', '―',
  '⁃', '−', '─', '━', '⸺', '⸻',
  '︱', '︲', '﹘', '﹣', '－',
];
const DASH_CLASS = '[' + DASHES.join('') + ']';
const AR = '[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]';
/** شرطة ملاصقة لحرف عربي من أي جهة (تتخطّى المسافات) */
const OFFENDING = new RegExp(AR + '\\s*' + DASH_CLASS + '|' + DASH_CLASS + '\\s*' + AR);
/** سلاسل نصية: مفردة ومزدوجة وقالبية */
const STRINGS = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|json)$/.test(e.name)) out.push(p);
  }
  return out;
};

/** يعيد مواضع المخالفة في ملف واحد */
export function dashOffenders(file: string): string[] {
  const out: string[] = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    // التعليقات وعناوين الاختبارات خارج القاعدة
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const s of line.match(STRINGS) ?? []) {
      if (OFFENDING.test(s)) out.push(file + ':' + (i + 1) + '  ' + s.slice(0, 90));
    }
  });
  return out;
}

test('صفر شرطة في نصّ عربي يظهر للمستخدم · src/ و app/ بكل الامتدادات', () => {
  const files = [...walk('src'), ...walk('app')];
  // الحارس بلا ملفات حارسٌ زائف
  expect(files.length).toBeGreaterThan(60);
  const offenders = files.flatMap(dashOffenders);
  expect(offenders).toEqual([]);
});

test('الحارس يمسك الشرطات كلها ولا يمسك الأرقام ولا CSS', () => {
  const bad = [
    'فاتورة ضريبية — قابلة للخصم',
    'فاتورة ضريبية – قابلة للخصم',
    'يوم-وحدة',
    'أريكة  - عدد المقاعد',
    'سند-قبض-',
    '─── المحاسبة ───',
    'نص ﹘ آخر',
    'نص － آخر',
  ];
  for (const s of bad) expect(OFFENDING.test(s)).toBe(true);

  const good = [
    'فاتورة ضريبية · قابلة للخصم',
    'يوم·وحدة',
    '<div class="doc-no">رقم: 5</div>',
    '<div style="margin-top:4px">الرقم الضريبي</div>',
    'الفرق 5 · الفارق 3',
    '2026-Q1',
    'transform:rotate(-28deg)',
  ];
  for (const s of good) expect(OFFENDING.test(s)).toBe(false);
});

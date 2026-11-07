/**
 * حارس الاختبارات: لا محاكاة «افتراضية» (`{ virtual: true }`) لوحدةٍ مثبّتة.
 * ذاكرة معرّفات الوحدات في Jest مشتركةٌ بين ملفات الاختبار في العامل نفسه، فمحاكاةٌ افتراضية لـ«react-native» في ملفٍ تجعل
 * ملفاً بعده يحمّل الوحدة الحقيقية رغم محاكاته لها (سقط بها `d4.version` في جيت هب على 2847c51 بترتيب التشغيل وحده).
 * فالافتراضية لما ليس مثبّتاً وحده.
 */
import fs from 'fs';
import path from 'path';

const DIR = __dirname;
const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : /\.test\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));

test('كل محاكاةٍ افتراضية لوحدةٍ غير مثبّتة', () => {
  const bad: string[] = [];
  for (const f of files(DIR)) {
    const src = fs.readFileSync(f, 'utf8');
    // jest.mock('<الوحدة>', ... , { virtual: true }) ولو امتدّت على أسطر
    for (const m of src.matchAll(/jest\.mock\(\s*'([^']+)'((?:(?!jest\.mock\()[\s\S])*?)\{\s*virtual:\s*true\s*\}\s*\)/g)) {
      if (m[1].startsWith('.') || m[1].startsWith('@/')) continue;
      let installed = true;
      try { require.resolve(m[1], { paths: [path.join(DIR, '..')] }); } catch { installed = false; }
      if (installed) bad.push(`${path.relative(DIR, f)}: ${m[1]}`);
    }
  }
  expect(bad).toEqual([]);
});

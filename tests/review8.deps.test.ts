/**
 * المراجعة الشاملة (الالتزام ac76adc) · البندان ٢٩ و٣٠: لا خدمة في البيان لحزمةٍ غير مثبتة، ولا اعتمادٌ لا يستعمله ملف ·
 * فحصٌ ثابت على ملفات المستودع.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('٢٩ كل خدمةٍ من حزم expo في البيان حزمتها مثبتة', () => {
  const pkg = JSON.parse(read('package.json'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const services = [...manifest.matchAll(/<service android:name="expo\.modules\.([a-z]+)\./g)].map((m) => m[1]);
  for (const mod of services) expect(Object.keys(deps)).toContain('expo-' + mod);
  expect(manifest).not.toContain('expo.modules.audio.service.AudioControlsService');
});

test('٣٠ zod ليس في الاعتمادات ولا يستورده ملف (عليها ثغرة عالية ولا يستعملها التطبيق)', () => {
  const pkg = JSON.parse(read('package.json'));
  expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain('zod');
  const walk = (d: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  for (const f of [...walk('src'), ...walk('app')]) expect(read(f)).not.toMatch(/from ['"]zod['"]|require\(['"]zod['"]\)/);
});

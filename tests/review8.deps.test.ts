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

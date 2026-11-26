/**
 * المراجعة الشاملة 2026-11-13 · G-10 · منخفض · نظافة الاعتمادات (بلا أجزاء قوقل).
 * السيناريو: date-fns بلا استيرادٍ واحد، و@expo/ngrok للنفق ولا يُستعمل، وهما في package.json والقفل · ولا تحديثٌ آلي للإجراءات.
 * الصحيح: لا اعتمادٌ لا يستعمله ملف، والقفل يطابق package.json، وdependabot أسبوعي لإجراءات جيت هب وحدها.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const UNUSED = ['date-fns', '@expo/ngrok'];

test('G-10 لا اعتماد غير مستعمل في package.json ولا في جذر القفل', () => {
  const pkg = JSON.parse(read('package.json'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const lock = JSON.parse(read('package-lock.json'));
  const root = lock.packages[''];
  const lockDeps = { ...root.dependencies, ...root.devDependencies };
  for (const d of UNUSED) {
    expect([d, d in deps]).toEqual([d, false]);
    expect([d, d in lockDeps]).toEqual([d, false]);
    expect([d, `node_modules/${d}` in lock.packages]).toEqual([d, false]);
  }
});

test('G-10 dependabot أسبوعي لإجراءات جيت هب وحدها', () => {
  const y = read('.github/dependabot.yml');
  expect(y).toMatch(/version: 2/);
  expect(y).toMatch(/package-ecosystem: "github-actions"/);
  expect(y).toMatch(/interval: "weekly"/);
  expect(y).not.toMatch(/package-ecosystem: "npm"/);
});

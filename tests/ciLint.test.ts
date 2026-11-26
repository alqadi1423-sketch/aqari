/**
 * G-3 (المراجعة الشاملة 2026-11-13) · ESLint لا يعمل أصلاً: غير مثبّت، وإعداده بالصيغة القديمة (.eslintrc.js يمتد من «expo» غير المثبّت)،
 * ولا أمر ولا خطوة في جيت هب · فخطأٌ كـG-2 (خطافٌ بعد عودةٍ مبكرة يُسقط التطبيق) مرّ بلا إنذار، وقائمة استثناء Text الخام انجرفت عن
 * tests/noRawText.test.ts لأن واحدةً منهما لا تعمل.
 *
 * السلوك الصحيح: eslint@9 وeslint-config-expo في devDependencies وفي القفل، وeslint.config.js بصيغة flat، وأمر «lint» في package.json،
 * وخطوةٌ في tests.yml تشغّله قبل الحزمة وتُسقط الدفعة بخطأ، والتحذيرات بسقفها لا تزيد.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

type Step = { name?: string; run?: string; uses?: string; 'continue-on-error'?: unknown; if?: string };

test('G-3 · خطوة «فحص الكود» في tests.yml: بعد فحص الأنواع وقبل الحزمة، وتُسقط الدفعة', () => {
  const wf = parse(read('.github/workflows/tests.yml')) as { jobs: { tests: { steps: Step[] } } };
  const steps = wf.jobs.tests.steps;
  const at = (pred: (s: Step) => boolean) => steps.findIndex(pred);
  const install = at((s) => s.run === 'npm ci');
  const types = at((s) => /tsc --noEmit/.test(s.run ?? ''));
  const lint = at((s) => s.run === 'npm run lint');
  const jest = at((s) => /jest/.test(s.run ?? ''));
  expect(install).toBeGreaterThanOrEqual(0);
  expect(lint).toBeGreaterThan(install);
  expect(lint).toBeGreaterThan(types);
  expect(lint).toBeLessThan(jest);
  // لا يُتجاوز فشلها
  expect(steps[lint]['continue-on-error']).toBeUndefined();
  expect(steps[lint].if).toBeUndefined();
});

test('G-3 · أمر lint: app وsrc، والتحذيرات بسقفٍ رقمي · وeslint وإعداد إكسبو مثبّتان بإصدارٍ في القفل', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
  expect(pkg.scripts.lint).toMatch(/^eslint app src --max-warnings=\d+$/);
  expect(pkg.devDependencies.eslint).toMatch(/^9\./);
  expect(pkg.devDependencies['eslint-config-expo']).toBeDefined();
  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string; dev?: boolean }> };
  expect(lock.packages['node_modules/eslint']?.version).toBe(pkg.devDependencies.eslint);
  expect(lock.packages['node_modules/eslint-config-expo']?.version).toBe(pkg.devDependencies['eslint-config-expo']);
  expect(lock.packages['']).toMatchObject({ devDependencies: { eslint: pkg.devDependencies.eslint } });
});

test('G-3 · الإعداد بصيغة flat وحدها: قواعد الخطافات خطأ، وقاعدة Text الخام باستثناء حارسها نفسه', () => {
  expect(fs.existsSync(path.join(ROOT, '.eslintrc.js'))).toBe(false);
  const cfg = read('eslint.config.js');
  expect(cfg).toMatch(/require\('eslint-config-expo\/flat'\)/);
  expect(cfg).toMatch(/'react-hooks\/rules-of-hooks': 'error'/);
  expect(cfg).toMatch(/importNames: \['Text'\]/);
  // القائمتان واحدة (كانتا ثمانية وتسعة)
  const list = (src: string, from: RegExp) => [...(from.exec(src)?.[1] ?? '').matchAll(/'(src\/[^']+)'/g)].map((m) => m[1]).sort();
  const lint = list(cfg, /RAW_TEXT_ALLOWED = \[([\s\S]*?)\];/);
  const guard = list(read('tests/noRawText.test.ts'), /ALLOWED = new Set\(\[([\s\S]*?)\]\)/);
  expect(lint.length).toBeGreaterThan(0);
  expect(lint).toEqual(guard);
});

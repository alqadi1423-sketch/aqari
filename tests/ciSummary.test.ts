/**
 * المراجعة الخارجية ٧ «ثالثاً» · النتيجة ٣٢ (جزؤها المغلق في ed869ab · قرار المالك ١٤ من «رابعاً»): خلاصة خط الاختبارات تفشل
 * باختبارٍ معلّق أو بلا اختبارات أو بلا ملف النتائج (كانت تكتب «success true» فيبدو الخط أخضر واختبارات المحاكي معلّقة) ·
 * وfirebase-tools من package-lock بإصداره لا من الشبكة وقت التشغيل · والباقي من النتيجة مفتوح: expo-router ≥ 58 أو حارس طول
 * الرابط العميق قبل تحليله.
 * الاختبار يشغّل نص خطوة «الخلاصة» نفسه من .github/workflows/tests.yml على نتائج مصطنعة.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');

function summaryScript(): string {
  const m = /- name: الخلاصة[\s\S]*?node -e '\r?\n([\s\S]*?)\r?\n\s*'\r?\n/.exec(workflow);
  if (!m) throw new Error('summary step not found');
  return m[1];
}

function runSummary(results: object | null): { status: number | null; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-ci-'));
  if (results) fs.writeFileSync(path.join(dir, 'jest-results.json'), JSON.stringify(results));
  const r = spawnSync(process.execPath, ['-e', summaryScript()], { cwd: dir, env: { ...process.env, GITHUB_SHA: 'test-sha' }, encoding: 'utf8' });
  const out = fs.existsSync(path.join(dir, 'result.txt')) ? fs.readFileSync(path.join(dir, 'result.txt'), 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out };
}

const clean = { success: true, numPendingTests: 0, numTotalTests: 10, numPassedTests: 10, numFailedTests: 0, numPassedTestSuites: 2, numTotalTestSuites: 2, testResults: [] };

test('٣٢ الخلاصة تفشل باختبارٍ معلّق (اختبارات المحاكي حين يغيب متغيره)', () => {
  const r = runSummary({ ...clean, numPendingTests: 3 });
  expect(r.status).toBe(1);
  expect(r.out).toContain('success false');
});

test('٣٢ الخلاصة تفشل بلا اختبارات وبلا ملف النتائج', () => {
  expect(runSummary({ ...clean, numTotalTests: 0, numPassedTests: 0 }).status).toBe(1);
  expect(runSummary(null).status).toBe(1);
});

test('٣٢ وتشغيلٌ نظيف ينجح', () => {
  const r = runSummary(clean);
  expect(r.status).toBe(0);
  expect(r.out).toContain('success true');
});

test('٣٢ firebase-tools من package-lock بإصداره · والخط لا يجلبه من الشبكة', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string }> };
  expect(lock.packages['node_modules/firebase-tools']?.version).toBe(pkg.devDependencies['firebase-tools']);
  expect(workflow).not.toMatch(/npx --yes firebase-tools@/);
  expect(workflow).toMatch(/npx firebase emulators:exec --only firestore,storage/);
});

/**
 * المراجعة ١٠ · المرحلة ٠ · حارس النشرة (G-1 · 832da4d) مع إلغاء التشغيل القديم (G-7 · 77bd204 و3dff115)
 *
 * الحارس يقرأ ci-results/runs/<المصدر>.txt: «success true» يوسم، وغيرها يُفشل، وغيابه «يُترك للتشغيل التالي» (action=skip،
 * رمز خروج 0). لكن الملف قد يغيب إلى الأبد لا «بعدُ» فقط:
 *  - تشغيل اختبارات المصدر أُلغي لأن دفعةً لحقته على الفرع نفسه (concurrency · tests.yml:17-19)، والخلاصة ونشرها صارا
 *    `!cancelled()` (3dff115) فلا يُكتب شيء · وكذلك العمل الذي تجاوز timeout-minutes (جيت هب «يلغيه آلياً»).
 *  - أو خسر عمل النشر سباق الدفع إلى ci-results: tests.yml:114 يدفع مرةً واحدة بلا إعادة، بخلاف android-e2e.yml:143 الذي
 *    يعيد ثلاثاً بعد `git pull --rebase` · وسجل ci-results نفسه فيه دفعتان بينهما أربع ثوانٍ (5f6adf6 و205646e).
 * فحزمةٌ من ذلك المصدر لا تُوسم أبداً، وسير العمل أخضر كل يوم بلا إنذار.
 *
 * السلوك الصحيح: (١) نشر الخلاصة في tests.yml يعيد الدفع بعد سحبٍ وإعادة تأسيس كما في android-e2e.yml · (٢) غياب النتيجة
 * لحزمةٍ مضى على رأس فرع apk أكثر من يوم يُفشل التشغيل برسالةٍ تطلب إعادة اختبار المصدر، لا تخطٍّ صامت.
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'apkRelease.js');

test('review10 · نشر خلاصة الاختبارات في ci-results يعيد الدفع عند التعارض (كالجوال الافتراضي)', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
  const publish = wf.slice(wf.indexOf('  publish:'));
  expect(publish).toMatch(/git pull -q --rebase origin ci-results/);
});

describe('review10 · apkRelease: نتيجةٌ غائبة لمصدرٍ قديم', () => {
  let dir = '';
  const env = (date: string) => ({ ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const git = (date: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test',
    '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8', env: env(date) }).trim();
  const old = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  let src = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r10-apk-'));
    git(old, 'init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'src', 'version.ts'), "export const APP_VERSION = '9.9.9';\nexport const APP_BUILD = 99;\n");
    fs.writeFileSync(path.join(dir, 'docs', 'سجل-التغييرات.md'), '# سجل\n\n## 9.9.9\n\n- تغييرٌ مصطنع.\n');
    git(old, 'add', '.');
    git(old, 'commit', '-q', '-m', 'source');
    src = git(old, 'rev-parse', 'HEAD');
    // فرع apk: التزامٌ يسمّي مصدره، عمره خمسة أيام
    git(old, 'checkout', '-q', '--orphan', 'apk');
    git(old, 'rm', '-q', '-rf', '.');
    fs.writeFileSync(path.join(dir, 'Aqari.apk'), 'synthetic');
    git(old, 'add', '.');
    git(old, 'commit', '-q', '-m', `حزمة arm64 من main ${src.slice(0, 7)}: مصطنعة`);
    git(old, 'update-ref', 'refs/remotes/origin/apk', 'HEAD');
    git(old, 'checkout', '-q', 'main');
  });
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const ciResults = (files: Record<string, string>) => {
    git(old, 'checkout', '-q', '--orphan', 'ci');
    git(old, 'rm', '-q', '-rf', '.');
    for (const [f, t] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), t);
    }
    git(old, 'add', '.');
    git(old, 'commit', '-q', '-m', 'ci');
    git(old, 'update-ref', 'refs/remotes/origin/ci-results', 'HEAD');
    git(old, 'checkout', '-q', '-f', 'main');
  };
  const run = () => spawnSync(process.execPath, [SCRIPT, path.join(dir, 'out.txt')], { cwd: dir, encoding: 'utf8' });

  test('ضابط: خلاصةٌ فاشلة تُفشل التشغيل', () => {
    ciResults({ [`runs/${src}.txt`]: `commit ${src}\nsuccess false\n` });
    expect(run().status).toBe(1);
  });

  test('الاختبارات والجوال الافتراضي ناجحان على شيفرة المصدر: يُوسم (P0-14)', () => {
    ciResults({ [`runs/${src}.txt`]: 'success true\n', [`e2e/${src}/summary.txt`]: 'success true\n' });
    const r = run();
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toMatch(/action=create/);
  });

  test('الاختبارات ناجحة والجوال الافتراضي فاشلٌ على شيفرة المصدر: لا وسم (P0-14)', () => {
    ciResults({ [`runs/${src}.txt`]: 'success true\n', [`e2e/${src}/summary.txt`]: 'success false\nflows 22 · failed 1\n' });
    expect(run().status).toBe(1);
  });

  test('نتيجةٌ غائبة لحزمةٍ عمرها خمسة أيام (تشغيلٌ أُلغي أو نشرٌ خسر السباق) تُفشل التشغيل، لا تخطٍّ صامت', () => {
    ciResults({ 'runs/0000000000000000000000000000000000000000.txt': 'success true\n' });
    const r = run();
    expect(r.status).not.toBe(0);
  });
});

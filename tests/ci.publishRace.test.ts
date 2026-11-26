/**
 * نشر الخلاصة في ci-results تحت السباق: التشغيل 45865769363 (الجوال الافتراضي على main) خسر الدفع لأن دفعاتٍ متقاربة سبقته،
 * وإعادة التأسيس تعارضت في e2e/latest.txt فسقط عمل النشر · الآن تُعاد كل محاولة فوق آخر ci-results.
 * الاختبار يشغّل سكربت الخطوة نفسه من ملف سير العمل على مستودعٍ محلي، وبعد أول جلبٍ يدفع «تشغيلٌ آخر» إلى الفرع نفسه.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const ROOT = path.resolve(__dirname, '..');
const stepScript = (wf: string, name: string) => {
  const src = fs.readFileSync(path.join(ROOT, '.github/workflows', wf), 'utf8');
  const i = src.indexOf(`- name: ${name}`);
  const body = src.slice(src.indexOf('run: |', i) + 'run: |'.length).split('\n');
  const out: string[] = [];
  for (const l of body.slice(1)) { if (l.trim() && !l.startsWith('          ')) break; out.push(l.slice(10)); }
  return out.join('\n');
};
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test',
  '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();

for (const [wf, step, tmp, files, expectFile] of [
  ['android-e2e.yml', 'نشر الخلاصة واللقطات في فرع ci-results', '/tmp/e2e', { 'summary.txt': 'success true\n' }, 'e2e/latest.txt'],
  ['tests.yml', 'نشر الخلاصة في فرع ci-results', '/tmp/result', { 'result.txt': 'success true\n' }, 'latest.txt'],
] as const) {
  test(`${wf}: دفعةٌ سبقت النشر وغيّرت الملف نفسه لا تُسقطه`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-ci-race-'));
    const remote = path.join(dir, 'remote.git');
    git(dir, 'init', '-q', '--bare', remote);
    const seed = path.join(dir, 'seed');
    git(dir, 'clone', '-q', remote, seed);
    git(seed, 'checkout', '-q', '-b', 'ci-results');
    fs.mkdirSync(path.join(seed, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(seed, expectFile), 'old\n');
    git(seed, 'add', '.'); git(seed, 'commit', '-q', '-m', 'seed'); git(seed, 'push', '-q', 'origin', 'ci-results');
    const ci = path.join(dir, 'ci');
    git(dir, 'clone', '-q', '-b', 'ci-results', remote, ci);
    // تشغيلٌ آخر يدفع latest بعد أن نُسخ «ci» (هو ما رفض الدفع ثم تعارض)
    fs.writeFileSync(path.join(seed, expectFile), 'other run\n');
    git(seed, 'commit', '-q', '-am', 'other'); git(seed, 'push', '-q', 'origin', 'ci-results');
    const src = path.join(dir, 'artifact');
    fs.mkdirSync(src);
    for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(src, f), t);
    const script = stepScript(wf, step).split(tmp).join(src);
    expect(script).toMatch(/git reset -q --hard origin\/ci-results/);
    const r = spawnSync('bash', ['-e', '-c', script], { cwd: ci, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: 'a'.repeat(40) } });
    expect([r.status, r.stderr]).toEqual([0, '']);
    git(seed, 'pull', '-q', 'origin', 'ci-results');
    expect(fs.readFileSync(path.join(seed, expectFile), 'utf8')).toBe('success true\n');
    expect(git(seed, 'log', '--format=%s', '-3').split('\n')[1]).toBe('other');
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

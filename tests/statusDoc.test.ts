/**
 * فحص ملف الحال (القاعدة ١٠٣ · التوجيه الرابع 2026-11-07): «فحص في جيت هب يفشل إن تغيّر كود في src/ أو app/ أو android/
 * بلا تغيير في docs/الحال.md.» · يزرع الخلل عمداً ويتأكد أن الفحص يسقط (القاعدة ٤٨)، ويُجرّب على مستودع git مؤقت حقيقي.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sd = require('../scripts/ci/statusDoc.js');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'ci', 'statusDoc.js');
const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'status-doc.yml');

const c = (over: Partial<{ sha: string; subject: string; parents: number; hasStatusFile: boolean; files: string[] }>) => ({
  sha: 'a'.repeat(40),
  subject: 'التزام',
  parents: 1,
  hasStatusFile: true,
  files: [],
  ...over,
});

describe('فحص ملف الحال · الدالة', () => {
  it('كودٌ في src/ أو app/ أو android/ بلا ملف الحال: مخالفة', () => {
    for (const f of ['src/domain/x.ts', 'app/settings.tsx', 'android/app/build.gradle']) {
      expect(sd.violations([c({ files: [f] })])).toHaveLength(1);
    }
  });

  it('كودٌ ومعه ملف الحال في الالتزام نفسه: سليم', () => {
    expect(sd.violations([c({ files: ['src/domain/x.ts', 'docs/الحال.md'] })])).toEqual([]);
  });

  it('وثائق أو اختبارات وحدها: سليم', () => {
    expect(sd.violations([c({ files: ['docs/حوكمة/الخطة.md', 'tests/a.test.ts', 'scripts/x.js'] })])).toEqual([]);
  });

  it('مسارٌ يبدأ بالاسم ولا يقع في المجلد (srcx/) ليس كوداً', () => {
    expect(sd.isCode('srcx/a.ts')).toBe(false);
    expect(sd.isCode('docs/src/a.md')).toBe(false);
    expect(sd.isCode('src/a.ts')).toBe(true);
  });

  it('التزام الدمج يُتخطّى، والتزامٌ قبل القاعدة (لا ملف حال في شجرته) يُتخطّى', () => {
    expect(sd.violations([c({ parents: 2, files: ['src/a.ts'] })])).toEqual([]);
    expect(sd.violations([c({ hasStatusFile: false, files: ['src/a.ts'] })])).toEqual([]);
  });

  it('كل التزامٍ وحده: ملف الحال في التزامٍ لاحق لا يغطي التزاماً قبله', () => {
    const bad = sd.violations([
      c({ sha: '1'.repeat(40), files: ['src/a.ts'] }),
      c({ sha: '2'.repeat(40), files: ['docs/الحال.md'] }),
    ]);
    expect(bad.map((b: { sha: string }) => b.sha)).toEqual(['1'.repeat(40)]);
  });

  it('سير العمل ينادي الفحص على المدى ويعمل عند الدفع وطلب الدمج', () => {
    const y = fs.readFileSync(WORKFLOW, 'utf8');
    expect(y).toMatch(/node scripts\/ci\/statusDoc\.js "\$BASE" "\$HEAD_SHA"/);
    expect(y).toMatch(/pull_request:/);
    expect(y).toMatch(/fetch-depth: 0/);
  });
});

describe('فحص ملف الحال · على مستودع git حقيقي', () => {
  const run = (cwd: string, args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
    });
  const write = (dir: string, rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  const check = (dir: string, base: string, head: string) => {
    try {
      execFileSync(process.execPath, [SCRIPT, base, head], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };

  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusdoc-'));
    run(dir, ['init', '-q', '-b', 'main']);
    write(dir, 'src/a.ts', '1');
    run(dir, ['add', '-A']);
    run(dir, ['commit', '-q', '-m', 'قبل القاعدة']);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('التاريخ قبل القاعدة لا يُحاسَب، والتزام الكود مع ملف الحال يمرّ', () => {
    const base = run(dir, ['rev-parse', 'HEAD']).trim();
    write(dir, 'src/a.ts', '2');
    write(dir, 'docs/الحال.md', 'الحال');
    run(dir, ['add', '-A']);
    run(dir, ['commit', '-q', '-m', 'القاعدة']);
    expect(check(dir, `${base}~0`, 'HEAD')).toBe(0);
  });

  it('التزام كودٍ بلا ملف الحال بعد القاعدة يُسقط الفحص', () => {
    write(dir, 'docs/الحال.md', 'الحال');
    run(dir, ['add', '-A']);
    run(dir, ['commit', '-q', '-m', 'القاعدة']);
    const base = run(dir, ['rev-parse', 'HEAD']).trim();
    write(dir, 'app/x.tsx', 'x');
    run(dir, ['add', '-A']);
    run(dir, ['commit', '-q', '-m', 'كود بلا حال']);
    expect(check(dir, base, 'HEAD')).toBe(1);
  });
});

// فحص الأسرار (القاعدة ٤٠): الأسرار هنا مركّبة بالجمع فلا تظهر نصاً في الملف، ويزرعها الاختبار عمداً ليسقط الفحص (القاعدة ٤٨)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ss = require('../scripts/ci/secretScan.js');

describe('فحص الأسرار في الأسطر المضافة', () => {
  const diff = (...lines: string[]) => ['+++ b/f.txt', '@@ -0,0 +1,' + lines.length + ' @@', ...lines.map((l) => '+' + l)].join('\n');
  const planted: Record<string, string> = {
    'private-key': '-----BEGIN ' + 'PRIVATE KEY-----',
    'gcp-service-account': '{"type": "service' + '_account"}',
    'google-api-key': 'AI' + 'za' + 'Sy' + 'A'.repeat(33),
    'github-token': 'gh' + 'p_' + 'a1B2'.repeat(9),
    'aws-access-key': 'AK' + 'IA' + 'ABCDEFGH12345678',
    'hardcoded-password': 'storePassword = "' + 'hunter2hunter2' + '"',
  };

  it.each(Object.entries(planted))('يسقط على %s', (rule, line) => {
    const hits = ss.scan(ss.addedLines(diff('سطر عادي', line)));
    expect(hits.map((h: { rule: string }) => h.rule)).toContain(rule);
    expect(hits[0].line).toBe(2);
  });

  it('لا يسقط على نص عادي ولا على متغيرات بيئة ولا على المحذوف', () => {
    const d = diff('const key = process.env.EXPO_PUBLIC_FIREBASE_API_KEY;', 'password: ${{ secrets.X }}', 'كلمة المرور') + '\n-AI' + 'za' + 'Sy' + 'B'.repeat(33);
    expect(ss.scan(ss.addedLines(d))).toEqual([]);
  });

  it('سير العمل يفحص الأسرار على مدى الدفع', () => {
    expect(fs.readFileSync(WORKFLOW, 'utf8')).toMatch(/node scripts\/ci\/secretScan\.js "\$BASE" "\$HEAD_SHA"/);
  });
});

/**
 * G-4 · متوسط · scripts/ci/secretScan.js:26-27 (نمط hardcoded-password) و:75 (فرق المدى مجموعاً)
 *
 * السيناريو (بيانات مصطنعة كلها):
 *  ١) كلمة مرور مفتاح التوقيع تُكتب في android/app/build.gradle بصيغة Groovy المعتادة: storePassword 'Synthetic-Pass-2026'
 *     (بلا «=» ولا «:») ← النمط يشترط [:=] فلا يلتقطها. والملف نفسه يكتب مفتاح التصحيح بهذه الصيغة (build.gradle:122).
 *  ٢) أو في ملف خصائص/بيئة: AQARI_UPLOAD_STORE_PASSWORD=SyntheticPass2026 ← «\bpassword\b» لا يطابق بعد «_» والقيمة بلا
 *     علامتي اقتباس، فلا تُلتقط · وهذه أسماء المتغيرات التي يقرؤها build.gradle:11 نفسه.
 *  ٣) سرٌّ يُضاف في التزام ويُحذف في الالتزام التالي من الدفعة نفسها ← سير العمل يفحص `git diff <الأساس>..<الرأس>` مجموعاً
 *     فلا يرى السطر، والسرّ باقٍ في تاريخ المستودع على جيت هب.
 *
 * لماذا يهم: الفحص هو الضمان الوحيد في جيت هب للقاعدة ٤٠، والفرع main غير محمي، والحالات الثلاث أشيع طرق تسرّب سرّ
 * التوقيع في مشروع أندرويد · والتسرّب في التاريخ لا يُصلحه حذف السطر.
 *
 * السلوك الصحيح: تُلتقط الحالات الثلاث (فحص كل التزامٍ وحده، ونمطٌ لصيغة Groovy وملفات الخصائص) · أو تُستبدل الأداة
 * بـgitleaks نفسه المستعمل محلياً (docs/حوكمة/دليل-الاستلام.md §٧).
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scan } = require('../scripts/ci/secretScan.js') as { scan: (l: Array<{ file: string; line: number; text: string }>) => unknown[] };
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ci', 'secretScan.js');
const one = (file: string, text: string) => [{ file, line: 1, text }];

describe('G-4 · فحص الأسرار في جيت هب', () => {
  test.failing('كلمة مرور التوقيع بصيغة Groovy في build.gradle تُلتقط', () => {
    const k = 'store' + 'Password';
    expect(scan(one('android/app/build.gradle', `            ${k} 'Synthetic-Pass-2026'`))).not.toEqual([]);
  });

  test.failing('كلمة مرور التوقيع في ملف خصائص أو بيئة (المتغير الذي يقرؤه build.gradle) تُلتقط', () => {
    const k = 'AQARI_UPLOAD_STORE_' + 'PASS' + 'WORD';
    expect(scan(one('android/gradle.properties', `${k}=SyntheticPass2026`))).not.toEqual([]);
  });

  // مستودعٌ مؤقت فيه: أساس ← التزامٌ يضيف مفتاحاً مصطنعاً ← التزامٌ يحذفه (الدفعة نفسها)
  let dir = '';
  let base = '';
  let leak = '';
  let head = '';
  const run = (a: string, b: string) => spawnSync(process.execPath, [SCRIPT, a, b], { cwd: dir, encoding: 'utf8' }).status;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-secret-'));
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...a],
      { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'config.ts'), 'export const x = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    base = git('rev-parse', 'HEAD');
    // مفتاح AWS مصطنع بصيغة يلتقطها النمط aws-access-key · مركّبٌ هنا كي لا يطابق سطرُ الاختبار نفسه
    const fake = 'AK' + 'IA' + 'SYNTHETICEXAMPL1';
    fs.writeFileSync(path.join(dir, 'config.ts'), `export const x = 1;\nexport const k = '${fake}';\n`);
    git('commit', '-q', '-am', 'oops');
    leak = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'config.ts'), 'export const x = 1;\n');
    git('commit', '-q', '-am', 'remove');
    head = git('rev-parse', 'HEAD');
  });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('ضابط: التزام التسريب وحده يُمسك', () => {
    expect(run(base, leak)).toBe(1);
  });

  test.failing('سرٌّ أُضيف ثم حُذف في الدفعة نفسها يُلتقط (فحص كل التزامٍ لا المدى مجموعاً)', () => {
    expect(run(base, head)).toBe(1); // الواقع 0: الدفعة كلها تمرّ والسرّ في التاريخ
  });
});

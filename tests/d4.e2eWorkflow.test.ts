/**
 * التوجيه الرابع ٤ · ١: الجوال الافتراضي في جيت هب (android-e2e.yml) · حارسٌ للبنية لا للتدفقات نفسها (تجري على المحاكي هناك):
 * لا سرّ ولا مفتاح للمالك في سير العمل، والحزمة تُوقَّع بمفتاحٍ مؤقت يُحذف، وكل تدفقٍ يستهدف التطبيق ويُشغَّل بترتيب اسمه.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/android-e2e.yml'), 'utf8');

describe('سير عمل الجوال الافتراضي', () => {
  test('بلا أسرار ولا مفتاح المالك، والتوقيع بمفتاح اختبارٍ مؤقت يُحذف', () => {
    expect(wf).not.toMatch(/secrets\./);
    // متغيرات الإصدار تحمل مفتاح الاختبار المولَّد هنا وحده، لا مفتاح المالك
    expect(wf).toMatch(/AQARI_UPLOAD_STORE_FILE=\$ks/);
    expect(wf).not.toMatch(/D:\/keys/);
    expect(wf).toMatch(/keytool -genkeypair/);
    expect(wf).toMatch(/rm -f "\$RUNNER_TEMP\/e2e\.keystore"/);
  });

  test('الكتابة في ci-results في عملٍ مستقل، وعمل البناء بصلاحية القراءة وحدها', () => {
    const e2eJob = wf.slice(wf.indexOf('  e2e:'), wf.indexOf('  publish:'));
    expect(e2eJob).toMatch(/contents: read/);
    expect(e2eJob).not.toMatch(/contents: write/);
    expect(wf.slice(wf.indexOf('  publish:'))).toMatch(/contents: write/);
  });

  test('الإجراءات ببصمة التزامها لا بوسمها', () => {
    for (const m of wf.matchAll(/uses: ([^\s]+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
  });

  test('كل تدفقٍ يستهدف com.aqari.app، واسمه برقم ترتيبه (وحرفٌ للخطوات المتتابعة)', () => {
    const dir = path.join(ROOT, 'e2e/maestro');
    const flows = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    expect(flows.length).toBeGreaterThan(0);
    for (const f of flows) {
      expect(f).toMatch(/^\d{2}[a-z]?-[a-z0-9-]+\.yaml$/);
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).toMatch(/^appId: com\.aqari\.app$/m);
    }
  });

  test('خطوات الجهاز (sh) سكربتات bash مرتّبة مع التدفقات، ويحكم عليها آخر أمر فيها', () => {
    const dir = path.join(ROOT, 'e2e/maestro');
    const steps = fs.readdirSync(dir).filter((f) => f.endsWith('.sh'));
    for (const f of steps) {
      expect(f).toMatch(/^\d{2}[a-z]?-[a-z0-9-]+\.sh$/);
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src).toMatch(/^#!\/bin\/bash\n/);
      expect(src).toMatch(/^set -u$/m);
    }
    const run = fs.readFileSync(path.join(ROOT, 'e2e/run.sh'), 'utf8');
    expect(run).toContain('ls e2e/maestro/[0-9]*.yaml e2e/maestro/[0-9]*.sh 2>/dev/null | LC_ALL=C sort');
    expect(run).toContain('run=(bash "$f" "$OUT")');
  });
});

/**
 * التوجيه الرابع ٤ · ١: الجوال الافتراضي في جيت هب (android-e2e.yml) · حارسٌ للبنية لا للتدفقات نفسها (تجري على المحاكي هناك):
 * لا سرّ ولا مفتاح للمالك في سير العمل، والحزمة تُوقَّع بمفتاحٍ مؤقت يُحذف، وكل تدفقٍ يستهدف التطبيق ويُشغَّل بترتيب اسمه.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/android-e2e.yml'), 'utf8');

describe('سير عمل الجوال الافتراضي', () => {
  test('بلا أسرار ولا مفتاح المالك، والتوقيع بمفتاحٍ مؤقت يُحذف', () => {
    expect(wf).not.toMatch(/secrets\./);
    expect(wf).not.toMatch(/AQARI_UPLOAD_/);
    expect(wf).toMatch(/keytool -genkeypair/);
    expect(wf).toMatch(/rm -f "\$ks"/);
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

  test('كل تدفقٍ يستهدف com.aqari.app، واسمه برقم ترتيبه', () => {
    const dir = path.join(ROOT, 'e2e/maestro');
    const flows = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    expect(flows.length).toBeGreaterThan(0);
    for (const f of flows) {
      expect(f).toMatch(/^\d{2}-[a-z0-9-]+\.yaml$/);
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).toMatch(/^appId: com\.aqari\.app$/m);
    }
  });
});

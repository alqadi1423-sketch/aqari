/**
 * المراجعة ١٠ · المرحلة ٠ · فحص الأسرار بعد إصلاح G-4 (scripts/ci/secretScan.js · الالتزام b6e753e)
 *
 * الإصلاح يدّعي أن الفحص «يمسك أشيع تسرّبات سرّ التوقيع» ويفحص كل التزامٍ وحده. هذه حالاتٌ بقيمٍ مصطنعة كلها تثبت غير ذلك:
 *  ١) السطر الأقرب إلى الوقوع في build.gradle نفسه: `storePassword System.getenv('…') ?: 'سر'` (كسطر keyAlias تحته تماماً
 *     في android/app/build.gradle:131) لا يُلتقط، ولا مقابله في Kotlin DSL.
 *  ٢) صيغة Groovy بقوسين `storePassword('سر')`، وقيمةٌ بين علامتي اقتباسٍ مفردتين فيها «$» (حرفيةٌ في Groovy وفي الصدفة)،
 *     لا تُلتقط.
 *  ٣) كلمة مرورٍ من ٦ أو ٧ أحرف (أدنى ما يقبله keytool ٦) في keystore.properties أو build.gradle.kts لا تُلتقط، مع أن صيغة
 *     Groovy بالمسافة تُلتقط من ٦.
 *  ٤) ملفٌ في اسمه مسافة («signing - Copy.env» كما ينسخه ويندوز): git يُلحق باسمه في سطر «+++» علامة جدولة، فلا يطابق
 *     `\.env$` ولا `\.properties$`، فتسقط القاعدتان الجديدتان عنه كلياً.
 *  ٥) مدى فيه التزامٌ جذري (دمجُ تاريخٍ غير مرتبط): `${c}^1` غير موجود فينهار السكربت بأثر مكدّس بدل أن يفحص ويبلّغ.
 *  ٦) ملف مفتاح التوقيع نفسه (release.jks مضافاً قسراً) يمرّ: الفرق ثنائي فلا أسطر، ولا قاعدة باسم الملف · وكان هذا في إصلاح
 *     G-4 المقترح نفسه («رفض أي ملفٍ مضاف بامتداد .jks أو .keystore أو .p12 أو .pem ولو قسراً»).
 *  ٧) إنذارٌ كاذب: مفتاح التصحيح العام `storePassword 'android'` (android/app/build.gradle:121 و:123) يُلتقط بالقاعدة الجديدة،
 *     فأي تعديلٍ لذلك السطر يُسقط «ملف الحال وفحص الأسرار».
 *
 * السلوك الصحيح: تُلتقط الحالات ١–٤ و٦، ويبلّغ ٥ عن السرّ بلا انهيار، ولا يُعدّ ٧ سرّاً (كلمة مرور مفتاح التصحيح العامة).
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scan } = require('../scripts/ci/secretScan.js') as { scan: (l: Array<{ file: string; line: number; text: string }>) => unknown[] };
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ci', 'secretScan.js');
const one = (file: string, text: string) => [{ file, line: 1, text }];
// الأسماء مركّبةٌ هنا كي لا يطابق سطرُ الاختبار نفسه أنماط الفحص
const SP = 'store' + 'Password';
const ENV = 'AQARI_UPLOAD_STORE_' + 'PASS' + 'WORD';

describe('review10 · فحص الأسرار: صيغ التوقيع الشائعة', () => {
  test('١ قيمةٌ احتياطية بعد System.getenv (كسطر keyAlias في build.gradle) تُلتقط · Groovy وKotlin', () => {
    expect(scan(one('android/app/build.gradle', `        ${SP} System.getenv('${ENV}') ?: 'Synthetic-2026'`))).not.toEqual([]);
    expect(scan(one('android/app/build.gradle.kts', `        ${SP} = System.getenv("${ENV}") ?: "Synthetic-2026"`))).not.toEqual([]);
  });

  test('٢ صيغة Groovy بقوسين، وقيمةٌ حرفية فيها «$» بين علامتي اقتباسٍ مفردتين، تُلتقطان', () => {
    expect(scan(one('android/app/build.gradle', `        ${SP}('Synthetic-2026')`))).not.toEqual([]);
    expect(scan(one('android/app/build.gradle', `        ${SP} 'Synth$$-2026'`))).not.toEqual([]);
    expect(scan(one('signing.env', `${ENV}='Synth$$-2026'`))).not.toEqual([]);
  });

  test('٣ كلمة مرورٍ من ٦ أو ٧ أحرف (أدنى ما يقبله keytool) في الخصائص وKotlin DSL تُلتقط كما في Groovy', () => {
    expect(scan(one('android/app/build.gradle', `        ${SP} 'Synth1'`))).not.toEqual([]); // ضابط: يُلتقط اليوم
    expect(scan(one('android/keystore.properties', `${SP}=Synth12`))).not.toEqual([]);
    expect(scan(one('android/app/build.gradle.kts', `        ${SP} = "Synth12"`))).not.toEqual([]);
  });

  test('٧ مفتاح التصحيح العام (storePassword \'android\') ليس سرّاً ولا يُسقط الفحص', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'android', 'app', 'build.gradle'), 'utf8').split('\n');
    const lines = src.map((text, i) => ({ file: 'android/app/build.gradle', line: i + 1, text }));
    expect(scan(lines)).toEqual([]);
  });
});

describe('review10 · فحص الأسرار: المدى في مستودعٍ حقيقي', () => {
  let dir = '';
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...a],
    { cwd: dir, encoding: 'utf8' }).trim();
  const run = (a: string, b: string) => spawnSync(process.execPath, [SCRIPT, a, b], { cwd: dir, encoding: 'utf8' });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r10-secret-'));
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
  });
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('٤ ملف بيئةٍ في اسمه مسافة («signing - Copy.env») يُفحص كغيره', () => {
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'signing.env'), `${ENV}=Synthetic2026\n`);
    git('add', '.');
    git('commit', '-q', '-m', 'control');
    const control = git('rev-parse', 'HEAD');
    expect(run(base, control).status).toBe(1); // ضابط: الاسم بلا مسافة يُلتقط اليوم
    fs.writeFileSync(path.join(dir, 'signing - Copy.env'), `${ENV}=Synthetic2026\n`);
    git('add', '.');
    git('commit', '-q', '-m', 'copy');
    const r = run(control, git('rev-parse', 'HEAD'));
    expect(r.stderr).toMatch(/signing - Copy\.env:1 · env-assignment-secret/);
    expect(r.status).toBe(1);
  });

  test('٥ مدى فيه التزامٌ جذري (تاريخ غير مرتبط): يُفحص ويُبلَّغ عن السرّ، لا ينهار', () => {
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--orphan', 'other');
    git('rm', '-q', '-rf', '.');
    fs.writeFileSync(path.join(dir, 'k.ts'), `export const k = '${'AK' + 'IA' + 'SYNTHETICEXAMPL1'}';\n`);
    git('add', '.');
    git('commit', '-q', '-m', 'other-root');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--allow-unrelated-histories', '-m', 'merge', 'other');
    const r = run(base, git('rev-parse', 'HEAD'));
    expect(r.stderr).not.toMatch(/Command failed/);
    expect(r.stderr).toMatch(/k\.ts:1 · aws-access-key/);
    expect(r.status).toBe(1);
  });

  test('٦ ملف مفتاح التوقيع نفسه (release.jks مضافاً قسراً) يُرفض', () => {
    const base = git('rev-parse', 'HEAD');
    fs.mkdirSync(path.join(dir, 'android'));
    // بايتاتٌ مصطنعة تبدأ بتوقيع JKS وفيها صفر فيعدّها git ثنائية
    fs.writeFileSync(path.join(dir, 'android', 'release.jks'), Buffer.from([0xfe, 0xed, 0xfe, 0xed, 0, 0, 0, 2, 1, 2, 3]));
    git('add', '-f', '.');
    git('commit', '-q', '-m', 'keystore');
    expect(run(base, git('rev-parse', 'HEAD')).status).toBe(1);
  });
});

describe('review10 · فحص الأسرار: سطر الأوامر، وUTF-16، وقائمة الاستثناء', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = require('../scripts/ci/secretScan.js') as {
    decodeText: (b: Buffer) => string;
    loadIgnore: (t: string) => Array<{ commit: string; file: string; rule: string; line: number }>;
    ignored: (l: unknown[], h: { commit: string; file: string; rule: string; line: number }) => boolean;
  };
  const PASS = 'Synth' + '-2026x';

  test('كلمة المرور في أوامر التوقيع تُلتقط، والمتغير وكلمة مفتاح التصحيح العامة لا', () => {
    expect(scan(one('scripts/sign.sh', `apksigner sign --ks-pass pass:${PASS} app.apk`))).not.toEqual([]);
    expect(scan(one('scripts/sign.ps1', `keytool -genkeypair -store` + `pass ${PASS} -alias x`))).not.toEqual([]);
    expect(scan(one('build.bat', `gradlew assembleRelease -PAQARI_UPLOAD_STORE_PASS` + `WORD=${PASS}`))).not.toEqual([]);
    expect(scan(one('ci.yml', `keytool -genkeypair -store` + `pass "$pw" -key` + `pass "$pw"`))).toEqual([]);
    expect(scan(one('debug.sh', `keytool -list -store` + `pass android`))).toEqual([]);
    expect(scan(one('gradle.sh', `./gradlew -PreactNativeArchitectures=x86_64`))).toEqual([]);
  });

  test('ملف بيئةٍ بترميز UTF-16 (PowerShell 5.1) يُفكّ فيُفحص', () => {
    const text = `${ENV}=Synthetic2026\r\n`;
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(m.decodeText(le)).toBe(text);
    const lines = m.decodeText(le).split(/\r?\n/).map((t, i) => ({ file: 'signing.env', line: i + 1, text: t }));
    expect(scan(lines)).not.toEqual([]);
  });

  test('قائمة الاستثناء تطابق إصابة التزامٍ مضى بعينه، ولا تستثني المحتوى الحالي (بلا التزام) ولا سطراً آخر', () => {
    const list = m.loadIgnore('abc1234:a.yml:cli-signing-password:60  # سبب\n# تعليق\n');
    const h = { commit: 'abc1234def', file: 'a.yml', rule: 'cli-signing-password', line: 60 };
    expect(m.ignored(list, h)).toBe(true);
    expect(m.ignored(list, { ...h, commit: '' })).toBe(false);
    expect(m.ignored(list, { ...h, line: 61 })).toBe(false);
    expect(m.ignored(list, { ...h, commit: 'fff1234' })).toBe(false);
  });
});

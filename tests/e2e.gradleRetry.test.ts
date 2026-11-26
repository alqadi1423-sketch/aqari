/**
 * الجوال الافتراضي على d9609a0: إضافة foojay في settings.gradle.kts لـ@react-native/gradle-plugin لم تُجلب من بوابة الإضافات،
 * فسقط البناء في ٢١ ثانية وما بعده كله · scripts/ci/gradleRetry.sh يعيد البناء لعطل الجلب من الشبكة وحده، ولا يخفي خطأ ترجمة.
 * gradlew مزيّف يكتب ما طُلب منه ويفشل أو ينجح بحسب رقم المحاولة.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/ci/gradleRetry.sh');
const FOOJAY = "Plugin [id: 'org.gradle.toolchains.foojay-resolver-convention', version: '1.0.0'] was not found in any of the following sources:";
const KOTLIN = "e: file:///x/MainApplication.kt:12:5 Unresolved reference 'foo'.\nFAILURE: Build failed with an exception.";

/** outcomes[i]: ما تفعله المحاولة i+1 · 'ok' تنجح، وإلا تطبع النص وتفشل برمز ١ */
function run(outcomes: string[], attempts = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-gradle-'));
  outcomes.forEach((o, i) => fs.writeFileSync(path.join(dir, 'out' + (i + 1)), o));
  const fake = path.join(dir, 'gradlew');
  fs.writeFileSync(fake, [
    '#!/bin/bash',
    `d=${JSON.stringify(dir)}`,
    'n=$(( $(cat "$d/count" 2>/dev/null || echo 0) + 1 )); echo $n > "$d/count"',
    'echo "args $*" >> "$d/calls"',
    'o="$(cat "$d/out$n" 2>/dev/null || echo ok)"',
    '[ "$o" = ok ] && { echo "BUILD SUCCESSFUL"; exit 0; }',
    'echo "$o"; exit 1',
  ].join('\n'));
  const r = spawnSync('bash', [SCRIPT, ':app:assembleRelease', '--no-daemon'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GRADLEW: fake, RETRY_WAIT: '0', GRADLE_ATTEMPTS: String(attempts) },
  });
  const calls = fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n') : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: r.stdout + r.stderr, calls };
}

describe('بناء Gradle بإعادةٍ لعطل الشبكة وحده', () => {
  test('النجاح من أول مرة بلا إعادة', () => {
    const r = run(['ok']);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['args :app:assembleRelease --no-daemon']);
  });

  test('الإضافة لم تُجلب ثم جُلبت: إعادةٌ واحدة بـ--refresh-dependencies وتنجح الخطوة', () => {
    const r = run([FOOJAY, 'ok']);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['args :app:assembleRelease --no-daemon', 'args :app:assembleRelease --no-daemon --refresh-dependencies']);
    expect(r.out).toMatch(/::warning::gradle-retry/);
  });

  test('خطأ الترجمة يُسقط الخطوة من أول مرة برمز Gradle ولا يُعاد', () => {
    const r = run([KOTLIN, 'ok']);
    expect(r.status).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.out).toContain("Unresolved reference 'foo'");
  });

  test('عطل الشبكة في المحاولات كلها يُسقط الخطوة بعد آخرها', () => {
    const r = run([FOOJAY, 'Could not GET https://plugins.gradle.org/m2/x.pom. Received status code 502', FOOJAY, 'ok']);
    expect(r.status).toBe(1);
    expect(r.calls).toHaveLength(3);
    expect(r.out).toMatch(/المحاولات كلها \(3\)/);
  });

  test('سير العمل يبني بالسكربت من مجلد android بمعاملات البناء نفسها', () => {
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/android-e2e.yml'), 'utf8');
    expect(wf).toContain('bash ../scripts/ci/gradleRetry.sh :app:assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon');
    expect(wf).not.toMatch(/bash \.\/gradlew :app:assembleRelease/);
  });
});

/**
 * الجوال الافتراضي · التشغيل 45847901210 (af84ee5): سقط ١٠ أ لأن أندرويد لم يُقلع التطبيق أصلاً بعد مسح حالته
 * («Process ProcessRecord{… com.aqari.app/u0a141} failed to attach» في السجل) فبقيت شاشة البداية حتى المهلة، وسقط ١٠ ب بعده لأنه
 * يبني على نسخة ١٠ أ · ونجح ١٠ أ بلا تغيير في التشغيل السابق. فيُعاد التدفق مرةً إن ظهر «failed to attach» للتطبيق في سجل
 * الجهاز أثناءه (عطلٌ في المحاكي لا في التطبيق)، ويُكتب ذلك في الخلاصة، والإعادة تنجح كلها أو يسقط.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const runSh = fs.readFileSync(path.resolve(__dirname, '..', 'e2e', 'run.sh'), 'utf8');

test('دالة attach_failed تعرف سطر أندرويد كما ظهر، ولا تعرف تطبيقاً آخر ولا سطراً قبل التدفق', () => {
  const fn = runSh.slice(runSh.indexOf('attach_failed() {'), runSh.indexOf('}\n', runSh.indexOf('attach_failed() {')) + 2);
  expect(fn).toMatch(/^attach_failed\(\) \{/);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aq-attach-'));
  const log = path.join(dir, 'logcat.txt');
  const run = (lines: string[], from: number) => {
    fs.writeFileSync(log, lines.join('\n') + '\n');
    return spawnSync('bash', ['-c', `OUT=${JSON.stringify(dir)}; ${fn} attach_failed ${from}`]).status;
  };
  const hit = '11-26 18:36:26.921 W/ActivityManager(  505): Process ProcessRecord{dd7b7f9 7419:com.aqari.app/u0a141} failed to attach';
  const other = '11-26 18:36:26.921 W/ActivityManager(  505): Process ProcessRecord{dd7b7f9 7419:com.android.other/u0a99} failed to attach';
  expect(run(['a', 'b', hit], 2)).toBe(0);
  expect(run(['a', 'b', other], 2)).toBe(1);
  // السطر قبل بداية التدفق لا يُحسب له
  expect(run([hit, 'a', 'b'], 2)).toBe(1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('الحلقة تعيد التدفق مرةً بعد «failed to attach» وتكتب سببه في الخلاصة', () => {
  expect(runSh).toMatch(/from=\$\(\( \$\(wc -l < "\$OUT\/logcat\.txt"[^)]*\) \+ 1 \)\)/);
  expect(runSh).toMatch(/elif \[ \$ok = 0 \] && attach_failed "\$from"; then\n\s+note=" \(retried: app failed to attach\)"/);
});

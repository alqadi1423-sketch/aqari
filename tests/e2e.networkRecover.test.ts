/**
 * الجوال الافتراضي على main (التشغيل 45865769363): بعد إطفاء Wi-Fi لم تقم بيانات الجوال («Active default network: none» عند
 * العلامتين، والتسجيل حزمتان)، فغابت العلامة وسقط «لا اتصال بقوقل» بلا دليل، والشيفرة نفسها نجحت ٢٢ من ٢٢ قبلها على الفرع ·
 * الآن ensure_network تعيد البيانات بعد مهلةٍ بلا شبكة، ثم وضع الطيران، وتكتب ذلك في net.txt.
 * الاختبار يشغّل الدوال من run.sh بـadb مزيّف لا يُظهر شبكةً إلا بعد إعادة البيانات (أو بعد وضع الطيران في الحالة الثانية).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const runSh = fs.readFileSync(path.resolve(__dirname, '..', 'e2e', 'run.sh'), 'utf8');
const fn = (name: string) => { const i = runSh.indexOf(`${name}() {`); expect(i).toBeGreaterThan(-1); return runSh.slice(i, runSh.indexOf('\n}\n', i) + 3); };

function run(recoverOn: 'data' | 'airplane' | 'never') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-net-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const state = path.join(dir, 'state'); fs.writeFileSync(state, '');
  // adb مزيّف: يسجّل كل أمر، ويُظهر الشبكة حين يُرى الأمر المطلوب
  fs.writeFileSync(path.join(bin, 'adb'), `#!/bin/bash
echo "$*" >> ${JSON.stringify(state)}
if [[ "$*" == *"dumpsys connectivity"* ]]; then
  if grep -q ${JSON.stringify(recoverOn === 'data' ? 'svc data disable' : recoverOn === 'airplane' ? 'airplane-mode disable' : 'NEVER')} ${JSON.stringify(state)}; then
    echo "Active default network: 101"; else echo "Active default network: none"; fi
fi
exit 0
`, { mode: 0o755 });
  const script = `OUT=${JSON.stringify(dir)}; ${fn('has_network')}\n${fn('ensure_network')}\nensure_network`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, NET_WAIT: '2', NET_SLEEP: '0' } });
  const net = fs.existsSync(path.join(dir, 'net.txt')) ? fs.readFileSync(path.join(dir, 'net.txt'), 'utf8') : '';
  const calls = fs.readFileSync(state, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, net, calls };
}

test('بلا شبكة: تُعاد بيانات الجوال فتقوم، ويُكتب ذلك', () => {
  const r = run('data');
  expect(r.status).toBe(0);
  expect(r.net).toMatch(/no default network: restarting mobile data/);
  expect(r.net).not.toMatch(/airplane/);
});

test('ولا تقوم بإعادة البيانات: وضع الطيران ثم Wi-Fi مطفأ والبيانات قائمة', () => {
  const r = run('airplane');
  expect(r.status).toBe(0);
  expect(r.net).toMatch(/still none: toggling airplane mode/);
  const after = r.calls.slice(r.calls.indexOf('airplane-mode disable'));
  expect(after).toMatch(/svc wifi disable/);
  expect(after).toMatch(/svc data enable/);
});

test('ولا شبكة أبداً: تعود بفشلٍ والعلامة تُحاول بعدها كما كانت (mark لا يتوقف)', () => {
  expect(run('never').status).toBe(1);
  expect(fn('mark')).toMatch(/ensure_network \|\| true/);
});

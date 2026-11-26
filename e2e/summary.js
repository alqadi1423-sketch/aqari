#!/usr/bin/env node
// خلاصة الجوال الافتراضي (android-e2e.yml): سطرٌ لكل تدفق ونتيجته، والالتزام ورابط التشغيل · تُكتب في e2e-out/summary.txt
const fs = require('fs');
const out = 'e2e-out';
fs.mkdirSync(out, { recursive: true });
let status = '';
try { status = fs.readFileSync(`${out}/status.txt`, 'utf8').trim(); } catch { status = 'no-flows-ran'; }
// سطر التدفق «<الاسم> pass|fail <الزمن>» · وغيره (فشل التثبيت أو لا تدفق) حالٌ لا تدفق
const lines = status.split('\n').filter((l) => / (pass|fail) /.test(l));
const failed = lines.filter((l) => / fail /.test(l));
// وفحص «لا اتصال بقوقل» (ق٠-٨ · scripts/ci/noGoogle.js) سطرٌ في الخلاصة: فشله أو غيابه فشلٌ للجوال الافتراضي كفشل تدفق
let noGoogle = '';
try { noGoogle = fs.readFileSync(`${out}/no-google.txt`, 'utf8').split('\n')[0].trim(); } catch { noGoogle = ''; }
if (!/^no-google /.test(noGoogle)) noGoogle = 'no-google missing';
const ok = lines.length > 0 && failed.length === 0 && !/install-failed|no-flows-ran/.test(status) && /^no-google (pass|report) /.test(noGoogle);
const summary = [
  'commit ' + (process.env.GITHUB_SHA || ''),
  'run ' + (process.env.GITHUB_SERVER_URL || '') + '/' + (process.env.GITHUB_REPOSITORY || '') + '/actions/runs/' + (process.env.GITHUB_RUN_ID || ''),
  'success ' + ok,
  'flows ' + lines.length + ' · failed ' + failed.length,
  noGoogle,
  ...(lines.length ? lines : [status]),
].join('\n') + '\n';
fs.writeFileSync(`${out}/summary.txt`, summary);
process.stdout.write(summary);
if (!ok) process.exit(1);

#!/usr/bin/env node
/**
 * وسمٌ ونشرة في جيت هب لكل APK (التوجيه الرابع ٤ · ٢ · قرار المالك 2026-11-07 «أرقام إصدارات وسجل تغييرات لكل APK»).
 * يقرأ رأس فرع apk: رسالة التزامه تسمّي التزام المصدر («من main <بصمة>» أو «· <بصمة> ·»)، ومن المصدر يُقرأ رقم الإصدار
 * (src/version.ts) وقسمه في سجل التغييرات (docs/سجل-التغييرات.md) · فإن لم يُوسَم الرقم بعد أعدّ الوسم والنشرة، وإن وُسم
 * برقمه نفسه لحزمةٍ أخرى فشل: لكل حزمةٍ رقمٌ جديد.
 *
 * الاستعمال (في سير العمل، بعد جلب الفروع والوسوم): node scripts/ci/apkRelease.js <ملف الخرج>
 * يكتب في الخرج: tag وsource وtitle وnotes (ملف النشرة) وaction (create أو skip)، بصيغة GITHUB_OUTPUT.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

const git = (...a) => execFileSync('git', ['-c', 'core.quotepath=false', ...a], { encoding: 'utf8' }).trim();

/** بصمة التزام المصدر من رسالة حزمة apk */
function sourceOf(message) {
  const m = /من\s+(?:main|[\w./-]+)\s+([0-9a-f]{7,40})\b/.exec(message) || /·\s*([0-9a-f]{7,40})\s*·/.exec(message);
  return m ? m[1] : null;
}

/** رقم الإصدار والبناء من نص src/version.ts */
function versionOf(text) {
  const v = /APP_VERSION = '(\d+\.\d+\.\d+)'/.exec(text);
  const b = /APP_BUILD = (\d+);/.exec(text);
  return v && b ? { version: v[1], build: Number(b[1]) } : null;
}

/** قسم الإصدار في سجل التغييرات: ما بين «## <الرقم>» والقسم التالي */
function notesOf(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## ' + version);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

if (require.main === module) {
  const out = process.argv[2];
  if (!out) { console.error('الاستعمال: node scripts/ci/apkRelease.js <ملف الخرج>'); process.exit(2); }
  const head = git('rev-parse', 'origin/apk');
  const msg = git('log', '-1', '--format=%B', head);
  const src = sourceOf(msg);
  if (!src) { console.error('رسالة حزمة apk لا تسمّي التزام مصدرها: ' + msg.split('\n')[0]); process.exit(1); }
  const full = git('rev-parse', src + '^{commit}');
  let vtext;
  try { vtext = git('show', full + ':src/version.ts'); } catch { vtext = ''; }
  const v = versionOf(vtext);
  if (!v) {
    // حزمةٌ قبل نظام الإصدارات (1.0.0): لا وسم لها
    fs.appendFileSync(out, 'action=skip\n');
    console.log('المصدر ' + full.slice(0, 7) + ' قبل نظام الإصدارات · لا وسم');
    process.exit(0);
  }
  const tag = 'v' + v.version;
  let tagged = null;
  try { tagged = git('rev-parse', 'refs/tags/' + tag + '^{commit}'); } catch { tagged = null; }
  if (tagged) {
    // الوسم قائم: لحزمةٍ من المصدر نفسه لا شيء جديد، ولغيره رقمٌ مكرر
    if (tagged === full) { fs.appendFileSync(out, 'action=skip\n'); console.log(tag + ' موسومٌ بمصدره · لا شيء جديد'); process.exit(0); }
    console.error(tag + ' موسومٌ لالتزامٍ آخر (' + tagged.slice(0, 7) + ') · ارفع الإصدار في src/version.ts وapp.json وbuild.gradle وسجل التغييرات');
    process.exit(1);
  }
  let changelog = '';
  try { changelog = git('show', full + ':docs/سجل-التغييرات.md'); } catch { changelog = ''; }
  const notes = notesOf(changelog, v.version);
  if (!notes) { console.error('لا قسم «## ' + v.version + '» في سجل التغييرات عند المصدر'); process.exit(1); }
  const notesFile = 'release-notes.md';
  fs.writeFileSync(notesFile, notes + '\n\n---\nالحزمة من الالتزام `' + full.slice(0, 7) + '` · رقم البناء ' + v.build + '\n');
  fs.appendFileSync(out, ['action=create', 'tag=' + tag, 'source=' + full, 'title=عقاري ' + v.version + ' (' + v.build + ')', 'notes=' + notesFile].join('\n') + '\n');
  console.log('يُوسم ' + tag + ' على ' + full.slice(0, 7));
}

module.exports = { sourceOf, versionOf, notesOf };

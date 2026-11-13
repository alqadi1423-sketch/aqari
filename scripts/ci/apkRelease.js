#!/usr/bin/env node
/**
 * وسمٌ ونشرة في جيت هب لكل APK (التوجيه الرابع ٤ · ٢ · قرار المالك 2026-11-07 «أرقام إصدارات وسجل تغييرات لكل APK»).
 * يقرأ رأس فرع apk: رسالة التزامه تسمّي التزام المصدر («من main <بصمة>» أو «· <بصمة> ·»)، ومن المصدر يُقرأ رقم الإصدار
 * (src/version.ts) وقسمه في سجل التغييرات (docs/سجل-التغييرات.md) · فإن لم يُوسَم الرقم بعد أعدّ الوسم والنشرة، وإن وُسم
 * برقمه نفسه لحزمةٍ أخرى فشل: لكل حزمةٍ رقمٌ جديد · ولا وسم قبل أن تنجح في فرع ci-results اختبارات المصدر وتدفقات الجوال الافتراضي
 * على شيفرته، وغياب إحداهما أكثر من يوم يُفشل التشغيل.
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

/** مسارات شيفرة التطبيق التي يُشغَّل عليها الجوال الافتراضي (android-e2e.yml · on.push.paths) */
const E2E_PATHS = ['app', 'src', 'android', 'assets', 'e2e', 'package.json', 'package-lock.json', 'app.json', 'babel.config.js', 'metro.config.js'];
/** مهلة انتظار نتيجةٍ لم تصل: يوم */
const MAX_WAIT_SECONDS = 24 * 3600;

/**
 * حكم اختبارات التزام المصدر من خلاصته في فرع ci-results (runs/<البصمة>.txt): pass أو fail أو missing.
 * لا حزمة تُوسَم من التزامٍ لم تنجح اختباراته (قرار المالك 2026-10-07 «لا حزمة قبل ذلك» · المراجعة الشاملة 2026-11-13 · G-1).
 */
function testsVerdict(resultText) {
  if (!resultText) return 'missing';
  return /^success true$/m.test(resultText) ? 'pass' : 'fail';
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
  // اختبارات المصدر، وتدفقات الجوال الافتراضي على آخر التزامٍ غيّر شيفرة التطبيق حتى المصدر (المسارات نفسها في android-e2e.yml)
  const show = (spec) => { try { return git('show', spec); } catch { return ''; } };
  const e2eAt = git('log', '-1', '--format=%H', full, '--', ...E2E_PATHS) || full;
  const checks = [
    { name: 'الاختبارات', sha: full, text: show('origin/ci-results:runs/' + full + '.txt') },
    { name: 'الجوال الافتراضي', sha: e2eAt, text: show('origin/ci-results:e2e/' + e2eAt + '/summary.txt') },
  ];
  for (const c of checks) {
    const verdict = testsVerdict(c.text);
    if (verdict === 'fail') {
      console.error(c.name + ' على ' + c.sha.slice(0, 7) + ' لم تنجح (ci-results) · لا وسم ولا نشرة لحزمة ' + full.slice(0, 7));
      process.exit(1);
    }
    if (verdict === 'missing') {
      // لم تنتهِ بعد: يُعاد الفحص في التشغيل التالي · وإن مضى على الحزمة يومٌ فالغياب دائم (تشغيلٌ أُلغي، أو نشرٌ خسر السباق)
      // فيُفشل التشغيل بما يُفعل، لا تخطٍّ صامت إلى الأبد (مدقق المرحلة ٠ · P0-4)
      const age = Date.now() / 1000 - Number(git('log', '-1', '--format=%ct', head));
      if (age > MAX_WAIT_SECONDS) {
        console.error('لا نتيجة لـ«' + c.name + '» على ' + c.sha.slice(0, 7) + ' منذ أكثر من يوم · أعد تشغيلها عليه من جيت هب ثم أعد هذا التشغيل');
        process.exit(1);
      }
      fs.appendFileSync(out, 'action=skip\n');
      console.log('لا نتيجة لـ«' + c.name + '» على ' + c.sha.slice(0, 7) + ' بعد · لا وسم حتى تنجح');
      process.exit(0);
    }
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

module.exports = { sourceOf, versionOf, notesOf, testsVerdict, E2E_PATHS, MAX_WAIT_SECONDS };

#!/usr/bin/env node
/**
 * تحقق الحزمة قبل وسمها ونشرها (المراجعة الشاملة 2026-11-13 · G-9): رقماها من داخلها (aapt2 dump badging) يطابقان src/version.ts عند
 * التزام المصدر، وشهادة توقيعها (apksigner verify --print-certs) ليست شهادة التصحيح العامة، وتطابق البصمة المثبّتة إن ضُبطت في
 * متغير المستودع APK_CERT_SHA256 (البصمة ليست سراً) · فحزمةٌ برقمٍ قديم أو بمفتاح الاختبار لا تُنشر ثم يرفض الجوال تثبيتها.
 *
 * الاستعمال (في apk-release.yml): node scripts/ci/apkVerify.js <الحزمة> <بصمة المصدر>
 * يقرأ APK_CERT_SHA256 من البيئة، ويخرج بخطأ يسمّي كل مخالفة.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { versionOf } = require('./apkRelease');

/** versionCode وversionName من خرج aapt2 dump badging */
function badgingOf(text) {
  const m = /versionCode='(\d+)'\s+versionName='([^']*)'/.exec(text || '');
  return m ? { versionCode: Number(m[1]), versionName: m[2] } : null;
}

/** الموقّعون من خرج apksigner verify --print-certs */
function certsOf(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/Signer #(\d+) certificate DN: (.+)\n(?:.*\n)*?Signer #\1 certificate SHA-256 digest: ([0-9a-fA-F:]+)/g)) {
    out.push({ dn: m[2].trim(), sha256: m[3].toLowerCase().replace(/:/g, '') });
  }
  return out;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^0-9a-f]/g, '');

/** المخالفات · فارغة إن صحّت الحزمة */
function verdict({ badging, certs, version, pinned }) {
  const issues = [];
  const b = badgingOf(badging);
  if (!b) issues.push('تعذّرت قراءة رقمي الحزمة');
  else {
    if (b.versionName !== version.version) issues.push(`versionName في الحزمة ${b.versionName} والمصدر ${version.version}`);
    if (b.versionCode !== version.build) issues.push(`versionCode في الحزمة ${b.versionCode} والمصدر ${version.build}`);
  }
  const c = certsOf(certs);
  if (!c.length) issues.push('تعذّرت قراءة شهادة التوقيع');
  else if (c.some((x) => /CN=Android Debug/.test(x.dn))) issues.push('الحزمة موقّعة بشهادة التصحيح العامة');
  else if (pinned && !c.some((x) => x.sha256 === norm(pinned))) issues.push('بصمة شهادة التوقيع تخالف APK_CERT_SHA256');
  return issues;
}

/** أحدث أداة في build-tools بالـSDK المثبّت على المشغّل */
function buildTool(name) {
  const root = path.join(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '', 'build-tools');
  const vers = fs.readdirSync(root).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return path.join(root, vers[vers.length - 1], name);
}

if (require.main === module) {
  const [apk, source] = process.argv.slice(2);
  if (!apk || !source) { console.error('الاستعمال: node scripts/ci/apkVerify.js <الحزمة> <بصمة المصدر>'); process.exit(2); }
  const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }); } catch (e) { return String(e.stdout || ''); } };
  const version = versionOf(execFileSync('git', ['show', source + ':src/version.ts'], { encoding: 'utf8' }));
  if (!version) { console.error('لا رقم إصدار في src/version.ts عند المصدر'); process.exit(1); }
  const issues = verdict({
    badging: run(buildTool('aapt2'), ['dump', 'badging', apk]),
    certs: run(buildTool('apksigner'), ['verify', '--print-certs', apk]),
    version,
    pinned: process.env.APK_CERT_SHA256 || '',
  });
  if (issues.length) { console.error('لا تُنشر الحزمة:\n- ' + issues.join('\n- ')); process.exit(1); }
  if (!process.env.APK_CERT_SHA256) console.log('تنبيه: APK_CERT_SHA256 غير مضبوط في متغيرات المستودع · فُحص ألا تكون شهادة التصحيح وحده');
  console.log(`الحزمة ${version.version} (${version.build}) موقّعةٌ بشهادة الإصدار`);
}

module.exports = { badgingOf, certsOf, verdict };

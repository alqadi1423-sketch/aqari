#!/usr/bin/env node
/**
 * فحص ملف الحال (القاعدة ١٠٣ · التوجيه الرابع 2026-11-07):
 * «فحص في جيت هب يفشل إن تغيّر كود في src/ أو app/ أو android/ بلا تغيير في docs/الحال.md.»
 *
 * يُفحص كل التزامٍ في المدى وحده («ملف docs/الحال.md … يُحدَّث مع كل التزام»)، لا المدى مجموعاً:
 * - التزام الدمج (أكثر من أب) يُتخطّى، لأن التزاماته فُحصت كلٌّ وحده.
 * - التزامٌ لا يحوي شجرته docs/الحال.md يسبق القاعدة فيُتخطّى، فلا يُحاسَب التاريخ القديم بقاعدةٍ جاءت بعده.
 *
 * الاستعمال: node scripts/ci/statusDoc.js <الأساس> <الرأس>
 * والأساس الصفري (فرعٌ جديد) أو غير السلف يُستبدل بنقطة الافتراق عن origin/main في سير العمل.
 */
const { execFileSync } = require('child_process');

const STATUS_FILE = 'docs/الحال.md';
const CODE_DIRS = ['src/', 'app/', 'android/'];

/** هل يمسّ المسار كود التطبيق المحروس؟ */
function isCode(path) {
  return CODE_DIRS.some((d) => path.startsWith(d));
}

/**
 * المخالفات من قائمة التزامات: كلٌّ { sha, subject, parents, hasStatusFile, files }.
 * hasStatusFile: هل في شجرة الالتزام نفسه ملف الحال (وإلا سبق القاعدة).
 */
function violations(commits) {
  const out = [];
  for (const c of commits) {
    if (c.parents > 1) continue;
    if (!c.hasStatusFile) continue;
    const code = c.files.filter(isCode);
    if (code.length === 0) continue;
    if (c.files.includes(STATUS_FILE)) continue;
    out.push({ sha: c.sha, subject: c.subject, code });
  }
  return out;
}

function git(args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function commitsInRange(base, head) {
  const shas = git(['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean);
  return shas.map((sha) => {
    const parents = git(['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').length - 1;
    const subject = git(['log', '-1', '--format=%s', sha]).trim();
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha]).split('\0').filter(Boolean);
    let hasStatusFile = true;
    try {
      git(['cat-file', '-e', `${sha}:${STATUS_FILE}`]);
    } catch {
      hasStatusFile = false;
    }
    return { sha, subject, parents, hasStatusFile, files };
  });
}

if (require.main === module) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error('الاستعمال: node scripts/ci/statusDoc.js <الأساس> <الرأس>');
    process.exit(2);
  }
  const commits = commitsInRange(base, head);
  const bad = violations(commits);
  console.log(`فُحص ${commits.length} التزاماً من ${base.slice(0, 7)} إلى ${head.slice(0, 7)}`);
  if (bad.length) {
    for (const b of bad) {
      console.error(`✗ ${b.sha.slice(0, 7)} «${b.subject}» غيّر ${b.code.length} ملفاً من الكود ولم يحدّث ${STATUS_FILE}:`);
      for (const f of b.code.slice(0, 10)) console.error(`    ${f}`);
    }
    console.error(`القاعدة ١٠٣: كل التزامٍ يغيّر الكود في ${CODE_DIRS.join(' أو ')} يحدّث ${STATUS_FILE} في الالتزام نفسه.`);
    process.exit(1);
  }
  console.log('✓ كل التزامٍ غيّر الكود حدّث ملف الحال.');
}

module.exports = { violations, isCode, STATUS_FILE, CODE_DIRS };

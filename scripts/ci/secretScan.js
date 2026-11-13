#!/usr/bin/env node
/**
 * فحص الأسرار في الأسطر المضافة (القاعدة ٤٠ «فحص الأسرار بأداة قبل كل رفع»).
 * أنماط gitleaks الأعلى دلالة لما يخص هذا المشروع: مفاتيح خاصة، ومفتاح حساب خدمة Google، ومفاتيح Google API،
 * ورموز GitHub وAWS وSlack وStripe، وكلمات مرور مكتوبة نصاً. يُشغَّل محلياً قبل الرفع، وفي جيت هب على مدى الدفع.
 *
 * الاستعمال:
 *   node scripts/ci/secretScan.js --staged            الأسطر المضافة في المرحَّل
 *   node scripts/ci/secretScan.js <الأساس> <الرأس>     الأسطر المضافة في المدى، وفي كل التزامٍ منه وحده
 * والسطر الذي يحمل «secret-scan:allow» يُستثنى (لأنماط الاختبار المخترعة وحدها، ويُذكر سببه بجانبه).
 */
const { execFileSync } = require('child_process');

const RULES = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'gcp-service-account', re: /"type"\s*:\s*"service_account"/ },
  { id: 'gcp-private-key-id', re: /"private_key_id"\s*:\s*"[0-9a-f]{40}"/ },
  { id: 'google-api-key', re: /AIza[0-9A-Za-z_\-]{35}/ },
  { id: 'google-oauth-secret', re: /GOCSPX-[0-9A-Za-z_\-]{28}/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b|\bgithub_pat_[0-9A-Za-z_]{82}\b/ },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { id: 'stripe-key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/ },
  { id: 'jwt', re: /\beyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\b/ },
  {
    id: 'hardcoded-password',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|storePassword|keyPassword)\b\s*[:=]\s*["'][^"'\s$<{]{8,}["']/i,
  },
  // صيغة Groovy في build.gradle بلا «=» ولا «:» (storePassword 'x') · المراجعة الشاملة 2026-11-13 · G-4
  // وفي ملفات Gradle والخصائص وحدها: ذكرُ المثال المصطنع في وثيقةٍ أو تعليق ليس تسرّباً
  {
    id: 'gradle-signing-password',
    file: /\.gradle(?:\.kts)?$|\.properties$/,
    re: /\b(?:storePassword|keyPassword)\s+["'][^"'\s$<{]{6,}["']/,
  },
  // ملفات الخصائص والبيئة والسكربتات: NAME_PASSWORD=value بلا علامتي اقتباس، والاسم موصولٌ بـ«_» · G-4
  {
    id: 'env-assignment-secret',
    file: /(?:\.properties|\.env|\.sh|\.bash|\.npmrc)$|(?:^|\/)\.env(?:\.[^/]*)?$/,
    re: /^\s*(?:export\s+)?[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|api[_-]?key|token)[A-Za-z0-9_.-]*\s*[=:]\s*["']?[^\s"'$<{]{8,}/i,
  },
];

/** الأسطر المضافة من نص فرقٍ موحّد: [{ file, line, text }]. */
function addedLines(diff) {
  const out = [];
  let file = '';
  let n = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '');
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (raw.startsWith('+')) {
      out.push({ file, line: n, text: raw.slice(1) });
      n += 1;
    } else if (!raw.startsWith('-')) {
      n += 1;
    }
  }
  return out;
}

/** النتائج: [{ file, line, rule }] بلا نص السر نفسه. */
function scan(lines) {
  const hits = [];
  for (const l of lines) {
    if (l.text.includes('secret-scan:allow')) continue;
    for (const r of RULES) {
      if (r.file && !r.file.test(l.file)) continue;
      if (r.re.test(l.text)) hits.push({ file: l.file, line: l.line, rule: r.id });
    }
  }
  return hits;
}

function diffOf(args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--no-color', '-U0', '--no-ext-diff', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** التزامات المدى من الأقدم، وفرق كلٍّ منها عن أبيه الأول · سرٌّ أُضيف ثم حُذف في الدفعة نفسها يبقى في التاريخ (G-4) */
function commitDiffs(base, head) {
  const list = execFileSync('git', ['rev-list', '--reverse', `${base}..${head}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  return list.map((c) => ({ commit: c, diff: diffOf([`${c}^1`, c]) }));
}

if (require.main === module) {
  const a = process.argv.slice(2);
  let parts = null;
  if (a[0] === '--staged') parts = [{ commit: '', diff: diffOf(['--cached']) }];
  else if (a.length === 2) parts = [{ commit: '', diff: diffOf([`${a[0]}..${a[1]}`]) }, ...commitDiffs(a[0], a[1])];
  if (parts === null) {
    console.error('الاستعمال: node scripts/ci/secretScan.js --staged | <الأساس> <الرأس>');
    process.exit(2);
  }
  let count = 0;
  const seen = new Set();
  const hits = [];
  for (const p of parts) {
    const lines = addedLines(p.diff);
    if (!p.commit || parts.length === 1) count += lines.length;
    for (const h of scan(lines)) {
      const k = h.file + ':' + h.line + ':' + h.rule + ':' + p.commit;
      if (seen.has(k)) continue;
      seen.add(k);
      hits.push({ ...h, commit: p.commit });
    }
  }
  console.log(`فُحص ${count} سطراً مضافاً بـ${RULES.length} نمطاً` + (parts.length > 1 ? ` · وكل التزامٍ وحده (${parts.length - 1})` : ''));
  if (hits.length) {
    for (const h of hits) console.error(`✗ ${h.file}:${h.line} · ${h.rule}` + (h.commit ? ` · ${h.commit.slice(0, 7)}` : ''));
    process.exit(1);
  }
  console.log('✓ لا سرّ في الأسطر المضافة.');
}

module.exports = { RULES, addedLines, scan };

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

/** كلمة مفتاح التصحيح العامة في كل مشروع أندرويد: ليست سرّاً (P0-9) */
const DEBUG_PASSWORD = 'android';

/**
 * سطرٌ فيه storePassword أو keyPassword وقيمةٌ نصية حرفية من ستة أحرف فأكثر، سوى وسيط دوال القراءة من البيئة والخصائص
 * (System.getenv('V') وfindProperty("V") وproperties['V'] …) · والمزدوج الذي فيه «${» استيفاءٌ لا قيمة.
 */
function signingLiteral(text) {
  if (!/\b(?:storePassword|keyPassword)\b/.test(text)) return false;
  let t = text.replace(/\b([A-Za-z_][\w.]*)\s*\(\s*(['"])[^'"]*\2\s*\)/g,
    (m, name) => (/(?:^|\.)(?:storePassword|keyPassword)$/.test(name) ? m : 'CALL'));
  t = t.replace(/\[\s*(['"])[^'"]*\1\s*\]/g, '[IDX]');
  for (const m of t.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    const single = m[1] !== undefined;
    const v = single ? m[1] : m[2];
    if (!single && (v.includes('${') || /^\$\w/.test(v))) continue;
    if (v.length >= 6 && v !== DEBUG_PASSWORD) return true;
  }
  // storePassword=value في ملف الخصائص بلا اقتباس
  const bare = /\b(?:storePassword|keyPassword)\s*[=:]\s*([^\s"'$<{]{6,})\s*$/.exec(t);
  return !!bare && bare[1] !== DEBUG_PASSWORD && bare[1] !== 'CALL';
}

/** ملف مفتاح التوقيع نفسه لا يُرفع ولو أُضيف قسراً (P0-8) */
const KEYSTORE_FILE = /\.(?:jks|keystore|p12|pfx)$/i;
/** ملفات البيئة والخصائص التي قد تُكتب بترميز UTF-16 (PowerShell 5.1) فيعدّها git ثنائية (P0-8) */
const TEXTY_BINARY = /(?:\.properties|\.env|\.envrc|\.ps1|\.bat|\.cmd)$|(?:^|\/)[^/]*\.env(?:\.[^/]*)?$/i;

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
  // كلمة مرور التوقيع في ملفات Gradle والخصائص بأي صيغة (المراجعة الشاملة 2026-11-13 · G-4 ومدقق المرحلة ٠ P0-1):
  // storePassword 'x' · storePassword('x') · storePassword = "x" · storePassword System.getenv('V') ?: 'x' · و«$» حرفيٌّ في المفرد
  // · وذكرُ المثال في وثيقةٍ أو تعليق ليس تسرّباً، فلا تُفحص غير هذه الملفات
  { id: 'gradle-signing-password', file: /\.gradle(?:\.kts)?$|\.properties$/, test: signingLiteral },
  // ملفات الخصائص والبيئة والسكربتات وYAML: NAME_PASSWORD=value بلا اقتباس أو بهما، والاسم موصولٌ بـ«_»، ومن ستة أحرف (أدنى ما
  // يقبله keytool) · ومعها set وexport و$env: (ويندوز وPowerShell) · G-4 وP0-1
  {
    id: 'env-assignment-secret',
    file: /(?:\.properties|\.env|\.envrc|\.sh|\.bash|\.zsh|\.ps1|\.bat|\.cmd|\.npmrc|\.ya?ml)$|(?:^|\/)\.env(?:\.[^/]*)?$|(?:^|[\/ ])[^/]*\.env(?:\.[^/]*)?$/i,
    re: /^\s*(?:export\s+|set\s+|\$env:)?[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|api[_-]?key|token)[A-Za-z0-9_.-]*\s*[=:]\s*(?:'[^']{6,}'|"[^"$]{6,}"|[^\s"'$%<{][^\s"']{5,})/i,
  },
  // كلمة المرور في سطر أوامر التوقيع: apksigner --ks-pass pass:x · keytool -storepass x · gradlew -P…PASSWORD=x (P0-1)
  {
    id: 'cli-signing-password',
    test: (t) => /--(?:ks|key)-pass\s+pass:(?!android\b)[^\s"'$%<{]{6,}/.test(t)
      || /(?:^|\s)-(?:src|dest)?(?:storepass|keypass)\s+["']?(?!android\b)[^\s"'$%<{]{6,}/.test(t)
      || /(?:^|\s)-P[\w.]*pass(?:word)?[\w.]*=["']?[^\s"'$%<{]{6,}/i.test(t),
  },
];

/**
 * مسار الملف من سطر «+++» أو «Binary files»: git يُلحق علامة جدولة بالاسم الذي فيه مسافة، ويقتبس الاسم الذي فيه محارف خاصة
 * بهروب C (P0-2) · ويُنزع «b/».
 */
function pathOf(raw) {
  let p = raw.replace(/\t$/, '');
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    const inner = p.slice(1, -1);
    const bytes = [];
    const esc = { n: 10, t: 9, '"': 34, '\\': 92, a: 7, b: 8, f: 12, r: 13, v: 11 };
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '\\' && i + 1 < inner.length) {
        const oct = /^[0-7]{3}/.exec(inner.slice(i + 1));
        if (oct) { bytes.push(parseInt(oct[0], 8)); i += 3; continue; }
        const n = inner[i + 1];
        bytes.push(esc[n] ?? n.charCodeAt(0));
        i += 1;
        continue;
      }
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
    }
    p = Buffer.from(bytes).toString('utf8');
  }
  return p.replace(/^b\//, '');
}

/** الأسطر المضافة من نص فرقٍ موحّد: [{ file, line, text }]. */
function addedLines(diff) {
  const out = [];
  let file = '';
  let n = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = pathOf(raw.slice(4));
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (raw.startsWith('+')) {
      out.push({ file, line: n, text: raw.slice(1).replace(/\r$/, '') });
      n += 1;
    } else if (!raw.startsWith('-')) {
      n += 1;
    }
  }
  return out;
}

/** الملفات الثنائية المضافة أو المعدَّلة في الفرق (لا المحذوفة) */
function binaryFiles(diff) {
  const out = [];
  for (const raw of diff.split('\n')) {
    const m = /^Binary files (.+) and (.+) differ$/.exec(raw);
    if (m && m[2] !== '/dev/null') out.push(pathOf(m[2]));
  }
  return out;
}

/** نص ملفٍ ثنائي في نظر git قد يكون UTF-16: يُفكّ إلى أسطر (P0-8) */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2));
    sw.swap16();
    return sw.toString('utf16le');
  }
  const nul = buf.filter((b) => b === 0).length;
  if (buf.length % 2 === 0 && nul >= buf.length / 4) return buf.toString('utf16le');
  return buf.toString('utf8');
}

/** النتائج: [{ file, line, rule }] بلا نص السر نفسه. */
function scan(lines) {
  const hits = [];
  for (const l of lines) {
    if (l.text.includes('secret-scan:allow')) continue;
    for (const r of RULES) {
      if (r.file && !r.file.test(l.file)) continue;
      if (r.re ? r.re.test(l.text) : r.test(l.text)) hits.push({ file: l.file, line: l.line, rule: r.id });
    }
  }
  return hits;
}

/** نتائج الملفات الثنائية: ملف مفتاحٍ يُرفض باسمه، وملف بيئةٍ بترميز UTF-16 يُفكّ ويُفحص كغيره · read(file) يعيد بايتاته */
function scanBinaries(files, read) {
  const hits = [];
  for (const f of files) {
    if (KEYSTORE_FILE.test(f)) { hits.push({ file: f, line: 0, rule: 'keystore-file' }); continue; }
    if (!TEXTY_BINARY.test(f)) continue;
    let buf;
    try { buf = read(f); } catch { continue; }
    const lines = decodeText(buf).split(/\r?\n/).map((text, i) => ({ file: f, line: i + 1, text }));
    hits.push(...scan(lines));
  }
  return hits;
}

function diffOf(args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--no-color', '-U0', '--no-ext-diff', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const gitOut = (args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const blob = (spec) => execFileSync('git', ['show', spec], { maxBuffer: 64 * 1024 * 1024 });

/**
 * التزامات المدى من الأقدم، وفرق كلٍّ منها عن أبيه الأول · سرٌّ أُضيف ثم حُذف في الدفعة نفسها يبقى في التاريخ (G-4)
 * · والالتزام الجذري (تاريخٌ غير مرتبط دُمج) يُقارن بالشجرة الفارغة (P0-7).
 */
function commitDiffs(base, head) {
  const list = gitOut(['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean);
  return list.map((c) => {
    const parents = gitOut(['rev-list', '--parents', '-n', '1', c]).trim().split(/\s+/).slice(1);
    return { commit: c, at: c, diff: diffOf([parents.length ? parents[0] : EMPTY_TREE, c]) };
  });
}

/**
 * قائمة الاستثناء (.secretscan-ignore): إصاباتٌ في التزاماتٍ سابقة ثبت أنها ليست أسراراً · تُطابق إصابة التزامٍ بعينه لا المحتوى
 * الحالي، فلا يُخفى بها سرٌّ جديد.
 */
function loadIgnore(text) {
  return text.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean).map((l) => {
    const m = /^([0-9a-f]{7,40}):(.+):([\w-]+):(\d+)$/.exec(l);
    return m ? { commit: m[1], file: m[2], rule: m[3], line: Number(m[4]) } : null;
  }).filter(Boolean);
}
function ignored(list, h) {
  return !!h.commit && list.some((e) => h.commit.startsWith(e.commit) && e.file === h.file && e.rule === h.rule && e.line === h.line);
}

if (require.main === module) {
  const a = process.argv.slice(2);
  let ignoreList = [];
  try { ignoreList = loadIgnore(require('fs').readFileSync('.secretscan-ignore', 'utf8')); } catch { ignoreList = []; }
  let parts = null;
  if (a[0] === '--staged' && a.length === 1) parts = [{ commit: '', at: '', diff: diffOf(['--cached']) }];
  else if (a.length === 2 && a[0] && a[1]) parts = [{ commit: '', at: a[1], diff: diffOf([`${a[0]}..${a[1]}`]) }, ...commitDiffs(a[0], a[1])];
  if (parts === null) {
    console.error('الاستعمال: node scripts/ci/secretScan.js --staged | <الأساس> <الرأس>');
    process.exit(2);
  }
  let count = 0;
  const seen = new Set();
  const hits = [];
  for (const p of parts) {
    const lines = addedLines(p.diff);
    if (!p.commit) count += lines.length;
    const found = [...scan(lines), ...scanBinaries(binaryFiles(p.diff), (f) => blob(`${p.at}:${f}`))];
    for (const h of found) {
      const k = h.file + ':' + h.line + ':' + h.rule + ':' + p.commit;
      if (seen.has(k)) continue;
      seen.add(k);
      if (ignored(ignoreList, { ...h, commit: p.commit })) continue;
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

module.exports = { RULES, addedLines, scan, scanBinaries, binaryFiles, signingLiteral, decodeText, pathOf, loadIgnore, ignored };

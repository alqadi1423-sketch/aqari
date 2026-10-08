#!/usr/bin/env node
/**
 * فحص تطابق الإعداد بين مشروعي Firebase (القاعدة ٩٥ · 2026-10-08): «أي نشر على أي مشروع Firebase يشمل القواعد
 * والفهارس معاً، ومعه فحص تطابق الإعداد بين المشروعين (المصادقة ومزوّداتها، والفهارس، والقواعد)، ويُعرض ناتجه.»
 *
 * يقرأ الإعداد وحده، لا بيانات ولا مستخدمين: مزوّدات الدخول المفعّلة، والفهارس وحالة بنائها، والقواعد المنشورة.
 * ولا يطبع رمزاً ولا مفتاحاً ولا سرّ عميل. الرمز من جلسة firebase-tools المسجّلة على هذا الجهاز ويبقى في الذاكرة.
 *
 * الاستعمال:
 *   FIREBASE_TOOLS_DIR=<مسار firebase-tools> node scripts/check-firebase-parity.js <المرجع> <الهدف> [--rules-ignore-block=chat]
 *   --rules-ignore-block=chat: كتلة <chat> في القواعد المحلية تُستثنى من مقارنة المرجع (تُنشر عليه عند الدمج بإذن منفصل)
 * يخرج بـ 1 إن اختلف شيء غير المستثنى.
 */
const fs = require('fs');
const path = require('path');

const [ref, target] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ignoreBlock = (process.argv.find((a) => a.startsWith('--rules-ignore-block=')) || '').split('=')[1] || '';
const toolsDir = process.env.FIREBASE_TOOLS_DIR;
if (require.main === module) {
  if (!ref || !target) { console.error('الاستعمال: node scripts/check-firebase-parity.js <المرجع> <الهدف>'); process.exit(2); }
  if (!toolsDir) { console.error('FIREBASE_TOOLS_DIR غير محدد'); process.exit(2); }
}

const ROOT = process.env.AQARI_ROOT || path.join(__dirname, '..');
const stripBlock = (src, name) => (name ? src.replace(new RegExp(`\\n?[ \\t]*// <${name}>[\\s\\S]*?// </${name}>[^\\n]*`, 'g'), '') : src);
const norm = (s) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).join('\n');

async function token() {
  const { getAccessToken } = require(path.join(toolsDir, 'lib', 'auth.js'));
  const { configstore } = require(path.join(toolsDir, 'lib', 'configstore.js'));
  const tokens = configstore.get('tokens');
  const scopes = require(path.join(toolsDir, 'lib', 'scopes.js'));
  const t = await getAccessToken(tokens && tokens.refresh_token, [scopes.CLOUD_PLATFORM, scopes.FIREBASE_PLATFORM].filter(Boolean));
  return t.access_token;
}

async function main() {
  const tk = await token();
  const get = async (url, project) => {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + tk, 'x-goog-user-project': project } });
    const text = await res.text();
    if (!res.ok) throw new Error(res.status + ' ' + url.replace(/\?.*/, '') + ' ' + (text.match(/"message":\s*"([^"]{0,140})/) || [])[1]);
    return text ? JSON.parse(text) : {};
  };

  async function auth(p) {
    const cfg = await get(`https://identitytoolkit.googleapis.com/admin/v2/projects/${p}/config`, p);
    const idps = await get(`https://identitytoolkit.googleapis.com/admin/v2/projects/${p}/defaultSupportedIdpConfigs`, p);
    const out = {
      'email': !!(cfg.signIn && cfg.signIn.email && cfg.signIn.email.enabled),
      'anonymous': !!(cfg.signIn && cfg.signIn.anonymous && cfg.signIn.anonymous.enabled),
      'phone': !!(cfg.signIn && cfg.signIn.phoneNumber && cfg.signIn.phoneNumber.enabled),
    };
    // اسم المزوّد وتفعيله وحدهما · لا معرّف عميل ولا سرّ
    for (const c of idps.defaultSupportedIdpConfigs || []) out[c.name.slice(c.name.lastIndexOf('/') + 1)] = !!c.enabled;
    return out;
  }

  /** كل الصفحات · فلا تُقطع قائمة طويلة فتبدو مطابقة */
  async function all(url, p, key) {
    const out = [];
    let page = '';
    for (let guard = 0; guard < 50; guard++) {
      // حجم الصفحة يحدده الخادم (واجهة الفهارس لا تقبل pageSize) · ويُتبع رمز الصفحة التالية
      const j = await get(url + (page ? (url.includes('?') ? '&' : '?') + 'pageToken=' + encodeURIComponent(page) : ''), p);
      out.push(...(j[key] || []));
      if (!j.nextPageToken) break;
      page = j.nextPageToken;
    }
    return out;
  }

  async function indexes(p) {
    const base = `https://firestore.googleapis.com/v1/projects/${p}/databases/(default)/collectionGroups/-`;
    const ix = { indexes: await all(`${base}/indexes`, p, 'indexes') };
    const composite = (ix.indexes || []).map((i) => ({
      key: [i.queryScope, i.name.split('/collectionGroups/')[1].split('/')[0],
        ...(i.fields || []).filter((f) => f.fieldPath !== '__name__').map((f) => f.fieldPath + ':' + (f.order || f.arrayConfig))].join(' '),
      state: i.state,
    }));
    const fl = { fields: await all(`${base}/fields?filter=indexConfig.usesAncestorConfig:false`, p, 'fields') };
    const overrides = (fl.fields || []).filter((f) => !f.name.endsWith('/fields/*')).map((f) => ({
      key: f.name.split('/collectionGroups/')[1].replace('/fields/', '.') + ' ' + ((f.indexConfig && f.indexConfig.indexes) || [])
        .map((i) => i.queryScope + ':' + (i.fields || []).map((x) => x.order || x.arrayConfig).join('')).sort().join(','),
      state: ((f.indexConfig && f.indexConfig.indexes) || []).map((i) => i.state).filter(Boolean).join(',') || 'READY',
    }));
    return { composite, overrides };
  }

  async function rules(p) {
    try {
      const rel = await get(`https://firebaserules.googleapis.com/v1/projects/${p}/releases/cloud.firestore`, p);
      const rs = await get(`https://firebaserules.googleapis.com/v1/${rel.rulesetName}`, p);
      return ((rs.source && rs.source.files) || []).map((f) => f.content).join('\n');
    } catch (e) {
      // لا قواعد منشورة: ٤٠٤ وحده · وما سواه خطأ يُذكر لا يُخفى
      if (/^404 /.test(e.message)) return null;
      throw e;
    }
  }

  /** أول الأسطر المختلفة بين نصين · لفهم الاختلاف دون طباعة القواعد كاملة */
  const diffHead = (a, b, n = 8) => {
    const x = norm(a).split('\n');
    const y = norm(b).split('\n');
    const sx = new Set(x);
    const sy = new Set(y);
    const out = [];
    for (const l of x) if (!sy.has(l) && l.trim()) out.push('   - المنشور: ' + l.trim().slice(0, 150));
    for (const l of y) if (!sx.has(l) && l.trim()) out.push('   + المحلي: ' + l.trim().slice(0, 150));
    return out.slice(0, n).join('\n') + (out.length > n ? `\n   … و${out.length - n} سطراً غيرها` : '');
  };

  let bad = 0;
  const line =(ok, label, detail = '') => { if (!ok) bad++; console.log((ok ? 'مطابق  ' : 'مختلف  ') + label + (detail ? ' · ' + detail : '')); };

  console.log(`فحص التطابق · المرجع ${ref} · الهدف ${target}`);
  // ١) المصادقة ومزوّداتها
  const [a1, a2] = await Promise.all([auth(ref), auth(target)]);
  for (const k of [...new Set([...Object.keys(a1), ...Object.keys(a2)])].sort()) {
    line(!!a1[k] === !!a2[k], 'المصادقة · ' + k, `المرجع ${a1[k] ? 'مفعّل' : 'معطّل'} · الهدف ${a2[k] ? 'مفعّل' : 'معطّل'}`);
  }
  // ٢) الفهارس وحالة بنائها
  const [i1, i2] = await Promise.all([indexes(ref), indexes(target)]);
  for (const kind of ['composite', 'overrides']) {
    const label = kind === 'composite' ? 'فهرس مركّب' : 'فهرس حقل';
    const k1 = new Map(i1[kind].map((x) => [x.key, x.state]));
    const k2 = new Map(i2[kind].map((x) => [x.key, x.state]));
    for (const k of [...new Set([...k1.keys(), ...k2.keys()])].sort()) {
      // موجود في المشروعين ومبنيّ فيهما · فالفهرس قيد البناء أو المعطوب لا يُعدّ مطابقاً
      const ready = (s) => !!s && s.split(',').every((x) => x === 'READY');
      line(ready(k1.get(k)) && ready(k2.get(k)), label + ' · ' + k, `المرجع ${k1.get(k) || 'غائب'} · الهدف ${k2.get(k) || 'غائب'}`);
    }
  }
  // ٣) القواعد: الهدف يطابق الملف المحلي حرفاً · والمرجع يطابقه دون الكتلة المستثناة
  const local = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const [r1, r2] = await Promise.all([rules(ref), rules(target)]);
  const sameTarget = r2 !== null && norm(r2) === norm(local);
  line(sameTarget, 'القواعد · الهدف = firestore.rules المحلي', r2 === null ? 'لا قواعد منشورة' : '');
  if (r2 !== null && !sameTarget) console.log(diffHead(r2, local));
  if (r1 === null) line(false, 'القواعد · المرجع', 'لا قواعد منشورة');
  else {
    const a = stripBlock(r1, ignoreBlock);
    const b = stripBlock(local, ignoreBlock);
    const same = norm(a) === norm(b);
    line(same, 'القواعد · المرجع = firestore.rules المحلي' + (ignoreBlock ? ` دون كتلة <${ignoreBlock}>` : ''),
      ignoreBlock ? `كتلة <${ignoreBlock}> في المرجع: ${r1.includes(`// <${ignoreBlock}>`) ? 'منشورة' : 'غير منشورة (بالقرار)'}` : '');
    if (!same) console.log(diffHead(a, b));
  }
  console.log(bad ? `النتيجة: ${bad} اختلاف` : 'النتيجة: مطابق');
  process.exit(bad ? 1 : 0);
}

/** مقارنة القواعد وحدها بلا شبكة · لاختبارها بخللٍ مزروع (القاعدة ٤٨) */
function rulesMatch(deployed, local, block = '') {
  return norm(stripBlock(deployed, block)) === norm(stripBlock(local, block));
}
module.exports = { rulesMatch, stripBlock, norm };

if (require.main === module) main().catch((e) => { console.error('تعذّر الفحص: ' + e.message); process.exit(2); });

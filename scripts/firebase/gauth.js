// @ts-check
/**
 * أدوات سير عمل نشر قواعد Firestore وفهارسه (التوجيه الثالث · قرار المالك 2026-11-07) · بلا اعتمادات، بـ node وحده.
 * المفتاح يُقرأ من ملفٍ مؤقت لا يُطبع، ولا تحمل رسالةٌ هنا شيئاً منه.
 */
'use strict';
const crypto = require('node:crypto');

const SECRET_NAME = 'FIREBASE_SERVICE_ACCOUNT';
const IDTK_AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
const DAY = 86_400_000;

/**
 * @typedef {{ type: string, project_id: string, private_key_id?: string, private_key: string, client_email: string, token_uri?: string }} ServiceAccount
 */

/** يتحقق من نص المفتاح · والخطأ برسالةٍ لا تنقل منه شيئاً */
function parseServiceAccount(raw, project) {
  if (!raw || !String(raw).trim()) throw new Error(`السر ${SECRET_NAME} فارغ أو غير موجود في أسرار المستودع`);
  /** @type {any} */
  let sa;
  try { sa = JSON.parse(String(raw)); } catch { throw new Error(`السر ${SECRET_NAME} ليس JSON صالحاً (انسخ ملف المفتاح كما نزّلته)`); }
  if (!sa || sa.type !== 'service_account') throw new Error(`السر ${SECRET_NAME} ليس مفتاح حساب خدمة (type ≠ service_account)`);
  for (const k of ['project_id', 'private_key', 'client_email']) {
    if (typeof sa[k] !== 'string' || !sa[k]) throw new Error(`مفتاح حساب الخدمة ينقصه الحقل ${k}`);
  }
  if (project && sa.project_id !== project) {
    throw new Error(`مفتاح حساب الخدمة لمشروع ${sa.project_id} لا للمشروع ${project}`);
  }
  return /** @type {ServiceAccount} */ (sa);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** JWT موقَّعٌ بمفتاح الحساب (RS256) */
function signJwt(sa, payload) {
  const head = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64(payload);
  const sig = crypto.createSign('RSA-SHA256').update(head).sign(sa.private_key).toString('base64url');
  return head + '.' + sig;
}

/** رمز دخولٍ مخصص لعضو اختبار (يُستبدل برمز هويته من Identity Toolkit) */
function customToken(sa, uid, nowSec = Math.floor(Date.now() / 1000)) {
  return signJwt(sa, { iss: sa.client_email, sub: sa.client_email, aud: IDTK_AUD, iat: nowSec, exp: nowSec + 3600, uid });
}

/**
 * رمز وصولٍ بالمفتاح (منحة JWT) · وهو فحص المفتاح نفسه: المنتهي أو المعطّل أو المحذوف يُرفض هنا برسالة التجديد
 * @param {ServiceAccount} sa @param {string[]} scopes @param {any} [fetchFn] @param {number} [nowSec]
 */
async function accessToken(sa, scopes, fetchFn = fetch, nowSec = Math.floor(Date.now() / 1000)) {
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const assertion = signJwt(sa, { iss: sa.client_email, scope: scopes.join(' '), aud, iat: nowSec, exp: nowSec + 3600 });
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
  /** @type {any} */
  let res;
  try {
    res = await fetchFn(aud, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  } catch (e) {
    throw new Error(`تعذّر الاتصال بخادم رموز قوقل: ${(e && /** @type {any} */ (e).message) || e}`);
  }
  /** @type {any} */
  let j = {};
  try { j = await res.json(); } catch { /* رسالةٌ بلا جسم */ }
  if (!res.ok || !j.access_token) {
    const why = [j.error, j.error_description].filter(Boolean).join(' · ') || 'HTTP ' + res.status;
    throw new Error(`مفتاح حساب الخدمة ${sa.client_email} مرفوضٌ من قوقل (${why}): منتهٍ أو معطّلٌ أو محذوف. `
      + `جدّده: أنشئ مفتاحاً جديداً للحساب نفسه في Google Cloud (IAM · حسابات الخدمة · المفاتيح) وضعه كاملاً في السر ${SECRET_NAME}`);
  }
  return String(j.access_token);
}

/**
 * تاريخ انتهاء المفتاح من IAM (validBeforeTime) إن أذنت صلاحيات الحساب بقراءته · وإلا null بلا ادعاء
 * @param {ServiceAccount} sa @param {string} token @param {any} [fetchFn]
 */
async function keyExpiry(sa, token, fetchFn = fetch) {
  if (!sa.private_key_id) return { validBefore: null, why: 'المفتاح بلا private_key_id' };
  const url = `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(sa.client_email)}/keys/${encodeURIComponent(sa.private_key_id)}`;
  /** @type {any} */
  let res;
  try { res = await fetchFn(url, { headers: { Authorization: 'Bearer ' + token } }); } catch (e) {
    return { validBefore: null, why: 'تعذّر الاتصال بـ IAM' };
  }
  if (!res.ok) return { validBefore: null, why: 'IAM أعاد ' + res.status + (res.status === 403 ? ' (لا صلاحية iam.serviceAccountKeys.get للحساب)' : '') };
  /** @type {any} */
  const j = await res.json();
  return { validBefore: j.validBeforeTime || null, why: '' };
}

/** حال الانتهاء: منتهٍ، أو قريب (٣٠ يوماً فأقل)، أو سليم، أو بلا انتهاء (9999)، أو غير معروف */
function expiryStatus(validBefore, now = Date.now()) {
  if (!validBefore) return { state: 'unknown' };
  const t = Date.parse(validBefore);
  if (!Number.isFinite(t)) return { state: 'unknown' };
  if (t >= Date.parse('9999-01-01T00:00:00Z')) return { state: 'none' };
  if (t <= now) return { state: 'expired' };
  const days = Math.floor((t - now) / DAY);
  return days <= 30 ? { state: 'soon', days } : { state: 'ok', days };
}

/**
 * ما يُقال عن انتهاء المفتاح: بتاريخ IAM إن قُرئ (منتهٍ يوقف، وقبله بشهرٍ فأقل تنبيه)، وإلا بالتاريخ المسجَّل في الخطة (hintDate:
 * أول يومٍ ممكن في شهر الانتهاء الذي ذكره المالك) تنبيهاً لا إيقافاً، فالرفض الحقيقي في طلب رمز الوصول · وبلا تاريخٍ لا يُدّعى شيء
 * @param {{ validBefore?: string | null, hintDate?: string | null, now?: number }} o
 * @returns {{ level: 'error' | 'warning' | 'notice' | 'info', text: string }}
 */
function keyNotice(o) {
  const now = o.now ?? Date.now();
  const renew = `جدّده: مفتاحٌ جديد للحساب نفسه في السر ${SECRET_NAME}`;
  const st = expiryStatus(o.validBefore ?? null, now);
  if (st.state === 'expired') return { level: 'error', text: `انتهت صلاحية مفتاح حساب الخدمة في ${o.validBefore} · ${renew}` };
  if (st.state === 'soon') return { level: 'warning', text: `مفتاح حساب الخدمة ينتهي في ${o.validBefore} (بعد ${st.days} يوماً) · ${renew}` };
  if (st.state === 'ok') return { level: 'info', text: `ينتهي مفتاح حساب الخدمة في ${o.validBefore} (بعد ${st.days} يوماً)` };
  if (st.state === 'none') return { level: 'info', text: 'مفتاح حساب الخدمة بلا تاريخ انتهاء' };
  if (o.hintDate) {
    const h = expiryStatus(o.hintDate + 'T00:00:00Z', now);
    if (h.state === 'expired' || h.state === 'soon') {
      return { level: 'warning', text: `تاريخ انتهاء المفتاح المسجَّل في الخطة يبدأ ${o.hintDate}${h.state === 'soon' ? ` (بعد ${h.days} يوماً)` : ' وقد بلغه'} · ${renew}` };
    }
    return { level: 'notice', text: `تاريخ انتهاء المفتاح لم يُقرأ من IAM · المسجَّل في الخطة يبدأ ${o.hintDate}` };
  }
  return { level: 'notice', text: 'تاريخ انتهاء المفتاح لم يُقرأ من IAM ولا تاريخ مسجَّل' };
}

/** خلاصة jest --json: لا نشر إلا بنجاحٍ كامل بلا معلَّق ولا فراغ */
function jestSummaryOk(r) {
  if (!r) return { ok: false, why: 'لا خلاصة لاختبارات المحاكي' };
  if (!(r.numTotalTests > 0)) return { ok: false, why: 'لم يُشغَّل أي اختبار' };
  if ((r.numPendingTests ?? 0) > 0) return { ok: false, why: `${r.numPendingTests} اختباراً معلّقاً (غاب متغير المحاكي؟)` };
  if (r.success !== true || (r.numFailedTests ?? 0) > 0) return { ok: false, why: `${r.numFailedTests ?? '?'} اختباراً فاشلاً` };
  return { ok: true, why: '' };
}

/** نص القواعد المنشور (ruleset من Firebase Rules API) يطابق الملف المختبَر حرفاً حرفاً */
function sameRules(ruleset, local) {
  const files = (ruleset && ruleset.source && ruleset.source.files) || [];
  return files.length === 1 && files[0].content === local;
}

/** مفتاح واجهة الدخول من إعداد تطبيق ويب (apiKey) أو من ملف google-services.json لتطبيق أندرويد (مرمَّزاً base64) */
function apiKeyFrom(config) {
  if (config && typeof config.apiKey === 'string' && config.apiKey) return config.apiKey;
  if (config && typeof config.configFileContents === 'string') {
    try {
      const gs = JSON.parse(Buffer.from(config.configFileContents, 'base64').toString('utf8'));
      const k = gs && gs.client && gs.client[0] && gs.client[0].api_key && gs.client[0].api_key[0] && gs.client[0].api_key[0].current_key;
      return typeof k === 'string' && k ? k : null;
    } catch { return null; }
  }
  return null;
}

module.exports = {
  SECRET_NAME, parseServiceAccount, signJwt, customToken, accessToken, keyExpiry, expiryStatus, keyNotice, jestSummaryOk, sameRules, apiKeyFrom,
};

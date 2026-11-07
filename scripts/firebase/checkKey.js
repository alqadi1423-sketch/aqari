// @ts-check
/**
 * فحص مفتاح حساب الخدمة قبل النشر: صالحٌ لمشروعه، ويُمنح به رمز وصول (فالمنتهي أو المعطّل أو المحذوف يُفشل هنا برسالة التجديد)،
 * وتاريخ انتهائه: من IAM إن أذنت صلاحيات الحساب بقراءته (منتهٍ يُفشل، وقبله بشهرٍ فأقل تنبيه)، وإلا من التاريخ المسجَّل في الخطة
 * KEY_EXPIRES_AT (تنبيهٌ قبله بشهر) · ولا يُطبع من المفتاح شيء.
 * الاستعمال: node scripts/firebase/checkKey.js <مسار ملف المفتاح>   (والمشروع من FIREBASE_PROJECT)
 */
'use strict';
const fs = require('node:fs');
const g = require('./gauth.js');

const summary = (line) => {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n');
};

(async () => {
  const file = process.argv[2];
  const project = process.env.FIREBASE_PROJECT || '';
  try {
    const sa = g.parseServiceAccount(file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', project);
    const token = await g.accessToken(sa, ['https://www.googleapis.com/auth/cloud-platform']);
    console.log(`المفتاح صالح: الحساب ${sa.client_email} للمشروع ${sa.project_id}`);
    const { validBefore, why } = await g.keyExpiry(sa, token);
    if (!validBefore) console.log(`تاريخ الانتهاء من IAM: لم يُقرأ (${why})`);
    const n = g.keyNotice({ validBefore, hintDate: process.env.KEY_EXPIRES_AT || null });
    const tag = n.level === 'error' ? '::error::' : n.level === 'warning' ? '::warning::' : n.level === 'notice' ? '::notice::' : '';
    console.log(tag + n.text);
    summary((n.level === 'warning' || n.level === 'error' ? '⚠️ ' : '') + n.text);
    if (n.level === 'error') process.exit(1);
  } catch (e) {
    console.log(`::error::${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
})();

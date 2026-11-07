// @ts-check
/**
 * بعد النشر: القواعد المنشورة على المشروع (إصدار cloud.firestore) هي الملف المختبَر نفسه حرفاً حرفاً.
 * الاستعمال: node scripts/firebase/verifyRelease.js   (GOOGLE_APPLICATION_CREDENTIALS وFIREBASE_PROJECT)
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const g = require('./gauth.js');

(async () => {
  try {
    const project = process.env.FIREBASE_PROJECT || '';
    const sa = g.parseServiceAccount(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS || '', 'utf8'), project);
    const token = await g.accessToken(sa, ['https://www.googleapis.com/auth/cloud-platform']);
    const api = 'https://firebaserules.googleapis.com/v1/';
    const get = async (p) => {
      const res = await fetch(api + p, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error(`Firebase Rules API أعاد ${res.status} لـ ${p}`);
      return res.json();
    };
    const release = await get(`projects/${project}/releases/cloud.firestore`);
    const ruleset = await get(release.rulesetName);
    const local = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8');
    if (!g.sameRules(ruleset, local)) {
      console.log(`::error::القواعد المنشورة (${release.rulesetName}) لا تطابق firestore.rules المختبَر`);
      process.exit(1);
    }
    console.log(`القواعد المنشورة تطابق المختبَر حرفاً حرفاً: ${release.rulesetName} · ${ruleset.createTime}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `القواعد المنشورة تطابق المختبَر: \`${release.rulesetName}\` (${ruleset.createTime})\n`);
    }
  } catch (e) {
    console.log(`::error::${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
})();

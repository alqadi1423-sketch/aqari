// @ts-check
/**
 * خلاصة jest --json تُوقف النشر إن فشل اختبار أو عُلِّق أو لم يُشغَّل شيء.
 * الاستعمال: node scripts/firebase/assertJest.js <ملف الخلاصة> <وصف>
 */
'use strict';
const fs = require('node:fs');
const g = require('./gauth.js');

const [file, label = 'الاختبارات'] = process.argv.slice(2);
let r = null;
try { r = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* لا خلاصة */ }
const v = g.jestSummaryOk(r);
if (!v.ok) {
  console.log(`::error::${label}: ${v.why} · لا نشر`);
  process.exit(1);
}
console.log(`${label}: ${r.numPassedTests} ناجحاً من ${r.numTotalTests} · لا فشل ولا تعليق`);

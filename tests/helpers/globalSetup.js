/**
 * مجلدٌ مؤقت لكل تشغيل تحت جذر الاختبارات · يرثه العمّال فيكتب فيه كل ما يُنشئه os.tmpdir() · ويُمسح في آخر التشغيل
 * (globalTeardown) · ولكل تشغيلٍ مجلده، فلا يمسح تشغيلٌ ما ينشئه تشغيلٌ آخر يجري معه
 */
const fs = require('fs');
const path = require('path');
const { TEST_TMP_ROOT } = require('./tmpRoot');

module.exports = async () => {
  const run = path.join(TEST_TMP_ROOT, 'run-' + process.pid + '-' + Date.now());
  fs.mkdirSync(run, { recursive: true });
  process.env.AQARI_TEST_RUN_TMP = run;
  process.env.TMP = run;
  process.env.TEMP = run;
  process.env.TMPDIR = run;
};

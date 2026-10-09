/** يمسح مجلد هذا التشغيل المؤقت كله · وما بقي من تشغيلٍ انقطع يمسحه تشغيلٌ تالٍ إن مضى عليه يوم */
const fs = require('fs');
const path = require('path');
const { TEST_TMP_ROOT } = require('./tmpRoot');

module.exports = async () => {
  const run = process.env.AQARI_TEST_RUN_TMP;
  if (run && path.resolve(run).startsWith(path.resolve(TEST_TMP_ROOT))) {
    try { fs.rmSync(run, { recursive: true, force: true }); } catch { /* ملفٌ مفتوح · يمسحه تشغيلٌ تالٍ */ }
  }
  const day = 24 * 60 * 60 * 1000;
  for (const name of fs.existsSync(TEST_TMP_ROOT) ? fs.readdirSync(TEST_TMP_ROOT) : []) {
    if (!name.startsWith('run-')) continue;
    const p = path.join(TEST_TMP_ROOT, name);
    try { if (Date.now() - fs.statSync(p).mtimeMs > day) fs.rmSync(p, { recursive: true, force: true }); } catch { /* تجاهل */ }
  }
};

/** يضمن أن os.tmpdir() في كل عاملٍ مجلدُ هذا التشغيل (يُرث من globalSetup) أو جذر الاختبارات على الأقل */
const fs = require('fs');
const { TEST_TMP_ROOT } = require('./tmpRoot');

const dir = process.env.AQARI_TEST_RUN_TMP || TEST_TMP_ROOT;
fs.mkdirSync(dir, { recursive: true });
process.env.TMP = dir;
process.env.TEMP = dir;
process.env.TMPDIR = dir;

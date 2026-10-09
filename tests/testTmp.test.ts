/**
 * قرار المالك 2026-10-09: «اجعل الاختبارات تمسح ما تنشئه، وملفاتها المؤقتة على D دائماً» · ما ينشئه الاختبار بـ os.tmpdir()
 * يقع تحت جذر الاختبارات المؤقت (على ويندوز في D) في مجلد هذا التشغيل الذي يُمسح في آخره
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TEST_TMP_ROOT } = require('./helpers/tmpRoot') as { TEST_TMP_ROOT: string };

test('المجلد المؤقت للاختبارات تحت جذرها · وفي مجلد هذا التشغيل', () => {
  const norm = (p: string) => path.resolve(p).toLowerCase();
  expect(norm(os.tmpdir()).startsWith(norm(TEST_TMP_ROOT))).toBe(true);
  if (process.platform === 'win32' && !process.env.AQARI_TEST_TMP) expect(norm(os.tmpdir()).startsWith('d:')).toBe(true);
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-probe-'));
  expect(norm(made).startsWith(norm(process.env.AQARI_TEST_RUN_TMP ?? TEST_TMP_ROOT))).toBe(true);
});

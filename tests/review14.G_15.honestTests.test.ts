/**
 * المراجعة الشاملة 2026-11-13 · G-15 · منخفض · اختباراتٌ لا تسقط، وتحققٌ ناقص في التدفقات.
 * السيناريو ١: printDocs.test.ts وvatModel.test.ts فيهما `if (!outDir) { expect(true).toBe(true); return; }`، وPRINT_SAMPLES_DIR لا يُضبط
 * في جيت هب، فهما ناجحان دائماً · مولّدا عيناتٍ لا اختباران (وكان مولّد الإقرار معطّلاً لا يُرى).
 * السيناريو ٢: test.failing لـA2-2 وM9 ينجح على أي فشل، ومنه عطلٌ لا صلة له، فلا يثبت أن العطل نفسه ما زال يُستنسخ.
 * السيناريو ٣: e2e/maestro/09-contract-payment.yaml ينتهي بإغلاق ورقة التحصيل ولا يتحقق من أن الدفعة سُجّلت.
 * الصحيح: المولّدان في scripts/ يفشلان بلا المجلد · وقبل كل test.failing اختبارٌ عادي يثبت القيمة الخاطئة نفسها اليوم · والتدفق
 * يرحّل الدفعة وينتظر حوار «سند القبض» الذي لا يظهر إلا بعد تسجيلها.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('G-15 لا اختبار ينجح بلا فحص: expect(true) غائبٌ من tests/', () => {
  const hits = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.ts') && f !== path.basename(__filename))
    .filter((f) => /expect\(true\)\.toBe\(true\)/.test(read('tests', f)));
  expect(hits).toEqual([]);
  const gen = read('scripts', 'samples', 'printSamples.samples.ts');
  expect(gen).toMatch(/throw new Error\('PRINT_SAMPLES_DIR/);
});

test('G-15 قبل كل test.failing لـA2-2 وM9 اختبارٌ عادي يثبت الحدّ القائم نفسه', () => {
  const a2 = read('tests', 'd4.auditA2.twoOwnerDevices.test.ts');
  expect(a2).toMatch(/test\('A2-2 · \(الحد القائم اليوم\)/);
  expect(a2).toMatch(/A22_TODAY = \{ phone: \{ bank: 200000, bankPayments: 2, onlyInBooks: 1 \}/);
  const m9 = read('tests', 'd4.auditM.reversedIssue.test.ts');
  expect(m9.indexOf("test('(M9 · الحد القائم اليوم)")).toBeGreaterThan(0);
  expect(m9.indexOf("test('(M9 · الحد القائم اليوم)")).toBeLessThan(m9.indexOf("test.failing('(M9)"));
});

test('G-15 تدفق التحصيل يرحّل الدفعة وينتظر «سند القبض»', () => {
  const y = read('e2e', 'maestro', '09-contract-payment.yaml');
  const paid = y.indexOf('notVisible: "تأكيد التحصيل"');
  const confirm = y.indexOf('text: "تأكيد التسجيل"');
  const receipt = y.indexOf('visible: "سند القبض"');
  expect(paid).toBeGreaterThan(0);
  expect(confirm).toBeGreaterThan(paid);
  expect(receipt).toBeGreaterThan(confirm);
});

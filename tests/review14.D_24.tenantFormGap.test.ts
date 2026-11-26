/**
 * المراجعة الشاملة 2026-11-13 · D-24 · منخفض · فراغ بنصف العرض بجانب حقل الجوال في نموذج «مستأجر جديد».
 * السيناريو: من يرى التحصيل يفتح «+ مستأجر» ← حقل الجوال بنصف العرض وبجانبه خانةٌ فارغة، بقية خانة رصيدٍ حُذفت.
 * الصحيح: لا عنصر فارغ في النموذج · حقل الجوال بعرضه.
 */
import fs from 'fs';
import path from 'path';

test('D-24 لا View فارغ بجانب حقل الجوال', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'tenants.tsx'), 'utf8');
  expect(src).not.toMatch(/<View style=\{\{ flex: 1 \}\}>\s*<\/View>/);
  expect(src).not.toMatch(/seesMoney \? \(\s*<View style=\{\{ flex: 1 \}\}>\s*<\/View>\s*\) : null/);
});

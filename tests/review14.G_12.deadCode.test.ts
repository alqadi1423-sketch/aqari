/**
 * المراجعة الشاملة 2026-11-13 · G-12 · منخفض · كودٌ ميت.
 * السيناريو: تصديراتٌ لا يذكرها شيءٌ خارج ملفها ولا اختبار ولا تُستعمل داخله، واستيراداتٌ ومتغيراتٌ غير مستعملة (no-unused-vars) ·
 * صيانةٌ أثقل وتشويشٌ على القارئ.
 * الصحيح: تُحذف بعد مراجعة كلٍّ منها · وLinkedRefsSheet يبقى (ميزةٌ قائمةٌ بلا مدخل، قرارها للمالك) · ويُخفَّض سقف التحذيرات.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const DEAD: Array<[string, string]> = [
  ['src/chat/store.ts', 'getThreadRow'],
  ['src/domain/access/sections.ts', 'LEVEL_MEANING'],
  ['src/domain/accrual.ts', 'BASES'],
  ['src/domain/assets/catalog.ts', 'categoryName'],
  ['src/domain/assets/catalog.ts', 'ASSET_ACCOUNTS'],
  ['src/domain/contracts/rules.ts', 'isActiveDisplay'],
  ['src/domain/invoiceIssue.ts', 'cancelPendingIssue'],
  ['src/domain/invoices.ts', 'KIND_INVOICE'],
  ['src/domain/jpegExif.ts', 'stripPngMetadata'],
  ['src/domain/jpegExif.ts', 'stripWebpMetadata'],
  ['src/domain/library.ts', 'sortLibrary'],
  ['src/domain/library.ts', 'searchLibrary'],
  ['src/domain/numbering.ts', 'deviceLetterAssigned'],
  ['src/domain/phone.ts', 'displayPhone'],
  ['src/domain/stats.ts', 'propertyMapStatus'],
  ['src/domain/zatcaQr.ts', 'hasZone'],
  ['src/files/cloudFiles.ts', 'DEFAULT_CACHE_LIMIT'],
  ['src/files/store.ts', 'readAttachment'],
  ['src/services/org.ts', 'PROFILE_KEYS'],
  ['src/sync/acl.ts', 'DRAFT_TABLES'],
  ['src/ui/AppDialog.tsx', 'toggleClose'],
];

test('G-12 التصديرات الميتة محذوفة', () => {
  const left = DEAD.filter(([f, n]) => new RegExp('\\b' + n + '\\b').test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  expect(left).toEqual([]);
});

test('G-12 سقف تحذيرات الفحص نزل عن 525', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const cap = Number(/--max-warnings=(\d+)/.exec(pkg.scripts.lint)?.[1]);
  expect(cap).toBeLessThan(525);
});

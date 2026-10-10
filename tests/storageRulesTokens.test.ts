/**
 * قواعد التخزين لا تمرّ على قائمة ولا تقرأ نصاً داخل رمز، فرموز «كل العقارات» التي لا يضمّها العضو إلى ملف (#19)
 * مكتوبةٌ فيها قائمةً ثابتة · وهذا الاختبار يُبقيها مطابقةً للأقسام فلا يفلت قسمٌ يُضاف لاحقاً.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SECTION_KEYS } from '@/domain/access/sections';
import { ORG_WIDE } from '@/sync/acl';

test('قواعد التخزين تمنع ضمّ رمز «كل العقارات» لكل قسم', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', 'storage.rules'), 'utf8');
  const m = /function orgWideTokens\(\) \{\s*return \[([^\]]*)\];/.exec(rules);
  expect(m).not.toBeNull();
  const listed = m![1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
  expect(listed).toEqual(SECTION_KEYS.map((s) => s + '|' + ORG_WIDE).sort());
});

test('أقسام الرموز بربط المرفق في قواعد التخزين من قرّاء جهته كما في المولّد · وأنواع الجهات المعروفة كلها', async () => {
  const { attachmentGRegex } = await import('@/domain/access/rulesGen');
  const { ATTACHMENT_ENTITY_TABLE } = await import('@/domain/access/readSections');
  const rules = fs.readFileSync(path.join(__dirname, '..', 'storage.rules'), 'utf8');
  expect(/function attSectionsRx\(\) \{\s*return '([^']*)';/.exec(rules)![1]).toBe(attachmentGRegex());
  expect(/function attKnownRx\(\) \{\s*return '([^']*)';/.exec(rules)![1]).toBe(Object.keys(ATTACHMENT_ENTITY_TABLE).join('|'));
});

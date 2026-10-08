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

/**
 * المراجعة الشاملة 2026-11-13 · D-23 · منخفض · «تحصيل» ناقص في تفاصيل قسط العقد الملغى.
 * السيناريو: عقدٌ أُلغي وعليه قسطٌ قائم سابقٌ لإلغائه ← صفّه في جدول العقد يعرض «تحصيل» ← ضغط الصف نفسه يفتح تفاصيل القسط
 * فلا يظهر فيها «تحصيل»، والدومين يجيزه على القسط المحدد (المراجعة ٤.٩ · service.ts).
 * الصحيح: تفاصيل القسط تعرض «تحصيل» بقاعدة صفّ الجدول نفسها: متبقٍّ، والقسط غير ملغى، وصلاحية الإضافة.
 */
import fs from 'fs';
import path from 'path';

test('D-23 «تحصيل» في تفاصيل القسط بقاعدة صف الجدول: العقد الملغى لا يحجبه', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ui', 'InstallmentSheet.tsx'), 'utf8');
  const m = /const collectable = ([^;]+);/.exec(src);
  expect(m).not.toBeNull();
  expect(m![1]).not.toMatch(/contractCancelled/);
  expect(m![1]).toMatch(/remaining > 0/);
  expect(m![1]).toMatch(/i\.status !== 'ملغية'/);
  expect(m![1]).toMatch(/perm\.add/);
});

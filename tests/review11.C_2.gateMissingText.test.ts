/**
 * المدقق المستقل · C-2 (الإصلاح المرحلي) · نص شاشة «missing» في بوابة الترقية لم يتبع تغيّر النسخة.
 *
 * بعد الإصلاح لا يدخل نسخةَ ما قبل الترقية ملفٌ واحد (local_files بلا الملفات · قرار المالك س٣). لكن شاشة البوابة
 * (UpgradeGate.tsx · upgrade.missingTitle وupgrade.missingBody) ما زالت تقول إن النسخة حُفظت «ما عدا» الملفات المفقودة،
 * أي إن باقي الملفات دخلها: «حُفظت نسخة كاملة من بياناتك قبل الترقية، ما عدا N ملف مرفق … فلم يدخلها» و
 * «A full backup of your data was saved before the upgrade, except N attached file(s) … so they are not in it».
 * فيُطمئَن المستخدم إلى أن ملفاته محفوظة في نسخةٍ لا تحملها، فلا يصدّر نسخةً كاملة قبل أن يمسح أو يحذف.
 *
 * السلوك الصحيح: نص الشاشة لا يصف الملفات المفقودة بأنها وحدها خارج النسخة (لا «ما عدا» ولا «except») ·
 * يقول إن النسخة فيها البيانات وقائمة الملفات وبصماتها، وإن هذه الملفات لم تُوجد على الجهاز أو تلفت.
 */
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';

test('C-2 شاشة الملفات المفقودة في البوابة لا تقول إن باقي الملفات في نسخة ما قبل الترقية', () => {
  const a = (ar as unknown as { upgrade: Record<string, string> }).upgrade;
  const e = (en as unknown as { upgrade: Record<string, string> }).upgrade;
  expect(a.missingTitle).not.toMatch(/ما عدا/);
  expect(a.missingBody).not.toMatch(/ما عدا|فلم يدخلها/);
  expect(e.missingTitle).not.toMatch(/except/i);
  expect(e.missingBody).not.toMatch(/except|so they are not in it/i);
});

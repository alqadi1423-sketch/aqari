/**
 * أُصلح في الجولة نفسها (D٦ وD٩): التأكيد بخطوتين، والرسالة بحال المفتاح.
 * المدقق الخارجي D · الجولة الثانية · ورقة مفتاح الاسترداد ورسالة السرّ المتعذّر (واجهة لا تعمل على Node: إثباتٌ من المصدر).
 *
 *  ١) قرار المالك «مفتاح استرداد يظهر مرة» مع تأكيد أنه حُفظ: الورقة (app/settings.tsx) ترسم المفتاح كاملاً وزرّ نسخه وحقل «اكتب آخر
 *     خمسة أحرف» معاً في فرعٍ واحد (newKey ? …)، فيُجتاز التأكيد بقراءة آخر مجموعةٍ من الشاشة نفسها أو بلصق ما نُسخ للتو، ولا يثبت
 *     أن المفتاح حُفظ خارج الهاتف · والمستخدم الذي ظنّ أنه حفظه ثم أغلق الورقة ثم أعاد فتحها يُعطى مفتاحاً آخر يؤكّده كذلك.
 *  ٢) رسالة «وُضع سرٌّ وتعذّرت قراءته» (backup.passwordLost) ما زالت تقول «ضع كلمة المرور من جديد، أو أزلها إن أردت نسخاً بلا
 *     تشفير» · ولا كلمة مرور تُوضع بعد feb6ceb، ولا زرّ يزيل السرّ («ولا زرّ يزيل السرّ»)، والتشفير إجباري · فترشد المستخدم إلى ما
 *     لا وجود له وتناقض القرار.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const settings = fs.readFileSync(path.join(__dirname, '..', 'app/settings.tsx'), 'utf8');

test('١ · حقل تأكيد الحفظ لا يُعرض والمفتاح ظاهرٌ على الشاشة نفسها', () => {
  // بعد الإصلاح: خطوتان · فرع العرض بلا حقل التأكيد، وفرع التأكيد بلا المفتاح
  const show = settings.slice(settings.indexOf("{newKey && keyStep === 'show' ? ("), settings.indexOf(') : newKey ? ('));
  const confirm = settings.slice(settings.indexOf(') : newKey ? ('), settings.indexOf(") : secretKind === 'key' ? ("));
  expect(show.length).toBeGreaterThan(0);
  expect(confirm.length).toBeGreaterThan(0);
  expect(/formatRecoveryKey\(newKey\)\}<\/T>/.test(show)).toBe(true);
  expect(/t\('backup\.key\.confirmLabel'\)/.test(show)).toBe(false);
  expect(/formatRecoveryKey\(newKey\)/.test(confirm)).toBe(false);
  expect(/t\('backup\.key\.confirmLabel'\)/.test(confirm)).toBe(true);
});

test('٢ · رسالة السرّ المتعذّر لا ترشد إلى كلمة مرورٍ تُوضع ولا إلى إزالةٍ لنسخٍ بلا تشفير', () => {
  const ar = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/i18n/locales/ar.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/i18n/locales/en.json'), 'utf8'));
  // eslint-disable-next-line no-console
  console.log('ar:', ar.backup.passwordLost, '\nen:', en.backup.passwordLost);
  // ولا زرّ في الواجهة يزيل السرّ (backupPassword.ts: «ولا زرّ في الواجهة يزيله، فالتشفير إجباري»)
  expect(settings).not.toMatch(/removeBackupPassword|clearBackupPassword\(/);
  expect(ar.backup.passwordLost).not.toMatch(/أزلها إن أردت نسخاً بلا تشفير|ضع كلمة المرور من جديد/);
  expect(en.backup.passwordLost).not.toMatch(/remove it if you want unencrypted backups|Set the password again/);
});

/**
 * المراجعة الشاملة 2026-11-13 · D-21 · منخفض · رسائل خام أو عابرة.
 * السيناريو أ: فتح ملفٍ بلا شبكة ← «Network request failed» إنجليزية على الشاشة (FileViewer)، ومثلها فشل نسخة ما قبل الترقية.
 * السيناريو ب: حفظ مورد برقمٍ ضريبي خاطئ، أو مستأجر بلا اسم، أو قيدٍ سطره بلا حساب ← تنبيهٌ عابر يختفي بعد ثانيتين ونصف.
 * الصحيح (قرارا المالك 2026-09-09 «كل حوار خطأ يمرّ بحوار الفشل الموحَّد» و2026-10-07 «الخانة الإلزامية تُظلَّل بعد محاولة حفظ»):
 * النص العربي من الخطأ أو نصٌّ عربي عام، والخطأ في الحفظ بالحوار الموحَّد، والخانة الناقصة حمراء.
 */
import fs from 'fs';
import path from 'path';

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');

test('D-21 لا نصّ استثناءٍ خام يُعرض في الملف والترقية', () => {
  for (const f of [['src', 'ui', 'FileViewer.tsx'], ['src', 'ui', 'UpgradeGate.tsx']]) {
    const src = read(...f);
    expect(src).not.toMatch(/e instanceof Error \? e\.message :/);
    expect(src).toMatch(/arabicMessage\(e\) \|\|/);
  }
});

test('D-21 خطأ حفظ المورد بالحوار الموحَّد لا بتنبيهٍ عابر', () => {
  const src = read('app', 'suppliers.tsx');
  expect(src).not.toMatch(/toast\(\(e as Error\)\.message\)/);
});

test('D-21 الخانة الناقصة حمراء بعد محاولة الحفظ لا تنبيهٌ عابر', () => {
  const tenants = read('app', 'tenants.tsx');
  expect(tenants).not.toMatch(/toast\('الرجاء إدخال اسم المستأجر'\)/);
  expect(tenants).toMatch(/useSaveAttempt\(\)/);
  expect(tenants).toMatch(/<Field label="اسم المستأجر"[^>]*error=\{/);
  const journal = read('app', 'journal.tsx');
  expect(journal).not.toMatch(/toast\('أضف سطراً واحداً على الأقل بحساب صحيح'\)/);
  expect(journal).toMatch(/<SelectField label="الحساب"[^>]*error=\{/);
});

/**
 * المراجعة الخارجية ٧ (النتيجتان ٣٢ و١٤ · قرار المالك 2026-10-10): على خط الاختبارات (CI) لا تمرّ الحزمة ومتغيرا المحاكيين
 * غائبان، فاختبارات المحاكي تُعلَّق حينها بصمت وتبدو الحزمة خضراء · وعلى الجهاز يمرّ (تُشغَّل اختبارات المحاكي بسكربتها)
 */
test('على خط الاختبارات: محاكيا Firestore وStorage حاضران', () => {
  if (process.env.CI !== 'true') return;
  expect(process.env.FIRESTORE_EMULATOR_HOST ?? '').not.toBe('');
  expect(process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '').not.toBe('');
});

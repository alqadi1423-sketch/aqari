#!/usr/bin/env node
/**
 * مفتاح التصحيح قبل `npm run android` (المراجعة الشاملة 2026-11-13 · G-9): build.gradle يطلب android/app/debug.keystore، والملف
 * مستثنى بـ`*.keystore` في .gitignore، فكان البناء يفشل على نسخةٍ جديدة من المستودع حتى يُولَّد يدوياً · يُولَّد هنا إن غاب بالقيم
 * العامة نفسها في build.gradle (androiddebugkey · android) بأداة keytool من JDK · مفتاح التصحيح ليس سراً ولا يوقّع حزمة إصدار.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'android', 'app', 'debug.keystore');
if (!fs.existsSync(file)) {
  const keytool = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'keytool') : 'keytool';
  execFileSync(keytool, [
    '-genkeypair', '-v', '-keystore', file, '-storepass', 'android', '-alias', 'androiddebugkey', '-keypass', 'android',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US',
  ], { stdio: 'inherit' });
  console.log('وُلِّد مفتاح التصحيح: ' + file);
}

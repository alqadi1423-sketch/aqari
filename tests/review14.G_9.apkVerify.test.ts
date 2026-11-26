/**
 * المراجعة الشاملة 2026-11-13 · G-9 · منخفض · مصدر الحزمة وبناء التطوير.
 * السيناريو أ: apk-release ينشر الحزمة دون أن يقرأ versionCode وversionName من داخلها ولا شهادة توقيعها، فحزمةٌ برقمٍ قديم
 * أو موقّعةٌ بمفتاح التصحيح تُنشر، ويرفض الجوال تثبيتها فوق الحالية.
 * السيناريو ب: build.gradle يطلب debug.keystore المستثنى من git، فـ`npm run android` يفشل على نسخةٍ جديدة.
 * السيناريو ج: eas.json بـautoIncrement يخالف مصدر الرقم الواحد في src/version.ts لو استُعمل.
 * الصحيح: خطوة تحقق في apk-release (aapt2 وapksigner) تقارن الرقمين بـsrc/version.ts عند المصدر وترفض شهادة التصحيح، وتطابق
 * البصمة المثبّتة إن ضُبطت (APK_CERT_SHA256) · وdebug.keystore يُولَّد قبل البناء إن غاب · وeas.json على الرقم المحلي.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const v = require('../scripts/ci/apkVerify.js') as {
  badgingOf: (s: string) => { versionCode: number; versionName: string } | null;
  certsOf: (s: string) => Array<{ dn: string; sha256: string }>;
  verdict: (a: { badging: string; certs: string; version: { version: string; build: number }; pinned?: string }) => string[];
};

const BADGING = "package: name='com.rekaz.aqari' versionCode='2' versionName='1.1.0' platformBuildVersionName='16'\nsdkVersion:'24'\n";
const CERT_RELEASE = 'Signer #1 certificate DN: CN=Rekaz Aqari, O=Rekaz, C=SA\nSigner #1 certificate SHA-256 digest: ab12cd34ef\nSigner #1 certificate SHA-1 digest: 99\n';
const CERT_DEBUG = 'Signer #1 certificate DN: C=US, O=Android, CN=Android Debug\nSigner #1 certificate SHA-256 digest: 0011\n';

test('G-9 قراءة رقمي الحزمة وشهادتها', () => {
  expect(v.badgingOf(BADGING)).toEqual({ versionCode: 2, versionName: '1.1.0' });
  expect(v.certsOf(CERT_RELEASE)).toEqual([{ dn: 'CN=Rekaz Aqari, O=Rekaz, C=SA', sha256: 'ab12cd34ef' }]);
});

test('G-9 الحكم: الرقم القديم والتوقيع بمفتاح التصحيح والبصمة المخالفة تُرفض', () => {
  const version = { version: '1.1.0', build: 2 };
  expect(v.verdict({ badging: BADGING, certs: CERT_RELEASE, version })).toEqual([]);
  expect(v.verdict({ badging: BADGING, certs: CERT_RELEASE, version, pinned: 'AB:12:CD:34:EF' })).toEqual([]);
  expect(v.verdict({ badging: BADGING, certs: CERT_RELEASE, version: { version: '1.2.0', build: 3 } }).length).toBe(2);
  expect(v.verdict({ badging: BADGING, certs: CERT_DEBUG, version }).length).toBe(1);
  expect(v.verdict({ badging: BADGING, certs: CERT_RELEASE, version, pinned: 'ffff' }).length).toBe(1);
  expect(v.verdict({ badging: '', certs: '', version }).length).toBeGreaterThanOrEqual(2);
});

test('G-9 سير النشر يتحقق قبل الوسم والنشرة', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'apk-release.yml'), 'utf8');
  const verify = wf.indexOf('scripts/ci/apkVerify.js');
  const release = wf.indexOf('gh release create');
  expect(verify).toBeGreaterThan(0);
  expect(verify).toBeLessThan(release);
  // بصمة شهادة المالك مثبّتةٌ في سير العمل (من حزمة فرع apk: C=SA, O=Aqari, CN=Aqari حتى 2054)، ومتغير المستودع يغلبها إن ضُبط
  // (إذن المالك 2026-11-26 «أي شيء تقدر تسويه انت لا تطلبه مني»)
  expect(wf).toMatch(/APK_CERT_SHA256: \$\{\{ vars\.APK_CERT_SHA256 \|\| 'ee5d5c5c602d9739a42d666f398c8de66ee60f8f0cfff1fde14feda6dfb7bf83' \}\}/);
});

test('G-9 بناء التطوير يولّد debug.keystore إن غاب، وeas.json على الرقم المحلي', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  expect(pkg.scripts.android).toMatch(/^node scripts\/ensure-debug-keystore\.js && expo run:android/);
  const ks = fs.readFileSync(path.join(ROOT, 'scripts', 'ensure-debug-keystore.js'), 'utf8');
  expect(ks).toMatch(/android', 'app', 'debug\.keystore'/);
  expect(ks).toMatch(/'-alias', 'androiddebugkey'/);
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  expect(eas.cli.appVersionSource).toBe('local');
  expect(eas.build.production.autoIncrement).toBeUndefined();
});

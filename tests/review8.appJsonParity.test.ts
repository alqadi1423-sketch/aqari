/**
 * المراجعة الشاملة (الالتزام ac76adc) · البند ٣١: مجلد android مرفوع ولا يُعاد توليده (القاعدة ٤١)، فإعدادات app.json لا تنتقل إليه
 * وحدها · فالقيم الأساسية تُطابَق هنا، وما يملكه android وحده (الأيقونة) مذكورٌ في README · بيانات الإعداد نفسها.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

interface AndroidFiles { manifest: string; gradle: string; strings: string; colors: string }
type Expo = Record<string, any>;

/** ما يختلف بين app.json وملفات android في القيم الأساسية · فارغٌ إن تطابقت */
function parityIssues(expo: Expo, f: AndroidFiles): string[] {
  const out: string[] = [];
  const color = (name: string) => new RegExp(`<color name="${name}">([^<]+)</color>`).exec(f.colors)?.[1]?.toUpperCase();
  const plugin = (name: string) => (expo.plugins as Array<string | [string, Record<string, unknown>]>)
    .find((p) => (Array.isArray(p) ? p[0] : p) === name) as [string, Record<string, string>] | undefined;
  const pkg = String(expo.android?.package ?? '');
  if (!f.gradle.includes(`namespace '${pkg}'`) || !f.gradle.includes(`?: '${pkg}')`)) out.push('package');
  if (!f.gradle.includes(`versionName "${expo.version}"`)) out.push('version');
  if (!f.strings.includes(`<string name="app_name">${expo.name}</string>`)) out.push('name');
  if (!new RegExp(`android:name="\\.MainActivity"[^>]*android:screenOrientation="${expo.orientation}"`).test(f.manifest)) out.push('orientation');
  if (!f.manifest.includes(`<data android:scheme="${expo.scheme}"/>`)) out.push('scheme');
  if (!f.manifest.includes(`android:allowBackup="${String(expo.android?.allowBackup)}"`)) out.push('allowBackup');
  for (const perm of (expo.android?.blockedPermissions ?? []) as string[]) {
    if (!f.manifest.includes(`<uses-permission android:name="${perm}" tools:node="remove"/>`)) out.push('blocked:' + perm);
  }
  if (color('splashscreen_background') !== String(plugin('expo-splash-screen')?.[1]?.backgroundColor).toUpperCase()) out.push('splash');
  if (color('notification_icon_color') !== String(plugin('expo-notifications')?.[1]?.color).toUpperCase()) out.push('notification');
  if (color('colorPrimary') !== String(expo.primaryColor).toUpperCase()) out.push('primary');
  if (color('activityBackground') !== String(expo.backgroundColor).toUpperCase()) out.push('background');
  return out;
}

const files: AndroidFiles = {
  manifest: read('android/app/src/main/AndroidManifest.xml'),
  gradle: read('android/app/build.gradle'),
  strings: read('android/app/src/main/res/values/strings.xml'),
  colors: read('android/app/src/main/res/values/colors.xml'),
};

test('٣١ القيم الأساسية في android كما في app.json: الحزمة والإصدار والاسم والاتجاه والمخطط والنسخ الاحتياطي والأذونات والألوان', () => {
  expect(parityIssues(JSON.parse(read('app.json')).expo, files)).toEqual([]);
});

test('٣١ والفحص يسقط إن تغيّرت قيمةٌ في app.json ولم تُنقل إلى android', () => {
  const expo = JSON.parse(read('app.json')).expo;
  const drifted = { ...expo, version: '9.9.9', orientation: 'landscape', android: { ...expo.android, blockedPermissions: [...expo.android.blockedPermissions, 'android.permission.CAMERA'] } };
  expect(parityIssues(drifted, files)).toEqual(['version', 'orientation', 'blocked:android.permission.CAMERA']);
});

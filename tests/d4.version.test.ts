/**
 * التوجيه الرابع ٤ · ٢ (قرار المالك 2026-11-07 «أرقام إصدارات وسجل تغييرات لكل APK»): رقمٌ واحد في src/version.ts يطابقه app.json
 * وpackage.json وandroid/app/build.gradle، وله قسمٌ في سجل التغييرات، ويُكتب في كل تقرير عطل · ونصّ وسم الحزمة ونشرتها يُقرأ من
 * رسالة حزمة apk وسجل التغييرات (scripts/ci/apkRelease.js).
 */
import fs from 'fs';
import path from 'path';
import { APP_VERSION, APP_BUILD, APP_VERSION_LABEL } from '@/version';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('@/services/intents', () => ({ saveErrorLogNative: jest.fn() }));
jest.mock('@/files/expoFs', () => ({ appDataRoot: () => '/tmp', expoFs: {} }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const rel = require('../scripts/ci/apkRelease.js');
const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('رقم الإصدار واحدٌ في كل موضع', () => {
  test('src/version.ts = app.json = package.json = build.gradle', () => {
    const expo = JSON.parse(read('app.json')).expo;
    const gradle = read('android/app/build.gradle');
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(expo.version).toBe(APP_VERSION);
    expect(JSON.parse(read('package.json')).version).toBe(APP_VERSION);
    expect(expo.android.versionCode).toBe(APP_BUILD);
    expect(gradle).toContain(`versionName "${APP_VERSION}"`);
    expect(gradle).toContain(`versionCode ${APP_BUILD}`);
    expect(APP_VERSION_LABEL).toBe(`${APP_VERSION} (${APP_BUILD})`);
  });

  test('للإصدار قسمٌ في سجل التغييرات بالعربية', () => {
    const notes = rel.notesOf(read('docs/سجل-التغييرات.md'), APP_VERSION);
    expect(notes).toBeTruthy();
    expect(notes).toMatch(/[؀-ۿ]/);
  });

  test('الإعدادات والنسخة الاحتياطية تأخذان الرقم من src/version.ts لا نصاً ثابتاً', () => {
    expect(read('app/settings.tsx')).not.toMatch(/APP_VERSION = '/);
    expect(read('src/services/backupService.ts')).toMatch(/appVersion: APP_VERSION_LABEL/);
  });

  test('كل تقرير عطل يحمل رقم الإصدار', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { errorReportText } = require('@/services/errorReport');
    expect(errorReportText('موضع مصطنع', new Error('خطأ مصطنع'))).toContain('الإصدار: ' + APP_VERSION_LABEL);
  });
});

describe('وسم الحزمة ونشرتها (apkRelease.js)', () => {
  test('التزام المصدر من رسالة حزمة apk بصيغتيها', () => {
    expect(rel.sourceOf('حزمة arm64 من main 4265092: المراجعة ٧ كاملة')).toBe('4265092');
    expect(rel.sourceOf('Aqari.apk · d377bbd · arm64-v8a')).toBe('d377bbd');
    expect(rel.sourceOf('حزمة بلا مصدر')).toBeNull();
  });

  test('الرقم والبناء من نص src/version.ts، والنشرة قسمها وحده', () => {
    expect(rel.versionOf(read('src/version.ts'))).toEqual({ version: APP_VERSION, build: APP_BUILD });
    const log = '# سجل\n\n## 2.0.0\nجديد\n\n## 1.9.0\nقديم\n';
    expect(rel.notesOf(log, '2.0.0')).toBe('جديد');
    expect(rel.notesOf(log, '1.9.0')).toBe('قديم');
    expect(rel.notesOf(log, '3.0.0')).toBeNull();
  });

  test('سير العمل يُشغَّل من الفرع الرئيسي (فرع apk بلا ملفات سير عمل)، وبالساعة وبالزر', () => {
    const wf = read('.github/workflows/apk-release.yml');
    expect(wf).toMatch(/branches: \[main\]/);
    expect(wf).toMatch(/schedule:/);
    expect(wf).toMatch(/workflow_dispatch:/);
    expect(wf).toMatch(/node scripts\/ci\/apkRelease\.js "\$GITHUB_OUTPUT"/);
    for (const m of wf.matchAll(/uses: ([^\s]+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
  });
});

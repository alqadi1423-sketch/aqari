/**
 * مراجعة التثبيت #65 · مغادرة المنشأة طوعاً تفرّغ الجهاز كما تفرّغه الإزالة: نسخة أمان أولاً، وفشلها يوقف كل شيء فيبقى
 * عضواً وبياناته كما هي، ثم الخروج من السحابة، ثم التفريغ بسببه وسطرٍ في سجل العمليات · قرار المالك 2026-10-05:
 * «لا يُمسح شيء من الجهاز إلا بأمر صريح من المستخدم في تلك اللحظة، أو بإزالة عضويته. وكل مسح يُسجَّل في سجل العمليات
 * بسببه، ويسبقه نسخة أمان.» · وقرار المالك على «حذف حسابي» (#65): «يُعرض حفظ نسخة خارج التطبيق قبل الحذف.»
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { leaveSafely } from '@/domain/leaveOrg';

test('#65 المغادرة: نسخة الأمان أولاً ثم الخروج ثم التفريغ بها وبسببه', async () => {
  const calls: string[] = [];
  const safety = await leaveSafely({
    backup: async () => { calls.push('backup'); return '/backups/safety-1.aqbk'; },
    leaveCloud: async () => { calls.push('leave'); },
    wipe: async (s, why) => { calls.push('wipe:' + s + ':' + why); },
  }, 'سبب مصطنع');
  expect(safety).toBe('/backups/safety-1.aqbk');
  expect(calls).toEqual(['backup', 'leave', 'wipe:/backups/safety-1.aqbk:سبب مصطنع']);
});

test('#65 فشل نسخة الأمان يوقف المغادرة: لا خروج ولا تفريغ', async () => {
  const calls: string[] = [];
  await expect(leaveSafely({
    backup: async () => { throw new Error('القرص ممتلئ'); },
    leaveCloud: async () => { calls.push('leave'); },
    wipe: async () => { calls.push('wipe'); },
  }, 'سبب مصطنع')).rejects.toThrow('القرص ممتلئ');
  expect(calls).toEqual([]);
});

test('#65 المغادرة في الخدمة بنسخة أمان لا بتفريغٍ بلا نسخة · و«حذف حسابي» يعرض حفظ نسخة خارج التطبيق', () => {
  const cloud = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'cloud.ts'), 'utf8');
  const leave = cloud.slice(cloud.indexOf('export async function leaveOrgNow'), cloud.indexOf('\n}\n', cloud.indexOf('export async function leaveOrgNow')));
  expect(leave).toContain('leaveSafely(');
  expect(leave).not.toContain('resetDeviceData(');
  const settings = fs.readFileSync(path.join(__dirname, '..', 'app', 'settings.tsx'), 'utf8');
  const sheet = settings.slice(settings.indexOf('title="حذف حسابي">'), settings.indexOf('احذف حسابي نهائياً'));
  expect(sheet).toContain("t('account.saveCopyBeforeDelete')");
});

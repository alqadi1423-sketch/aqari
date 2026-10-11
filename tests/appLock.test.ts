/**
 * #51 قفل التطبيق (قرار المالك 2026-10-07 «أ») · المنطق بلا خدمات الجهاز · رموز مصطنعة
 */
import { nodeCipher } from '@/files/nodeCipher';
import { hashPin, pinMatches, pinShapeOk, lockoutMs, waitLeft, lockOnReturn, parseLockConfig } from '@/domain/appLock';

test('الرمز لا يُحفظ نصاً · يطابق صاحبه وحده · وملحه عشوائي', async () => {
  const a = await hashPin(nodeCipher, '4826', 1000);
  const b = await hashPin(nodeCipher, '4826', 1000);
  expect(JSON.stringify(a)).not.toContain('4826');
  expect(a.salt).not.toBe(b.salt);
  expect(await pinMatches(nodeCipher, '4826', a)).toBe(true);
  expect(await pinMatches(nodeCipher, '4827', a)).toBe(false);
  expect(await pinMatches(nodeCipher, '', a)).toBe(false);
});

test('شكل الرمز من ٤ إلى ٨ أرقام', () => {
  for (const ok of ['1234', '12345678']) expect(pinShapeOk(ok)).toBe(true);
  for (const bad of ['123', '123456789', '12a4', '١٢٣٤', ' 1234']) expect(pinShapeOk(bad)).toBe(false);
});

test('المحاولات الخاطئة: خمسٌ بلا انتظار ثم يتضاعف حتى ساعة', () => {
  expect(lockoutMs(4)).toBe(0);
  expect(lockoutMs(5)).toBe(30_000);
  expect(lockoutMs(6)).toBe(60_000);
  expect(lockoutMs(30)).toBe(3_600_000);
  expect(waitLeft({ fails: 5, failAt: 1_000 }, 11_000)).toBe(20_000);
  expect(waitLeft({ fails: 5, failAt: 1_000 }, 40_000)).toBe(0);
});

test('العودة من الخلفية: بعد المهلة يُقفل وقبلها لا · والمعطّل لا يُقفل', () => {
  expect(lockOnReturn({ on: true, delay: 60 }, 0, 59_000)).toBe(false);
  expect(lockOnReturn({ on: true, delay: 60 }, 0, 60_000)).toBe(true);
  expect(lockOnReturn({ on: true, delay: 0 }, 5, 5)).toBe(true);
  expect(lockOnReturn({ on: false, delay: 0 }, 0, 99_999)).toBe(false);
  expect(lockOnReturn({ on: true, delay: 0 }, null, 99_999)).toBe(false);
});

test('إعدادٌ تعذّرت قراءته والقفل مُعلَّم مفعّلاً: يبقى القفل بقفل الجهاز ولا يسقط بصمت', () => {
  expect(parseLockConfig(null, true)).toMatchObject({ on: true, method: 'device' });
  expect(parseLockConfig('{bad', true)).toMatchObject({ on: true, method: 'device' });
  expect(parseLockConfig(null, false)).toMatchObject({ on: false });
  // رمزٌ بلا تجزئته يعامَل قفلَ الجهاز · ومهلةٌ غير معروفة تصير فوراً
  expect(parseLockConfig(JSON.stringify({ on: true, method: 'pin', delay: 999 }), true)).toMatchObject({ on: true, method: 'device', delay: 0 });
});

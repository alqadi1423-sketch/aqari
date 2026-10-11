/**
 * #51 قفل التطبيق · خدمة الجهاز ببدائل في الذاكرة (المخزن الآمن وملف العلامة) · رموز مصطنعة
 * المتحقق المستقل (الجولة الخامسة): ساعة الجهاز المقدَّمة كانت تُنهي انتظار المحاولات · وتعذّر فحص العلامة كان يُسقط القفل
 */
const kv = new Map<string, string>();
const fileState = { exists: false, throws: false };

jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => kv.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { kv.set(k, v); },
  deleteItemAsync: async (k: string) => { kv.delete(k); },
}));
jest.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => ({ success: false }) }));
jest.mock('expo-file-system', () => ({
  Paths: { document: '/doc' },
  File: class {
    get exists() { if (fileState.throws) throw new Error('fs'); return fileState.exists; }
    write() { fileState.exists = true; }
    delete() { fileState.exists = false; }
  },
}));
jest.mock('@/services/cipher', () => ({ deviceCipher: jest.requireActual('@/files/nodeCipher').nodeCipher }));
jest.mock('@/i18n', () => ({ t: (k: string) => k }));

import { enablePinLock, tryPin, lockMaybeOn, loadLock, disableLock, onLockChange } from '@/services/appLockService';

beforeEach(() => { kv.clear(); fileState.exists = false; fileState.throws = false; });
afterEach(() => { jest.restoreAllMocks(); });

test('المتحقق المستقل: تقديم ساعة الجهاز لا يُنهي انتظار المحاولات الخاطئة', async () => {
  await enablePinLock('4826', 0);
  for (let i = 0; i < 5; i++) expect(await tryPin('1111')).toBe('wrong');
  // ساعة الجهاز قُدِّمت يوماً: الانتظار باقٍ
  const wall = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(wall + 86_400_000);
  const r = await tryPin('4826');
  expect(typeof r).toBe('number');
  expect(r as number).toBeGreaterThan(25_000);
  // والرمز الصحيح لا يُقبل أثناء الانتظار
  expect((await loadLock()).fails).toBe(5);
});

test('المتحقق المستقل: تعذّر فحص العلامة يُعدّ «مفعّل» فلا يسقط القفل بالشك', async () => {
  fileState.throws = true;
  expect(lockMaybeOn()).toBe(true);
  expect(await loadLock()).toMatchObject({ on: true, method: 'device' });
});

test('البوابة تُبلَّغ بكل تغيير في الإعداد (لتقرر عند العودة بلا انتظار)', async () => {
  const seen: boolean[] = [];
  const off = onLockChange((c) => seen.push(c.on));
  await enablePinLock('4826', 60);
  await disableLock();
  off();
  expect(seen).toEqual([true, false]);
  expect(lockMaybeOn()).toBe(false);
});

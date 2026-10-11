/**
 * #51 قفل التطبيق (قرار المالك 2026-10-07 «أ») · المنطق بلا خدمات الجهاز · رموز مصطنعة
 */
import { nodeCipher } from '@/files/nodeCipher';
import { hashPin, pinMatches, pinShapeOk, lockoutMs, waitLeft, lockOnReturn, decideReturn, parseLockConfig, PROMPT_GRACE_MS } from '@/domain/appLock';
import { createSession, KEYS } from '@/cloud/session';

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

test('المحاولات الخاطئة: خمسٌ بلا انتظار ثم يتضاعف حتى ساعة · بالساعة الرتيبة', () => {
  expect(lockoutMs(4)).toBe(0);
  expect(lockoutMs(5)).toBe(30_000);
  expect(lockoutMs(6)).toBe(60_000);
  expect(lockoutMs(30)).toBe(3_600_000);
  expect(waitLeft(5, 1_000, 11_000)).toBe(20_000);
  expect(waitLeft(5, 1_000, 40_000)).toBe(0);
  expect(waitLeft(4, 1_000, 1_000)).toBe(0);
  // ساعةٌ رتيبة رجعت (لا يكون، لكن لا يُقصَّر الانتظار به)
  expect(waitLeft(5, 50_000, 10_000)).toBe(30_000);
});

test('العودة من الخلفية: بعد المهلة يُقفل وقبلها لا · والمعطّل لا يُقفل', () => {
  expect(lockOnReturn({ on: true, delay: 60 }, 59_000, 59_000)).toBe(false);
  expect(lockOnReturn({ on: true, delay: 60 }, 60_000, 60_000)).toBe(true);
  expect(lockOnReturn({ on: true, delay: 0 }, 0, 0)).toBe(true);
  expect(lockOnReturn({ on: false, delay: 0 }, 99_999, 99_999)).toBe(false);
  expect(lockOnReturn({ on: true, delay: 0 }, null, 99_999)).toBe(false);
});

test('المتحقق المستقل: ساعة الجهاز المُرجَعة لا تمنع القفل · والرتيبة وحدها تكفي', () => {
  // خرج ساعتين ثم أرجع ساعة الجهاز ثلاث ساعات: الفرق بساعة الجهاز سالب
  expect(lockOnReturn({ on: true, delay: 300 }, -3_600_000, 7_200_000)).toBe(true);
  // ساعة الجهاز أُرجعت إلى ما قبل المهلة والرتيبة تجاوزتها
  expect(lockOnReturn({ on: true, delay: 300 }, 10_000, 400_000)).toBe(true);
  // ونوم الجهاز قد لا تعدّه الرتيبة: ساعة الجهاز تكفي
  expect(lockOnReturn({ on: true, delay: 300 }, 400_000, 1_000)).toBe(true);
});

test('المتحقق المستقل: الخروج أثناء نافذة البصمة أو قوقل لا يُلغي القفل إلا لعودةٍ قصيرة', () => {
  const cfg = { on: true, delay: 0 as const };
  const away = { wall: 1_000_000, mono: 5_000, prompting: true };
  // عودةٌ قصيرة من النافذة: لا يُقفل
  expect(decideReturn(cfg, true, away, 1_000_000 + 3_000, 5_000 + 3_000)).toBe(false);
  // خرج والنافذة مفتوحة ثم غاب ساعة: يُقفل (كان الخروج يُمحى فلا يُقفل)
  expect(decideReturn(cfg, true, away, 1_000_000 + 3_600_000, 5_000 + 3_600_000)).toBe(true);
  // وبساعة الجهاز المُرجَعة لا يُعفى
  expect(decideReturn(cfg, true, away, 1_000_000 - 1, 5_000 + PROMPT_GRACE_MS)).toBe(true);
  // بلا نافذة: المهلة وحدها
  expect(decideReturn(cfg, true, { ...away, prompting: false }, 1_000_000 + 1, 5_001)).toBe(true);
  // لا خروج إلى الخلفية (inactive وحده): لا يُقفل
  expect(decideReturn(cfg, true, null, 0, 0)).toBe(false);
  // الإعداد لم يُعرف بعد والقفل مُعلَّم: يُقفل · وبلا علامة لا
  expect(decideReturn(null, true, away, 1_000_000 + 1, 5_001)).toBe(true);
  expect(decideReturn(null, false, away, 1_000_000 + 1, 5_001)).toBe(false);
});

test('إعدادٌ تعذّرت قراءته والقفل مُعلَّم مفعّلاً: يبقى القفل بقفل الجهاز ولا يسقط بصمت', () => {
  expect(parseLockConfig(null, true)).toMatchObject({ on: true, method: 'device' });
  expect(parseLockConfig('{bad', true)).toMatchObject({ on: true, method: 'device' });
  expect(parseLockConfig(null, false)).toMatchObject({ on: false });
  // رمزٌ بلا تجزئته يعامَل قفلَ الجهاز · ومهلةٌ غير معروفة تصير فوراً
  expect(parseLockConfig(JSON.stringify({ on: true, method: 'pin', delay: 999 }), true)).toMatchObject({ on: true, method: 'device', delay: 0 });
});

/* ═══ تأكيد الحساب (نسيان الرمز أو غياب قفل الجهاز) لا يمسّ الجلسة المحفوظة ═══ */

function fakeSession(chosenUid: string) {
  const kv = new Map<string, string>([[KEYS.uid, 'uid-owner-a'], [KEYS.refresh, 'r-owner-a'], [KEYS.email, 'a@example.test']]);
  const calls = { googleSignOut: 0, idp: 0 };
  const s = createSession({
    google: {
      signIn: async () => ({ idToken: 'tok-' + chosenUid, email: chosenUid + '@example.test' }),
      signInSilently: async () => true,
      accessToken: async () => 'acc',
      signOut: async () => { calls.googleSignOut++; },
    },
    store: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, v); }, del: async (k) => { kv.delete(k); } },
    signInWithIdp: async (t) => { calls.idp++; const uid = t.replace('tok-', ''); return { uid, email: uid + '@example.test', idToken: 'id-' + uid, refreshToken: 'r-' + uid, expiresAt: 9e15 }; },
    refresh: async (r) => ({ uid: 'x', idToken: 'id', refreshToken: r, expiresAt: 9e15 }),
  });
  return { s, kv, calls };
}

test('المتحقق المستقل: حسابٌ آخر في تأكيد الحساب يُرفض ولا يستبدل الجلسة المحفوظة', async () => {
  const { s, kv, calls } = fakeSession('uid-intruder-b');
  await s.restore();
  expect(await s.confirmSameAccount()).toBe(false);
  expect(kv.get(KEYS.uid)).toBe('uid-owner-a');
  expect(kv.get(KEYS.refresh)).toBe('r-owner-a');
  expect(s.current()?.uid).toBe('uid-owner-a');
  // والحساب المختار يُخرج من قوقل فلا تصير رموز Drive له
  expect(calls.googleSignOut).toBe(1);
});

test('تأكيد الحساب نفسه يُقبل ولا يكتب شيئاً', async () => {
  const { s, kv, calls } = fakeSession('uid-owner-a');
  await s.restore();
  const before = JSON.stringify([...kv]);
  expect(await s.confirmSameAccount()).toBe(true);
  expect(JSON.stringify([...kv])).toBe(before);
  expect(calls.googleSignOut).toBe(0);
  expect(calls.idp).toBe(1);
});

test('بلا جلسة محفوظة لا تأكيد', async () => {
  const { s, kv } = fakeSession('uid-owner-a');
  kv.clear();
  await s.restore();
  expect(await s.confirmSameAccount()).toBe(false);
});

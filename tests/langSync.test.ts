/**
 * لغة المستخدم تتبعه على أجهزته وتُزامَن مع حسابه، والافتراضي لغة الجهاز (قرار المالك ٢٠٢٦-١٠-٠٧) ·
 * الأحدث يغلب، ومستخدمٌ آخر على الجهاز لا يرث اختيار من قبله.
 */
import { reconcileLang, EMPTY_LANG_STATE } from '@/i18n/sync';
import { getCloudLang, putCloudLang } from '@/cloud/userPrefs';

const T1 = '2026-10-07T08:00:00.000Z';
const T2 = '2026-10-07T09:00:00.000Z';

test('أول دخول بلا اختيارٍ في الحساب: لغة الجهاز · وباختيارٍ فيه: يُطبَّق', () => {
  expect(reconcileLang(EMPTY_LANG_STATE, null, 'u1')).toEqual({ use: 'device', push: false, state: { pref: 'device', at: null, uid: 'u1', pending: false } });
  expect(reconcileLang(EMPTY_LANG_STATE, { pref: 'en', at: T1 }, 'u1').use).toBe('en');
});

test('اختيارٌ على الجهاز ينتظر الرفع يُرفع · إلا إن سبقه في الحساب أحدث منه من جهاز آخر', () => {
  const local = { pref: 'en' as const, at: T2, uid: 'u1', pending: true };
  expect(reconcileLang(local, { pref: 'ar', at: T1 }, 'u1')).toMatchObject({ use: 'en', push: true });
  expect(reconcileLang({ ...local, at: T1 }, { pref: 'ar', at: T2 }, 'u1')).toMatchObject({ use: 'ar', push: false });
});

test('جهازٌ ثانٍ يأخذ اختيار الحساب الأحدث · ومستخدمٌ آخر لا يرث اختيار الأول', () => {
  const local = { pref: 'ar' as const, at: T1, uid: 'u1', pending: false };
  expect(reconcileLang(local, { pref: 'en', at: T2 }, 'u1').use).toBe('en');
  expect(reconcileLang(local, { pref: 'ar', at: T1 }, 'u1')).toMatchObject({ use: 'ar', push: false });
  expect(reconcileLang({ ...local, pref: 'en' }, null, 'u2')).toMatchObject({ use: 'device', state: { uid: 'u2' } });
});

test('الحساب: يُقرأ الحقلان ويُكتبان بقناعهما وحدهما', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const store: Record<string, unknown> = {};
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === 'PATCH') { Object.assign(store, JSON.parse(String(init.body)).fields); return new Response('{}', { status: 200 }); }
    return Object.keys(store).length ? new Response(JSON.stringify({ fields: store }), { status: 200 }) : new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  const t = { projectId: 'demo', uid: 'u1', idToken: async () => 'tok', fetchImpl };
  expect(await getCloudLang(t)).toBeNull();
  await putCloudLang(t, { pref: 'en', at: T1 });
  expect(await getCloudLang(t)).toEqual({ pref: 'en', at: T1 });
  expect(calls[1].url).toContain('updateMask.fieldPaths=langPref&updateMask.fieldPaths=langAt');
  expect(calls[1].url).toContain('/documents/users/u1?');
});

test('اختيار اللغة قبل أول دخول يُرفع لحساب المستخدم ولا يُهمل', () => {
  const r = reconcileLang({ pref: 'en', at: '2026-01-02T00:00:00.000Z', uid: null, pending: true }, null, 'u-new');
  expect(r.use).toBe('en');
  expect(r.push).toBe(true);
  expect(r.state.uid).toBe('u-new');
  const older = reconcileLang({ pref: 'en', at: '2026-01-02T00:00:00.000Z', uid: null, pending: true }, { pref: 'ar', at: '2026-01-03T00:00:00.000Z' }, 'u-new');
  expect(older.use).toBe('ar');
});

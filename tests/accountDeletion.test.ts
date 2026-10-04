/**
 * «حذف حسابي» (الدراسة أ): حذف حساب Firebase بالرمز الحديث، وكل نسخ التطبيق على Drive · بشبكة مصطنعة.
 * وحذف بيانات السحابة بقواعده في tests/firestoreRules.emulator.test.ts على المحاكي الرسمي.
 */
import { deleteFirebaseAccount, AuthError } from '@/cloud/authRest';
import { deleteAllAppDataFiles, type DriveIO } from '@/cloud/drive';

const reply = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

test('حذف حساب Firebase: الطلب الصحيح · ودخولٌ قديم يُبلَّغ بالعربية', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const ok = (async (url: string, init: RequestInit) => { calls.push({ url, body: String(init.body) }); return reply(200); }) as unknown as typeof fetch;
  await deleteFirebaseAccount({ apiKey: 'KEY', fetchImpl: ok }, 'TOKEN-1');
  expect(calls).toEqual([{ url: 'https://identitytoolkit.googleapis.com/v1/accounts:delete?key=KEY', body: JSON.stringify({ idToken: 'TOKEN-1' }) }]);

  const old = (async () => reply(400, { error: { message: 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN' } })) as unknown as typeof fetch;
  await expect(deleteFirebaseAccount({ apiKey: 'KEY', fetchImpl: old }, 'T')).rejects.toThrow(AuthError);
  await expect(deleteFirebaseAccount({ apiKey: 'KEY', fetchImpl: old }, 'T')).rejects.toThrow(/دخول حديث/);
});

test('Drive: تُحذف كل نسخ التطبيق في مجلده الخاص صفحةً بعد صفحة · وفشل الحذف يُبلَّغ', async () => {
  let files = Array.from({ length: 7 }, (_, i) => ({ id: 'f' + i, name: 'نسخة ' + i, createdTime: '2026-10-01T00:00:00Z', size: '10' }));
  const deleted: string[] = [];
  const io = {
    fetch: async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        const id = url.slice(url.lastIndexOf('/') + 1);
        deleted.push(id);
        files = files.filter((f) => f.id !== id);
        return reply(204);
      }
      return reply(200, { files: files.slice(0, 3) }); // صفحات صغيرة
    },
  } as unknown as DriveIO;
  expect(await deleteAllAppDataFiles(io, 'T')).toBe(7);
  expect(deleted.sort()).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6']);

  const failing = { fetch: async (_u: string, init?: RequestInit) => (init?.method === 'DELETE' ? reply(500) : reply(200, { files: [{ id: 'x', name: 'n', createdTime: 't' }] })) } as unknown as DriveIO;
  await expect(deleteAllAppDataFiles(failing, 'T')).rejects.toThrow(/تعذّر حذف نسخة/);
});

/**
 * قواعد المحادثة على محاكي Firestore (firestore.rules · كتلة <chat>) بعميل المحادثة نفسه · بيانات مصطنعة:
 * الأطراف وحدهم يقرؤون · الرسالة بوقت الخادم ولا تُعدَّل ولا تُحذف · المجموعة للمالك والمشرف · لا مرفقات قبل الفوترة ·
 * وغير الأعضاء لا يصلون شيئاً.
 *   firebase emulators:exec --only firestore --project demo-aqari "npx jest tests/chat.emulator.test.ts"
 */
import { encodeFields } from '@/cloud/firestore';
import { ChatRemote } from '@/chat/remote';
import { directId } from '@/chat/types';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'CHATOWNER';
const d = HOST ? describe : describe.skip;

function token(uid: string, email = uid.toLowerCase() + '@example.test'): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const chat = (uid: string) => new ChatRemote({ projectId: PROJECT, org: ORG, uid, idToken: async () => token(uid), baseUrl: 'http://' + HOST });
const url = (path: string) => `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`;
async function put(path: string, data: Record<string, unknown>, uid: string, method = 'PATCH'): Promise<number> {
  const res = await fetch(url(path), { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) }, body: JSON.stringify({ fields: encodeFields(data) }) });
  return res.status;
}
async function del(path: string, uid: string): Promise<number> {
  return (await fetch(url(path), { method: 'DELETE', headers: { Authorization: 'Bearer ' + token(uid) } })).status;
}
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { return Number(/Firestore (\d+)/.exec(String(e))?.[1] ?? 0); } };

d('قواعد المحادثة', () => {
  const A = 'U-CHA';
  const B = 'U-CHB';
  const OUT = 'U-OUT';
  beforeAll(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    for (const u of [A, B]) {
      expect(await put(`orgs/${ORG}/members/${u}`, { email: u.toLowerCase() + '@example.test', perm: { contracts: 1 }, all: true, props: [], tokens: [] }, ORG)).toBe(200);
    }
  });

  test('الدليل: كل عضو يكتب اسمه ويقرأ الأسماء · ولا يكتب إشرافاً لم يمنحه المالك', async () => {
    expect(await status(chat(A).putMyDirectory('عضو مصطنع أ', []))).toBe(200);
    expect(await status(chat(B).putMyDirectory('عضو مصطنع ب', ['contracts']))).toBe(403);
    expect(await status(chat(ORG).setRole('u-chb@example.test', ['contracts']))).toBe(200);
    expect(await status(chat(B).setRole('u-cha@example.test', ['contracts']))).toBe(403);
    expect(await status(chat(B).putMyDirectory('عضو مصطنع ب', ['contracts']))).toBe(200);
    const dir = await chat(A).directory();
    expect(dir.map((x) => x.name).sort()).toEqual(['عضو مصطنع أ', 'عضو مصطنع ب']);
    await expect(chat(OUT).directory()).rejects.toThrow(/403/);
  });

  test('الفردية: أي عضو يراسل أي عضو · الأطراف وحدهم يقرؤون · ورقمها من طرفيها', async () => {
    const id = directId(A, B);
    expect(await chat(A).createThread({ id, k: 'direct', p: [A, B].sort(), name: '' })).toBe('created');
    expect(await chat(B).createThread({ id, k: 'direct', p: [A, B].sort(), name: '' })).toBe('exists');
    expect(await status(chat(A).createThread({ id: 'd_X_Y', k: 'direct', p: [A, B].sort(), name: '' }))).toBe(403);
    expect(await status(chat(A).sendMessage(id, { id: 'M1', name: 'أ', body: 'رسالة مصطنعة', link: { type: 'contract', id: 'C1', label: 'عقد مصطنع' } }))).toBe(200);
    expect(await chat(A).sendMessage(id, { id: 'M1', name: 'أ', body: 'مكررة', link: null })).toBe('exists');
    const got = await chat(B).messagesSince(id, null);
    expect(got.map((m) => [m.from, m.body, m.link?.label])).toEqual([[A, 'رسالة مصطنعة', 'عقد مصطنع']]);
    expect(got[0].ts).toMatch(/^\d{4}-/);
    expect((await chat(B).myThreads()).map((t) => t.id)).toEqual([id]);
    // المالك ليس طرفاً فيها: لا يقرؤها
    await expect(chat(ORG).messagesSince(id, null)).rejects.toThrow(/403/);
    await expect(chat(OUT).messagesSince(id, null)).rejects.toThrow(/403/);
  });

  test('الرسالة لا تُعدَّل ولا تُحذف · ولا يُنتحل مرسلها · ولا مرفقات قبل الفوترة · ولا وقت من الجهاز', async () => {
    const id = directId(A, B);
    const p = `orgs/${ORG}/chats/${id}/msgs/M1`;
    expect(await put(p, { from: A, name: 'أ', body: 'معدَّلة', link: null, att: null, ts: '2026-01-01T00:00:00Z' }, A)).toBe(403);
    expect(await del(p, A)).toBe(403);
    expect(await del(p, ORG)).toBe(403);
    expect(await put(`orgs/${ORG}/chats/${id}/msgs/M2`, { from: B, name: 'ب', body: 'منتحلة', link: null, att: null }, A)).toBe(403);
    expect(await put(`orgs/${ORG}/chats/${id}/msgs/M3`, { from: A, name: 'أ', body: 'بمرفق', link: null, att: { k: 'image' } }, A)).toBe(403);
    expect(await put(`orgs/${ORG}/chats/${id}/msgs/M4`, { from: A, name: 'أ', body: 'وقت الجهاز', link: null, att: null, ts: '2026-01-01T00:00:00Z' }, A)).toBe(403);
    expect(await del(`orgs/${ORG}/chats/${id}`, A)).toBe(403);
  });

  test('المجموعة: ينشئها المالك أو مشرف قسم · لا العضو العادي', async () => {
    expect(await status(chat(A).createThread({ id: 'g_member01', k: 'group', p: [A, B].sort(), name: 'مجموعة عضو' }))).toBe(403);
    expect(await chat(B).createThread({ id: 'g_super01', k: 'group', p: [A, B].sort(), name: 'مجموعة مشرف' })).toBe('created');
    expect(await chat(ORG).createThread({ id: 'g_owner01', k: 'group', p: [ORG, A, B].sort(), name: 'مجموعة المالك' })).toBe('created');
    expect(await status(chat(ORG).sendMessage('g_owner01', { id: 'G1', name: 'المالك', body: 'إعلان مصطنع', link: null }))).toBe(200);
    expect((await chat(A).messagesSince('g_owner01', null)).map((m) => m.body)).toEqual(['إعلان مصطنع']);
    // غير العضو لا ينشئ في المنشأة ولو جعل نفسه طرفاً
    expect(await status(chat(OUT).createThread({ id: directId(OUT, A), k: 'direct', p: [OUT, A].sort(), name: '' }))).toBe(403);
  });
});

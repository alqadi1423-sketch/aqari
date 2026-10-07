/**
 * قرارات المالك على مراجعة المحادثة (2026-10-07T18:06Z) على محاكي Firestore · بيانات مصطنعة:
 *  #2  «حذف حسابي»: المالك تُحذف محادثات منشأته كلها · والعضو يصير «عضو سابق» في رسائله ويخرج من الدليل
 *  #19 تعديل المجموعة للمالك ومنشئها · والمُزال من المنشأة يُزال من المجموعات والدليل والإشراف
 *  #28 «مسح كل البيانات» يشمل المحادثة (المسار نفسه: chatPurgeOrg في نافذة الحذف)
 */
import { encodeFields } from '@/cloud/firestore';
import { ChatRemote } from '@/chat/remote';
import { chatPurgeOrg, chatForgetMe, chatRemoveMember, FORMER_MEMBER, directId } from '@/chat';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'DECOWNER';
const d = HOST ? describe : describe.skip;

function token(uid: string, email = uid.toLowerCase() + '@example.test'): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return b({ alg: 'none', typ: 'JWT' }) + '.' + b({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: true, firebase: { sign_in_provider: 'google.com', identities: {} },
  }) + '.';
}
const session = (uid: string) => ({ projectId: PROJECT, uid, email: uid.toLowerCase() + '@example.test', idToken: async () => token(uid), baseUrl: 'http://' + HOST });
const chat = (uid: string) => new ChatRemote({ projectId: PROJECT, org: ORG, uid, idToken: async () => token(uid), baseUrl: 'http://' + HOST });
const url = (path: string) => `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`;
async function put(path: string, data: Record<string, unknown>, uid: string): Promise<number> {
  const res = await fetch(url(path), { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) }, body: JSON.stringify({ fields: encodeFields(data) }) });
  return res.status;
}
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { return Number(/Firestore (\d+)/.exec(String(e))?.[1] ?? 0); } };
const A = 'U-DCA';
const B = 'U-DCB';
const C = 'U-DCC';
const NAMES: Record<string, string> = { [A]: 'عضو أ مصطنع', [B]: 'عضو ب مصطنع', [C]: 'عضو ج مصطنع', [ORG]: 'منشأة قرارات مصطنعة' };

async function seed() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (const u of [A, B, C]) {
    expect(await put(`orgs/${ORG}/members/${u}`, { email: u.toLowerCase() + '@example.test', perm: { contracts: 1 }, all: true, props: [], tokens: [], name: NAMES[u] }, ORG)).toBe(200);
  }
  expect(await status(chat(ORG).setRole('u-dcb@example.test', ['contracts']))).toBe(200);
  for (const u of [ORG, A, B, C]) expect(await status(chat(u).putMyDirectory(NAMES[u], u === B ? ['contracts'] : []))).toBe(200);
  const dAB = directId(A, B);
  await chat(A).createThread({ id: dAB, k: 'direct', p: [A, B].sort(), name: '' });
  await chat(A).sendMessage(dAB, { id: 'MA1', name: NAMES[A], body: 'من أ', link: null });
  await chat(B).sendMessage(dAB, { id: 'MB1', name: NAMES[B], body: 'من ب', link: null });
  // مجموعة أنشأها المشرف ب، فيها أ وج · والمالك ليس طرفاً فيها
  await chat(B).createThread({ id: 'g_decgroup1', k: 'group', p: [A, B, C].sort(), name: 'مجموعة المشرف' });
  await chat(A).sendMessage('g_decgroup1', { id: 'MA2', name: NAMES[A], body: 'في المجموعة', link: null });
}

d('قرارات المالك على مراجعة المحادثة', () => {
  beforeEach(seed);

  test('#19 تعديل أعضاء المجموعة: منشئها والمالك · لا عضو آخر · ولا نوعها', async () => {
    expect(await status(chat(A).updateGroup('g_decgroup1', [A, B].sort(), 'معدَّلة'))).toBe(403);
    expect(await status(chat(B).updateGroup('g_decgroup1', [A, B].sort(), 'بلا ج'))).toBe(200);
    expect(await status(chat(ORG).updateGroup('g_decgroup1', [A, B, C].sort(), 'عاد ج'))).toBe(200);
    expect(await put(`orgs/${ORG}/chats/g_decgroup1`, { k: 'direct', p: [A, B, C].sort(), name: 'x', by: B }, B)).toBe(403);
    expect((await chat(C).myThreads()).map((t) => t.name)).toEqual(['عاد ج']);
  });

  test('#19 المالك يُزيل عضواً: يخرج من كل المجموعات ومن الدليل والإشراف · ولا يُفقد الوصول وحده', async () => {
    expect(await chatRemoveMember(session(ORG), ORG, B, 'u-dcb@example.test')).toBe(1);
    const g = (await chat(A).myThreads()).find((t) => t.id === 'g_decgroup1')!;
    expect(g.p).toEqual([A, C].sort());
    expect((await chat(A).directory()).map((x) => x.uid).sort()).toEqual([ORG, A, C].sort());
    expect(await chat(ORG).role('u-dcb@example.test')).toEqual([]);
  });

  test('#2 العضو يحذف حسابه: «عضو سابق» في رسائله وحدها · ويخرج من الدليل · ولا يغيّر غير اسمه', async () => {
    expect(await chatForgetMe(session(A), ORG)).toBe(2);
    const dAB = directId(A, B);
    const msgs = await chat(B).messagesSince(dAB, null);
    expect(msgs.map((m) => [m.from, m.name])).toEqual([[A, FORMER_MEMBER], [B, NAMES[B]]]);
    expect((await chat(C).messagesSince('g_decgroup1', null))[0].name).toBe(FORMER_MEMBER);
    expect((await chat(B).directory()).map((x) => x.uid)).not.toContain(A);
    // لا يغيّر اسم غيره ولا يضع اسماً آخر
    expect(await put(`orgs/${ORG}/chats/${dAB}/msgs/MB1?updateMask.fieldPaths=name`, { name: FORMER_MEMBER }, A)).toBe(403);
    expect(await put(`orgs/${ORG}/chats/${dAB}/msgs/MA1?updateMask.fieldPaths=name`, { name: 'اسم منتحل' }, A)).toBe(403);
    expect(await put(`orgs/${ORG}/chats/${dAB}/msgs/MA1?updateMask.fieldPaths=body`, { body: 'معدَّلة' }, A)).toBe(403);
  });

  test('#2 و#28 المالك: محادثات المنشأة كلها تُحذف في نافذة الحذف وحدها · ولو لم يكن طرفاً فيها', async () => {
    const dAB = directId(A, B);
    // بلا نافذة: لا حذف ولا سرد لرسائل ليس طرفاً فيها
    expect(await status(chat(ORG).deleteIn(`chats/${dAB}/msgs/MA1`))).toBe(403);
    await expect(chat(ORG).messagesSince(dAB, null)).rejects.toThrow(/403/);
    expect(await chatPurgeOrg(session(ORG), ORG)).toBe(3);
    expect(await chat(A).myThreads()).toEqual([]);
    expect(await chat(A).directory()).toEqual([]);
    expect(await chat(B).role('u-dcb@example.test')).toEqual([]);
    // أُغلقت النافذة بعده
    const meta = await fetch(url(`orgs/${ORG}/meta/deletion`), { headers: { Authorization: 'Bearer ' + token(ORG) } });
    expect(meta.status).toBe(404);
  });
});

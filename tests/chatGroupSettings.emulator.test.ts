/**
 * إعدادات المجموعة ومسؤولوها (قرار المالك 2026-10-08T05:31Z) على محاكي Firestore · بيانات مصطنعة:
 *  - تُحدَّد عند الإنشاء: سجل المنضم (كل السابق افتراضاً أو من لحظة انضمامه) · من يرسل · من يضيف.
 *  - الاسم والإعدادات للمسؤولين وحدهم · والمسؤولون: المالك دائماً، والمنشئ، ومن يعيّنه أحدهما من أعضائها.
 *  - الإضافة عضواً واحداً في الالتزام بوقت انضمامه من الخادم · والإزالة للمالك والمنشئ (#19) · والمغادرة لصاحبها.
 */
import { encodeFields } from '@/cloud/firestore';
import { ChatRemote } from '@/chat/remote';
import { chatForgetMe, FORMER_MEMBER } from '@/chat';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'GSOWNER';
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
async function readDoc(path: string, uid: string): Promise<number> {
  return (await fetch(url(path), { headers: { Authorization: 'Bearer ' + token(uid) } })).status;
}
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { return Number(/Firestore (\d+)/.exec(String(e))?.[1] ?? 0); } };

const A = 'U-GSA';
const B = 'U-GSB';
const C = 'U-GSC';
const D = 'U-GSD';
const E = 'U-GSE';
const OUT_OF_GROUP = E;
const NAMES: Record<string, string> = { [A]: 'عضو أ مصطنع', [B]: 'مشرف ب مصطنع', [C]: 'عضو ج مصطنع', [D]: 'عضو د مصطنع', [E]: 'عضو هـ مصطنع', [ORG]: 'منشأة إعدادات مصطنعة' };
const G = 'g_settings01';
const send = (u: string, id: string, body: string, g = G) => status(chat(u).sendMessage(g, { id, name: NAMES[u], body, link: null }));

async function seed(s: { h?: 'all' | 'join'; w?: 'all' | 'admins'; ad?: 'admins' | 'all' } = {}) {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (const u of [A, B, C, D, E]) {
    expect(await put(`orgs/${ORG}/members/${u}`, { email: u.toLowerCase() + '@example.test', perm: { contracts: 1 }, all: true, props: [], tokens: [], name: NAMES[u] }, ORG)).toBe(200);
  }
  expect(await status(chat(ORG).setRole('u-gsb@example.test', ['contracts']))).toBe(200);
  for (const u of [ORG, A, B, C, D, E]) expect(await status(chat(u).putMyDirectory(NAMES[u], u === B ? ['contracts'] : []))).toBe(200);
  expect(await chat(B).createThread({ id: G, k: 'group', p: [A, B, C].sort(), name: 'مجموعة إعدادات', s: { h: s.h ?? 'all', w: s.w ?? 'all', ad: s.ad ?? 'admins' }, a: [] })).toBe('created');
  expect(await send(B, 'GA1', 'قبل الانضمام')).toBe(200);
}

d('إعدادات المجموعة ومسؤولوها (2026-10-08T05:31Z)', () => {
  test('الإنشاء بالإعدادات · وقيمة غير معروفة تُرفض · والمسؤول المعيَّن من أعضائها', async () => {
    await seed({ h: 'join', w: 'admins', ad: 'all' });
    const t = await chat(B).getThread(G);
    expect(t.s).toEqual({ h: 'join', w: 'admins', ad: 'all' });
    expect(await status(chat(B).createThread({ id: 'g_bad000001', k: 'group', p: [A, B].sort(), name: 'x', s: { h: 'never' } as never, a: [] }))).toBe(403);
    // مسؤول ليس من أعضائها مرفوض
    expect(await status(chat(B).createThread({ id: 'g_bad000002', k: 'group', p: [A, B].sort(), name: 'x', s: {}, a: [D] }))).toBe(403);
  });

  test('الاسم والإعدادات للمسؤولين: المنشئ والمالك ومن يعيّنه أحدهما · وتعيين المسؤولين للمالك والمنشئ وحدهما', async () => {
    await seed();
    expect(await status(chat(A).setGroupMeta(G, { name: 'من عضو' }))).toBe(403);
    expect(await status(chat(A).setGroupMeta(G, { s: { h: 'join', w: 'all', ad: 'admins' } }))).toBe(403);
    expect(await status(chat(B).setGroupMeta(G, { name: 'من المنشئ' }))).toBe(200);
    // المالك مسؤول دائماً ولو لم يكن فيها
    expect(await status(chat(ORG).setGroupMeta(G, { s: { h: 'all', w: 'all', ad: 'all' } }))).toBe(200);
    // المنشئ يعيّن أ مسؤولاً · فيعدّل أ الاسم · ولا يعيّن أ غيره
    expect(await status(chat(B).setGroupMeta(G, { a: [A] }))).toBe(200);
    expect(await status(chat(A).setGroupMeta(G, { name: 'من مسؤول معيَّن' }))).toBe(200);
    expect(await status(chat(A).setGroupMeta(G, { a: [A, C].sort() }))).toBe(403);
    expect(await status(chat(ORG).setGroupMeta(G, { a: [A, C].sort() }))).toBe(200);
  });

  test('من يضيف: المسؤولون وحدهم افتراضاً، أو كل الأعضاء · عضواً واحداً بوقت الخادم', async () => {
    await seed();
    // عضوان في التزام واحد مرفوض (قبل إضافة أيٍّ منهما)
    const both = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents:commit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(B) },
      body: JSON.stringify({ writes: [{
        update: { name: `projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/chats/${G}`, fields: encodeFields({ la: D }) },
        updateMask: { fieldPaths: ['la'] },
        updateTransforms: [
          { fieldPath: 'p', appendMissingElements: { values: [{ stringValue: D }, { stringValue: E }] } },
          { fieldPath: 'jt.`' + D + '`', setToServerValue: 'REQUEST_TIME' },
        ],
      }] }) });
    expect(both.status).toBe(403);
    expect(await status(chat(C).addMember(G, D))).toBe(403);
    expect(await status(chat(B).addMember(G, D))).toBe(200);
    // وقت انضمام من الجهاز مرفوض (مفتاحه وحده في الخريطة، بلا مسّ مفاتيح غيره)
    expect(await put(`orgs/${ORG}/chats/${G}?updateMask.fieldPaths=p&updateMask.fieldPaths=la&updateMask.fieldPaths=${encodeURIComponent('jt.`' + E + '`')}`,
      { p: [A, B, C, D, E].sort(), jt: { [E]: new Date('2020-01-01T00:00:00Z') }, la: E }, B)).toBe(403);
    // وقت انضمام لمفتاح غير المضاف مرفوض
    const otherKey = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents:commit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(B) },
      body: JSON.stringify({ writes: [{
        update: { name: `projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/chats/${G}`, fields: encodeFields({ la: E }) },
        updateMask: { fieldPaths: ['la'] },
        updateTransforms: [
          { fieldPath: 'p', appendMissingElements: { values: [{ stringValue: E }] } },
          { fieldPath: 'jt.`' + E + '`', setToServerValue: 'REQUEST_TIME' },
          { fieldPath: 'jt.`' + A + '`', setToServerValue: 'REQUEST_TIME' },
        ],
      }] }) });
    expect(otherKey.status).toBe(403);
    // ولا يُضاف من ليس عضواً في المنشأة
    expect(await status(chat(B).addMember(G, 'U-NOBODY'))).toBe(403);
    // ولا تتغير la ولا jt بلا إضافة
    expect(await put(`orgs/${ORG}/chats/${G}?updateMask.fieldPaths=la`, { la: A }, B)).toBe(403);
    expect(await status(chat(B).setGroupMeta(G, { s: { h: 'all', w: 'all', ad: 'all' } }))).toBe(200);
    expect(await status(chat(C).addMember(G, E))).toBe(200);
    expect((await chat(B).getThread(G)).p).toEqual([A, B, C, D, E].sort());
  });

  test('من يرسل: كل الأعضاء أو المسؤولون وحدهم', async () => {
    await seed({ w: 'admins' });
    expect(await send(C, 'GC1', 'من عضو')).toBe(403);
    expect(await send(B, 'GB1', 'من المنشئ')).toBe(200);
    expect(await status(chat(B).setGroupMeta(G, { a: [C] }))).toBe(200);
    expect(await send(C, 'GC2', 'من مسؤول معيَّن')).toBe(200);
  });

  test('سجل المنضم: كل السابق افتراضاً · أو من لحظة انضمامه، يفرضه الخادم', async () => {
    await seed({ h: 'join' });
    expect(await status(chat(B).addMember(G, D))).toBe(200);
    expect(await send(B, 'GA2', 'بعد انضمام د')).toBe(200);
    // د لا يقرأ ما قبل انضمامه ولو طلبه باسمه · ويقرأ ما بعده
    expect(await readDoc(`orgs/${ORG}/chats/${G}/msgs/GA1`, D)).toBe(403);
    await expect(chat(D).messagesSince(G, null)).rejects.toThrow(/403/);
    const t = await chat(D).getThread(G);
    await expect(chat(D).messagesSince(G, t.jt![D])).rejects.toThrow(/403/);
    expect((await chat(D).messagesSinceJoined(G, t.jt![D])).map((m) => m.body)).toEqual(['بعد انضمام د']);
    // ولا يطلب رسالة قبل انضمامه بالطريق نفسه
    await expect(chat(D).messagesSinceJoined(G, '2000-01-01T00:00:00Z')).rejects.toThrow(/403/);
    // والأعضاء الأوائل يقرؤون كل شيء (وقت انضمامهم وقت إنشائها) · بالطريق نفسه، فالسرد لا يُجاز في هذه المجموعة
    await expect(chat(C).messagesSince(G, null)).rejects.toThrow(/403/);
    expect((await chat(C).messagesSinceJoined(G, t.at!)).length).toBe(2);
    // وفي «كل السابق» يقرأ المضاف كل شيء
    expect(await status(chat(B).setGroupMeta(G, { s: { h: 'all', w: 'all', ad: 'admins' } }))).toBe(200);
    expect((await chat(D).messagesSince(G, null)).length).toBe(2);
  });

  test('الأطراف بلا تكرار ولا إعادة ترتيب ولا حشو · ولا مسؤول من غير أعضائها · ولا مفتاح غريب في الإعدادات', async () => {
    await seed();
    for (const u of [A, OUT_OF_GROUP]) {
      expect(await put(`orgs/${ORG}/chats/${G}?updateMask.fieldPaths=p`, { p: [C, B, A] }, u)).toBe(403);
      expect(await put(`orgs/${ORG}/chats/${G}?updateMask.fieldPaths=p`, { p: [A, B, C, C] }, u)).toBe(403);
      expect(await put(`orgs/${ORG}/chats/${G}?updateMask.fieldPaths=p`, { p: [A, B, C, ...Array.from({ length: 50 }, () => A)] }, u)).toBe(403);
    }
    // ولو كان المنشئ: التكرار مرفوض
    expect(await put(`orgs/${ORG}/chats/${G}?updateMask.fieldPaths=p`, { p: [A, B, C, C] }, B)).toBe(403);
    expect(await status(chat(B).setGroupMeta(G, { a: [D] }))).toBe(403);
    expect(await status(chat(B).setGroupMeta(G, { s: { h: 'all', w: 'all', ad: 'admins', x: 1 } as never }))).toBe(403);
  });

  test('مراجعة المالك تقرأ مجموعة «من لحظة انضمامه» · وإن انضم المالك فمن لحظة انضمامه', async () => {
    await seed({ h: 'join' });
    await chat(ORG).openReview(G, 'سبب مصطنع');
    expect((await chat(ORG).messagesSince(G, null)).map((m) => m.body)).toEqual(['قبل الانضمام']);
    await chat(ORG).closeReview(G);
    await chat(ORG).joinGroup(G, NAMES[ORG]);
    expect(await readDoc(`orgs/${ORG}/chats/${G}/msgs/GA1`, ORG)).toBe(403);
  });

  test('#2 في «من لحظة انضمامه»: من أُزيل ثم أُضيف يجعل رسائله الأولى «عضو سابق» عند حذف حسابه', async () => {
    await seed({ h: 'join' });
    expect(await status(chat(B).addMember(G, D))).toBe(200);
    expect(await send(D, 'GD1', 'من د أولاً')).toBe(200);
    expect(await status(chat(B).removeMembers(G, [D]))).toBe(200);
    expect(await status(chat(B).addMember(G, D))).toBe(200);
    expect(await chatForgetMe(session(D), ORG)).toBe(1);
    const t = await chat(B).getThread(G);
    expect((await chat(B).messagesSinceJoined(G, t.at!)).find((m) => m.id === 'GD1')!.name).toBe(FORMER_MEMBER);
  });

  test('الإزالة للمالك والمنشئ (#19) · والمغادرة لصاحبها، ومعها خروجه من المسؤولين', async () => {
    await seed();
    expect(await status(chat(B).setGroupMeta(G, { a: [A] }))).toBe(200);
    // المسؤول المعيَّن لا يزيل غيره
    expect(await status(chat(A).removeMembers(G, [C]))).toBe(403);
    expect(await status(chat(C).removeMembers(G, [A]))).toBe(403);
    expect(await status(chat(B).removeMembers(G, [C]))).toBe(200);
    expect(await status(chat(A).leaveGroup(G))).toBe(200);
    const t = await chat(B).getThread(G);
    expect([t.p, t.a]).toEqual([[B], []]);
  });

  test('انضمام المالك ما زال بسطره · ويصير له وقت انضمام', async () => {
    await seed({ h: 'join' });
    await chat(ORG).joinGroup(G, NAMES[ORG]);
    const t = await chat(A).getThread(G);
    expect(t.p).toContain(ORG);
    expect(typeof t.jt![ORG]).toBe('string');
    const msgs = await chat(A).messagesSinceJoined(G, t.at!);
    expect(msgs[msgs.length - 1].sys).toBe('join');
  });
});

/**
 * المحادثة · الدفعة ٢ (قرار المالك 2026-10-08T05:31Z · المرحلة أ) على محاكي Firestore · بيانات مصطنعة:
 *  الرد في سلسلة · التثبيت · الإشارة لشخص أو قسم · إشعار القراءة ومن قرأ (والمسودات على الجهاز وحده)
 */
import { encodeFields } from '@/cloud/firestore';
import { ChatRemote } from '@/chat/remote';
import { directId } from '@/chat';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'B2OWNER';
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
async function put(path: string, data: Record<string, unknown>, uid: string): Promise<number> {
  const res = await fetch(url(path), { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) }, body: JSON.stringify({ fields: encodeFields(data) }) });
  return res.status;
}
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { return Number(/Firestore (\d+)/.exec(String(e))?.[1] ?? 0); } };

const A = 'U-B2A';
const B = 'U-B2B';
const C = 'U-B2C';
const OUT = 'U-B2OUT';
const NAMES: Record<string, string> = { [A]: 'عضو أ مصطنع', [B]: 'مشرف ب مصطنع', [C]: 'عضو ج مصطنع', [ORG]: 'منشأة مصطنعة' };
const G = 'g_batch20001';
const dAB = directId(A, B);

async function seed() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (const u of [A, B, C]) {
    expect(await put(`orgs/${ORG}/members/${u}`, { email: u.toLowerCase() + '@example.test', perm: { contracts: 1 }, all: true, props: [], tokens: [], name: NAMES[u] }, ORG)).toBe(200);
  }
  expect(await status(chat(ORG).setRole('u-b2b@example.test', ['contracts']))).toBe(200);
  for (const u of [ORG, A, B, C]) expect(await status(chat(u).putMyDirectory(NAMES[u], u === B ? ['contracts'] : []))).toBe(200);
  await chat(B).createThread({ id: G, k: 'group', p: [A, B, C].sort(), name: 'مجموعة الدفعة ٢', s: {}, a: [] });
  await chat(A).createThread({ id: dAB, k: 'direct', p: [A, B].sort(), name: '' });
  expect(await status(chat(B).sendMessage(G, { id: 'P1', name: NAMES[B], body: 'رسالة أصل', link: null }))).toBe(200);
}

d('المحادثة · الدفعة ٢ (2026-10-08T05:31Z)', () => {
  beforeEach(seed);

  test('الرد في سلسلة: يشير إلى رسالة في المحادثة نفسها · لا إلى غائبة', async () => {
    expect(await status(chat(A).sendMessage(G, { id: 'R1', name: NAMES[A], body: 'رد', link: null, re: 'P1' }))).toBe(200);
    expect(await status(chat(A).sendMessage(G, { id: 'R2', name: NAMES[A], body: 'رد على غائبة', link: null, re: 'NOPE' }))).toBe(403);
    const msgs = await chat(C).messagesSince(G, null);
    expect(msgs.find((m) => m.id === 'R1')!.re).toBe('P1');
  });

  test('الإشارة لشخص أو قسم: قائمة محدودة بصيغتها', async () => {
    expect(await status(chat(A).sendMessage(G, { id: 'M1', name: NAMES[A], body: 'إلى ج وقسم العقود', link: null, men: ['u:' + C, 's:contracts'] }))).toBe(200);
    expect(await status(chat(A).sendMessage(G, { id: 'M2', name: NAMES[A], body: 'ليست قائمة', link: null, men: 'u:x' as never }))).toBe(403);
    expect(await status(chat(A).sendMessage(G, { id: 'M3', name: NAMES[A], body: 'كثيرة', link: null, men: Array.from({ length: 31 }, (_, i) => 'u:' + i) }))).toBe(403);
    expect((await chat(C).messagesSince(G, null)).find((m) => m.id === 'M1')!.men).toEqual(['u:' + C, 's:contracts']);
  });

  test('التثبيت: في المجموعة للمسؤولين · وفي الفردية للطرفين · ولرسالة موجودة', async () => {
    expect(await status(chat(A).setPin(G, 'P1', true))).toBe(403);
    expect(await status(chat(B).setPin(G, 'P1', true))).toBe(200);
    expect(await status(chat(B).setPin(G, 'NOPE', true))).toBe(403);
    expect(await status(chat(A).sendMessage(dAB, { id: 'D1', name: NAMES[A], body: 'فردية', link: null }))).toBe(200);
    expect(await status(chat(B).setPin(dAB, 'D1', true))).toBe(200);
    const st = await chat(C).stateSince(G, null);
    expect(st.map((x) => [x.id, x.k, x.on])).toEqual([['p_P1', 'pin', true]]);
    expect(await status(chat(B).setPin(G, 'P1', false))).toBe(200);
    expect((await chat(C).stateSince(G, null))[0].on).toBe(false);
  });

  test('إشعار القراءة: كلٌّ يكتب قراءته وحده بوقت لا يسبق ولا يتجاوز · ويقرؤها أطراف المحادثة', async () => {
    const msgs = await chat(A).messagesSince(G, null);
    expect(await status(chat(A).markReadUpTo(G, msgs[0].ts))).toBe(200);
    // لا يكتب قراءة غيره · ولا وقتاً في المستقبل
    const forged = await fetch(url(`orgs/${ORG}/chats/${G}/st/r_${C}`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(A) },
      body: JSON.stringify({ fields: { k: { stringValue: 'read' }, at: { timestampValue: msgs[0].ts } } }) });
    expect(forged.status).toBe(403);
    expect(await status(chat(A).markReadUpTo(G, '2999-01-01T00:00:00Z'))).toBe(403);
    const st = await chat(B).stateSince(G, null);
    expect(st.find((x) => x.id === 'r_' + A)!.at).toBe(msgs[0].ts);
    // غير الطرف لا يقرأ الحال
    await expect(chat(OUT).stateSince(G, null)).rejects.toThrow(/403/);
    await expect(chat(C).stateSince(dAB, null)).rejects.toThrow(/403/);
  });
});

d('المحادثة · الدفعة ٢ · المسح (#2 و#28) يصل حال المحادثة', () => {
  test('التثبيت والقراءة تُحذف مع المحادثة في نافذة الحذف', async () => {
    await seed();
    expect(await status(chat(B).setPin(G, 'P1', true))).toBe(200);
    const msgs = await chat(A).messagesSince(G, null);
    expect(await status(chat(A).markReadUpTo(G, msgs[0].ts))).toBe(200);
    const { chatPurgeOrg } = await import('@/chat');
    const session = { projectId: PROJECT, uid: ORG, email: 'b2owner@example.test', idToken: async () => token(ORG), baseUrl: 'http://' + HOST };
    expect(await chatPurgeOrg(session, ORG)).toBe(1);
    const st = await fetch(url(`orgs/${ORG}/chats/${G}/st`), { headers: { Authorization: 'Bearer owner' } });
    expect(((await st.json()) as { documents?: unknown[] }).documents ?? []).toEqual([]);
  });
});

d('المحادثة · الدفعة ٢ · ثغرات مسدودة', () => {
  beforeEach(seed);

  test('صيغة الإشارات ورقم الأصل · والأصل من المحادثة نفسها', async () => {
    expect(await status(chat(A).sendMessage(G, { id: 'X1', name: NAMES[A], body: 'صيغة خاطئة', link: null, men: ['x:1'] }))).toBe(403);
    expect(await status(chat(A).sendMessage(G, { id: 'X2', name: NAMES[A], body: 'طويلة', link: null, men: ['u:' + 'a'.repeat(200)] }))).toBe(403);
    expect(await status(chat(A).sendMessage(dAB, { id: 'D0', name: NAMES[A], body: 'في الفردية', link: null }))).toBe(200);
    // أصلٌ من محادثة أخرى · ورقم بحروف ممنوعة
    expect(await status(chat(A).sendMessage(G, { id: 'X3', name: NAMES[A], body: 'رد عابر', link: null, re: 'D0' }))).toBe(403);
    expect(await status(chat(A).sendMessage(G, { id: 'X4', name: NAMES[A], body: 'رقم مسار', link: null, re: 'P1/x' }))).toBe(403);
  });

  test('التثبيت والقراءة: لا لغير الطرف · ولا مفاتيح زائدة ولا وقت من الجهاز ولا تثبيت باسم غيره ولا لرسالة من محادثة أخرى', async () => {
    expect(await status(chat(A).sendMessage(dAB, { id: 'D1X', name: NAMES[A], body: 'في الفردية', link: null }))).toBe(200);
    // رسالة موجودة في الفردية: الرفض لأنه ليس طرفاً لا لغياب الرسالة
    expect(await status(chat(C).setPin(dAB, 'D1X', true))).toBe(403);
    expect(await status(chat(C).markReadUpTo(dAB, '2026-01-01T00:00:00Z'))).toBe(403);
    const raw = (sid: string, fields: Record<string, unknown>, uid: string) => fetch(url(`orgs/${ORG}/chats/${G}/st/${sid}`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) }, body: JSON.stringify({ fields }) });
    expect((await raw('p_P1', { k: { stringValue: 'pin' }, on: { booleanValue: true }, by: { stringValue: B }, ts: { timestampValue: '2026-01-01T00:00:00Z' } }, B)).status).toBe(403);
    // مفتاح زائد مع وقت الخادم
    const extra = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents:commit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(B) },
      body: JSON.stringify({ writes: [{ update: { name: `projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/chats/${G}/st/p_P1`,
        fields: { k: { stringValue: 'pin' }, on: { booleanValue: true }, by: { stringValue: B }, x: { stringValue: '1' } } },
        updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }] }] }) });
    expect(extra.status).toBe(403);
    const forgedBy = await fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents:commit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(B) },
      body: JSON.stringify({ writes: [{ update: { name: `projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/chats/${G}/st/p_P1`,
        fields: { k: { stringValue: 'pin' }, on: { booleanValue: true }, by: { stringValue: A } } },
        updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }] }] }) });
    expect(forgedBy.status).toBe(403);
    // رسالة الفردية لا تُثبَّت في المجموعة
    expect(await status(chat(A).sendMessage(dAB, { id: 'D2', name: NAMES[A], body: 'فردية', link: null }))).toBe(200);
    expect(await status(chat(B).setPin(G, 'D2', true))).toBe(403);
  });

  test('المالك لا يقرأ حال محادثة ليس طرفاً فيها إلا بمراجعتها', async () => {
    await expect(chat(ORG).stateSince(dAB, null)).rejects.toThrow(/403/);
    await chat(ORG).openReview(dAB, 'سبب مصطنع');
    expect(await chat(ORG).stateSince(dAB, null)).toEqual([]);
    await chat(ORG).closeReview(dAB);
  });
});

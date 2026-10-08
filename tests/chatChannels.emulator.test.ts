/**
 * المحادثة · الدفعة ٤ (قرار المالك 2026-10-08T05:31Z · المرحلة أ) على محاكي Firestore · بيانات مصطنعة:
 *  قنوات الأقسام وإضافة العضو إلى قنوات أقسامه · قناة إعلانات الإدارة · محادثة لكل عقار يراها من له صلاحية عليه
 *  والصلاحية تُفرض في القواعد من مستند العضوية نفسه: من سُحبت صلاحيته لا يقرأ ولا يرسل ولو بقي في أطرافها
 */
import { encodeFields } from '@/cloud/firestore';
import { ChatRemote } from '@/chat/remote';
import { channelId } from '@/chat';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'B4OWNER';
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

// أ: العقود على كل العقارات · ب: الصيانة على العقار P1 وحده · ج: لا قسم
const A = 'U-B4A';
const B = 'U-B4B';
const C = 'U-B4C';
const NAMES: Record<string, string> = { [A]: 'عضو أ مصطنع', [B]: 'عضو ب مصطنع', [C]: 'عضو ج مصطنع', [ORG]: 'منشأة مصطنعة' };
const SEC = channelId({ t: 'section', key: 'contracts' });
const ANN = channelId({ t: 'announce' });
const P1 = channelId({ t: 'prop', id: 'P1' });
const P2 = channelId({ t: 'prop', id: 'P2' });

async function member(u: string, perm: Record<string, number>, all: boolean, props: string[]) {
  expect(await put(`orgs/${ORG}/members/${u}`, { email: u.toLowerCase() + '@example.test', perm, all, props, tokens: [], name: NAMES[u] }, ORG)).toBe(200);
}
async function seed() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await member(A, { contracts: 2 }, true, []);
  await member(B, { maintenance: 1 }, false, ['P1']);
  await member(C, {}, false, []);
  for (const u of [ORG, A, B, C]) expect(await status(chat(u).putMyDirectory(NAMES[u], []))).toBe(200);
  for (const [id, ch, name] of [[SEC, { t: 'section', key: 'contracts' }, 'العقود'], [ANN, { t: 'announce' }, 'إعلانات الإدارة'],
    [P1, { t: 'prop', id: 'P1' }, 'عقار أ'], [P2, { t: 'prop', id: 'P2' }, 'عقار ب']] as const) {
    expect(await chat(ORG).createChannel(id, ch, name)).toBe('created');
  }
}

d('المحادثة · الدفعة ٤: القنوات ومحادثات العقارات (2026-10-08T05:31Z)', () => {
  beforeEach(seed);

  test('القناة ينشئها المالك وحده · ورقمها من نوعها', async () => {
    expect(await status(chat(A).createChannel(channelId({ t: 'section', key: 'claims' }), { t: 'section', key: 'claims' }, 'المطالبات'))).toBe(403);
    // رقم لا يطابق نوعها
    expect(await status(chat(ORG).createChannel('g_sec_claims', { t: 'section', key: 'contracts' }, 'خطأ'))).toBe(403);
  });

  test('قناة القسم: ينضم إليها من له صلاحية على القسم وحده', async () => {
    expect(await status(chat(A).addMember(SEC, A))).toBe(200);
    expect(await status(chat(B).addMember(SEC, B))).toBe(403);
    expect(await status(chat(C).addMember(SEC, C))).toBe(403);
    // ولا يُدخل غيره بحجة القناة
    expect(await status(chat(A).addMember(SEC, C))).toBe(403);
  });

  test('قناة إعلانات الإدارة: ينضم إليها كل عضو · ويرسل فيها المسؤولون وحدهم', async () => {
    for (const u of [A, B, C]) expect(await status(chat(u).addMember(ANN, u))).toBe(200);
    expect(await status(chat(ORG).sendMessage(ANN, { id: 'AN1', name: NAMES[ORG], body: 'إعلان مصطنع', link: null }))).toBe(200);
    expect(await status(chat(A).sendMessage(ANN, { id: 'AN2', name: NAMES[A], body: 'من عضو', link: null }))).toBe(403);
    expect((await chat(C).messagesSince(ANN, null)).map((m) => m.body)).toEqual(['إعلان مصطنع']);
  });

  test('محادثة العقار: ينضم إليها من له صلاحية على العقار (كل العقارات أو هذا بعينه)', async () => {
    expect(await status(chat(A).addMember(P1, A))).toBe(200);
    expect(await status(chat(B).addMember(P1, B))).toBe(200);
    expect(await status(chat(B).addMember(P2, B))).toBe(403);
    expect(await status(chat(C).addMember(P1, C))).toBe(403);
  });

  test('من سُحبت صلاحيته لا يقرأ ولا يرسل ولو بقي في أطرافها · والمجموعة العادية لا يُنضم إليها هكذا', async () => {
    expect(await status(chat(A).addMember(SEC, A))).toBe(200);
    expect(await status(chat(ORG).sendMessage(SEC, { id: 'S1', name: NAMES[ORG], body: 'للعقود', link: null }))).toBe(200);
    expect((await chat(A).messagesSince(SEC, null)).length).toBe(1);
    await member(A, { props: 1 }, true, []);
    await expect(chat(A).messagesSince(SEC, null)).rejects.toThrow(/403/);
    expect(await status(chat(A).sendMessage(SEC, { id: 'S2', name: NAMES[A], body: 'بعد السحب', link: null }))).toBe(403);
    // المالك يزيله
    expect(await status(chat(ORG).removeMembers(SEC, [A]))).toBe(200);
    // مجموعة عادية: الانضمام الذاتي مرفوض
    await chat(ORG).createThread({ id: 'g_normal0001', k: 'group', p: [ORG, B].sort(), name: 'عادية', s: {}, a: [] });
    expect(await status(chat(C).addMember('g_normal0001', C))).toBe(403);
  });
});

d('المحادثة · الدفعة ٤ · ثغرات مسدودة', () => {
  beforeEach(seed);

  test('لا مجموعة عادية برقم قناة · ولا قناة بغير المالك وحده · ولا بمفاتيح زائدة · والرقم من النوع لكل نوع', async () => {
    expect(await put(`orgs/${ORG}/members/${A}`, { email: 'u-b4a@example.test', perm: { contracts: 2 }, all: true, props: [], tokens: [], name: NAMES[A] }, ORG)).toBe(200);
    expect(await status(chat(ORG).createThread({ id: 'g_sec_claims', k: 'group', p: [ORG, A].sort(), name: 'منتحلة', s: {}, a: [] }))).toBe(403);
    expect(await status(chat(ORG).createThread({ id: 'g_prop_P9', k: 'group', p: [ORG, A].sort(), name: 'منتحلة', s: {}, a: [] }))).toBe(403);
    const raw = (id: string, p: string[], ch: Record<string, unknown>) => fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents:commit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(ORG) },
      body: JSON.stringify({ writes: [{ update: { name: `projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/chats/${id}`,
        fields: encodeFields({ k: 'group', p, name: 'قناة', by: ORG, s: {}, a: [], ch }) }, currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }] }] }) }).then((r) => r.status);
    expect(await raw('g_sec_claims', [ORG, A], { t: 'section', key: 'claims' })).toBe(403);
    expect(await raw('g_sec_claims', [ORG], { t: 'section', key: 'claims', x: 1 })).toBe(403);
    expect(await raw('g_prop_P9', [ORG], { t: 'prop', id: 'P8' })).toBe(403);
    expect(await raw('g_announce2', [ORG], { t: 'announce' })).toBe(403);
    expect(await raw('g_sec_claims', [ORG], { t: 'section', key: 'claims' })).toBe(200);
  });

  test('من سُحبت صلاحيته لا يعدّل رسالته في القناة ولا يكتب حالها · ولا يقرأ سجل تعديلها', async () => {
    expect(await status(chat(A).addMember(SEC, A))).toBe(200);
    expect(await status(chat(A).sendMessage(SEC, { id: 'SA1', name: NAMES[A], body: 'قبل', link: null }))).toBe(200);
    expect(await status(chat(A).editMessage(SEC, 'SA1', 'قبل معدَّلة', null))).toBe(200);
    await member(A, { props: 1 }, true, []);
    expect(await status(chat(A).editMessage(SEC, 'SA1', 'بعد السحب', null))).toBe(403);
    // والتزام التعديل كاملاً بلا قراءة قبله (فالرفض لقاعدة التعديل نفسها لا لمنع القراءة)
    const docsRoot = `projects/${PROJECT}/databases/(default)/documents`;
    const base = `${docsRoot}/orgs/${ORG}/chats/${SEC}`;
    const raw = await fetch(`http://${HOST}/v1/${docsRoot}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(A) },
      body: JSON.stringify({ writes: [
        { update: { name: `${base}/msgs/SA1`, fields: { ...encodeFields({ body: 'بعد السحب', tag: null }), ev: { integerValue: '2' } } },
          updateMask: { fieldPaths: ['body', 'tag', 'ev'] }, currentDocument: { exists: true }, updateTransforms: [{ fieldPath: 'et', setToServerValue: 'REQUEST_TIME' }] },
        { update: { name: `${base}/msgs/SA1/edits/2`, fields: encodeFields({ body: 'قبل معدَّلة', tag: null }) }, currentDocument: { exists: false },
          updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }] },
        { update: { name: `${base}/ids/SA1`, fields: { ev: { integerValue: '2' } } }, updateMask: { fieldPaths: ['ev'] }, currentDocument: { exists: true } },
        { update: { name: `${base}/st/x_SA1`, fields: { ...encodeFields({ k: 'edit', m: 'SA1' }), n: { integerValue: '2' } } },
          updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }] },
      ] }) });
    expect(raw.status).toBe(403);
    expect(await status(chat(A).markReadUpTo(SEC, '2026-01-01T00:00:00Z'))).toBe(403);
    await expect(chat(A).editsOf(SEC, 'SA1')).rejects.toThrow(/403/);
  });

  test('في القناة لا يُدخل المسؤول المعيَّن ولا «كل الأعضاء» من لا تحق له · والمالك يُدخل', async () => {
    expect(await status(chat(A).addMember(SEC, A))).toBe(200);
    expect(await status(chat(ORG).setGroupMeta(SEC, { a: [A], s: { h: 'all', w: 'all', ad: 'all' } }))).toBe(200);
    expect(await status(chat(A).addMember(SEC, C))).toBe(403);
    expect(await status(chat(ORG).addMember(SEC, C))).toBe(200);
  });
});

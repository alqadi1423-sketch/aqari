/**
 * المحادثة · الدفعة ٥ (قرار المالك 2026-10-08T05:31Z · المرحلة أ) على محاكي Firestore · بيانات مصطنعة:
 *  تحويل رسالة إلى مهمة بمسؤول وموعد · والاستطلاعات (والتحويل إلى مطالبة أو فاتورة شراء بمسارات الخدمة على الجهاز)
 */
import { encodeFields } from '@/cloud/firestore';
import { ChatRemote } from '@/chat/remote';
import { chatPurgeOrg, directId } from '@/chat';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'B5OWNER';
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

const A = 'U-B5A';
const B = 'U-B5B';
const C = 'U-B5C';
const NAMES: Record<string, string> = { [A]: 'عضو أ مصطنع', [B]: 'مشرف ب مصطنع', [C]: 'عضو ج مصطنع', [ORG]: 'منشأة مصطنعة' };
const G = 'g_batch50001';
const dAB = directId(A, B);

async function seed() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (const u of [A, B, C]) {
    expect(await put(`orgs/${ORG}/members/${u}`, { email: u.toLowerCase() + '@example.test', perm: { contracts: 1 }, all: true, props: [], tokens: [], name: NAMES[u] }, ORG)).toBe(200);
  }
  expect(await status(chat(ORG).setRole('u-b5b@example.test', ['contracts']))).toBe(200);
  for (const u of [ORG, A, B, C]) expect(await status(chat(u).putMyDirectory(NAMES[u], u === B ? ['contracts'] : []))).toBe(200);
  await chat(B).createThread({ id: G, k: 'group', p: [A, B].sort(), name: 'مجموعة الدفعة ٥', s: {}, a: [] });
  await chat(A).createThread({ id: dAB, k: 'direct', p: [A, B].sort(), name: '' });
  expect(await status(chat(A).sendMessage(G, { id: 'M1', name: NAMES[A], body: 'اصلحوا المكيف', link: null }))).toBe(200);
}

d('المحادثة · الدفعة ٥ (2026-10-08T05:31Z)', () => {
  beforeEach(seed);

  test('الرسالة مهمة بمسؤول من أطرافها وموعد · ينجزها مسؤولها أو منشئها · ويعدّلها منشئها', async () => {
    expect(await status(chat(A).setTask(G, 'M1', { title: 'إصلاح المكيف', as: B, due: '2026-12-31', done: false }))).toBe(200);
    // مسؤول ليس من أطرافها · وموعد بغير صيغته · ورسالة غائبة
    expect(await status(chat(A).setTask(G, 'M1', { title: 'x', as: C, due: '2026-12-31', done: false }))).toBe(403);
    expect(await status(chat(A).setTask(G, 'M1', { title: 'x', as: B, due: '31/12/2026', done: false }))).toBe(403);
    expect(await status(chat(A).setTask(G, 'NOPE', { title: 'x', as: B, due: '2026-12-31', done: false }))).toBe(403);
    // المسؤول ينجزها ولا يغيّر غير ذلك · والمنشئ يعدّلها
    // المسؤول ينجزها بكتابة الإنجاز وحده
    expect(await status(chat(B).setTaskDone(G, 'M1', true))).toBe(200);
    expect(await status(chat(B).setTask(G, 'M1', { title: 'تغيير العنوان', as: B, due: '2026-12-31', done: true }))).toBe(403);
    expect(await status(chat(A).setTask(G, 'M1', { title: 'إصلاح المكيف والتسريب', as: B, due: '2027-01-15', done: true }))).toBe(200);
    // غير الطرف لا يقرأ ولا يكتب
    expect(await status(chat(C).setTask(G, 'M1', { title: 'x', as: B, due: '2026-12-31', done: false }))).toBe(403);
    const st = await chat(B).stateSince(G, null);
    expect(st.filter((x) => x.k === 'task').map((x) => [x.m, x.title, x.as, x.due, x.done, x.by]))
      .toEqual([['M1', 'إصلاح المكيف والتسريب', B, '2027-01-15', true, A]]);
  });

  test('الاستطلاع: خيارات بين ٢ و١٠ · وكلٌّ يصوّت لنفسه بخيارٍ (أو أكثر إن سُمح) ويغيّر صوته', async () => {
    expect(await status(chat(B).sendMessage(G, { id: 'P1', name: NAMES[B], body: 'موعد الاجتماع؟', link: null, poll: { o: ['الأحد', 'الاثنين'], m: false } }))).toBe(200);
    expect(await status(chat(B).sendMessage(G, { id: 'P2', name: NAMES[B], body: 'خيار واحد', link: null, poll: { o: ['وحده'], m: false } }))).toBe(403);
    expect(await status(chat(B).sendMessage(G, { id: 'P3', name: NAMES[B], body: 'أكثر', link: null, poll: { o: Array.from({ length: 11 }, (_, i) => 'خ' + i), m: false } }))).toBe(403);
    expect(await status(chat(A).vote(G, 'P1', [1]))).toBe(200);
    expect(await status(chat(A).vote(G, 'P1', [0]))).toBe(200);
    // خياران في استطلاع خيارٍ واحد · ورقم خارج الحد · وتصويت باسم غيره · ولرسالة ليست استطلاعاً
    expect(await status(chat(A).vote(G, 'P1', [0, 1]))).toBe(403);
    expect(await status(chat(A).vote(G, 'P1', [12]))).toBe(403);
    expect(await put(`orgs/${ORG}/chats/${G}/st/v_P1_${B}`, { k: 'vote', m: 'P1', by: B, o: [0] }, A)).toBe(403);
    expect(await status(chat(A).vote(G, 'M1', [0]))).toBe(403);
    const st = await chat(B).stateSince(G, null);
    expect(st.filter((x) => x.k === 'vote').map((x) => [x.m, x.by, x.o])).toEqual([['P1', A, [0]]]);
  });

  test('#2 و#28: المسح يحذف المهام والأصوات مع المحادثة', async () => {
    expect(await status(chat(A).setTask(G, 'M1', { title: 'مهمة', as: B, due: '2026-12-31', done: false }))).toBe(200);
    expect(await status(chat(B).sendMessage(G, { id: 'P1', name: NAMES[B], body: 'استطلاع', link: null, poll: { o: ['نعم', 'لا'], m: false } }))).toBe(200);
    expect(await status(chat(A).vote(G, 'P1', [0]))).toBe(200);
    expect(await chatPurgeOrg(session(ORG), ORG)).toBe(2);
    const st = await fetch(url(`orgs/${ORG}/chats/${G}/st`), { headers: { Authorization: 'Bearer owner' } });
    expect(((await st.json()) as { documents?: unknown[] }).documents ?? []).toEqual([]);
  });
});

const docs = `projects/${PROJECT}/databases/(default)/documents`;
/** كتابة حالٍ خامة بوقت الخادم · بلا قراءة قبلها */
const rawSt = (uid: string, sid: string, fields: Record<string, unknown>, mask?: string[]) => fetch(`http://${HOST}/v1/${docs}:commit`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) },
  body: JSON.stringify({ writes: [{ update: { name: `${docs}/orgs/${ORG}/chats/${G}/st/${sid}`, fields: encodeFields(fields) },
    ...(mask ? { updateMask: { fieldPaths: mask } } : {}), updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }] }] }) }).then((r) => r.status);

d('المحادثة · الدفعة ٥ · كل قاعدة وحدها', () => {
  beforeEach(seed);

  test('المهمة بالكتابة الخامة: غير الطرف · وثالثٌ ليس منشئاً ولا مسؤولاً · والمنشئ لا يغيّر منشئها · والمسؤول لا يغيّر موعدها', async () => {
    const task = { k: 'task', m: 'M1', title: 'مهمة', as: B, due: '2026-12-31', done: false, by: A };
    expect(await rawSt(C, 't_M1', { ...task, by: C })).toBe(403);
    expect(await rawSt(A, 't_M1', task)).toBe(200);
    // طرفٌ ثالث في المجموعة
    expect(await status(chat(B).addMember(G, C))).toBe(200);
    expect(await rawSt(C, 't_M1', { ...task, done: true }, ['done'])).toBe(403);
    expect(await rawSt(A, 't_M1', { ...task, by: B })).toBe(403);
    expect(await rawSt(B, 't_M1', { ...task, due: '2027-01-01' }, ['due'])).toBe(403);
    expect(await rawSt(B, 't_M1', { ...task, done: true }, ['done'])).toBe(200);
  });

  test('المهمة: لا في مجموعة إرسالها للمسؤولين لغيرهم · ولا لسطر نظام · والإنجاز وحده لا يُرجع غيره', async () => {
    expect(await status(chat(B).setGroupMeta(G, { s: { h: 'all', w: 'admins', ad: 'admins' } }))).toBe(200);
    expect(await status(chat(A).setTask(G, 'M1', { title: 'x', as: B, due: '2026-12-31', done: false }))).toBe(403);
    expect(await status(chat(B).setGroupMeta(G, { s: { h: 'all', w: 'all', ad: 'admins' } }))).toBe(200);
    await chat(ORG).joinGroup(G, NAMES[ORG]);
    const line = (await chat(A).messagesSince(G, null)).find((m) => m.sys === 'join')!;
    expect(await status(chat(A).setTask(G, line.id, { title: 'سطر نظام', as: B, due: '2026-12-31', done: false }))).toBe(403);
    expect(await status(chat(A).setTask(G, 'M1', { title: 'أصل', as: B, due: '2026-12-31', done: false }))).toBe(200);
    expect(await status(chat(B).setTaskDone(G, 'M1', true))).toBe(200);
    // المنشئ يعدّل بنسخةٍ قديمة الإنجاز فيبقى منجزاً
    expect(await status(chat(A).setTask(G, 'M1', { title: 'أصل معدَّل', as: B, due: '2027-01-01', done: false }))).toBe(200);
    const t = (await chat(B).stateSince(G, null)).find((x) => x.k === 'task')!;
    expect([t.title, t.due, t.done]).toEqual(['أصل معدَّل', '2027-01-01', true]);
  });

  test('الاستطلاع: رقم الخيار دون عددها · ومتعدد الاختيار بلا تكرار · وتصويت باسم غيره بوقت الخادم', async () => {
    expect(await status(chat(B).sendMessage(G, { id: 'PM', name: NAMES[B], body: 'متعدد', link: null, poll: { o: ['أ', 'ب', 'ج'], m: true } }))).toBe(200);
    expect(await status(chat(A).vote(G, 'PM', [0, 1]))).toBe(200);
    expect(await status(chat(A).vote(G, 'PM', [3]))).toBe(403);
    expect(await rawSt(A, 'v_PM_' + A, { k: 'vote', m: 'PM', by: A, o: [0, 0] })).toBe(403);
    expect(await rawSt(A, 'v_PM_' + B, { k: 'vote', m: 'PM', by: B, o: [0] })).toBe(403);
    // خيارات غير نصية لا تُرفض في القواعد (join يقبل الأعداد) · والجهاز يعرضها نصاً · مذكورٌ في DESIGN
  });
});

d('المحادثة · الدفعة ٥ · المسؤول المنضم بعد الرسالة', () => {
  beforeEach(seed);

  test('في «من لحظة انضمامه»: مسؤولٌ انضم بعد الرسالة ينجز مهمتها · ولا ينشئ مهمةً لرسالةٍ قبل انضمامه', async () => {
    expect(await status(chat(B).setGroupMeta(G, { s: { h: 'join', w: 'all', ad: 'admins' } }))).toBe(200);
    expect(await status(chat(B).addMember(G, C))).toBe(200);
    expect(await status(chat(A).setTask(G, 'M1', { title: 'لمن انضم بعدها', as: C, due: '2026-12-31', done: false }))).toBe(200);
    expect(await status(chat(C).setTaskDone(G, 'M1', true))).toBe(200);
    // ولا ينشئ مهمة لرسالة قبل انضمامه
    expect(await status(chat(A).sendMessage(G, { id: 'M2', name: NAMES[A], body: 'أخرى', link: null }))).toBe(200);
    expect(await rawSt(C, 't_M1x', { k: 'task', m: 'M1', title: 'x', as: C, due: '2026-12-31', done: false, by: C })).toBe(403);
  });
});

d('أجوبة المالك 2026-10-08T10:24Z', () => {
  beforeEach(seed);

  test('#٢ الإعلان المهم بتأكيد الاطلاع للمسؤولين وحدهم · وفي الفردية للمالك', async () => {
    expect(await status(chat(A).sendMessage(G, { id: 'K1', name: NAMES[A], body: 'من عضو', link: null, ack: true }))).toBe(403);
    expect(await status(chat(B).sendMessage(G, { id: 'K2', name: NAMES[B], body: 'من المنشئ', link: null, ack: true }))).toBe(200);
    expect(await status(chat(A).sendMessage(dAB, { id: 'K3', name: NAMES[A], body: 'في الفردية', link: null, ack: true }))).toBe(403);
    // العادي بلا تأكيد كما كان
    expect(await status(chat(A).sendMessage(G, { id: 'K4', name: NAMES[A], body: 'عادية', link: null }))).toBe(200);
  });

  test('#٧ المهمة يلغيها منشئها فتبقى «ملغاة» · ولا ينجزها مسؤولها بعد الإلغاء · ولا يلغيها غير منشئها', async () => {
    expect(await status(chat(A).setTask(G, 'M1', { title: 'تُلغى', as: B, due: '2026-12-31', done: false }))).toBe(200);
    expect(await status(chat(B).cancelTask(G, 'M1'))).toBe(403);
    expect(await status(chat(A).cancelTask(G, 'M1'))).toBe(200);
    expect(await status(chat(B).setTaskDone(G, 'M1', true))).toBe(403);
    const t = (await chat(B).stateSince(G, null)).find((x) => x.k === 'task')!;
    expect([t.cx, t.done]).toEqual([true, false]);
  });

  test('تحقق الدمج ف١: الملغاة تبقى ملغاة · لا يعدّلها منشئها ولا يعيدها، فلا يُسقط التعديلُ إلغاءها', async () => {
    expect(await status(chat(A).setTask(G, 'M1', { title: 'تُلغى', as: B, due: '2026-12-31', done: false }))).toBe(200);
    expect(await status(chat(A).cancelTask(G, 'M1'))).toBe(200);
    expect(await status(chat(A).setTask(G, 'M1', { title: 'معدّلة', as: B, due: '2027-01-01', done: false }))).toBe(403);
    // ولا إعادة بكتابة الإلغاء وحده · بوقت الخادم كما يكتب التطبيق، فلا يُرفض لغير الإلغاء (التحقق الثاني)
    const commit = (cx: boolean) => fetch(`http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents:commit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(A) },
      body: JSON.stringify({ writes: [{
        update: { name: `projects/${PROJECT}/databases/(default)/documents/orgs/${ORG}/chats/${G}/st/t_M1`, fields: encodeFields({ cx }) },
        updateMask: { fieldPaths: ['cx'] }, currentDocument: { exists: true },
        updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }] }] }) });
    expect((await commit(false)).status).toBe(403);
    const t = (await chat(B).stateSince(G, null)).find((x) => x.k === 'task')!;
    expect([t.title, t.cx]).toEqual(['تُلغى', true]);
  });

  test('تحقق الدمج ف٣: منشئ المهمة يلغيها ولو غادر مسؤولها المجموعة · ولا يعدّلها إلى مسؤول ليس من أطرافها', async () => {
    expect(await status(chat(A).setTask(G, 'M1', { title: 'مسؤولها يغادر', as: B, due: '2026-12-31', done: false }))).toBe(200);
    expect(await status(chat(A).sendMessage(G, { id: 'M2', name: NAMES[A], body: 'ثانية', link: null }))).toBe(200);
    expect(await status(chat(A).setTask(G, 'M2', { title: 'تبقى', as: B, due: '2026-12-31', done: false }))).toBe(200);
    expect(await status(chat(B).leaveGroup(G))).toBe(200);
    expect(await status(chat(A).setTask(G, 'M2', { title: 'تعديل', as: B, due: '2026-12-31', done: false }))).toBe(403);
    expect(await status(chat(A).cancelTask(G, 'M1'))).toBe(200);
    const t = (await chat(A).stateSince(G, null)).find((x) => x.id === 't_M1')!;
    expect(t.cx).toBe(true);
  });
});

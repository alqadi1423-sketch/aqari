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
    // المالك مسؤول دائماً ولو لم يكن فيها: الاسم · والإعدادات لطرفٍ فيها وحده (المراجعة الخارجية ٧ · النتيجة ١٦)
    expect(await status(chat(ORG).setGroupMeta(G, { name: 'من المالك' }))).toBe(200);
    expect(await status(chat(ORG).setGroupMeta(G, { s: { h: 'all', w: 'all', ad: 'all' } }))).toBe(403);
    expect(await status(chat(B).setGroupMeta(G, { s: { h: 'all', w: 'all', ad: 'all' } }))).toBe(200);
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
    // وقت انضمام من الجهاز مرفوض (مفتاحه وحده في الخريطة بقيمة وقتٍ صحيحة النوع، بلا مسّ مفاتيح غيره)
    const forged = await fetch(url(`orgs/${ORG}/chats/${G}?updateMask.fieldPaths=p&updateMask.fieldPaths=la&updateMask.fieldPaths=${encodeURIComponent('jt.`' + E + '`')}`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(B) },
      body: JSON.stringify({ fields: { ...encodeFields({ p: [A, B, C, D, E].sort(), la: E }),
        jt: { mapValue: { fields: { [E]: { timestampValue: '2020-01-01T00:00:00Z' } } } } } }) });
    expect(forged.status).toBe(403);
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

/* ═══ المراجعة الخارجية ٧ · النتيجة ١٦ (قرار المالك «رابعاً ٩»: «تُغلق الثغرتان، فالقرار وعد للأعضاء») ═══ */
d('المراجعة الخارجية ٧ · النتيجة ١٦: المالك لا يقرأ ما قبل انضمامه بلا مراجعة ولا يدخل بلا سطر', () => {
  test('(أ) سلبي: المالك من خارج مجموعة «من لحظة انضمامه» لا يقلبها إلى «كل السابق» · ولا مع انضمامه', async () => {
    await seed({ h: 'join' });
    expect(await status(chat(ORG).setGroupMeta(G, { s: { h: 'all', w: 'all', ad: 'admins' } }))).toBe(403);
    // ولا قبل انضمامه في الالتزام نفسه: المسار كله كما وصفته المراجعة ينتهي بلا قراءة لما قبل انضمامه
    await chat(ORG).joinGroup(G, NAMES[ORG]);
    expect(await readDoc(`orgs/${ORG}/chats/${G}/msgs/GA1`, ORG)).toBe(403);
    expect((await chat(B).getThread(G)).s).toEqual({ h: 'join', w: 'all', ad: 'admins' });
  });

  test('(أ) إيجابي: المنشئ (طرفٌ مسؤول) يغيّر الإعدادات · والمالك بعد انضمامه بسطره مسؤولٌ يغيّرها', async () => {
    await seed({ h: 'join' });
    expect(await status(chat(B).setGroupMeta(G, { s: { h: 'join', w: 'admins', ad: 'admins' } }))).toBe(200);
    await chat(ORG).joinGroup(G, NAMES[ORG]);
    expect(await status(chat(ORG).setGroupMeta(G, { s: { h: 'join', w: 'all', ad: 'all' } }))).toBe(200);
  });

  test('(ب) سلبي: المنشئ أو المسؤول أو أي طرفٍ بإذن الإضافة لا يضيف المالك بلا سطر «انضم المالك»', async () => {
    await seed({ ad: 'all' });
    expect(await status(chat(B).addMember(G, ORG))).toBe(403);
    expect(await status(chat(B).setGroupMeta(G, { a: [A] }))).toBe(200);
    expect(await status(chat(A).addMember(G, ORG))).toBe(403);
    expect(await status(chat(C).addMember(G, ORG))).toBe(403);
    expect((await chat(B).getThread(G)).p).not.toContain(ORG);
  });

  test('(ب) إيجابي: المالك ينضم بنفسه بسطره · والمنشئ يضيف عضواً كما كان', async () => {
    await seed();
    expect(await status(chat(B).addMember(G, D))).toBe(200);
    await chat(ORG).joinGroup(G, NAMES[ORG]);
    const t = await chat(B).getThread(G);
    expect(t.p).toContain(ORG);
    expect((await chat(B).messagesSince(G, null)).some((m) => m.sys === 'join' && m.from === ORG)).toBe(true);
  });
});

/* ═══ المراجعة الخارجية ٧ · النتيجة ١٧ (قرار المالك «رابعاً ١٠»: «شارة دور مشتقة من المعرّف لا من النص، وقيد على الاسم») ═══ */
d('المراجعة الخارجية ٧ · النتيجة ١٧: العضو لا يسمّي نفسه بما يحاكي المالك أو المشرف', () => {
  const self = (name: string) => put(`orgs/${ORG}/members/${A}?updateMask.fieldPaths=name&updateMask.fieldPaths=phone`, { name, phone: '0500000017' }, A);

  test('سلبي: اسمٌ فيه «المالك» أو «مالك المنشأة» أو الفاصلان أو عنوانٌ إنجليزي يُرفض · ولو بعد سطرٍ جديد', async () => {
    await seed();
    for (const name of ['عضو أ مصطنع · المالك', 'المالك', 'مالك المنشأة', 'مشرف: العقود', 'عضو · مشرف', 'The OWNER', 'Supervisor', 'عضو مصطنع\nالمالك']) {
      expect(await self(name)).toBe(403);
    }
    // ولا يبلغ الدليلَ اسمٌ غير اسم عضويته
    expect(await status(chat(A).putMyDirectory('عضو أ مصطنع · مالك المنشأة', []))).toBe(403);
  });

  test('إيجابي: اسمٌ عادي (ولو فيه «مالك» أو «مشرف» اسماً) يُقبل ويبلغ الدليل · والمالك يكتب أسماء أعضائه كما كان', async () => {
    await seed();
    for (const name of ['عضو أ معدل' /* الجهاز ينزع التشكيل قبل الحفظ (الجولة ٢٨) */, 'مالك مصطنع', 'مشرف مصطنع']) expect(await self(name)).toBe(200);
    expect(await status(chat(A).putMyDirectory('مشرف مصطنع', []))).toBe(200);
    expect(await put(`orgs/${ORG}/members/${C}?updateMask.fieldPaths=name`, { name: 'عضو ج من المالك' }, ORG)).toBe(200);
  });
});

/* ═══ المتحقق المستقل، الجولة ٢٨ على efeb306 ═══ */
d('الجولة ٢٨: المالك لا يدخل المجموعة بلا سطره ولو بمستند عضوية · والاسم لا يحاكي المحجوز بحرفٍ شبيه', () => {
  test('١٦ سلبي: المالك لا ينشئ مستند عضويةٍ لنفسه · ومع وجوده لا يضيفه المنشئ بلا سطر انضمامه', async () => {
    await seed({ h: 'join' });
    expect(await put(`orgs/${ORG}/members/${ORG}`, { email: 'gsowner@example.test', perm: { contracts: 2 }, all: true, props: [], tokens: [], name: 'منشأة' }, ORG)).toBe(403);
    // مستندٌ قائم (بذره المدير): الإضافة من غير المالك مرفوضة كما كانت بلا مستند
    const res = await fetch(url(`orgs/${ORG}/members/${ORG}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ fields: encodeFields({ email: 'gsowner@example.test', perm: { contracts: 2 }, all: true, props: [], tokens: [], name: 'منشأة' }) }) });
    await res.text();
    expect(res.status).toBe(200);
    expect(await status(chat(B).addMember(G, ORG))).toBe(403);
    expect((await chat(B).getThread(G)).p).not.toContain(ORG);
  });

  test('١٧ سلبي: التطويل والتشكيل والحروف الشبيهة والعريضة لا تمرّ · والاسم العربي واللاتيني العادي يمرّ', async () => {
    await seed();
    const self = (name: string) => put(`orgs/${ORG}/members/${A}?updateMask.fieldPaths=name&updateMask.fieldPaths=phone`, { name, phone: '0500000028' }, A);
    for (const name of ['عضو أ المـالك', 'عضو أ المالِك', 'عضو أ \u30FB المالك', 'عضو أ \u2027 مالك', 'Member \u043Ewner', 'Member \uFF2F\uFF37\uFF2E\uFF25\uFF32', 'عضو \u2022 ب', 'عضو\u200Fالمالك']) {
      expect(await self(name)).toBe(403);
    }
    for (const name of ['عبدالله بن مصطنع', "O'Neil Test-Name", 'عضو ٢ مصطنع', 'گل مصطنع']) expect(await self(name)).toBe(200);
  });
});

/* ═══ المراجعة الخارجية ٧ · النتائج ٣٧ و٣٨ و٣٩ ═══ */
d('المراجعة الخارجية ٧ · المحادثة المباشرة بين أطرافٍ حقيقيين برقمٍ واحد · والمنشئ المُزال لا يدير', () => {
  test('٣٨ و٣٧ سلبي: المباشرة بترتيبٍ معكوس أو مع غير عضو تُرفض · وإيجابي: مع عضو ومع المالك تُقبل', async () => {
    await seed();
    expect(await status(chat(A).createThread({ id: 'd_' + B + '_' + A, k: 'direct', p: [B, A], name: '' }))).toBe(403);
    const ghost = 'U-NOT-A-MEMBER';
    const pg = [A, ghost].sort();
    expect(await status(chat(A).createThread({ id: 'd_' + pg[0] + '_' + pg[1], k: 'direct', p: pg, name: '' }))).toBe(403);
    expect(await chat(A).createThread({ id: 'd_' + A + '_' + B, k: 'direct', p: [A, B], name: '' })).toBe('created');
    const po = [A, ORG].sort();
    expect(await chat(A).createThread({ id: 'd_' + po[0] + '_' + po[1], k: 'direct', p: po, name: '' })).toBe('created');
  });

  test('٣٩ سلبي: المنشئ بعد إزالته لا يعيد نفسه ولا يُزيل ولا يعيّن · وإيجابي: قبل إزالته يدير', async () => {
    await seed();
    expect(await status(chat(B).addMember(G, D))).toBe(200);
    expect(await status(chat(B).removeMembers(G, [D]))).toBe(200);
    expect(await status(chat(ORG).removeMembers(G, [B]))).toBe(200);
    expect(await status(chat(B).addMember(G, B))).toBe(403);
    expect(await status(chat(B).removeMembers(G, [A]))).toBe(403);
    expect(await status(chat(B).setGroupMeta(G, { a: [A] }))).toBe(403);
    expect((await chat(A).getThread(G)).p).toEqual(expect.arrayContaining([A, C]));
  });
});

d('الجولة ٢٩: الحروف الشبيهة لا تمرّ في القواعد', () => {
  test('١٧ سلبي: الكاف الفارسية والمزخرفة وألف الوصل والأرقام الشبيهة · وإيجابي: اسمٌ فيه رقم أو حرفٌ فارسي عادي', async () => {
    await seed();
    const self = (name: string) => put(`orgs/${ORG}/members/${A}?updateMask.fieldPaths=name&updateMask.fieldPaths=phone`, { name, phone: '0500000029' }, A);
    for (const name of ['عضو أ المال\u06A9', 'عضو أ \u0671لمالك', 'عضو أ المال\u06AA', 'Ali 0wner', 'Ali 5upervisor', 'Ali Superv1sor', 'Ali SUPERVlSOR', 'Ali Ovvner']) expect(await self(name)).toBe(403);
    for (const name of ['گل مصطنع', 'Ali 5', 'عضو ١٠١']) expect(await self(name)).toBe(200);
  });
});

d('الجولة ٣١: المحجوز كلمةٌ كاملة في القواعد', () => {
  test('١٧ إيجابي: «عبد المالك» و«Downer» مقبولان · وسلبي: «المالك» و«Owner» كلمتين مرفوضتان', async () => {
    await seed();
    const self = (name: string) => put(`orgs/${ORG}/members/${A}?updateMask.fieldPaths=name&updateMask.fieldPaths=phone`, { name, phone: '0500000031' }, A);
    for (const name of ['عبد المالك الشهري', 'عبدالمالك سعيد', 'Downer Smith']) expect(await self(name)).toBe(200);
    for (const name of ['عضو المالك', 'Ali Owner', 'Supervisor Ali']) expect(await self(name)).toBe(403);
  });
});

d('الجولة ٣٢: الرقم الملاصق للمحجوز حدُّ كلمة في القواعد', () => {
  test('١٧ سلبي: «المالك1» و«owner1» مرفوضان · وإيجابي: «Bill 1» و«محمد المالكي» مقبولان', async () => {
    await seed();
    const self = (name: string) => put(`orgs/${ORG}/members/${A}?updateMask.fieldPaths=name&updateMask.fieldPaths=phone`, { name, phone: '0500000032' }, A);
    for (const name of ['محمد المالك1', 'محمد 1المالك', 'Ali owner1', 'Ali 3owner']) expect(await self(name)).toBe(403);
    for (const name of ['Bill 1', 'محمد المالكي']) expect(await self(name)).toBe(200);
  });
});

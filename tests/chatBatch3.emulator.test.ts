/**
 * المحادثة · الدفعة ٣ (قرار المالك 2026-10-08T05:31Z · المرحلة أ) على محاكي Firestore · بيانات مصطنعة:
 *  الإعلان المهم بتأكيد الاطلاع ومن أكّد · تعديل الرسالة بسجل تعديلاتها (والحذف ممنوع) · الوسوم (عاجل، قرار، متابعة)
 *  (والبحث بالتاريخ والشخص على الجهاز وحده)
 */
import { encodeFields } from '@/cloud/firestore';
import { ChatRemote } from '@/chat/remote';
import { chatPurgeOrg, directId } from '@/chat';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'B3OWNER';
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
const docs = `projects/${PROJECT}/databases/(default)/documents`;
async function put(path: string, data: Record<string, unknown>, uid: string): Promise<number> {
  const res = await fetch(url(path), { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) }, body: JSON.stringify({ fields: encodeFields(data) }) });
  return res.status;
}
async function commit(uid: string, writes: unknown[]): Promise<number> {
  return (await fetch(`http://${HOST}/v1/${docs}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) }, body: JSON.stringify({ writes }) })).status;
}
const ADMIN = { Authorization: 'Bearer owner' };
async function adminList(path: string): Promise<string[]> {
  const j = (await (await fetch(url(path), { headers: ADMIN })).json()) as { documents?: Array<{ name: string }> };
  return (j.documents ?? []).map((x) => x.name.slice(x.name.lastIndexOf('/') + 1));
}
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { return Number(/Firestore (\d+)/.exec(String(e))?.[1] ?? 0); } };

const A = 'U-B3A';
const B = 'U-B3B';
const C = 'U-B3C';
const NAMES: Record<string, string> = { [A]: 'عضو أ مصطنع', [B]: 'مشرف ب مصطنع', [C]: 'عضو ج مصطنع', [ORG]: 'منشأة مصطنعة' };
const G = 'g_batch30001';
const dAB = directId(A, B);

async function seed() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (const u of [A, B, C]) {
    expect(await put(`orgs/${ORG}/members/${u}`, { email: u.toLowerCase() + '@example.test', perm: { contracts: 1 }, all: true, props: [], tokens: [], name: NAMES[u] }, ORG)).toBe(200);
  }
  expect(await status(chat(ORG).setRole('u-b3b@example.test', ['contracts']))).toBe(200);
  for (const u of [ORG, A, B, C]) expect(await status(chat(u).putMyDirectory(NAMES[u], u === B ? ['contracts'] : []))).toBe(200);
  await chat(B).createThread({ id: G, k: 'group', p: [A, B, C].sort(), name: 'مجموعة الدفعة ٣', s: {}, a: [] });
  await chat(A).createThread({ id: dAB, k: 'direct', p: [A, B].sort(), name: '' });
}

d('المحادثة · الدفعة ٣ (2026-10-08T05:31Z)', () => {
  beforeEach(seed);

  test('الوسوم: عاجل وقرار ومتابعة · لا غيرها', async () => {
    for (const [id, tag] of [['T1', 'urgent'], ['T2', 'decision'], ['T3', 'followup']] as const) {
      expect(await status(chat(A).sendMessage(G, { id, name: NAMES[A], body: 'موسومة', link: null, tag }))).toBe(200);
    }
    expect(await status(chat(A).sendMessage(G, { id: 'T4', name: NAMES[A], body: 'وسم غريب', link: null, tag: 'other' as never }))).toBe(403);
    expect((await chat(C).messagesSince(G, null)).map((m) => m.tag)).toEqual(['urgent', 'decision', 'followup']);
  });

  test('الإعلان المهم: كلٌّ يؤكّد اطلاعه وحده مرة · ولإعلانٍ يطلبه · ويظهر من أكّد', async () => {
    expect(await status(chat(B).sendMessage(G, { id: 'N1', name: NAMES[B], body: 'إعلان مهم', link: null, ack: true }))).toBe(200);
    expect(await status(chat(B).sendMessage(G, { id: 'N2', name: NAMES[B], body: 'عادي', link: null }))).toBe(200);
    expect(await chat(A).acknowledge(G, 'N1')).toBe('created');
    // لا تأكيد لرسالة لا تطلبه · ولا باسم غيره · ولا يُعدَّل
    expect(await status(chat(A).acknowledge(G, 'N2'))).toBe(403);
    expect(await put(`orgs/${ORG}/chats/${G}/st/a_N1_${C}`, { k: 'ack', m: 'N1', by: C }, A)).toBe(403);
    // التأكيد مرة: الثاني «موجود» لا يُكتب · والكتابة فوقه بلا شرط مرفوضة في القواعد
    expect(await chat(A).acknowledge(G, 'N1')).toBe('exists');
    const over = await fetch(`http://${HOST}/v1/${docs}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(A) },
      body: JSON.stringify({ writes: [{ update: { name: `${docs}/orgs/${ORG}/chats/${G}/st/a_N1_${A}`, fields: encodeFields({ k: 'ack', m: 'N1', by: A }) },
        updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }] }] }) });
    expect(over.status).toBe(403);
    const st = await chat(B).stateSince(G, null);
    expect(st.filter((x) => x.k === 'ack').map((x) => [x.m, x.by])).toEqual([['N1', A]]);
  });

  test('تعديل الرسالة لمرسلها وحده · ويُحفظ ما قبل التعديل في سجلها · ويصل الأطراف أنها عُدّلت', async () => {
    expect(await status(chat(A).sendMessage(G, { id: 'E1', name: NAMES[A], body: 'أول نص', link: null, tag: 'followup' }))).toBe(200);
    expect(await status(chat(B).editMessage(G, 'E1', 'من غير مرسلها', null))).toBe(403);
    expect(await status(chat(A).editMessage(G, 'E1', 'نص ثانٍ', 'decision'))).toBe(200);
    expect(await status(chat(A).editMessage(G, 'E1', 'نص ثالث', 'decision'))).toBe(200);
    const m = (await chat(C).messagesSince(G, null)).find((x) => x.id === 'E1')!;
    expect([m.body, m.tag, m.ev]).toEqual(['نص ثالث', 'decision', 2]);
    expect((await chat(C).editsOf(G, 'E1')).map((e) => [e.n, e.body, e.tag])).toEqual([[1, 'أول نص', 'followup'], [2, 'نص ثانٍ', 'decision']]);
    expect((await chat(C).stateSince(G, null)).filter((x) => x.k === 'edit').map((x) => [x.m, x.n])).toEqual([['E1', 2]]);
    // لا تعديل يُسقط السجل · ولا سجل مزوّر · ولا تعديل الرابط أو المرسل
    const msg = `${docs}/orgs/${ORG}/chats/${G}/msgs/E1`;
    expect(await commit(A, [{ update: { name: msg, fields: encodeFields({ body: 'بلا سجل', ev: 3 }) }, updateMask: { fieldPaths: ['body', 'ev'] },
      updateTransforms: [{ fieldPath: 'et', setToServerValue: 'REQUEST_TIME' }] }])).toBe(403);
    expect(await commit(A, [
      { update: { name: msg, fields: encodeFields({ body: 'بسجل مزوّر', ev: 3 }) }, updateMask: { fieldPaths: ['body', 'ev'] },
        updateTransforms: [{ fieldPath: 'et', setToServerValue: 'REQUEST_TIME' }] },
      { update: { name: `${msg}/edits/3`, fields: encodeFields({ body: 'ليس النص السابق', tag: 'decision' }) }, currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }] },
    ])).toBe(403);
    expect(await put(`orgs/${ORG}/chats/${G}/msgs/E1?updateMask.fieldPaths=from`, { from: B }, A)).toBe(403);
    // والحذف ممنوع كما قُرّر
    expect((await fetch(url(`orgs/${ORG}/chats/${G}/msgs/E1`), { method: 'DELETE', headers: { Authorization: 'Bearer ' + token(A) } })).status).toBe(403);
    expect((await fetch(url(`orgs/${ORG}/chats/${G}/msgs/E1/edits/1`), { method: 'DELETE', headers: { Authorization: 'Bearer ' + token(A) } })).status).toBe(403);
  });

  test('سجل التعديل لا يقرؤه غير الطرف · ولا المنضم «من لحظة انضمامه» لرسالةٍ قبله', async () => {
    expect(await status(chat(A).sendMessage(dAB, { id: 'DE1', name: NAMES[A], body: 'خاصة', link: null }))).toBe(200);
    expect(await status(chat(A).editMessage(dAB, 'DE1', 'خاصة معدَّلة', null))).toBe(200);
    await expect(chat(C).editsOf(dAB, 'DE1')).rejects.toThrow(/403/);
    expect(await status(chat(B).setGroupMeta(G, { s: { h: 'join', w: 'all', ad: 'admins' } }))).toBe(200);
    expect(await status(chat(A).sendMessage(G, { id: 'GE1', name: NAMES[A], body: 'قبل', link: null }))).toBe(200);
    expect(await status(chat(A).editMessage(G, 'GE1', 'قبل معدَّلة', null))).toBe(200);
    expect(await put(`orgs/${ORG}/members/U-B3D`, { email: 'u-b3d@example.test', perm: { contracts: 1 }, all: true, props: [], tokens: [], name: 'د' }, ORG)).toBe(200);
    expect(await status(chat(B).addMember(G, 'U-B3D'))).toBe(200);
    await expect(chat('U-B3D').editsOf(G, 'GE1')).rejects.toThrow(/403/);
  });

  test('#2 و#28: المسح يحذف الرسالة وسجل تعديلاتها بالأرقام دون قراءتها', async () => {
    expect(await status(chat(A).sendMessage(G, { id: 'P1', name: NAMES[A], body: 'تُعدَّل', link: null }))).toBe(200);
    expect(await status(chat(A).editMessage(G, 'P1', 'معدَّلة', null))).toBe(200);
    expect(await status(chat(B).sendMessage(G, { id: 'P2', name: NAMES[B], body: 'إعلان', link: null, ack: true }))).toBe(200);
    expect(await chat(A).acknowledge(G, 'P2')).toBe('created');
    // المالك لا يقرأ السجل في نافذة الحذف
    await chat(ORG).openDeletionWindow();
    await expect(chat(ORG).editsOf(G, 'P1')).rejects.toThrow(/403/);
    await chat(ORG).closeDeletionWindow();
    expect(await chatPurgeOrg(session(ORG), ORG)).toBe(2);
    expect(await adminList(`orgs/${ORG}/chats/${G}/msgs/P1/edits`)).toEqual([]);
    expect(await adminList(`orgs/${ORG}/chats/${G}/msgs`)).toEqual([]);
    expect(await adminList(`orgs/${ORG}/chats/${G}/st`)).toEqual([]);
  });
});

/** التزام التعديل كاملاً بمكوّناته الأربعة · ويُفسد منه ما يُراد اختباره وحده */
function editCommit(uid: string, chatId: string, msgId: string, o: {
  body?: string; tag?: string | null; ev?: unknown; histBody?: string; histTag?: string | null; histN?: string; idsEv?: unknown; stN?: unknown;
  extraMsg?: Record<string, unknown>; skip?: Array<'edits' | 'ids' | 'st'>;
}) {
  const base = `${docs}/orgs/${ORG}/chats/${chatId}`;
  const n = String(o.histN ?? (o.ev as { integerValue?: string }).integerValue ?? o.ev);
  const msgFields = { ...encodeFields({ body: o.body ?? 'جديد', tag: o.tag ?? null }), ev: o.ev as never, ...(o.extraMsg ? encodeFields(o.extraMsg) : {}) };
  const writes: unknown[] = [{
    update: { name: `${base}/msgs/${msgId}`, fields: msgFields },
    updateMask: { fieldPaths: ['body', 'tag', 'ev', ...Object.keys(o.extraMsg ?? {})] },
    currentDocument: { exists: true },
    updateTransforms: [{ fieldPath: 'et', setToServerValue: 'REQUEST_TIME' }],
  }];
  if (!o.skip?.includes('edits')) writes.push({
    update: { name: `${base}/msgs/${msgId}/edits/${n}`, fields: encodeFields({ body: o.histBody ?? '', tag: o.histTag ?? null }) },
    currentDocument: { exists: false }, updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
  });
  if (!o.skip?.includes('ids')) writes.push({ update: { name: `${base}/ids/${msgId}`, fields: { ev: o.idsEv as never } }, updateMask: { fieldPaths: ['ev'] }, currentDocument: { exists: true } });
  if (!o.skip?.includes('st')) writes.push({
    update: { name: `${base}/st/x_${msgId}`, fields: { ...encodeFields({ k: 'edit', m: msgId }), n: o.stN as never } },
    updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }],
  });
  return commit(uid, writes);
}
const I = (n: number) => ({ integerValue: String(n) });

d('المحادثة · الدفعة ٣ · كل قاعدة وحدها', () => {
  beforeEach(seed);

  test('التزام كامل صحيح يُقبل · وفساد جزء واحد منه يُرفض', async () => {
    expect(await status(chat(A).sendMessage(G, { id: 'F1', name: NAMES[A], body: 'الأصل', link: null, tag: 'followup' }))).toBe(200);
    const ok = { body: 'جديد', tag: 'decision', ev: I(1), histBody: 'الأصل', histTag: 'followup', idsEv: I(1), stN: I(1) };
    // كل فساد وحده: سجل بنص آخر · سجل بوسم آخر · بلا سجل · بلا فهرس · بلا إشارة · قفز الرقم · رقم ليس عدداً صحيحاً · إشارة برقم آخر
    expect(await editCommit(A, G, 'F1', { ...ok, histBody: 'ليس الأصل' })).toBe(403);
    expect(await editCommit(A, G, 'F1', { ...ok, histTag: 'urgent' })).toBe(403);
    expect(await editCommit(A, G, 'F1', { ...ok, skip: ['edits'] })).toBe(403);
    expect(await editCommit(A, G, 'F1', { ...ok, skip: ['ids'] })).toBe(403);
    expect(await editCommit(A, G, 'F1', { ...ok, skip: ['st'] })).toBe(403);
    expect(await editCommit(A, G, 'F1', { ...ok, ev: I(2), idsEv: I(2), stN: I(2) })).toBe(403);
    expect(await editCommit(A, G, 'F1', { ...ok, ev: { doubleValue: 1.0 }, histN: '1.0', idsEv: { doubleValue: 1.0 }, stN: I(1) })).toBe(403);
    expect(await editCommit(A, G, 'F1', { ...ok, stN: I(2) })).toBe(403);
    // ولا تغيير للرابط أو الإشارات أو الإعلان بحجة التعديل
    expect(await editCommit(A, G, 'F1', { ...ok, extraMsg: { ack: true } })).toBe(403);
    // ومن غير مرسلها ولو كان التزاماً كاملاً
    expect(await editCommit(B, G, 'F1', ok)).toBe(403);
    // والكامل الصحيح يُقبل · ولا يُعاد السجل نفسه
    expect(await editCommit(A, G, 'F1', ok)).toBe(200);
    expect(await editCommit(A, G, 'F1', { ...ok, body: 'ثالث', histBody: 'جديد', histTag: 'decision', histN: '1', ev: I(2), idsEv: I(2), stN: I(2) })).toBe(403);
  });

  test('لا تعديل لسطر نظام · ولا في مجموعة إرسالها للمسؤولين لغيرهم · و«عضو سابق» على رسالة معدَّلة ما زال', async () => {
    await chat(ORG).joinGroup(G, NAMES[ORG]);
    const line = (await chat(A).messagesSince(G, null)).find((m) => m.sys === 'join')!;
    expect(await status(chat(ORG).editMessage(G, line.id, 'ليس سطراً', null))).toBe(403);
    expect(await status(chat(A).sendMessage(G, { id: 'W1', name: NAMES[A], body: 'قبل التقييد', link: null }))).toBe(200);
    expect(await status(chat(B).setGroupMeta(G, { s: { h: 'all', w: 'admins', ad: 'admins' } }))).toBe(200);
    expect(await status(chat(A).editMessage(G, 'W1', 'بعد التقييد', null))).toBe(403);
    expect(await status(chat(B).setGroupMeta(G, { s: { h: 'all', w: 'all', ad: 'admins' } }))).toBe(200);
    expect(await status(chat(A).editMessage(G, 'W1', 'معدَّلة', null))).toBe(200);
    const { chatForgetMe, FORMER_MEMBER } = await import('@/chat');
    await chatForgetMe(session(A), ORG);
    expect((await chat(C).messagesSince(G, null)).find((m) => m.id === 'W1')!.name).toBe(FORMER_MEMBER);
  });

  test('تأكيد الاطلاع: لا لرسالة من محادثة أخرى · ولا لغير الطرف · والسجل يقرؤه المنضم لما بعده والمالك بمراجعته', async () => {
    // الإعلان المهم للمسؤولين (قرار المالك 2026-10-08T10:24Z): رسالة فردية عادية هنا، وإعلانٌ مهم في المجموعة من منشئها
    expect(await status(chat(A).sendMessage(dAB, { id: 'DA1', name: NAMES[A], body: 'فردية', link: null }))).toBe(200);
    expect(await status(chat(B).sendMessage(G, { id: 'GA9', name: NAMES[B], body: 'إعلان مهم', link: null, ack: true }))).toBe(200);
    // تأكيدٌ في المحادثة الفردية لرقم إعلان المجموعة: مرفوض (رسالة من محادثة أخرى)
    expect(await status(chat(A).acknowledge(dAB, 'GA9'))).toBe(403);
    const raw = await commit(C, [{ update: { name: `${docs}/orgs/${ORG}/chats/${G}/st/a_DA1_${C}`, fields: encodeFields({ k: 'ack', m: 'DA1', by: C }) },
      currentDocument: { exists: false }, updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }] }]);
    expect(raw).toBe(403);
    expect(await status(chat(C).acknowledge(dAB, 'DA1'))).toBe(403);
    // المنضم «من لحظة انضمامه» يقرأ سجل رسالة بعد انضمامه
    expect(await status(chat(B).setGroupMeta(G, { s: { h: 'join', w: 'all', ad: 'admins' } }))).toBe(200);
    expect(await put(`orgs/${ORG}/members/U-B3D`, { email: 'u-b3d@example.test', perm: { contracts: 1 }, all: true, props: [], tokens: [], name: 'د' }, ORG)).toBe(200);
    expect(await status(chat(B).addMember(G, 'U-B3D'))).toBe(200);
    expect(await status(chat(A).sendMessage(G, { id: 'AJ1', name: NAMES[A], body: 'بعد', link: null }))).toBe(200);
    expect(await status(chat(A).editMessage(G, 'AJ1', 'بعد معدَّلة', null))).toBe(200);
    expect((await chat('U-B3D').editsOf(G, 'AJ1')).map((e) => e.body)).toEqual(['بعد']);
    // والمالك بمراجعته
    await chat(ORG).openReview(dAB, 'سبب مصطنع');
    expect(await chat(ORG).editsOf(dAB, 'DA1')).toEqual([]);
    await chat(ORG).closeReview(dAB);
  });
});

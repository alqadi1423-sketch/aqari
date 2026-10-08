/**
 * مراجعة المالك محادثةً بسبب، وانضمامه إلى مجموعة (قرارا المالك 2026-10-08T04:11Z) على محاكي Firestore · بيانات مصطنعة:
 *  ٦) لا قراءة لمحادثة ليس المالك طرفاً فيها إلا مع سجل مراجعة بسببه · ولا يقرؤها في نافذة الحذف ولا بغيرها.
 *  ٢-٤) السبب إلزامي · كل فتح بسجلٍّ جديد · للقراءة فقط · وتنتهي بالإغلاق.
 *  ٥) لا إشعار بمراجعة بعينها: سجل المراجعات يقرؤه المالك وحده.
 *  ثانياً) انضمام المالك إلى مجموعة ليس فيها مسموح في الخادم، ومعه سطر «انضم المالك» في الالتزام نفسه لا بدونه.
 */
import { encodeFields } from '@/cloud/firestore';
import { ChatRemote } from '@/chat/remote';
import { chatPurgeOrg, directId, OWNER_JOINED } from '@/chat';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'REVOWNER';
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
  const res = await fetch(`http://${HOST}/v1/${docs}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(uid) }, body: JSON.stringify({ writes }) });
  return res.status;
}
const ADMIN = { Authorization: 'Bearer owner' };
async function adminList(path: string): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
  const j = (await (await fetch(url(path), { headers: ADMIN })).json()) as { documents?: Array<{ name: string; fields?: Record<string, unknown> }> };
  return (j.documents ?? []).map((x) => ({ id: x.name.slice(x.name.lastIndexOf('/') + 1), fields: x.fields ?? {} }));
}
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { return Number(/Firestore (\d+)/.exec(String(e))?.[1] ?? 0); } };

const A = 'U-RVA';
const B = 'U-RVB';
const C = 'U-RVC';
const NAMES: Record<string, string> = { [A]: 'عضو أ مصطنع', [B]: 'مشرف ب مصطنع', [C]: 'عضو ج مصطنع', [ORG]: 'منشأة مراجعة مصطنعة' };
const dAC = directId(A, C);
const G = 'g_review0001';

async function seed() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (const u of [A, B, C]) {
    expect(await put(`orgs/${ORG}/members/${u}`, { email: u.toLowerCase() + '@example.test', perm: { contracts: 1 }, all: true, props: [], tokens: [], name: NAMES[u] }, ORG)).toBe(200);
  }
  expect(await status(chat(ORG).setRole('u-rvb@example.test', ['contracts']))).toBe(200);
  for (const u of [ORG, A, B, C]) expect(await status(chat(u).putMyDirectory(NAMES[u], u === B ? ['contracts'] : []))).toBe(200);
  await chat(A).createThread({ id: dAC, k: 'direct', p: [A, C].sort(), name: '' });
  await chat(A).sendMessage(dAC, { id: 'RA1', name: NAMES[A], body: 'خاصة من أ', link: null });
  await chat(C).sendMessage(dAC, { id: 'RC1', name: NAMES[C], body: 'خاصة من ج', link: null });
  await chat(B).createThread({ id: G, k: 'group', p: [A, B, C].sort(), name: 'مجموعة بلا المالك' });
  await chat(B).sendMessage(G, { id: 'RB1', name: NAMES[B], body: 'في المجموعة', link: null });
}

d('مراجعة المحادثات بسبب وانضمام المالك (2026-10-08T04:11Z)', () => {
  beforeEach(seed);

  test('٦ بلا مراجعة لا قراءة · ولا في نافذة الحذف · وقائمة المحادثات (أطرافها واسمها) للاختيار وحدها', async () => {
    await expect(chat(ORG).messagesSince(dAC, null)).rejects.toThrow(/403/);
    await chat(ORG).openDeletionWindow();
    await expect(chat(ORG).messagesSince(dAC, null)).rejects.toThrow(/403/);
    await chat(ORG).closeDeletionWindow();
    // يختار المحادثة من قائمتها دون محتواها
    expect((await chat(ORG).orgThreads()).map((t) => t.id).sort()).toEqual([dAC, G].sort());
    await expect(chat(B).orgThreads()).rejects.toThrow(/403/);
  });

  test('٢ و٣ و٤ المراجعة بسبب: تُسجَّل بالمحادثة والوقت والسبب والمراجِع · تُقرأ بها وحدها · وتنتهي بالإغلاق', async () => {
    // بلا سبب لا تُفتح
    expect(await status(chat(ORG).openReview(dAC, '   '))).toBe(403);
    const rid = await chat(ORG).openReview(dAC, 'شكوى مصطنعة من مستأجر');
    expect((await chat(ORG).messagesSince(dAC, null)).map((m) => m.body)).toEqual(['خاصة من أ', 'خاصة من ج']);
    // المراجعة لمحادثتها وحدها
    await expect(chat(ORG).messagesSince(G, null)).rejects.toThrow(/403/);
    const log = (await adminList(`orgs/${ORG}/chatReviews`)).find((x) => x.id === rid)!;
    expect(Object.keys(log.fields).sort()).toEqual(['at', 'by', 'chat', 'reason']);
    expect(JSON.stringify(log.fields)).toContain('شكوى مصطنعة من مستأجر');
    expect(JSON.stringify(log.fields)).toContain(dAC);
    expect(JSON.stringify(log.fields)).toContain(ORG);
    // للقراءة فقط
    expect(await status(chat(ORG).sendMessage(dAC, { id: 'RX1', name: NAMES[ORG], body: 'من المالك', link: null }))).toBe(403);
    // السجل لا يُعدَّل ولا يُحذف خارج نافذة الحذف
    expect(await put(`orgs/${ORG}/chatReviews/${rid}?updateMask.fieldPaths=reason`, { reason: 'معدَّل' }, ORG)).toBe(403);
    expect((await fetch(url(`orgs/${ORG}/chatReviews/${rid}`), { method: 'DELETE', headers: { Authorization: 'Bearer ' + token(ORG) } })).status).toBe(403);
    // الإغلاق ينهيها
    await chat(ORG).closeReview(dAC);
    await expect(chat(ORG).messagesSince(dAC, null)).rejects.toThrow(/403/);
  });

  test('٤ كل فتح بسجلٍّ جديد: لا تُفتح بسجلٍّ سابق ولا بلا سجل · ولا يفتحها غير المالك', async () => {
    const rid = await chat(ORG).openReview(dAC, 'سبب أول مصطنع');
    await chat(ORG).closeReview(dAC);
    const reopen = (r: string) => commit(ORG, [{
      update: { name: `${docs}/orgs/${ORG}/chatReviewOpen/${dAC}`, fields: encodeFields({ rid: r }) },
      updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
    }]);
    expect(await reopen(rid)).toBe(403);
    expect(await reopen('NO-SUCH-LOG')).toBe(403);
    await expect(chat(ORG).messagesSince(dAC, null)).rejects.toThrow(/403/);
    // المشرف لا يراجع
    expect(await status(chat(B).openReview(dAC, 'سبب مصطنع'))).toBe(403);
    await expect(chat(B).messagesSince(dAC, null)).rejects.toThrow(/403/);
  });

  test('٥ لا إشعار بمراجعة بعينها: سجل المراجعات والمراجعة المفتوحة للمالك وحده', async () => {
    await chat(ORG).openReview(dAC, 'سبب مصطنع');
    for (const u of [A, B, C]) {
      expect((await fetch(url(`orgs/${ORG}/chatReviews`), { headers: { Authorization: 'Bearer ' + token(u) } })).status).toBe(403);
      expect((await fetch(url(`orgs/${ORG}/chatReviewOpen/${dAC}`), { headers: { Authorization: 'Bearer ' + token(u) } })).status).toBe(403);
    }
  });

  test('ثانياً انضمام المالك إلى مجموعة ليس فيها: مسموح ومعه سطر «انضم المالك» · لا بدونه', async () => {
    // بلا سطر الانضمام يُرفض
    expect(await status(chat(ORG).updateGroup(G, [A, B, C, ORG].sort(), 'مجموعة بلا المالك'))).toBe(403);
    await chat(ORG).joinGroup(G, [A, B, C].sort(), 'مجموعة بلا المالك', NAMES[ORG]);
    expect((await chat(A).myThreads()).find((t) => t.id === G)!.p).toContain(ORG);
    const msgs = await chat(A).messagesSince(G, null);
    const line = msgs[msgs.length - 1];
    expect([line.from, line.sys, line.body]).toEqual([ORG, 'join', OWNER_JOINED]);
    // وصار طرفاً فيها: يقرأ ويكتب بلا مراجعة
    expect((await chat(ORG).messagesSince(G, null)).length).toBe(2);
    expect(await status(chat(ORG).sendMessage(G, { id: 'RO1', name: NAMES[ORG], body: 'رسالة من المالك', link: null }))).toBe(200);
    // لا سطر انضمام بلا انضمام · ولا من غير المالك
    expect(await status(chat(ORG).sendSystemLine(G, 'RJ2', NAMES[ORG]))).toBe(403);
    expect(await status(chat(B).sendSystemLine(G, 'RJ3', NAMES[B]))).toBe(403);
  });

  test('ثغرات مسدودة: سجل محادثة لا يفتح غيرها · jm بلا انضمام · سطر قديم · الفردية · الانتحال', async () => {
    // سجلٌّ لمحادثة أ وج لا يفتح المجموعة
    const crossed = await commit(ORG, [
      { update: { name: `${docs}/orgs/${ORG}/chatReviews/RX`, fields: encodeFields({ chat: dAC, reason: 'سبب', by: ORG }) }, currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }] },
      { update: { name: `${docs}/orgs/${ORG}/chatReviewOpen/${G}`, fields: encodeFields({ rid: 'RX' }) },
        updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }] },
    ]);
    expect(crossed).toBe(403);
    await expect(chat(ORG).messagesSince(G, null)).rejects.toThrow(/403/);
    // jm بلا انضمام · ومن غير المالك
    expect(await put(`orgs/${ORG}/chats/${G}?updateMask.fieldPaths=jm`, { jm: 'RB1' }, ORG)).toBe(403);
    expect(await put(`orgs/${ORG}/chats/${G}?updateMask.fieldPaths=jm`, { jm: 'RB1' }, B)).toBe(403);
    // انضمام ثم خروج ثم انضمام بسطر الانضمام الأول: يُرفض · وبسطر جديد يُقبل
    const first = await chat(ORG).joinGroup(G, [A, B, C].sort(), 'مجموعة بلا المالك', NAMES[ORG]);
    expect(await status(chat(ORG).updateGroup(G, [A, B, C].sort(), 'مجموعة بلا المالك'))).toBe(200);
    expect(await put(`orgs/${ORG}/chats/${G}?updateMask.fieldPaths=p&updateMask.fieldPaths=jm`, { p: [A, B, C, ORG].sort(), jm: 'x' }, ORG)).toBe(403);
    // انضمام ثانٍ بسطر جديد يُقبل · ثم خروج
    expect(await status(chat(ORG).joinGroup(G, [A, B, C].sort(), 'مجموعة بلا المالك', NAMES[ORG]))).toBe(200);
    expect(await status(chat(ORG).updateGroup(G, [A, B, C].sort(), 'مجموعة بلا المالك'))).toBe(200);
    // ثم انضمام بالسطر الأول (يخالف jm الحالي وهو سطر انضمام منه): يُرفض لأنه لم يُكتب في هذا الالتزام
    const rejoinOld = await commit(ORG, [{
      update: { name: `${docs}/orgs/${ORG}/chats/${G}`, fields: encodeFields({ p: [A, B, C, ORG].sort(), jm: first }) },
      updateMask: { fieldPaths: ['p', 'jm'] },
    }]);
    expect(rejoinOld).toBe(403);
    // الفردية لا ينضم إليها ولا يُدخل نفسه فيها
    expect(await status(chat(ORG).joinGroup(dAC, [A, C].sort(), '', NAMES[ORG]))).toBe(403);
    expect(await put(`orgs/${ORG}/chats/${dAC}?updateMask.fieldPaths=p`, { p: [A, C, ORG].sort() }, ORG)).toBe(403);
    // لا يكتب باسم غيره ولو صار طرفاً · ينضم بسطر جديد أولاً فيصير طرفاً، فيكون الرفض للاسم وحده
    expect(await status(chat(ORG).joinGroup(G, [A, B, C].sort(), 'مجموعة بلا المالك', NAMES[ORG]))).toBe(200);
    expect(await status(chat(ORG).sendMessage(G, { id: 'RZ0', name: NAMES[ORG], body: 'باسمه', link: null }))).toBe(200);
    expect(await status(chat(ORG).sendMessage(G, { id: 'RZ1', name: NAMES[A], body: 'باسم أ', link: null }))).toBe(403);
  });

  test('#2 و#28 كما هي: المسح يحذف الرسائل بفهرسها دون قراءتها · ومعها سجل المراجعات', async () => {
    await chat(ORG).openReview(dAC, 'سبب مصطنع');
    await chat(ORG).closeReview(dAC);
    expect(await chatPurgeOrg(session(ORG), ORG)).toBe(3);
    expect(await adminList(`orgs/${ORG}/chats`)).toEqual([]);
    for (const id of [dAC, G]) {
      expect(await adminList(`orgs/${ORG}/chats/${id}/msgs`)).toEqual([]);
      expect(await adminList(`orgs/${ORG}/chats/${id}/ids`)).toEqual([]);
    }
    expect(await adminList(`orgs/${ORG}/chatReviews`)).toEqual([]);
    expect(await adminList(`orgs/${ORG}/chatReviewOpen`)).toEqual([]);
  });
});

/**
 * اطلاع المالك على محادثات منشأته (قرار المالك 2026-10-08) على محاكي Firestore · بيانات مصطنعة:
 *  ١) المالك يقرأ كل محادثات منشأته ورسائلها، فردية ومجموعات، ولو لم يكن طرفاً.
 *  ٢) الاطلاع للمالك وحده: لا المشرف ولا غير الطرف ولا غير العضو.
 *  ٣) للقراءة فقط: لا يكتب في محادثة ليس طرفاً فيها، ولا باسم أحد، ولا يعدّل رسالة، ولا يحذف خارج نافذة الحذف.
 *  ٥) الرسالة بلا فهرس أرقام (لم يعد لازماً) · والحذف والمسح يصلان كل الرسائل، ومعها فهارس النسخ السابقة.
 */
import { encodeFields } from '@/cloud/firestore';
import { ChatRemote } from '@/chat/remote';
import { chatPurgeOrg, directId } from '@/chat';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-aqari';
const ORG = 'VIEWOWNER';
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
/** المحاكي يتجاوز القواعد بهذا الرمز · لزرع حال قديمة وللتحقق مما بقي */
const ADMIN = { Authorization: 'Bearer owner' };
async function adminList(path: string): Promise<string[]> {
  const j = (await (await fetch(url(path), { headers: ADMIN })).json()) as { documents?: Array<{ name: string }> };
  return (j.documents ?? []).map((x) => x.name.slice(x.name.lastIndexOf('/') + 1));
}
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { return Number(/Firestore (\d+)/.exec(String(e))?.[1] ?? 0); } };

const A = 'U-OVA';
const B = 'U-OVB';
const C = 'U-OVC';
const D = 'U-OVD';
const OUT = 'U-OVOUT';
const NAMES: Record<string, string> = { [A]: 'عضو أ مصطنع', [B]: 'مشرف ب مصطنع', [C]: 'عضو ج مصطنع', [ORG]: 'منشأة اطلاع مصطنعة' };
const dAC = directId(A, C);

async function seed() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (const u of [A, B, C]) {
    expect(await put(`orgs/${ORG}/members/${u}`, { email: u.toLowerCase() + '@example.test', perm: { contracts: 1 }, all: true, props: [], tokens: [], name: NAMES[u] }, ORG)).toBe(200);
  }
  expect(await status(chat(ORG).setRole('u-ovb@example.test', ['contracts']))).toBe(200);
  for (const u of [ORG, A, B, C]) expect(await status(chat(u).putMyDirectory(NAMES[u], u === B ? ['contracts'] : []))).toBe(200);
  // فردية بين أ وج: لا المالك ولا المشرف طرف فيها
  await chat(A).createThread({ id: dAC, k: 'direct', p: [A, C].sort(), name: '' });
  await chat(A).sendMessage(dAC, { id: 'OA1', name: NAMES[A], body: 'خاصة من أ', link: null });
  await chat(C).sendMessage(dAC, { id: 'OC1', name: NAMES[C], body: 'خاصة من ج', link: null });
  // مجموعة أنشأها المشرف ب · والمالك ليس فيها
  await chat(B).createThread({ id: 'g_ownview01', k: 'group', p: [A, B, C].sort(), name: 'مجموعة بلا المالك' });
  await chat(B).sendMessage('g_ownview01', { id: 'OB1', name: NAMES[B], body: 'في المجموعة', link: null });
}

d('اطلاع المالك على محادثات منشأته (2026-10-08)', () => {
  beforeEach(seed);

  test('١ المالك يقرأ كل المحادثات ورسائلها ولو لم يكن طرفاً', async () => {
    const all = await chat(ORG).orgThreads();
    expect(all.map((t) => t.id).sort()).toEqual([dAC, 'g_ownview01'].sort());
    // ولم يصر طرفاً في أي منها
    expect(all.every((t) => !t.p.includes(ORG))).toBe(true);
    expect((await chat(ORG).messagesSince(dAC, null)).map((m) => [m.from, m.body])).toEqual([[A, 'خاصة من أ'], [C, 'خاصة من ج']]);
    expect((await chat(ORG).messagesSince('g_ownview01', null)).map((m) => m.body)).toEqual(['في المجموعة']);
  });

  test('٢ الاطلاع للمالك وحده: لا المشرف ولا غير الطرف ولا غير العضو', async () => {
    await expect(chat(B).messagesSince(dAC, null)).rejects.toThrow(/403/);
    await expect(chat(B).orgThreads()).rejects.toThrow(/403/);
    await expect(chat(A).orgThreads()).rejects.toThrow(/403/);
    await expect(chat(OUT).messagesSince(dAC, null)).rejects.toThrow(/403/);
    // والمشرف يرى محادثاته وحدها
    expect((await chat(B).myThreads()).map((t) => t.id)).toEqual(['g_ownview01']);
    // عضو عادي ليس طرفاً
    expect(await put(`orgs/${ORG}/members/${D}`, { email: 'u-ovd@example.test', perm: { contracts: 1 }, all: true, props: [], tokens: [], name: 'عضو د مصطنع' }, ORG)).toBe(200);
    await expect(chat(D).messagesSince(dAC, null)).rejects.toThrow(/403/);
    // ومن أُزيل من المنشأة لا يقرأ ولو بقي رقمه في أطرافها
    expect((await fetch(url(`orgs/${ORG}/members/${C}`), { method: 'DELETE', headers: { Authorization: 'Bearer ' + token(ORG) } })).status).toBe(200);
    await expect(chat(C).messagesSince(dAC, null)).rejects.toThrow(/403/);
  });

  test('٣ للقراءة فقط: لا يكتب ولا باسم أحد ولا يعدّل ولا يحذف خارج نافذة الحذف', async () => {
    expect(await status(chat(ORG).sendMessage(dAC, { id: 'OX1', name: NAMES[ORG], body: 'من المالك', link: null }))).toBe(403);
    expect(await status(chat(ORG).sendMessage('g_ownview01', { id: 'OX2', name: NAMES[A], body: 'باسم أ', link: null }))).toBe(403);
    expect(await put(`orgs/${ORG}/chats/${dAC}/msgs/OA1?updateMask.fieldPaths=body`, { body: 'معدَّلة' }, ORG)).toBe(403);
    expect(await put(`orgs/${ORG}/chats/${dAC}/msgs/OA1?updateMask.fieldPaths=name`, { name: 'عضو سابق' }, ORG)).toBe(403);
    expect(await status(chat(ORG).deleteIn(`chats/${dAC}/msgs/OA1`))).toBe(403);
    // ولا يُدخل نفسه في محادثة فردية
    expect(await put(`orgs/${ORG}/chats/${dAC}?updateMask.fieldPaths=p`, { p: [A, C, ORG].sort() }, ORG)).toBe(403);
    expect((await chat(A).messagesSince(dAC, null)).length).toBe(2);
  });

  test('٥ الرسالة بلا فهرس أرقام · والمسح يصل كل الرسائل ومعها فهارس النسخ السابقة (#2 و#28 كما هي)', async () => {
    // لا فهرس يُكتب مع الرسالة بعد اليوم
    expect(await adminList(`orgs/${ORG}/chats/${dAC}/ids`)).toEqual([]);
    // فهرس من نسخة سابقة يبقى في السحابة · يزرعه المحاكي
    const legacy = await fetch(url(`orgs/${ORG}/chats/${dAC}/ids/OLD1`), { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...ADMIN }, body: JSON.stringify({ fields: {} }) });
    expect(legacy.status).toBe(200);
    expect(await chatPurgeOrg(session(ORG), ORG)).toBe(3);
    expect(await adminList(`orgs/${ORG}/chats`)).toEqual([]);
    for (const id of [dAC, 'g_ownview01']) {
      expect(await adminList(`orgs/${ORG}/chats/${id}/msgs`)).toEqual([]);
      expect(await adminList(`orgs/${ORG}/chats/${id}/ids`)).toEqual([]);
    }
    expect(await adminList(`orgs/${ORG}/chatDir`)).toEqual([]);
  });
});

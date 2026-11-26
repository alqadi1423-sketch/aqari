/**
 * ق٠-٧ · الجزء الثالث: ناقل المحادثة إلى خادم المنشأة (src/chat/serverTransport.ts) طرفاً لطرف: التطبيق بواجهته العامة (المزامنة
 * والقنوات وواجهة الوحدة) فوق الناقل، فوق عميلٍ في الذاكرة يمرّر JSON كما على الشبكة، فوق server/chat وserver/auth بقواعدهما وساعتهما ·
 * ولا يُربط بالتطبيق (لا منادي له) · أسماءٌ وأرقامٌ مصطنعة كلها، ولا Firestore ولا شبكة.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { memDb } from './helpers/testDb';
import type { DB } from '@/db/adapter';
import { saveMembership } from '@/services/access';
import {
  setChatTransport, runChatSync, chatEditMessage, chatEditsOf, chatSetPin, chatAcknowledge, chatSetTask, chatSetTaskDone, chatCancelTask,
  chatVote, chatReviewCandidates, chatOpenReview, chatCloseReview, chatJoinGroup, chatEditGroup, chatRemoveMember, chatLeaveOrg,
  chatForgetMe, chatPurgeOrg, setSupervisor, supervisorOf, openDirect, sendLocal, listMessages, listThreads, pinnedIds, acksOf, tasksIn,
  pollResults, listPeople, createGroup, channelId, FORMER_MEMBER, OWNER_JOINED, ChatTransportError,
  type ChatSession,
} from '@/chat';
import { ServerChatTransport, serverChatTransport, type ChatServerClient, type ChatServerOp } from '@/chat/serverTransport';
import { sectionDef } from '@/domain/access/sections';
import { createAuthServer, MemoryAuthStorage, type Session } from '../server/auth';
import { createChatServer, type OrgMember, type WireMessage } from '../server/chat';

const ROOT = join(__dirname, '..');
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8');
function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((n) => {
    const rel = join(dir, n);
    return statSync(join(ROOT, rel)).isDirectory() ? files(rel) : /\.(ts|tsx)$/.test(n) ? [rel] : [];
  });
}

const ORG = 'uid-owner-masnoo';
const A = 'uid-member-a';
const B = 'uid-member-b';
const SETUP = 'SETUP-CODE-MASNOO-2026-TRANSPRT';
const SIGNING = new Uint8Array(32).map((_, i) => (i * 13 + 1) & 255);
const devKey = (n: number) => 't' + String(n).padStart(3, '0') + '_'.repeat(4) + 'C'.repeat(40);
const OWNER_NAME = 'منشأة مصطنعة';

/** منشأةٌ في الذاكرة: خادم الهوية وخادم المحادثة في تخزينٍ واحد، وعميلٌ يمرّر JSON كما على الشبكة ويعدّ النداءات */
async function org() {
  const clock = { now: 1_796_000_000_000 };
  const storage = new MemoryAuthStorage();
  const auth = createAuthServer({ storage, clock: () => clock.now, signingKey: SIGNING, setupCode: SETUP });
  const own = await auth.bootstrapOwner({ setupCode: SETUP, uid: ORG, name: 'مالك مصطنع', deviceKey: devKey(1), source: 'ip-o' });
  if (!own.ok) throw new Error('owner');
  const sess: Record<string, Session> = { [ORG]: own };
  const dir = new Map<string, OrgMember>([
    [A, { uid: A, name: 'عضو أ مصطنع', email: 'a@example.test', perm: { contracts: 1 }, all: false, props: [] }],
    [B, { uid: B, name: 'عضو ب مصطنع', email: 'b@example.test', perm: {}, all: false, props: [] }],
  ]);
  let n = 2;
  for (const uid of [A, B]) {
    const inv = await auth.createInvite(own.tokens.accessToken, { uid, name: dir.get(uid)!.name, phone: '05000000' + n, role: 'staff' });
    if (!inv.ok) throw new Error('invite');
    const s = await auth.redeemInvite({ code: inv.code, deviceKey: devKey(n), source: 'ip-' + n++ });
    if (!s.ok) throw new Error('redeem');
    sess[uid] = s;
  }
  const chat = createChatServer({
    org: ORG, storage, clock: () => clock.now, auth,
    directory: { member: async (u) => (dir.has(u) ? structuredClone(dir.get(u)!) : null), members: async () => [...dir.values()].map((m) => structuredClone(m)) },
  });
  const calls: string[] = [];
  const knobs = { down: false };
  const client: ChatServerClient = {
    async call(o: string, op: ChatServerOp, token: string, args: Record<string, unknown>) {
      if (knobs.down) throw new Error('network down');
      calls.push(op);
      expect(o).toBe(ORG);
      const reply = await chat.dispatch(op, token, JSON.parse(JSON.stringify(args)));
      return JSON.parse(JSON.stringify(reply));
    },
  };
  const session = (uid: string, email: string): ChatSession => ({
    projectId: 'لا-مشروع', uid, email, idToken: async () => sess[uid].tokens.accessToken,
  });
  return { clock, storage, auth, chat, dir, sess, client, calls, knobs, session };
}

describe('غير مربوطٍ بالتطبيق', () => {
  test('لا منادي للناقل الجديد ولا لمبدّل الناقل في التطبيق · والتطبيق لا يستورد شيئاً من server/', () => {
    const app = [...files('src'), ...files('app')];
    const users = app.filter((f) => f !== join('src', 'chat', 'serverTransport.ts') && /serverChatTransport|ServerChatTransport|chat\/serverTransport/.test(src(f)));
    expect(users).toEqual([]);
    expect(app.filter((f) => /setChatTransport\(/.test(src(f).replace(/export function setChatTransport\(/, '')))).toEqual([]);
    expect(app.filter((f) => /from '(\.\.\/)+server\//.test(src(f)))).toEqual([]);
  });
});

describe('طرفاً لطرف على خادم المحادثة في الذاكرة', () => {
  let w: Awaited<ReturnType<typeof org>>;
  let o: DB, a: DB, b: DB;
  let sO: ChatSession, sA: ChatSession, sB: ChatSession;
  const meO = { uid: ORG, name: OWNER_NAME };
  const meA = { uid: A, name: 'عضو أ مصطنع' };
  const meB = { uid: B, name: 'عضو ب مصطنع' };
  const net: string[] = [];
  const orig = global.fetch;
  const sync = (db: DB, s: ChatSession, name = '') => runChatSync(db, s, name, { force: true });

  beforeEach(async () => {
    w = await org();
    setChatTransport(serverChatTransport(w.client));
    global.fetch = (async (u: string) => { net.push(String(u)); throw new Error('لا شبكة'); }) as unknown as typeof fetch;
    sO = w.session(ORG, 'owner@example.test'); sA = w.session(A, 'a@example.test'); sB = w.session(B, 'b@example.test');
    o = memDb(); a = memDb(); b = memDb();
    saveMembership(a, { org: ORG, uid: A, perms: { contracts: 1 } as never, allProps: false, props: [], profile: { name: meA.name, phone: '', nid: '', title: '' } });
    saveMembership(b, { org: ORG, uid: B, perms: {} as never, allProps: false, props: [], profile: { name: meB.name, phone: '', nid: '', title: '' } });
  });
  afterEach(() => {
    setChatTransport(null);
    global.fetch = orig;
    expect(net).toEqual([]);
  });

  test('الدليل والقنوات ثم الإرسال والسحب والرد والتعديل وسجله والتثبيت وتأكيد الاطلاع والمهمة والاستطلاع والقراءة', async () => {
    await sync(o, sO, OWNER_NAME);
    await sync(a, sA);
    await sync(b, sB);
    await sync(o, sO, OWNER_NAME);
    expect(listPeople(o).map((p) => p.name).sort()).toEqual([OWNER_NAME, meA.name, meB.name].sort());
    // القنوات: الإعلانات للجميع (يرسل المسؤولون)، وقسم العقود لمن له صلاحيته وحده
    const sec = channelId({ t: 'section', key: 'contracts' });
    expect(listThreads(a, A).map((t) => t.id).sort()).toEqual([channelId({ t: 'announce' }), sec].sort());
    expect(listThreads(b, B).map((t) => t.id)).toEqual([channelId({ t: 'announce' })]);
    expect(listThreads(o, ORG).find((t) => t.id === sec)!.name).toBe(sectionDef('contracts').label);

    const tid = openDirect(o, ORG, A);
    const hello = sendLocal(o, tid, meO, 'مرحبا من المالك', { type: 'unit', id: 'unit-1', label: 'وحدة مصطنعة' }, { ack: true, tag: 'urgent' });
    const poll = sendLocal(o, tid, meO, 'أي موعد يناسب؟', null, { poll: { o: ['الأحد', 'الاثنين', 'الثلاثاء'], m: true } });
    await sync(o, sO, OWNER_NAME);
    expect(listMessages(o, tid).map((m) => [m.sent, m.rejected])).toEqual([[true, false], [true, false]]);
    await sync(a, sA);
    const got = listMessages(a, tid);
    expect(got.map((m) => m.body)).toEqual(['مرحبا من المالك', 'أي موعد يناسب؟']);
    expect(got[0]).toMatchObject({ link: { type: 'unit', id: 'unit-1', label: 'وحدة مصطنعة' }, ack: true, tag: 'urgent', senderName: OWNER_NAME });
    expect(got[0].serverTs).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z$/);

    const reply = sendLocal(a, tid, meA, 'وعليكم السلام', null, { re: hello, men: ['u:' + ORG] });
    await sync(a, sA);
    await chatEditMessage(a, sA, ORG, tid, reply, 'وعليكم السلام ورحمة الله', 'followup');
    expect((await chatEditsOf(sA, ORG, tid, reply)).map((e) => [e.n, e.body])).toEqual([[1, 'وعليكم السلام']]);
    await chatAcknowledge(a, sA, ORG, tid, hello);
    await chatVote(a, sA, ORG, tid, poll, [2, 0, 2]);
    await chatSetPin(o, sO, ORG, tid, hello, true);
    await chatSetTask(o, sO, ORG, tid, hello, { title: 'مهمة مصطنعة', as: A, due: '2026-12-01', done: false });
    await chatSetTaskDone(a, sA, ORG, tid, hello, true);
    await sync(o, sO, OWNER_NAME);
    const mine = listMessages(o, tid).find((x) => x.id === reply)!;
    expect([mine.body, mine.tag, mine.ev, mine.re, mine.men]).toEqual(['وعليكم السلام ورحمة الله', 'followup', 1, hello, ['u:' + ORG]]);
    expect(pinnedIds(o, tid)).toEqual([hello]);
    expect(acksOf(o, tid)[hello]).toEqual([A]);
    expect(pollResults(o, tid, poll, 3, ORG).counts).toEqual([1, 0, 1]);
    expect(tasksIn(o, tid)[hello]).toMatchObject({ title: 'مهمة مصطنعة', as: A, done: true, by: ORG, cx: false });
    // تعديل المنشئ لا يرجع إنجاز المسؤول، والمسؤول لا يلغي
    await chatSetTask(o, sO, ORG, tid, hello, { title: 'عنوان معدّل', as: A, due: '2026-12-02', done: false });
    await expect(chatCancelTask(a, sA, ORG, tid, hello)).rejects.toThrow(ChatTransportError);
    await chatCancelTask(o, sO, ORG, tid, hello);
    expect(tasksIn(o, tid)[hello]).toMatchObject({ title: 'عنوان معدّل', done: true, cx: true });
    // تعديل رسالة غيري يرفضه الخادم (٤٠٣) فلا يُكتب
    await expect(chatEditMessage(o, sO, ORG, tid, reply, 'ليست لي', null)).rejects.toMatchObject({ status: 403, code: 'not_sender' });
  });

  test('الرفض يوسم الرسالة · والحدّ والانقطاع يُبقيانها منتظرةً تُعاد بلا تكرار', async () => {
    await sync(o, sO, OWNER_NAME);
    await sync(a, sA);
    await sync(b, sB);
    const tid = openDirect(a, A, B);
    sendLocal(a, tid, meA, 'أولى');
    w.knobs.down = true;
    await sync(a, sA);
    expect(listMessages(a, tid).map((m) => [m.sent, m.rejected])).toEqual([[false, false]]);
    w.knobs.down = false;
    await sync(a, sA);
    await sync(a, sA);
    expect(listMessages(a, tid).map((m) => [m.sent, m.rejected])).toEqual([[true, false]]);
    const stored = Object.keys(w.storage.dump()).filter((k) => k.startsWith(`c:m:${tid}:`));
    expect(stored).toHaveLength(1);
    // الإعلان المهم من عضوٍ ليس مسؤولاً: يرفضه الخادم فيُوسم
    sendLocal(a, tid, meA, 'إعلان ليس لي', null, { ack: true });
    await sync(a, sA);
    expect(listMessages(a, tid).map((m) => [m.body, m.rejected]).sort()).toEqual([['أولى', false], ['إعلان ليس لي', true]].sort());
    // الحدّ: عارضٌ لا رفض
    for (let i = 0; i < 70; i++) sendLocal(a, tid, meA, 'رسالة ' + i);
    await sync(a, sA);
    const all = listMessages(a, tid);
    expect(all.filter((m) => m.rejected)).toHaveLength(1);
    expect(all.filter((m) => !m.sent && !m.rejected).length).toBeGreaterThan(0);
    w.clock.now += 61_000;
    await sync(a, sA);
    expect(listMessages(a, tid).filter((m) => !m.sent && !m.rejected)).toEqual([]);
    // عضوٌ أُزيل من المنشأة: يُرفض دليله أولاً فلا يُرفع منه شيء (كما اليوم، وفحص العضوية في المزامنة العامة يتولى الإزالة)
    w.dir.delete(B);
    const tb = openDirect(b, B, A);
    sendLocal(b, tb, meB, 'بعد الإزالة');
    const before = w.calls.length;
    await sync(b, sB);
    expect(listMessages(b, tb).filter((m) => m.body === 'بعد الإزالة').map((m) => [m.sent, m.rejected])).toEqual([[false, false]]);
    expect(w.calls.slice(before)).not.toContain('sendMessage');
    const fromB = Object.values(w.storage.dump()).filter((v) => !!v && typeof v === 'object' && (v as WireMessage).from === B);
    expect(fromB).toEqual([]);
    await expect(new ServerChatTransport({ client: w.client, org: ORG, uid: B, accessToken: sB.idToken }).myThreads()).rejects.toMatchObject({ status: 403, code: 'not_in_org' });
  });

  test('«من لحظة انضمامه»: المنضم لاحقاً يسحب ما بعد انضمامه وحده بطريق الأرقام', async () => {
    await sync(o, sO, OWNER_NAME);
    await sync(a, sA);
    await sync(b, sB);
    const g = createGroup(o, ORG, 'مجموعة مصطنعة', [A], { h: 'join' });
    sendLocal(o, g, meO, 'قبل انضمام ب');
    await sync(o, sO, OWNER_NAME);
    await chatEditGroup(o, sO, ORG, g, { members: [ORG, A, B] });
    sendLocal(o, g, meO, 'بعد انضمام ب');
    await sync(o, sO, OWNER_NAME);
    await sync(b, sB);
    await sync(a, sA);
    expect(listMessages(b, g).map((m) => m.body)).toEqual(['بعد انضمام ب']);
    expect(listMessages(a, g).map((m) => m.body)).toEqual(['قبل انضمام ب', 'بعد انضمام ب']);
    expect(w.calls).toContain('joinedPage');
  });

  test('المشرف ينشئ مجموعة · والمالك يراجع بسبب وينضم بسطره ويعدّل · ثم الإزالة والمغادرة و«عضو سابق» والمسح في نافذة الحذف', async () => {
    await sync(o, sO, OWNER_NAME);
    await setSupervisor(sO, ORG, 'A@example.test', ['contracts']);
    expect(await supervisorOf(sO, ORG, 'a@example.test')).toEqual(['contracts']);
    await sync(a, sA);
    await sync(b, sB);
    const g = createGroup(a, A, 'مجموعة المشرف', [B], {}, [B]);
    sendLocal(a, g, meA, 'رسالة في المجموعة');
    await sync(a, sA);
    expect(listThreads(a, A).find((t) => t.id === g)).toMatchObject({ pending: false, rejected: false, admins: [B] });
    // العضو بلا إشراف لا ينشئ: يرفضه الخادم فتُوسم
    const gb = createGroup(b, B, 'مجموعة بلا إشراف', [A]);
    sendLocal(b, gb, meB, 'لن تصل');
    await sync(b, sB);
    expect(listThreads(b, B).find((t) => t.id === gb)!.rejected).toBe(true);

    const cands = await chatReviewCandidates(sO, ORG);
    expect(cands.map((t) => t.id)).toContain(g);
    const seen = await chatOpenReview(o, sO, ORG, g, 'سبب مصطنع', 'مجموعة المشرف');
    expect(seen.map((m) => m.body)).toEqual(['رسالة في المجموعة']);
    await chatCloseReview(sO, ORG, g);
    await expect(chatOpenReview(o, sO, ORG, g, '   ', 'x')).rejects.toThrow('chat: review needs a reason');

    await chatJoinGroup(o, sO, ORG, { id: g, p: [A, B], name: 'مجموعة المشرف' }, OWNER_NAME);
    await sync(a, sA);
    const line = listMessages(a, g).find((m) => m.sys === 'join')!;
    expect([line.body, line.sender]).toEqual([OWNER_JOINED, ORG]);
    await chatEditGroup(o, sO, ORG, g, { name: 'مجموعة معدّلة', s: { h: 'all', w: 'admins', ad: 'admins' } });
    expect(listThreads(o, ORG).find((t) => t.id === g)).toMatchObject({ name: 'مجموعة معدّلة', settings: { w: 'admins' } });

    // المالك يُزيل ب: من الدليل والإشراف ومجموعاتها (مجموعة المشرف وقناة الإعلانات)
    expect(await chatRemoveMember(sO, ORG, B, 'b@example.test')).toBe(2);
    expect((await w.chat.dispatch('getThread', w.sess[ORG].tokens.accessToken, { id: g }) as unknown as { thread: { p: string[] } }).thread.p).not.toContain(B);
    // أ يغادر ثم يحذف حسابه: اسمه في رسائله «عضو سابق»
    await chatLeaveOrg(sA, ORG);
    expect(await chatForgetMe(sA, ORG)).toBe(1);
    const stored = Object.values(w.storage.dump()).filter((v): v is WireMessage => !!v && typeof v === 'object' && (v as WireMessage).from === A);
    expect(stored.map((m) => m.name)).toEqual([FORMER_MEMBER]);
    // المسح في نافذة الحذف ثم إغلاقها · والدليل باقٍ مع keepDirectory
    expect(await chatPurgeOrg(sO, ORG, { keepDirectory: true })).toBe(2);
    expect(Object.keys(w.storage.dump()).filter((k) => /^c:(t|m|s|e):/.test(k))).toEqual([]);
    expect(Object.keys(w.storage.dump()).some((k) => k.startsWith('c:d:'))).toBe(true);
    expect(await w.storage.get('c:del')).toBeUndefined();
  });

  test('الناقل يطبّق الواجهة كلها ويقرأ الردّ بحذر', async () => {
    const t = new ServerChatTransport({ client: { call: async () => ({ ok: true, items: [{ id: 'g_x', k: 'weird', p: 'x', at: '2026-11-26T10:00:00Z', jt: { [A]: 5 } }] }) }, org: ORG, uid: A, accessToken: async () => 'tok' });
    expect(await t.myThreads()).toEqual([{ id: 'g_x', k: 'direct', p: [], name: '', by: '', at: '2026-11-26T10:00:00.000000000Z', s: {}, a: [], jt: {}, ch: null }]);
    const bad = new ServerChatTransport({ client: { call: async () => ({ ok: false, status: 429, code: 'rate_limited', waitMs: 5 }) }, org: ORG, uid: A, accessToken: async () => 'tok' });
    await expect(bad.directory()).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
  });
});

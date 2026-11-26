/**
 * ق٠-٧ · الجزء الأول: ناقل المحادثة (src/chat/transport.ts · F §٥.٢ · قرار المالك على السؤال ٣: (أ) تنتقل مع المنشأة) · Firestore خلف
 * الواجهة بلا تغيير في السلوك، وكل منادٍ في الوحدة (المزامن والقنوات وواجهة الوحدة) يمرّ بها وحدها، فتعمل المحادثة كلها بناقلٍ مصطنع في
 * الذاكرة لا يعرف Firestore ولا يمسّ الشبكة · أسماءٌ وأرقامٌ مصطنعة كلها.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { memDb } from './helpers/testDb';
import type { DB } from '@/db/adapter';
import { saveMembership } from '@/services/access';
import { FirestoreHttpError } from '@/cloud/firestore';
import { ChatRemote } from '@/chat/remote';
import {
  setChatTransport, runChatSync, chatEditMessage, chatEditsOf, chatSetPin, chatAcknowledge, chatSetTask, chatSetTaskDone, chatCancelTask,
  chatVote, chatReviewCandidates, chatOpenReview, chatCloseReview, chatJoinGroup, chatEditGroup, chatRemoveMember, chatLeaveOrg,
  chatForgetMe, chatPurgeOrg, setSupervisor, supervisorOf, openDirect, sendLocal, listMessages, listThreads, pinnedIds, acksOf, tasksIn,
  pollResults, listPeople, createGroup, channelId, ChatTransportError, isChatDenied, FORMER_MEMBER, OWNER_JOINED,
  type ChatSession, type ChatTransport, type RemoteMessage, type RemoteState, type RemoteThread, type RemoteEdit, type ChatMemberPerm,
} from '@/chat';

const ROOT = join(__dirname, '..');
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8');
function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((n) => {
    const rel = join(dir, n);
    return statSync(join(ROOT, rel)).isDirectory() ? files(rel) : /\.(ts|tsx)$/.test(n) ? [rel] : [];
  });
}

/** أسماء أعضاء الواجهة ChatTransport من نصّها (طرائق وخصائص) */
function transportMembers(): string[] {
  const sf = ts.createSourceFile('transport.ts', src('src/chat/transport.ts'), ts.ScriptTarget.Latest, true);
  let out: string[] = [];
  sf.forEachChild((n) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === 'ChatTransport') out = n.members.map((m) => (m.name as ts.Identifier).text);
  });
  return out;
}

/* ═══ ناقلٌ مصطنع في الذاكرة ═══ */

const ORG = 'uid-owner-masnoo';
const MEM = 'uid-member-masnoo';
const MEM2 = 'uid-member-thani';

/** سحابةٌ مصطنعة مشتركة بين الأجهزة · تطبّق من القواعد ما يكفي لإثبات أن الرفض يصل المنادي (طرفٌ وحده يرسل، ومرسلها وحده يعدّل) */
function memoryCloud(members: ChatMemberPerm[]) {
  let n = 0;
  const ts = () => '2026-11-26T10:00:' + String(++n).padStart(2, '0') + '.000000000Z';
  const threads = new Map<string, RemoteThread>();
  const msgs = new Map<string, RemoteMessage[]>();
  const st = new Map<string, RemoteState[]>();
  const edits = new Map<string, RemoteEdit[]>();
  const dir = new Map<string, { name: string; sup: string[] }>();
  const roles = new Map<string, string[]>();
  const reviews: Array<{ chat: string; reason: string; open: boolean }> = [];
  const calls: string[] = [];
  const knobs = { limitSends: false, window: false };
  const putSt = (tid: string, s: RemoteState) => st.set(tid, [...(st.get(tid) ?? []).filter((x) => x.id !== s.id), { ...s, ts: ts() }]);
  const deny = (why: string) => new ChatTransportError(403, why);

  function transport(uid: string): ChatTransport {
    const log = (k: string) => calls.push(uid + ':' + k);
    const th = (id: string) => { const t = threads.get(id); if (!t) throw new ChatTransportError(404, 'not_found'); return t; };
    const msg = (tid: string, id: string) => { const m = (msgs.get(tid) ?? []).find((x) => x.id === id); if (!m) throw new ChatTransportError(404, 'not_found'); return m; };
    const t: ChatTransport = {
      async putMyDirectory(name, sup) { log('putMyDirectory'); dir.set(uid, { name, sup }); },
      async directory() { log('directory'); return [...dir].map(([u, d]) => ({ uid: u, ...d })); },
      async removeFromDirectory(u) { log('removeFromDirectory'); dir.delete(u); },
      async role(email) { log('role'); return roles.get(email) ?? []; },
      async setRole(email, sup) { log('setRole'); roles.set(email, sup); },
      async removeRole(email) { log('removeRole'); roles.delete(email); },
      async members() { log('members'); if (uid !== ORG) throw deny('owner_only'); return members; },
      async createThread(x) {
        log('createThread');
        if (threads.has(x.id)) return 'exists';
        threads.set(x.id, { id: x.id, k: x.k, p: [...x.p].sort(), name: x.name, by: uid, at: ts(), s: x.s ?? {}, a: x.a ?? [], jt: {}, ch: null });
        return 'created';
      },
      async createChannel(id, ch, name) {
        log('createChannel');
        if (threads.has(id)) return 'exists';
        threads.set(id, { id, k: 'group', p: [uid], name, by: uid, at: ts(), s: {}, a: [], jt: {}, ch });
        return 'created';
      },
      async getThread(id) { log('getThread'); const x = th(id); return { ...x, p: [...x.p] }; },
      async myThreads() { log('myThreads'); return [...threads.values()].filter((x) => x.p.includes(uid)); },
      async orgThreads() { log('orgThreads'); if (uid !== ORG) throw deny('owner_only'); return [...threads.values()]; },
      async groupsOf(u) { log('groupsOf'); return [...threads.values()].filter((x) => x.k === 'group' && x.p.includes(u)).map((x) => ({ id: x.id, p: x.p, name: x.name })); },
      async addMember(id, u) { log('addMember'); const x = th(id); if (!x.p.includes(u)) { x.p = [...x.p, u]; x.jt = { ...x.jt, [u]: ts() }; } },
      async removeMembers(id, us) { log('removeMembers'); const x = th(id); x.p = x.p.filter((u) => !us.includes(u)); x.a = (x.a ?? []).filter((u) => !us.includes(u)); },
      async leaveGroup(id) { log('leaveGroup'); await t.removeMembers(id, [uid]); },
      async setGroupMeta(id, m) { log('setGroupMeta'); Object.assign(th(id), m); },
      async joinGroup(id, myName) {
        log('joinGroup');
        const x = th(id);
        x.p = [...x.p, uid];
        msgs.set(id, [...(msgs.get(id) ?? []), { id: 'j_1', from: uid, name: myName, body: OWNER_JOINED, link: null, ts: ts(), sys: 'join' }]);
        return 'j_1';
      },
      async sendMessage(tid, m) {
        log('sendMessage');
        if (knobs.limitSends) throw new ChatTransportError(429, 'rate_limited');
        if (!th(tid).p.includes(uid)) throw deny('not_party');
        const list = msgs.get(tid) ?? [];
        if (list.some((x) => x.id === m.id)) return 'exists';
        msgs.set(tid, [...list, { id: m.id, from: uid, name: m.name, body: m.body, link: m.link, ts: ts(), sys: null, re: m.re ?? null, men: m.men ?? [],
          tag: m.tag ?? null, ack: !!m.ack, ev: 0, et: null, poll: m.poll ?? null }]);
        return 'created';
      },
      async getMessage(tid, id) { log('getMessage'); return { ...msg(tid, id) }; },
      async messagesSince(tid, cursor) { log('messagesSince'); return (msgs.get(tid) ?? []).filter((m) => !cursor || m.ts >= cursor); },
      async joinedPage(tid, cursor) {
        log('joinedPage');
        const l = (msgs.get(tid) ?? []).filter((m) => m.ts >= cursor);
        return { msgs: l, ids: l.length, lastTs: l.length ? l[l.length - 1].ts : null, lastId: l.length ? l[l.length - 1].id : null };
      },
      async editMessage(tid, id, body, tag) {
        log('editMessage');
        const m = msg(tid, id);
        if (m.from !== uid) throw deny('not_sender');
        const ev = (m.ev ?? 0) + 1;
        edits.set(tid + '/' + id, [...(edits.get(tid + '/' + id) ?? []), { n: ev, body: m.body, tag: m.tag ?? null, at: ts() }]);
        Object.assign(m, { body, tag, ev, et: ts() });
        putSt(tid, { id: 'x_' + id, k: 'edit', m: id, n: ev, ts: '' });
        return ev;
      },
      async editsOf(tid, id) { log('editsOf'); return edits.get(tid + '/' + id) ?? []; },
      async anonymizeMine(label) {
        log('anonymizeMine');
        let k = 0;
        for (const l of msgs.values()) for (const m of l) if (m.from === uid) { m.name = label; k++; }
        return k;
      },
      async stateSince(tid, cursor) { log('stateSince'); return (st.get(tid) ?? []).filter((x) => !cursor || x.ts >= cursor); },
      async markReadUpTo(tid, at) { log('markReadUpTo'); putSt(tid, { id: 'r_' + uid, k: 'read', at, ts: '' }); },
      async setPin(tid, id, on) { log('setPin'); putSt(tid, { id: 'p_' + id, k: 'pin', on, by: uid, ts: '' }); },
      async acknowledge(tid, id) {
        log('acknowledge');
        if ((st.get(tid) ?? []).some((x) => x.id === `a_${id}_${uid}`)) return 'exists';
        putSt(tid, { id: `a_${id}_${uid}`, k: 'ack', m: id, by: uid, ts: '' });
        return 'created';
      },
      async setTask(tid, id, task) {
        log('setTask');
        const cur = (st.get(tid) ?? []).find((x) => x.id === 't_' + id);
        putSt(tid, { id: 't_' + id, k: 'task', m: id, ...task, done: cur?.done ?? task.done, by: cur?.by ?? uid, ts: '' });
      },
      async setTaskDone(tid, id, done) { log('setTaskDone'); const cur = (st.get(tid) ?? []).find((x) => x.id === 't_' + id)!; putSt(tid, { ...cur, done }); },
      async cancelTask(tid, id) { log('cancelTask'); const cur = (st.get(tid) ?? []).find((x) => x.id === 't_' + id)!; putSt(tid, { ...cur, cx: true }); },
      async vote(tid, id, o) { log('vote'); putSt(tid, { id: `v_${id}_${uid}`, k: 'vote', m: id, by: uid, o, ts: '' }); },
      async openReview(chat, reason) { log('openReview'); reviews.push({ chat, reason, open: true }); return 'rid-' + reviews.length; },
      async closeReview(chat) { log('closeReview'); for (const r of reviews) if (r.chat === chat) r.open = false; },
      async allMessages(tid) {
        log('allMessages');
        if (!reviews.some((r) => r.chat === tid && r.open)) throw deny('no_review');
        return [...(msgs.get(tid) ?? [])];
      },
      openDeletionWindow: async () => { log('openDeletionWindow'); knobs.window = true; },
      closeDeletionWindow: async () => { log('closeDeletionWindow'); knobs.window = false; },
      purgeAll: async (o = {}) => {
        log('purgeAll');
        if (!knobs.window) throw deny('window');
        let k = 0;
        for (const l of msgs.values()) k += l.length;
        threads.clear(); msgs.clear(); st.clear(); edits.clear();
        if (!o.keepDirectory) { dir.clear(); roles.clear(); }
        return k;
      },
    };
    return t;
  }
  return { transport, threads, msgs, dir, roles, reviews, calls, knobs };
}

const session = (uid: string, email: string): ChatSession => ({
  projectId: 'mashrou-ghayr-mawjood', uid, email,
  idToken: async () => { throw new Error('لا رمز Firestore في هذا الاختبار'); },
});

describe('الواجهة', () => {
  test('ChatRemote (Firestore) يطبّق الواجهة كلها · وكل عضوٍ فيها طريقةٌ فيه', () => {
    const r: ChatTransport = new ChatRemote({ projectId: 'demo-p', org: ORG, uid: ORG, idToken: async () => 'T' });
    const names = transportMembers();
    expect(names.length).toBeGreaterThan(35);
    for (const k of names) expect([k, typeof (r as unknown as Record<string, unknown>)[k]]).toEqual([k, 'function']);
  });

  test('لا منادي يعرف Firestore: ChatRemote وremote.ts لا يُستوردان إلا في الناقل الافتراضي (index.ts) · ولا قراءة لنصّ «Firestore 403» ولا deleteIn خارجه', () => {
    const users: string[] = [];
    for (const f of [...files('src'), ...files('app')]) {
      if (f === join('src', 'chat', 'remote.ts')) continue;
      const s = src(f);
      if (/from '[./@]*\/?(src\/)?chat\/remote'|from '\.\/remote'|\bChatRemote\b/.test(s.replace(/\/\*[^]*?\*\/|\/\/.*$/gm, ''))) users.push(f);
    }
    expect(users).toEqual([join('src', 'chat', 'index.ts')]);
    for (const f of ['src/chat/sync.ts', 'src/chat/channels.ts', 'src/chat/index.ts']) {
      expect([f, /Firestore \d|FirestoreHttpError|deleteIn\(|chatDir\/|chatRoles\//.test(src(f))]).toEqual([f, false]);
    }
    // والناقل الافتراضي واحدٌ في index.ts · ومبدّله بلا منادٍ في التطبيق حتى التحويل بإذن المالك
    const idx = src('src/chat/index.ts');
    expect(idx.match(/new ChatRemote\(/g)).toHaveLength(1);
    const callers = [...files('src'), ...files('app')].filter((f) => /setChatTransport\(/.test(src(f).replace(/export function setChatTransport\(/, '')));
    expect(callers).toEqual([]);
  });

  test('الرفض (403) واحدٌ للناقلين، والحدّ والانقطاع عارضان يُعادان', () => {
    expect(isChatDenied(new FirestoreHttpError(403, 'PERMISSION_DENIED'))).toBe(true);
    expect(isChatDenied(new Error('Firestore 403: x'))).toBe(true);
    expect(isChatDenied(new ChatTransportError(403, 'not_party'))).toBe(true);
    expect(isChatDenied(new FirestoreHttpError(500, 'x'))).toBe(false);
    expect(isChatDenied(new ChatTransportError(429, 'rate_limited'))).toBe(false);
    expect(isChatDenied(new ChatTransportError(401, 'expired'))).toBe(false);
    expect(isChatDenied(new Error('offline'))).toBe(false);
  });

  test('الافتراضي Firestore كما كان: الطلب نفسه إلى المسار نفسه بالرمز نفسه', async () => {
    const seen: Array<{ url: string; auth: string }> = [];
    const orig = global.fetch;
    global.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, auth: init?.headers?.Authorization ?? '' });
      return { ok: true, status: 200, text: async () => (/:runQuery$/.test(url) ? '[]' : '{}') } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      setChatTransport(null);
      const s: ChatSession = { projectId: 'demo-p', uid: MEM, email: 'm@example.test', idToken: async () => 'tok-masnoo' };
      await chatEditsOf(s, ORG, 'd_a_b', 'msg1');
      await chatLeaveOrg(s, ORG);
    } finally { global.fetch = orig; }
    expect(seen[0]).toEqual({ url: `https://firestore.googleapis.com/v1/projects/demo-p/databases/(default)/documents/orgs/${ORG}/chats/d_a_b/msgs/msg1/edits?pageSize=300`, auth: 'Bearer tok-masnoo' });
    expect(seen.map((x) => x.url)).toEqual(expect.arrayContaining([`https://firestore.googleapis.com/v1/projects/demo-p/databases/(default)/documents/orgs/${ORG}:runQuery`]));
  });
});

describe('المحادثة كلها بناقلٍ مصطنع بلا Firestore ولا شبكة', () => {
  const members: ChatMemberPerm[] = [
    { uid: MEM, perm: { contracts: 1 }, all: false, props: [] },
    { uid: MEM2, perm: {}, all: false, props: [] },
  ];
  let cloud: ReturnType<typeof memoryCloud>;
  let net: string[];
  const orig = global.fetch;
  const sO = session(ORG, 'owner@example.test');
  const sM = session(MEM, 'member@example.test');
  const sM2 = session(MEM2, 'member2@example.test');
  let o: DB, m: DB, m2: DB;
  const meO = { uid: ORG, name: 'منشأة مصطنعة' };
  const meM = { uid: MEM, name: 'عضو مصطنع' };
  const meM2 = { uid: MEM2, name: 'عضو ثان مصطنع' };
  const sync = (db: DB, s: ChatSession, name = '') => runChatSync(db, s, name, { force: true });

  beforeEach(() => {
    cloud = memoryCloud(members);
    net = [];
    global.fetch = (async (u: string) => { net.push(String(u)); throw new Error('لا شبكة في هذا الاختبار'); }) as unknown as typeof fetch;
    setChatTransport((s, org) => { expect(org).toBe(ORG); return cloud.transport(s.uid); });
    o = memDb(); m = memDb(); m2 = memDb();
    saveMembership(m, { org: ORG, uid: MEM, perms: { contracts: 1 } as never, allProps: false, props: [], profile: { name: meM.name, phone: '', nid: '', title: '' } });
    saveMembership(m2, { org: ORG, uid: MEM2, perms: {} as never, allProps: false, props: [], profile: { name: meM2.name, phone: '', nid: '', title: '' } });
  });
  afterEach(() => {
    setChatTransport(null);
    global.fetch = orig;
    expect(net).toEqual([]);
  });

  test('الدليل والقنوات والإرسال والسحب والتعديل وسجله والتثبيت وتأكيد الاطلاع والمهام والاستطلاع', async () => {
    await sync(o, sO, meO.name);
    expect(cloud.threads.has(channelId({ t: 'announce' }))).toBe(true);
    expect(cloud.threads.has(channelId({ t: 'section', key: 'contracts' }))).toBe(true);
    await sync(m, sM);
    await sync(m2, sM2);
    expect(cloud.threads.get(channelId({ t: 'section', key: 'contracts' }))!.p.sort()).toEqual([ORG, MEM].sort());
    await sync(o, sO, meO.name);
    expect(listPeople(o).map((p) => p.name).sort()).toEqual([meO.name, meM.name, meM2.name].sort());

    const tid = openDirect(o, ORG, MEM);
    const hello = sendLocal(o, tid, meO, 'مرحبا من المالك', null, { ack: true });
    const poll = sendLocal(o, tid, meO, 'أي موعد يناسب؟', null, { poll: { o: ['الأحد', 'الاثنين'], m: false } });
    await sync(o, sO, meO.name);
    await sync(m, sM);
    expect(listMessages(m, tid).map((x) => x.body)).toEqual(['مرحبا من المالك', 'أي موعد يناسب؟']);

    const reply = sendLocal(m, tid, meM, 'وعليكم السلام', null, { re: hello });
    await sync(m, sM);
    await chatEditMessage(m, sM, ORG, tid, reply, 'وعليكم السلام ورحمة الله', 'followup');
    expect((await chatEditsOf(sM, ORG, tid, reply)).map((e) => e.body)).toEqual(['وعليكم السلام']);
    await chatAcknowledge(m, sM, ORG, tid, hello);
    await chatVote(m, sM, ORG, tid, poll, [1, 1]);
    await chatSetPin(o, sO, ORG, tid, hello, true);
    await chatSetTask(o, sO, ORG, tid, hello, { title: 'مهمة مصطنعة', as: MEM, due: '2026-12-01', done: false });
    await chatSetTaskDone(m, sM, ORG, tid, hello, true);
    await sync(o, sO, meO.name);
    const mine = listMessages(o, tid).find((x) => x.id === reply)!;
    expect([mine.body, mine.tag, mine.ev]).toEqual(['وعليكم السلام ورحمة الله', 'followup', 1]);
    expect(pinnedIds(o, tid)).toEqual([hello]);
    expect(acksOf(o, tid)[hello]).toEqual([MEM]);
    expect(pollResults(o, tid, poll, 2, ORG).counts).toEqual([0, 1]);
    expect(tasksIn(o, tid)[hello]).toMatchObject({ title: 'مهمة مصطنعة', as: MEM, done: true, by: ORG, cx: false });
    await chatCancelTask(o, sO, ORG, tid, hello);
    expect(tasksIn(o, tid)[hello].cx).toBe(true);
  });

  test('الرفض من الناقل يُوسم الرسالة «رفضها الخادم» · والحدّ يُبقيها منتظرةً تُعاد', async () => {
    await sync(o, sO, meO.name);
    await sync(m, sM);
    const tid = openDirect(m, MEM, MEM2);
    sendLocal(m, tid, meM, 'أولى');
    cloud.knobs.limitSends = true;
    await sync(m, sM);
    expect(listMessages(m, tid).map((x) => [x.sent, x.rejected])).toEqual([[false, false]]);
    cloud.knobs.limitSends = false;
    await sync(m, sM);
    expect(listMessages(m, tid).map((x) => [x.sent, x.rejected])).toEqual([[true, false]]);
    // أُخرج من المحادثة في السحابة: الرفض يصل المنادي ويوسمها
    cloud.threads.get(tid)!.p = [MEM2];
    sendLocal(m, tid, meM, 'ثانية بعد الإخراج');
    await sync(m, sM);
    expect(listMessages(m, tid).map((x) => [x.body, x.rejected])).toEqual([['أولى', false], ['ثانية بعد الإخراج', true]]);
    // وتعديل رسالة غيري يرفضه الناقل فلا يُكتب
    await expect(chatEditMessage(m2, sM2, ORG, tid, listMessages(m, tid)[0].id, 'ليس لي', null)).rejects.toThrow(/403/);
  });

  test('المجموعات والمراجعة والانضمام والإشراف والإزالة والمغادرة و«عضو سابق» والمسح', async () => {
    await sync(o, sO, meO.name);
    await sync(m, sM);
    await sync(m2, sM2);
    await setSupervisor(sO, ORG, 'Member@Example.test ', ['contracts']);
    expect(await supervisorOf(sO, ORG, 'Member@Example.test ')).toEqual(['contracts']);
    // بين العضوين وحدهما: يراها المالك في المرشّحين، ويراجعها بسبب، وينضم إلى مجموعتهما
    const g = createGroup(m, MEM, 'مجموعة مصطنعة', [MEM, MEM2]);
    sendLocal(m, g, meM, 'رسالة في المجموعة');
    await sync(m, sM);
    const cands = await chatReviewCandidates(sO, ORG);
    expect(cands.map((t) => t.id)).toContain(g);
    const seen = await chatOpenReview(o, sO, ORG, g, 'سبب مصطنع', 'مجموعة مصطنعة');
    expect(seen.map((x) => x.body)).toEqual(['رسالة في المجموعة']);
    await chatCloseReview(sO, ORG, g);
    expect(cloud.reviews).toEqual([{ chat: g, reason: 'سبب مصطنع', open: false }]);
    await chatJoinGroup(o, sO, ORG, { id: g, p: [MEM, MEM2], name: 'مجموعة مصطنعة' }, meO.name);
    expect(listThreads(o, ORG).some((t) => t.id === g)).toBe(true);
    await chatEditGroup(o, sO, ORG, g, { name: 'مجموعة معدّلة', members: [ORG, MEM] });
    expect(cloud.threads.get(g)).toMatchObject({ name: 'مجموعة معدّلة', p: [ORG, MEM].sort() });
    // إزالة العضو الثاني من الدليل والإشراف والمجموعات
    await chatRemoveMember(sO, ORG, MEM2, 'Member2@example.test');
    expect(cloud.dir.has(MEM2)).toBe(false);
    // العضو يغادر ثم يحذف حسابه
    await chatLeaveOrg(sM, ORG);
    expect(cloud.threads.get(g)!.p).toEqual([ORG]);
    expect(cloud.dir.has(MEM)).toBe(false);
    expect(await chatForgetMe(sM, ORG)).toBeGreaterThan(0);
    expect([...cloud.msgs.values()].flat().filter((x) => x.from === MEM).every((x) => x.name === FORMER_MEMBER)).toBe(true);
    // المسح في نافذة الحذف ثم إغلاقها
    expect(await chatPurgeOrg(sO, ORG, { keepDirectory: true })).toBeGreaterThan(0);
    expect(cloud.threads.size).toBe(0);
    expect(cloud.dir.size).toBeGreaterThan(0);
    expect(cloud.knobs.window).toBe(false);
    expect(cloud.calls.filter((c) => /DeletionWindow/.test(c))).toEqual([ORG + ':openDeletionWindow', ORG + ':closeDeletionWindow']);
  });
});

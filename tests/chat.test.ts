/**
 * المحادثة (src/chat · قرار المالك 2026-10-07) على الجهاز: فردية ومجموعات، بلا اتصال ثم الإرسال عند عودته بلا
 * تكرار، ولا حذف للرسائل، وربط بعقد ووحدة وأصل يفتحه صاحب الصلاحية ويرى غيره اسمه · بيانات مصطنعة وعميل وهمي.
 */
import { memDb } from './helpers/testDb';
import { addProperty, addUnit, contractInput } from './helpers/fixtures';
import type { DB } from '@/db/adapter';
import { confirmContract } from '@/domain/contracts/service';
import { OWNER_ACCESS } from '@/domain/access/access';
import {
  openDirect, createGroup, sendLocal, listMessages, listThreads, markRead, linkTarget, linkCandidates, directId, canCreateGroup,
  OWNER_JOINED, REVIEW_ENTITY, JOIN_ENTITY, type ChatMe, type ChatLink,
} from '@/chat';
import { applyRemoteThread, applyRemoteMessage } from '@/chat/store';
import { chatSyncOnce } from '@/chat/sync';
import type { ChatRemote, RemoteMessage, RemoteThread } from '@/chat/remote';

/** سحابة وهمية مشتركة بين جهازين · وانقطاع يُشغَّل ويُطفأ */
function fakeCloud() {
  const threads = new Map<string, RemoteThread>();
  const msgs = new Map<string, RemoteMessage[]>();
  const dir = new Map<string, { name: string; sup: string[] }>();
  let clock = 0;
  const state = { offline: false, sends: 0 };
  const ts = () => new Date(Date.UTC(2026, 0, 1) + ++clock * 1000).toISOString();
  const remote = (uid: string): ChatRemote => {
    const guard = () => { if (state.offline) throw new Error('offline'); };
    return {
      async putMyDirectory(name: string, sup: string[]) { guard(); dir.set(uid, { name, sup }); },
      async directory() { guard(); return [...dir].map(([u, d]) => ({ uid: u, ...d })); },
      async role() { guard(); return []; },
      async setRole() { guard(); },
      async createThread(t: { id: string; k: 'direct' | 'group'; p: string[]; name: string }) {
        guard();
        if (threads.has(t.id)) return 'exists';
        threads.set(t.id, { ...t, by: uid, at: ts() });
        return 'created';
      },
      async myThreads() { guard(); return [...threads.values()].filter((t) => t.p.includes(uid)); },
      async sendMessage(threadId: string, m: { id: string; name: string; body: string; link: ChatLink | null }) {
        guard();
        state.sends++;
        const list = msgs.get(threadId) ?? [];
        if (list.some((x) => x.id === m.id)) return 'exists';
        list.push({ id: m.id, from: uid, name: m.name, body: m.body, link: m.link, ts: ts() });
        msgs.set(threadId, list);
        return 'created';
      },
      async messagesSince(threadId: string, cursor: string | null) {
        guard();
        return (msgs.get(threadId) ?? []).filter((m) => !cursor || m.ts >= cursor);
      },
    } as unknown as ChatRemote;
  };
  return { remote, state, msgs, threads };
}

const me = (uid: string, name: string, owner = false): ChatMe => ({ org: 'ORG', uid, email: uid + '@example.test', name, owner });
const OWNER = me('u-owner', 'مالك مصطنع', true);
const MEMBER = me('u-member', 'عضو مصطنع');

test('محادثة فردية: رقم ثابت للطرفين · بلا اتصال تبقى «لم تُرسل» ثم تُرسل مرة واحدة عند عودته', async () => {
  const cloud = fakeCloud();
  const a = memDb();
  const b = memDb();
  const tid = openDirect(a, OWNER.uid, MEMBER.uid);
  expect(tid).toBe(directId(MEMBER.uid, OWNER.uid));
  cloud.state.offline = true;
  sendLocal(a, tid, OWNER, 'رسالة مصطنعة أولى');
  await chatSyncOnce(a, cloud.remote(OWNER.uid), OWNER);
  expect(listMessages(a, tid).map((m) => m.sent)).toEqual([false]);
  cloud.state.offline = false;
  await chatSyncOnce(a, cloud.remote(OWNER.uid), OWNER);
  await chatSyncOnce(a, cloud.remote(OWNER.uid), OWNER);
  expect(cloud.msgs.get(tid)!.length).toBe(1);
  expect(listMessages(a, tid)[0].sent).toBe(true);
  // الطرف الآخر يتلقاها في محادثة بالرقم نفسه
  await chatSyncOnce(b, cloud.remote(MEMBER.uid), MEMBER);
  expect(listThreads(b, MEMBER.uid).map((t) => t.id)).toEqual([tid]);
  expect(listMessages(b, tid).map((m) => [m.senderName, m.body])).toEqual([['مالك مصطنع', 'رسالة مصطنعة أولى']]);
  expect(listThreads(b, MEMBER.uid)[0].unread).toBe(1);
  markRead(b, tid);
  expect(listThreads(b, MEMBER.uid)[0].unread).toBe(0);
});

test('المجموعة: المالك والمشرفون وحدهم ينشئونها · وأعضاؤها يتلقون رسائلها', async () => {
  expect(canCreateGroup(OWNER, [])).toBe(true);
  expect(canCreateGroup(MEMBER, [])).toBe(false);
  expect(canCreateGroup(MEMBER, ['contracts'])).toBe(true);
  const cloud = fakeCloud();
  const a = memDb();
  const b = memDb();
  const gid = createGroup(a, OWNER.uid, 'مجموعة مصطنعة', [MEMBER.uid, 'u-third']);
  sendLocal(a, gid, OWNER, 'إعلان مصطنع');
  await chatSyncOnce(a, cloud.remote(OWNER.uid), OWNER);
  await chatSyncOnce(b, cloud.remote(MEMBER.uid), MEMBER);
  const t = listThreads(b, MEMBER.uid)[0];
  expect([t.kind, t.name, t.members.length]).toEqual(['group', 'مجموعة مصطنعة', 3]);
  expect(listMessages(b, gid).map((m) => m.body)).toEqual(['إعلان مصطنع']);
});

test('الرسالة لا تُحذف من الجهاز', () => {
  const a = memDb();
  const tid = openDirect(a, OWNER.uid, MEMBER.uid);
  sendLocal(a, tid, OWNER, 'تبقى');
  expect(() => a.run(`DELETE FROM chat_messages`)).toThrow();
  expect(listMessages(a, tid).length).toBe(1);
});

function withRecords(db: DB) {
  const u = addUnit(db, addProperty(db, { name: 'عقار محادثة مصطنع' }), { unit_no: 'C-1' });
  const c = confirmContract(db, contractInput(u, { tenant: 'مستأجر محادثة مصطنع', idNumber: '1000009001', phone: '0500009001', depositHalalas: 0 }));
  return { u, c };
}

test('الربط بعقد ووحدة: يفتحه من له صلاحية وعلى جهازه السجل · ومن لا صلاحية له يرى اسمه فقط', () => {
  const a = memDb();
  const { u, c } = withRecords(a);
  const contracts = linkCandidates(a, OWNER_ACCESS, 'contract');
  const units = linkCandidates(a, OWNER_ACCESS, 'unit');
  expect(contracts.map((x) => x.id)).toContain(c);
  expect(units.map((x) => x.id)).toContain(u);
  const link = contracts.find((x) => x.id === c)!;
  expect(linkTarget(a, OWNER_ACCESS, link)).toEqual({ canOpen: true, route: '/contracts' });
  // عضو بلا قسم العقود: الاسم وحده
  const noContracts = { ...OWNER_ACCESS, owner: false, perms: { props: 1 } } as typeof OWNER_ACCESS;
  expect(linkTarget(a, noContracts, link)).toEqual({ canOpen: false, route: null });
  // جهاز لا يصله السجل (خارج نطاقه): الاسم وحده
  const other = memDb();
  expect(linkTarget(other, OWNER_ACCESS, link).canOpen).toBe(false);
  // طلب الصيانة مصمَّم ولا يُفتح حتى يُبنى
  expect(linkTarget(a, OWNER_ACCESS, { type: 'maintenance', id: 'x', label: 'طلب' }).canOpen).toBe(false);
  // الرسالة تحمل اسم السجل يوم إرسالها
  const tid = openDirect(a, OWNER.uid, MEMBER.uid);
  sendLocal(a, tid, OWNER, '', link);
  expect(listMessages(a, tid)[0].link).toEqual(link);
});

test('المحادثة لا تجعل الجهاز «فيه بيانات» فلا تمنع دعوة (مراجعة المحادثة #1)', async () => {
  const { hasUserData } = await import('@/domain/backup/upgrade');
  const a = memDb();
  expect(hasUserData(a)).toBe(false);
  const tid = openDirect(a, OWNER.uid, MEMBER.uid);
  sendLocal(a, tid, OWNER, 'لا تُحسب بيانات منشأة');
  expect(hasUserData(a)).toBe(false);
});

test('المحادثة لا تُرفع قبل أول رسالة · والدليل لا يُكتب بلا تغيير · والسحب الكامل بمدته (الحصة المجانية)', async () => {
  const cloud = fakeCloud();
  const calls = { dir: 0, threads: 0 };
  const base = cloud.remote(OWNER.uid);
  const remote = new Proxy(base, {
    get(t, k) {
      if (k === 'putMyDirectory') calls.dir++;
      if (k === 'myThreads') calls.threads++;
      return (t as unknown as Record<string | symbol, unknown>)[k];
    },
  }) as typeof base;
  const a = memDb();
  const tid = openDirect(a, OWNER.uid, MEMBER.uid);
  await chatSyncOnce(a, remote, OWNER, { now: 1_000_000 });
  expect(cloud.threads.has(tid)).toBe(false);
  expect([calls.dir, calls.threads]).toEqual([1, 1]);
  // بعد دقيقة: لا كتابة للدليل ولا سحب كامل
  await chatSyncOnce(a, remote, OWNER, { now: 1_060_000 });
  expect([calls.dir, calls.threads]).toEqual([1, 1]);
  // أول رسالة تُرفع معها المحادثة · وبعد دقيقتين سحب كامل
  sendLocal(a, tid, OWNER, 'أولى');
  await chatSyncOnce(a, remote, OWNER, { now: 1_200_000 });
  expect(cloud.threads.has(tid)).toBe(true);
  expect(calls.threads).toBe(2);
});

test('المحادثة المرفوضة تحجز رسائلها وتوسَم · والرسالة تُرفع باسم صاحبها الحالي (التحقق ج١ وج٢ وج٤)', async () => {
  const cloud = fakeCloud();
  const a = memDb();
  const base = cloud.remote(MEMBER.uid);
  const sent: string[] = [];
  const refusing = new Proxy(base, {
    get(t, k) {
      if (k === 'createThread') return async () => { throw new Error('Firestore 403: denied'); };
      if (k === 'sendMessage') return async (_id: string, m: { name: string }) => { sent.push(m.name); return 'created'; };
      return (t as unknown as Record<string | symbol, unknown>)[k];
    },
  }) as typeof base;
  const gid = createGroup(a, MEMBER.uid, 'مجموعة مرفوضة', [OWNER.uid]);
  sendLocal(a, gid, { uid: MEMBER.uid, name: 'اسم قديم' }, 'لا تُرسل');
  await chatSyncOnce(a, refusing, MEMBER, { force: true });
  await chatSyncOnce(a, refusing, MEMBER, { force: true });
  expect(listThreads(a, MEMBER.uid).find((t) => t.id === gid)!.rejected).toBe(true);
  expect(sent).toEqual([]);
  // محادثة سليمة: الرسالة المكتوبة باسم قديم تُرفع بالاسم الحالي
  const tid = openDirect(a, MEMBER.uid, OWNER.uid);
  sendLocal(a, tid, { uid: MEMBER.uid, name: 'اسم قديم' }, 'تُرسل');
  await chatSyncOnce(a, new Proxy(base, {
    get(t, k) {
      if (k === 'sendMessage') return async (_id: string, m: { name: string }) => { sent.push(m.name); return 'created'; };
      return (t as unknown as Record<string | symbol, unknown>)[k];
    },
  }) as typeof base, MEMBER, { force: true });
  expect(sent).toEqual([MEMBER.name]);
});

test('الدليل يُستبدل كاملاً فمن خرج منه لا يبقى باسمه · وتعديل المجموعة للمالك ومنشئها (#2 و#19)', async () => {
  const { savePeople, listPeople } = await import('@/chat/store');
  const { canEditGroup } = await import('@/chat');
  const a = memDb();
  savePeople(a, [{ uid: 'u1', name: 'أ', sup: [] }, { uid: 'u2', name: 'ب', sup: [] }]);
  savePeople(a, [{ uid: 'u1', name: 'أ', sup: [] }]);
  expect(listPeople(a).map((p) => p.uid)).toEqual(['u1']);
  expect(canEditGroup(OWNER, 'someone')).toBe(true);
  expect(canEditGroup(MEMBER, MEMBER.uid)).toBe(true);
  expect(canEditGroup(MEMBER, 'someone')).toBe(false);
});

/* ─── مراجعة المحادثات بسبب · وانضمام المالك (قرارا المالك 2026-10-08T04:11Z) ─── */

/** سحابة وهمية بمراجعات المالك وانضمامه · فوق السحابة المشتركة */
function reviewCloud() {
  const cloud = fakeCloud();
  const calls = { org: 0, open: [] as Array<{ chat: string; reason: string }>, closed: [] as string[] };
  const remote = (uid: string): ChatRemote => {
    const base = cloud.remote(uid) as unknown as Record<string, unknown>;
    return new Proxy(base, {
      get(t, k) {
        if (k === 'orgThreads') return async () => { calls.org++; return [...cloud.threads.values()]; };
        if (k === 'openReview') return async (chat: string, reason: string) => { calls.open.push({ chat, reason }); return 'rid-' + calls.open.length; };
        if (k === 'closeReview') return async (chat: string) => { calls.closed.push(chat); };
        if (k === 'allMessages') return async (id: string) => cloud.msgs.get(id) ?? [];
        if (k === 'joinGroup') return async (id: string, p: string[], name: string, myName: string) => {
          const th = cloud.threads.get(id)!;
          cloud.threads.set(id, { ...th, p: Array.from(new Set([...p, uid])).sort(), name });
          const list = cloud.msgs.get(id) ?? [];
          list.push({ id: 'j_1', from: uid, name: myName, body: OWNER_JOINED, link: null, ts: new Date(Date.UTC(2026, 0, 2)).toISOString(), sys: 'join' });
          cloud.msgs.set(id, list);
          return 'j_1';
        };
        return t[k as string];
      },
    }) as unknown as ChatRemote;
  };
  return { cloud, calls, remote };
}

async function memberChat(rc: ReturnType<typeof reviewCloud>) {
  const OTHER = me('u-other', 'عضو آخر مصطنع');
  const m1 = memDb();
  const tid = openDirect(m1, MEMBER.uid, OTHER.uid);
  sendLocal(m1, tid, MEMBER, 'خاصة بين عضوين');
  await chatSyncOnce(m1, rc.remote(MEMBER.uid), MEMBER);
  return { tid, OTHER };
}

test('١ و٧ قائمة المالك محادثاته وحدها · ولا تُقرأ محادثات المنشأة في المزامنة أبداً', async () => {
  const rc = reviewCloud();
  const { tid } = await memberChat(rc);
  const o = memDb();
  const own = openDirect(o, OWNER.uid, MEMBER.uid);
  sendLocal(o, own, OWNER, 'من المالك');
  for (const now of [10_000_000, 10_700_000, 20_000_000]) await chatSyncOnce(o, rc.remote(OWNER.uid), OWNER, { now, force: true });
  await chatSyncOnce(o, rc.remote(OWNER.uid), OWNER, { full: true });
  expect(rc.calls.org).toBe(0);
  expect(listThreads(o, OWNER.uid, true).map((t) => t.id)).toEqual([own]);
  expect(listMessages(o, tid)).toEqual([]);
});

test('العضو يرى مجموعةً أُخرج منها بسجلها كما كان · والتصفية للمالك وحده', () => {
  const m = memDb();
  applyRemoteThread(m, { id: 'g_out00001', k: 'group', p: ['u-a', 'u-b'], name: 'أُخرج منها', by: 'u-a', at: null });
  expect(listThreads(m, MEMBER.uid).map((t) => t.id)).toEqual(['g_out00001']);
  expect(listThreads(m, MEMBER.uid, true)).toEqual([]);
});

test('١ ما بقي على جهاز المالك من اطلاع النسخة السابقة يُمحى مرة واحدة · ولا تُمسّ محادثاته', async () => {
  const { forgetObserved } = await import('@/chat/store');
  const o = memDb();
  const own = openDirect(o, OWNER.uid, MEMBER.uid);
  sendLocal(o, own, OWNER, 'تبقى');
  // محادثة عضوين سُحبت بالاطلاع السابق
  applyRemoteThread(o, { id: 'd_u-a_u-b', k: 'direct', p: ['u-a', 'u-b'], name: '', by: 'u-a', at: null });
  applyRemoteMessage(o, 'd_u-a_u-b', { id: 'X1', from: 'u-a', name: 'أ', body: 'سُحبت بالاطلاع', link: null, ts: '2026-01-01T00:00:00.000Z' });
  // مجموعة غادرها المالك وفيها رسائله: تبقى
  applyRemoteThread(o, { id: 'g_left0001', k: 'group', p: ['u-a', 'u-b'], name: 'غادرها', by: OWNER.uid, at: null });
  expect(forgetObserved(o, OWNER.uid)).toBe(1);
  expect(listMessages(o, 'd_u-a_u-b')).toEqual([]);
  expect(listMessages(o, own).map((m) => m.body)).toEqual(['تبقى']);
  expect(o.get(`SELECT 1 AS x FROM chat_threads WHERE id = 'g_left0001'`)).toBeTruthy();
  // ثم لا يُمسّ شيء ولو تكرر
  expect(forgetObserved(o, OWNER.uid)).toBe(0);
  // والرسالة لا تُحذف بعده كما كانت
  expect(() => o.run(`DELETE FROM chat_messages`)).toThrow();
});

test('٢ و٣ و٤ المراجعة: سببٌ إلزامي · تُسجَّل في سجل العمليات · تُعرض ولا تُحفظ · وتنتهي بالإغلاق', async () => {
  const { chatOpenReview, chatCloseReview } = await import('@/chat');
  const rc = reviewCloud();
  const { tid } = await memberChat(rc);
  const o = memDb();
  const s = { projectId: 'p', uid: OWNER.uid, email: OWNER.email, idToken: async () => 't' };
  await expect(chatOpenReview(o, s, OWNER.org, tid, '   ', 'عضوان', rc.remote(OWNER.uid))).rejects.toThrow();
  expect(rc.calls.open).toEqual([]);
  const msgs = await chatOpenReview(o, s, OWNER.org, tid, 'شكوى مصطنعة', 'عضو مصطنع · عضو آخر مصطنع', rc.remote(OWNER.uid));
  expect(msgs.map((m) => m.body)).toEqual(['خاصة بين عضوين']);
  expect(rc.calls.open).toEqual([{ chat: tid, reason: 'شكوى مصطنعة' }]);
  // لا تُحفظ على الجهاز
  expect(listMessages(o, tid)).toEqual([]);
  expect(listThreads(o, OWNER.uid, true)).toEqual([]);
  // سجل العمليات: المحادثة والوقت والسبب والمراجِع
  const row = o.get<{ ts: string; user_name: string; module: string; entity_name: string; after_json: string }>(
    `SELECT ts, user_name, module, entity_name, after_json FROM audit_log WHERE entity_type = ? ORDER BY ts DESC LIMIT 1`, [REVIEW_ENTITY])!;
  expect(row.entity_name).toBe('عضو مصطنع · عضو آخر مصطنع');
  expect(row.ts).toMatch(/^\d{4}-/);
  expect(row.user_name).toBeTruthy();
  expect(JSON.parse(row.after_json)).toEqual({ chat: tid, reason: 'شكوى مصطنعة', rid: 'rid-1' });
  await chatCloseReview(s, OWNER.org, tid, rc.remote(OWNER.uid));
  expect(rc.calls.closed).toEqual([tid]);
  // كل فتح جديد بسببه
  await chatOpenReview(o, s, OWNER.org, tid, 'سبب ثانٍ مصطنع', 'عضوان', rc.remote(OWNER.uid));
  expect(rc.calls.open.map((x) => x.reason)).toEqual(['شكوى مصطنعة', 'سبب ثانٍ مصطنع']);
});

test('ثانياً انضمام المالك: يصير طرفاً في المجموعة · ويرى الأعضاء سطر «انضم المالك»', async () => {
  const { chatJoinGroup } = await import('@/chat');
  const rc = reviewCloud();
  const m = memDb();
  const SUP = me('u-sup', 'مشرف مصطنع');
  const gid = createGroup(m, SUP.uid, 'مجموعة مصطنعة', [MEMBER.uid]);
  sendLocal(m, gid, SUP, 'أولى');
  await chatSyncOnce(m, rc.remote(SUP.uid), SUP);
  const o = memDb();
  const s = { projectId: 'p', uid: OWNER.uid, email: OWNER.email, idToken: async () => 't' };
  await chatJoinGroup(o, s, OWNER.org, { id: gid, p: [MEMBER.uid, SUP.uid].sort(), name: 'مجموعة مصطنعة' }, OWNER.name, rc.remote(OWNER.uid));
  expect(listThreads(o, OWNER.uid, true).map((t) => t.id)).toEqual([gid]);
  // الانضمام عملية في سجل العمليات بمنفّذها
  expect(o.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = ?`, [JOIN_ENTITY])!.n).toBe(1);
  const b = memDb();
  await chatSyncOnce(b, rc.remote(MEMBER.uid), MEMBER, { force: true });
  const lines = listMessages(b, gid);
  expect(lines.map((x) => [x.body, x.sys])).toEqual([['أولى', null], [OWNER_JOINED, 'join']]);
});

test('٥ تنبيه ثابت للأعضاء · وزر «مراجعة محادثة» للمالك وحده بسببٍ إلزامي · وشاشة المراجعة بلا خانة كتابة', () => {
  const { readFileSync } = jest.requireActual('fs') as typeof import('fs');
  const { join } = jest.requireActual('path') as typeof import('path');
  const ar = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'i18n', 'locales', 'ar.json'), 'utf8'));
  expect(ar.chat.ownerSees).toBe('محادثات المنشأة يطّلع عليها المالك');
  expect(ar.chat.review).toBe('مراجعة محادثة');
  expect(ar.chat.ownerJoined).toBe('انضم المالك');
  const src = readFileSync(join(__dirname, '..', 'app', 'chat.tsx'), 'utf8');
  expect(src.match(/!me\.owner \? <Note[^>]*>\{t\('chat\.ownerSees'\)\}<\/Note> : null/g)?.length).toBe(2);
  expect(src).toMatch(/\{me\.owner \? <BtnGhost small title=\{t\('chat\.review'\)\}/);
  expect(src).toMatch(/f\.attempt\(!!reason\.trim\(\)/);
  // شاشة المراجعة لا تستورد ما يكتب
  const view = src.slice(src.indexOf('function ReviewView'), src.indexOf('/* ─── نهاية المراجعة ─── */'));
  expect(view.length).toBeGreaterThan(100);
  expect(view).not.toMatch(/sendLocal|TextInput|chatSyncNow/);
});

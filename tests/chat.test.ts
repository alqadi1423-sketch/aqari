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
  type ChatMe, type ChatLink,
} from '@/chat';
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
      async orgThreads() { guard(); if (uid !== OWNER.uid) throw new Error('Firestore 403: owner only'); return [...threads.values()]; },
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
      if (k === 'myThreads' || k === 'orgThreads') calls.threads++; // السحب الكامل · المالك بمحادثات المنشأة كلها (2026-10-08)
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

/* ─── اطلاع المالك على محادثات منشأته (قرار المالك 2026-10-08) ─── */

test('المالك يسحب محادثات المنشأة كلها للقراءة · لا يصير طرفاً ولا يكتب فيما ليس طرفاً فيه · والعضو محادثاته وحدها', async () => {
  const cloud = fakeCloud();
  const OTHER = me('u-other', 'عضو آخر مصطنع');
  const THIRD = me('u-third', 'عضو ثالث مصطنع');
  const m1 = memDb();
  const tid = openDirect(m1, MEMBER.uid, OTHER.uid);
  sendLocal(m1, tid, MEMBER, 'خاصة بين عضوين');
  await chatSyncOnce(m1, cloud.remote(MEMBER.uid), MEMBER);
  // المالك: يراها للقراءة · بلا غير مقروء يتراكم عليه · وأطرافها كما هم
  const o = memDb();
  await chatSyncOnce(o, cloud.remote(OWNER.uid), OWNER, { force: true });
  const seen = listThreads(o, OWNER.uid);
  expect(seen.map((t) => [t.id, t.observer, t.unread])).toEqual([[tid, true, 0]]);
  expect(seen[0].members).toEqual([MEMBER.uid, OTHER.uid].sort());
  expect(listMessages(o, tid).map((m) => [m.senderName, m.body])).toEqual([[MEMBER.name, 'خاصة بين عضوين']]);
  // للقراءة فقط: لا رسالة منه فيها ولو كُتبت على جهازه
  expect(() => sendLocal(o, tid, OWNER, 'من المالك')).toThrow();
  expect(listMessages(o, tid).length).toBe(1);
  await chatSyncOnce(o, cloud.remote(OWNER.uid), OWNER, { force: true });
  expect(cloud.msgs.get(tid)!.length).toBe(1);
  // محادثته هو مع عضو ليست اطلاعاً
  const own = openDirect(o, OWNER.uid, MEMBER.uid);
  expect(listThreads(o, OWNER.uid).find((t) => t.id === own)!.observer).toBe(false);
  // العضو غير الطرف لا يراها · والطرف يراها
  const t3 = memDb();
  await chatSyncOnce(t3, cloud.remote(THIRD.uid), THIRD, { force: true });
  expect(listThreads(t3, THIRD.uid)).toEqual([]);
  const t2 = memDb();
  await chatSyncOnce(t2, cloud.remote(OTHER.uid), OTHER, { force: true });
  expect(listThreads(t2, OTHER.uid).map((t) => [t.id, t.observer])).toEqual([[tid, false]]);
});

test('تعديل المالك مجموعةً ليس طرفاً فيها لا يُدخله فيها (#19 مع الاطلاع)', async () => {
  const { groupEditMembers } = await import('@/chat');
  const group = { members: ['u-a', 'u-b', 'u-sup'].sort() };
  expect(groupEditMembers(OWNER, group, ['u-a', 'u-b'])).toEqual(['u-a', 'u-b']);
  // ومن هو فيها يبقى فيها
  expect(groupEditMembers(MEMBER, { members: [MEMBER.uid, 'u-a'] }, ['u-a', 'u-b'])).toEqual([MEMBER.uid, 'u-a', 'u-b']);
});

test('تنبيه ثابت للأعضاء: «محادثات المنشأة يطّلع عليها المالك» · وشاشة المالك المطّلع بلا خانة كتابة', () => {
  const { readFileSync } = jest.requireActual('fs') as typeof import('fs');
  const { join } = jest.requireActual('path') as typeof import('path');
  const ar = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'i18n', 'locales', 'ar.json'), 'utf8'));
  expect(ar.chat.ownerSees).toBe('محادثات المنشأة يطّلع عليها المالك');
  const src = readFileSync(join(__dirname, '..', 'app', 'chat.tsx'), 'utf8');
  // في القائمة والمحادثة المفتوحة · للأعضاء لا للمالك
  expect(src.match(/!me\.owner \? <Note[^>]*>\{t\('chat\.ownerSees'\)\}<\/Note> : null/g)?.length).toBe(2);
  // خانة الكتابة وزر الربط لا يظهران للمطّلع
  expect(src).toMatch(/thread\?\.observer \? \(\s*<Note[^>]*>\{t\('chat\.readOnly'\)\}<\/Note>\s*\) : \(/);
});

test('حصة المالك: محادثاته بمدتها المعتادة · ومحادثات المنشأة التي يطّلع عليها كل عشر دقائق أو بفتحها (التحقق: الحصة)', async () => {
  const cloud = fakeCloud();
  const calls = { org: 0, mine: 0 };
  const base = cloud.remote(OWNER.uid);
  const remote = new Proxy(base, {
    get(t, k) {
      if (k === 'orgThreads') calls.org++;
      if (k === 'myThreads') calls.mine++;
      return (t as unknown as Record<string | symbol, unknown>)[k];
    },
  }) as typeof base;
  const o = memDb();
  await chatSyncOnce(o, remote, OWNER, { now: 10_000_000 });
  expect([calls.org, calls.mine]).toEqual([1, 0]);
  // سحب كامل بعد ٣ دقائق: محادثاته وحدها
  await chatSyncOnce(o, remote, OWNER, { now: 10_180_000, full: true });
  expect([calls.org, calls.mine]).toEqual([1, 1]);
  // بعد عشر دقائق: المنشأة كلها
  await chatSyncOnce(o, remote, OWNER, { now: 10_700_000, full: true });
  expect([calls.org, calls.mine]).toEqual([2, 1]);
  // فتح الشاشة (force): المنشأة كلها
  await chatSyncOnce(o, remote, OWNER, { now: 10_710_000, force: true });
  expect(calls.org).toBe(3);
});

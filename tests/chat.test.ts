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
        return (msgs.get(threadId) ?? []).filter((m) => !cursor || m.ts > cursor);
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

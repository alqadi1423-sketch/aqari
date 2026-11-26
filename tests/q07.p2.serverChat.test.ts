/**
 * ق٠-٧ · الجزء الثاني: خادم المحادثة (server/chat · F §٥.٢ · قرار المالك على السؤال ٣: (أ)) · كل قاعدةٍ في كتلة «<chat>» من
 * firestore.rules فحصٌ في الخادم برقمها، ولكلٍّ اختبارٌ يقبل ما تقبله ويرفض ما ترفضه · والهوية من خادم الهوية (server/auth) برموزه
 * الحقيقية، والتخزين في الذاكرة مشتركٌ بين الخادمين كما في كائن المنشأة، والساعة مصطنعة يحرّكها الاختبار · أسماءٌ وأرقامٌ مصطنعة كلها.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createAuthServer, MemoryAuthStorage, ACCESS_TTL_MS, type Session, type Fail } from '../server/auth';
import {
  createChatServer, RATE_LIMITS, OWNER_JOINED, FORMER_MEMBER, BODY_MAX, NAME_MAX, PARTIES_MAX, MENTIONS_MAX, POLL_MIN, POLL_MAX,
  REVIEW_TTL_MS, DELETION_TTL_MS, TAGS, LINK_TYPES, type OrgMember, type ChatServer, type WireThread, type WireMessage, type WireState,
} from '../server/chat';
import * as appTypes from '@/chat/types';

const ORG = 'uid-owner-masnoo';
const A = 'uid-member-a';   // عضو بصلاحية على العقود، ومشرف قسم بعد تسجيل المالك
const B = 'uid-member-b';   // عضو بلا صلاحيات
const C = 'uid-member-c';   // عضو بعقار واحد P1
const X = 'uid-outsider';   // له حسابٌ في الهوية وليس عضواً في المنشأة
const SETUP = 'SETUP-CODE-MASNOO-2026-CHATCHAT';
const SIGNING = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 255);
const devKey = (n: number) => 'c' + String(n).padStart(3, '0') + '_'.repeat(4) + 'B'.repeat(40);

type Who = 'O' | 'A' | 'B' | 'C' | 'X';

async function world() {
  const clock = { now: 1_795_000_000_000 };
  const storage = new MemoryAuthStorage();
  const auth = createAuthServer({ storage, clock: () => clock.now, signingKey: SIGNING, setupCode: SETUP });
  const own = await auth.bootstrapOwner({ setupCode: SETUP, uid: ORG, name: 'مالك مصطنع', deviceKey: devKey(1), source: 'ip-o' });
  if (!own.ok) throw new Error('owner');
  const sessions = { O: own } as unknown as Record<Who, Session>;
  const dir = new Map<string, OrgMember>([
    [A, { uid: A, name: 'عضو أ مصطنع', email: 'a@example.test', perm: { contracts: 1 }, all: false, props: [] }],
    [B, { uid: B, name: 'عضو ب مصطنع', email: 'b@example.test', perm: {}, all: false, props: [] }],
    [C, { uid: C, name: 'عضو ج مصطنع', email: 'c@example.test', perm: {}, all: false, props: ['P1'] }],
  ]);
  let n = 2;
  for (const [who, uid] of [['A', A], ['B', B], ['C', C], ['X', X]] as Array<[Who, string]>) {
    const inv = await auth.createInvite(own.tokens.accessToken, { uid, name: 'مصطنع ' + who, phone: '0500000' + n, role: 'staff' });
    if (!inv.ok) throw new Error('invite');
    const s = await auth.redeemInvite({ code: inv.code, deviceKey: devKey(n), source: 'ip-' + who });
    if (!s.ok) throw new Error('redeem');
    sessions[who] = s;
    n++;
  }
  const chat = createChatServer({
    org: ORG, storage, clock: () => clock.now, auth,
    directory: { member: async (u) => (dir.has(u) ? structuredClone(dir.get(u)!) : null), members: async () => [...dir.values()].map((m) => structuredClone(m)) },
  });
  const tok = (w: Who) => sessions[w].tokens.accessToken;
  const call = (op: string, w: Who, args: Record<string, unknown> = {}) => chat.dispatch(op, tok(w), args) as Promise<Record<string, unknown> & { ok: boolean; status?: number; code?: string }>;
  /** تجديد الرموز بعد تقديم الساعة أكثر من ساعة */
  const renew = async () => {
    for (const w of Object.keys(sessions) as Who[]) {
      const r = await auth.refresh({ refreshToken: sessions[w].tokens.refreshToken });
      if (!r.ok) throw new Error('refresh ' + w);
      sessions[w] = { ...sessions[w], tokens: r };
    }
  };
  const names: Record<Who, string> = { O: 'منشأة مصطنعة', A: dir.get(A)!.name, B: dir.get(B)!.name, C: dir.get(C)!.name, X: 'غريب' };
  const seedDir = async () => { for (const w of ['O', 'A', 'B', 'C'] as Who[]) ok(await call('putDirectory', w, { name: names[w], sup: [] })); };
  return { clock, storage, auth, chat, dir, sessions, tok, call, renew, names, seedDir };
}
type W = Awaited<ReturnType<typeof world>>;

function ok<T extends { ok: boolean }>(r: T): T {
  if (!r.ok) throw new Error('رُفض: ' + JSON.stringify(r));
  return r;
}
function no(r: { ok: boolean; status?: number; code?: string }, status = 403, code?: string) {
  expect({ ok: r.ok, status: r.status, ...(code ? { code: r.code } : {}) }).toEqual({ ok: false, status, ...(code ? { code } : {}) });
}
const uidSort = (...u: string[]) => [...u].sort();
const dId = (a: string, b: string) => 'd_' + uidSort(a, b).join('_');
const msg = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, body: 'نص مصطنع ' + id, link: null, ...extra });

/** مجموعةٌ عادية ينشئها المالك ويضيف إليها من يشاء */
async function ownerGroup(w: W, id: string, members: string[], s: Record<string, unknown> = {}, a: string[] = []) {
  ok(await w.call('createThread', 'O', { id, k: 'group', p: [ORG], name: 'مجموعة مصطنعة', s, a: [] }));
  for (const u of members) ok(await w.call('addMember', 'O', { id, uid: u }));
  if (a.length) ok(await w.call('setGroupMeta', 'O', { id, a }));
}
const thread = async (w: W, id: string) => (ok(await w.call('getThread', 'O', { id })) as unknown as { thread: WireThread }).thread;

describe('C1 · الدخول والمنشأة (chatIn)', () => {
  test('رمزٌ مزوّر أو منتهٍ أو جهازٌ مسحوب: ٤٠١ · وحسابٌ ليس عضواً: ٤٠٣ · وعضوٌ أُزيل من المنشأة: ٤٠٣', async () => {
    const w = await world();
    no(await w.chat.dispatch('myThreads', 'v1.zzz.yyy', {}), 401);
    no(await w.call('myThreads', 'X'), 403, 'not_in_org');
    ok(await w.call('myThreads', 'A'));
    w.dir.delete(A);
    no(await w.call('myThreads', 'A'), 403, 'not_in_org');
    w.clock.now += ACCESS_TTL_MS + 1;
    no(await w.call('myThreads', 'O'), 401);
    await w.renew();
    ok(await w.call('myThreads', 'O'));
    ok(await w.auth.revokeDevice(w.tok('O'), w.sessions.B.deviceId));
    no(await w.call('myThreads', 'B'), 401);
  });
});

describe('الدليل والإشراف', () => {
  test('D1 الدليل لكل من في المنشأة وحده', async () => {
    const w = await world();
    await w.seedDir();
    const r = ok(await w.call('directory', 'B')) as unknown as { items: Array<{ uid: string; name: string }> };
    expect(r.items.map((x) => x.uid).sort()).toEqual(uidSort(ORG, A, B, C));
    no(await w.call('directory', 'X'));
  });

  test('D2 D3 D4 D6 يكتب كلٌّ اسمه وحده: اسم عضويته حرفاً، لا يتجاوز ٨٠، والمالك ما شاء · بوقت الخادم', async () => {
    const w = await world();
    no(await w.call('putDirectory', 'A', { name: 'اسم آخر', sup: [] }), 403, 'name_mismatch');
    ok(await w.call('putDirectory', 'A', { name: w.names.A, sup: [] }));
    ok(await w.call('putDirectory', 'O', { name: 'أي اسم يختاره المالك', sup: [] }));
    no(await w.call('putDirectory', 'O', { name: 'ط'.repeat(NAME_MAX + 1), sup: [] }), 403, 'name');
    no(await w.call('putDirectory', 'X', { name: 'غريب', sup: [] }));
    const d = await w.storage.get<{ at: string }>('c:d:' + A);
    expect(d!.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z$/);
  });

  test('D5 إشرافه في الدليل كما سجّله المالك حرفاً · وR2 يكتبه المالك وحده بثلاثين قسماً على الأكثر', async () => {
    const w = await world();
    no(await w.call('setRole', 'A', { email: 'a@example.test', sup: ['contracts'] }), 403, 'owner_only');
    no(await w.call('setRole', 'O', { email: 'a@example.test', sup: Array.from({ length: 31 }, (_, i) => 's' + i) }), 403, 'sup');
    ok(await w.call('setRole', 'O', { email: ' A@Example.TEST ', sup: ['contracts'] }));
    no(await w.call('putDirectory', 'A', { name: w.names.A, sup: [] }), 403, 'sup_mismatch');
    no(await w.call('putDirectory', 'A', { name: w.names.A, sup: ['contracts', 'claims'] }), 403, 'sup_mismatch');
    ok(await w.call('putDirectory', 'A', { name: w.names.A, sup: ['contracts'] }));
  });

  test('D7 الخروج من الدليل لصاحبه وللمالك وحدهما', async () => {
    const w = await world();
    await w.seedDir();
    no(await w.call('removeDirectory', 'B', { uid: A }), 403);
    ok(await w.call('removeDirectory', 'A', { uid: A }));
    ok(await w.call('removeDirectory', 'O', { uid: B }));
    expect(await w.storage.get('c:d:' + A)).toBeUndefined();
    expect(await w.storage.get('c:d:' + B)).toBeUndefined();
  });

  test('R1 الإشراف بإيميله لا يراه إلا المالك وصاحبه · R3 وحذفه للمالك', async () => {
    const w = await world();
    ok(await w.call('setRole', 'O', { email: 'a@example.test', sup: ['contracts'] }));
    expect((ok(await w.call('getRole', 'A', { email: 'A@example.test' })) as unknown as { sup: string[] }).sup).toEqual(['contracts']);
    expect((ok(await w.call('getRole', 'O', { email: 'a@example.test' })) as unknown as { sup: string[] }).sup).toEqual(['contracts']);
    no(await w.call('getRole', 'B', { email: 'a@example.test' }));
    expect((ok(await w.call('getRole', 'B', { email: 'b@example.test' })) as unknown as { sup: string[] }).sup).toEqual([]);
    no(await w.call('removeRole', 'A', { email: 'a@example.test' }), 403, 'owner_only');
    ok(await w.call('removeRole', 'O', { email: 'a@example.test' }));
    expect((ok(await w.call('getRole', 'A', { email: 'a@example.test' })) as unknown as { sup: string[] }).sup).toEqual([]);
  });

  test('أعضاء المنشأة وصلاحياتهم للمالك وحده (يضبط بها القنوات)', async () => {
    const w = await world();
    const r = ok(await w.call('members', 'O')) as unknown as { items: Array<{ uid: string; perm: object }> };
    expect(r.items.map((x) => x.uid).sort()).toEqual(uidSort(A, B, C));
    expect(r.items[0]).not.toHaveProperty('email');
    no(await w.call('members', 'A'), 403, 'owner_only');
  });
});

describe('إنشاء المحادثة وقراءتها', () => {
  test('T2 T3 الفردية: طرفان بترتيبٍ واحد ورقمٌ منهما، والطالب أحدهما، والآخر عضوٌ أو المالك · بلا إعدادات ولا قناة', async () => {
    const w = await world();
    const [p0, p1] = uidSort(A, B);
    ok(await w.call('createThread', 'A', { id: dId(A, B), k: 'direct', p: [p0, p1], name: '' }));
    expect((ok(await w.call('createThread', 'B', { id: dId(A, B), k: 'direct', p: [p0, p1], name: '' })) as { result?: string }).result).toBe('exists');
    no(await w.call('createThread', 'A', { id: dId(A, B), k: 'direct', p: [p1, p0], name: '' }), 403, 'direct_id');
    no(await w.call('createThread', 'A', { id: 'd_x', k: 'direct', p: [p0, p1], name: '' }), 403, 'direct_id');
    no(await w.call('createThread', 'C', { id: dId(A, B), k: 'direct', p: [p0, p1], name: '' }), 403, 'parties');
    no(await w.call('createThread', 'A', { id: dId(A, X), k: 'direct', p: uidSort(A, X), name: '' }), 403, 'peer');
    ok(await w.call('createThread', 'A', { id: dId(A, ORG), k: 'direct', p: uidSort(A, ORG), name: '' }));
    no(await w.call('createThread', 'A', { id: dId(A, C), k: 'direct', p: uidSort(A, C), name: '', s: {} }), 403, 'direct_shape');
    no(await w.call('createThread', 'A', { id: dId(A, C), k: 'direct', p: uidSort(A, C, B), name: '' }), 403, 'direct_shape');
    no(await w.call('createThread', 'A', { id: dId(A, C), k: 'direct', p: uidSort(A, C), name: 'ط'.repeat(NAME_MAX + 1) }), 403, 'name');
    no(await w.call('createThread', 'A', { id: dId(A, C), k: 'direct', p: uidSort(A, C), name: '', by: C }), 403, 'keys');
    no(await w.call('createThread', 'A', { id: 'x', k: 'other', p: [A], name: '' }), 403, 'kind');
    const t = await thread(w, dId(A, B));
    expect(t).toMatchObject({ k: 'direct', by: A, s: {}, a: [], jt: {}, ch: null });
    expect(t.at).toMatch(/\.\d{9}Z$/);
  });

  test('T4 المجموعة العادية: للمالك والمشرف · بمنشئها وحده (ومعه المالك) · رقمها بصيغتها وليس من أرقام القنوات', async () => {
    const w = await world();
    no(await w.call('createThread', 'A', { id: 'g_masnoo1', k: 'group', p: [A], name: 'م' }), 403, 'owner_or_supervisor');
    ok(await w.call('setRole', 'O', { email: 'a@example.test', sup: ['contracts'] }));
    ok(await w.call('createThread', 'A', { id: 'g_masnoo1', k: 'group', p: [A, ORG], name: 'م', s: { h: 'join' }, a: [] }));
    no(await w.call('createThread', 'A', { id: 'g_masnoo2', k: 'group', p: [A, B], name: 'م' }), 403, 'group_parties');
    no(await w.call('createThread', 'O', { id: 'g_x', k: 'group', p: [ORG], name: 'م' }), 403, 'group_id');
    no(await w.call('createThread', 'O', { id: 'g_sec_contracts', k: 'group', p: [ORG], name: 'م' }), 403, 'group_id');
    no(await w.call('createThread', 'O', { id: 'g_announce', k: 'group', p: [ORG], name: 'م' }), 403, 'group_id');
    ok(await w.call('createThread', 'O', { id: 'g_masnoo3', k: 'group', p: [ORG], name: 'م' }));
  });

  test('S1 الإعدادات بمفاتيحها وقيمها، والمسؤولون من الأطراف ولا يتجاوزون مئة', async () => {
    const w = await world();
    const g = (s: unknown, a: unknown = [], p = [ORG]) => w.call('createThread', 'O', { id: 'g_masnoo9', k: 'group', p, name: 'م', s, a });
    no(await g({ h: 'some' }), 403, 'settings');
    no(await g({ w: 'owner' }), 403, 'settings');
    no(await g({ ad: 'none' }), 403, 'settings');
    no(await g({ x: 1 }), 403, 'settings');
    no(await g({}, [A]), 403, 'settings');
    no(await g({}, 'x'), 403, 'settings');
    ok(await g({ h: 'join', w: 'admins', ad: 'all' }, [ORG]));
  });

  test('T5 CH1 القناة: للمالك وحده وهو فيها وحده، ورقمها من نوعها بمفاتيحها', async () => {
    const w = await world();
    const ch = (who: Who, id: string, c: unknown, p = [ORG]) => w.call('createThread', who, { id, k: 'group', p, name: 'قناة', s: { w: 'all' }, a: [], ch: c });
    no(await ch('A', 'g_announce', { t: 'announce' }, [A]), 403, 'owner_only');
    no(await ch('O', 'g_announce', { t: 'announce' }, [ORG, A]), 403, 'channel_parties');
    no(await ch('O', 'g_announce', { t: 'announce', x: 1 }), 403, 'channel');
    no(await ch('O', 'g_sec_x1', { t: 'section', key: 'x1' }), 403, 'channel');
    no(await ch('O', 'g_sec_claims', { t: 'section', key: 'contracts' }), 403, 'channel');
    no(await ch('O', 'g_prop_P 1', { t: 'prop', id: 'P 1' }), 400, 'chat_id');
    no(await ch('O', 'g_prop_P2', { t: 'prop', id: 'P1' }), 403, 'channel');
    ok(await ch('O', 'g_announce', { t: 'announce' }));
    ok(await ch('O', 'g_sec_contracts', { t: 'section', key: 'contracts' }));
    ok(await ch('O', 'g_prop_P1', { t: 'prop', id: 'P1' }));
  });

  test('T1 المحادثة لأطرافها وللمالك · ومحادثاتي ما أنا فيه · ومحادثات المنشأة كلها للمالك وحده · ومجموعات عضو للمالك ولصاحبها', async () => {
    const w = await world();
    ok(await w.call('createThread', 'A', { id: dId(A, B), k: 'direct', p: uidSort(A, B), name: '' }));
    await ownerGroup(w, 'g_masnoo1', [A, C]);
    ok(await w.call('getThread', 'B', { id: dId(A, B) }));
    ok(await w.call('getThread', 'O', { id: dId(A, B) }));
    no(await w.call('getThread', 'C', { id: dId(A, B) }), 403);
    no(await w.call('getThread', 'C', { id: 'd_none' }), 403);
    no(await w.call('getThread', 'O', { id: 'd_none' }), 404);
    const mine = ok(await w.call('myThreads', 'A')) as unknown as { items: WireThread[] };
    expect(mine.items.map((t) => t.id).sort()).toEqual([dId(A, B), 'g_masnoo1'].sort());
    expect((ok(await w.call('orgThreads', 'O')) as unknown as { items: unknown[] }).items).toHaveLength(2);
    no(await w.call('orgThreads', 'A'), 403, 'owner_only');
    expect((ok(await w.call('groupsOf', 'O', { uid: C })) as unknown as { items: Array<{ id: string }> }).items.map((g) => g.id)).toEqual(['g_masnoo1']);
    ok(await w.call('groupsOf', 'C', { uid: C }));
    no(await w.call('groupsOf', 'C', { uid: A }), 403);
  });
});

describe('تعديل المجموعة', () => {
  test('U1 الفردية لا تُعدَّل · والاسم لا يتجاوز ٨٠ · والأطراف لا تتجاوز مئة', async () => {
    const w = await world();
    ok(await w.call('createThread', 'A', { id: dId(A, B), k: 'direct', p: uidSort(A, B), name: '' }));
    no(await w.call('setGroupMeta', 'A', { id: dId(A, B), name: 'x' }), 403, 'not_group');
    no(await w.call('addMember', 'O', { id: dId(A, B), uid: C }), 403, 'not_group');
    await ownerGroup(w, 'g_masnoo1', []);
    no(await w.call('setGroupMeta', 'O', { id: 'g_masnoo1', name: 'ط'.repeat(NAME_MAX + 1) }), 403, 'name');
    // مئة طرف ثم لا مزيد
    for (let i = 0; i < PARTIES_MAX - 1; i++) w.dir.set('uid-m' + i, { uid: 'uid-m' + i, name: 'م' + i, email: '', perm: {}, all: false, props: [] });
    for (let i = 0; i < PARTIES_MAX - 1; i++) ok(await w.call('addMember', 'O', { id: 'g_masnoo1', uid: 'uid-m' + i }));
    no(await w.call('addMember', 'O', { id: 'g_masnoo1', uid: A }), 403, 'parties');
  });

  test('U2 المغادرة: يُخرج نفسه وحده ومعه خروجه من المسؤولين · ولا يُخرج غيره', async () => {
    const w = await world();
    await ownerGroup(w, 'g_masnoo1', [A, B], {}, [A]);
    no(await w.call('removeMembers', 'A', { id: 'g_masnoo1', uids: [B] }), 403, 'remove_owner_or_creator');
    ok(await w.call('removeMembers', 'A', { id: 'g_masnoo1', uids: [A] }));
    expect(await thread(w, 'g_masnoo1')).toMatchObject({ p: [ORG, B], a: [] });
  });

  test('U3 U4 الاسم والإعدادات للمسؤولين، والإعدادات لطرفٍ فيها (فالمالك من خارجها لا يقلب سجل المنضم)', async () => {
    const w = await world();
    ok(await w.call('setRole', 'O', { email: 'a@example.test', sup: ['contracts'] }));
    ok(await w.call('createThread', 'A', { id: 'g_masnoo1', k: 'group', p: [A], name: 'م', s: { h: 'join' }, a: [] }));
    ok(await w.call('addMember', 'A', { id: 'g_masnoo1', uid: B }));
    no(await w.call('setGroupMeta', 'B', { id: 'g_masnoo1', name: 'اسمي' }), 403, 'admin_only');
    ok(await w.call('setGroupMeta', 'A', { id: 'g_masnoo1', name: 'اسم جديد', s: { h: 'join', w: 'admins' } }));
    ok(await w.call('setGroupMeta', 'O', { id: 'g_masnoo1', name: 'اسم المالك' }));
    no(await w.call('setGroupMeta', 'O', { id: 'g_masnoo1', s: { h: 'all' } }), 403, 'settings_party_only');
  });

  test('U5 U6 S2 تعيين المسؤولين والإزالة للمالك والمنشئ ما دام طرفاً · والمعيَّن لا يُزيل ولا يعيّن', async () => {
    const w = await world();
    ok(await w.call('setRole', 'O', { email: 'a@example.test', sup: ['contracts'] }));
    ok(await w.call('createThread', 'A', { id: 'g_masnoo1', k: 'group', p: [A], name: 'م', s: {}, a: [] }));
    for (const u of [B, C]) ok(await w.call('addMember', 'A', { id: 'g_masnoo1', uid: u }));
    ok(await w.call('setGroupMeta', 'A', { id: 'g_masnoo1', a: [B] }));
    no(await w.call('setGroupMeta', 'B', { id: 'g_masnoo1', a: [B, C] }), 403, 'appoint_owner_or_creator');
    ok(await w.call('setGroupMeta', 'B', { id: 'g_masnoo1', name: 'المعيَّن يسمّي' }));
    no(await w.call('removeMembers', 'B', { id: 'g_masnoo1', uids: [C] }), 403, 'remove_owner_or_creator');
    ok(await w.call('removeMembers', 'A', { id: 'g_masnoo1', uids: [C] }));
    // المنشئ إذا غادر لا يعود مسؤولاً
    ok(await w.call('removeMembers', 'A', { id: 'g_masnoo1', uids: [A] }));
    no(await w.call('setGroupMeta', 'A', { id: 'g_masnoo1', name: 'عاد' }), 403, 'admin_only');
    no(await w.call('removeMembers', 'A', { id: 'g_masnoo1', uids: [B] }), 403);
    ok(await w.call('removeMembers', 'O', { id: 'g_masnoo1', uids: [B] }));
  });

  test('U7 إضافة عضوٍ واحدٍ قائم بوقت انضمامه من الخادم · ومن فيها لا يُضاف ثانية · ولا غير العضو', async () => {
    const w = await world();
    await ownerGroup(w, 'g_masnoo1', [A]);
    const t = await thread(w, 'g_masnoo1');
    expect(Object.keys(t.jt)).toEqual([A]);
    expect(t.jt[A] > t.at).toBe(true);
    no(await w.call('addMember', 'O', { id: 'g_masnoo1', uid: A }), 403, 'join_fields');
    no(await w.call('addMember', 'O', { id: 'g_masnoo1', uid: X }), 403, 'not_member');
  });

  test('U8 M15 المالك لا يدخل مجموعةً إلا بسطر «انضم المالك» في الطلب نفسه · وباسمه في الدليل · ولا يضيفه غيره', async () => {
    const w = await world();
    await w.seedDir();
    ok(await w.call('setRole', 'O', { email: 'a@example.test', sup: ['contracts'] }));
    ok(await w.call('createThread', 'A', { id: 'g_masnoo1', k: 'group', p: [A], name: 'م', s: {}, a: [] }));
    no(await w.call('addMember', 'A', { id: 'g_masnoo1', uid: ORG }), 403, 'not_member');
    no(await w.call('addMember', 'O', { id: 'g_masnoo1', uid: ORG }), 403, 'join_line_required');
    no(await w.call('joinGroup', 'O', { id: 'g_masnoo1', name: 'اسمٌ غير اسمه' }), 403, 'name_mismatch');
    no(await w.call('joinGroup', 'A', { id: 'g_masnoo1', name: w.names.A }), 403, 'owner_only');
    const j = ok(await w.call('joinGroup', 'O', { id: 'g_masnoo1', name: w.names.O })) as unknown as { lineId: string };
    const line = (ok(await w.call('getMessage', 'A', { chat: 'g_masnoo1', id: j.lineId })) as unknown as { message: WireMessage }).message;
    expect(line).toMatchObject({ from: ORG, body: OWNER_JOINED, sys: 'join', link: null, name: w.names.O });
    no(await w.call('joinGroup', 'O', { id: 'g_masnoo1', name: w.names.O }), 403, 'already_party');
    // ولا سطر نظامٍ بإرسالٍ عادي
    no(await w.call('sendMessage', 'O', { chat: 'g_masnoo1', msg: { ...msg('m1', w.names.O), sys: 'join' } }), 403, 'keys');
  });

  test('U9 الإضافة في المجموعة العادية للمسؤولين، ولكل أعضائها إن أُذن', async () => {
    const w = await world();
    await ownerGroup(w, 'g_masnoo1', [A]);
    no(await w.call('addMember', 'A', { id: 'g_masnoo1', uid: B }), 403, 'add_not_allowed');
    no(await w.call('addMember', 'C', { id: 'g_masnoo1', uid: B }), 403, 'add_not_allowed');
    ok(await w.call('setGroupMeta', 'O', { id: 'g_masnoo1', s: { ad: 'all' } }));
    no(await w.call('addMember', 'C', { id: 'g_masnoo1', uid: C }), 403, 'add_not_allowed');
    ok(await w.call('addMember', 'A', { id: 'g_masnoo1', uid: B }));
  });

  test('U10 Q1 القناة: يضمّ المالك، أو يضمّ العضو نفسه بصلاحيته وحدها · ومن سُحبت صلاحيته لا يقرأ ولا يكتب ولو بقي طرفاً', async () => {
    const w = await world();
    await w.seedDir();
    for (const [id, c] of [['g_announce', { t: 'announce' }], ['g_sec_contracts', { t: 'section', key: 'contracts' }], ['g_prop_P1', { t: 'prop', id: 'P1' }]] as const) {
      ok(await w.call('createThread', 'O', { id, k: 'group', p: [ORG], name: 'قناة', s: {}, a: [], ch: c }));
    }
    for (const who of ['A', 'B', 'C'] as Who[]) ok(await w.call('addMember', who, { id: 'g_announce', uid: w.sessions[who].uid }));
    ok(await w.call('addMember', 'A', { id: 'g_sec_contracts', uid: A }));
    no(await w.call('addMember', 'B', { id: 'g_sec_contracts', uid: B }), 403, 'channel_not_qualified');
    no(await w.call('addMember', 'A', { id: 'g_sec_contracts', uid: B }), 403, 'channel_not_qualified');
    ok(await w.call('addMember', 'C', { id: 'g_prop_P1', uid: C }));
    no(await w.call('addMember', 'A', { id: 'g_prop_P1', uid: A }), 403, 'channel_not_qualified');
    w.dir.get(A)!.all = true;
    ok(await w.call('addMember', 'A', { id: 'g_prop_P1', uid: A }));
    ok(await w.call('addMember', 'O', { id: 'g_sec_contracts', uid: B }));
    // سُحبت صلاحية أ على العقود
    ok(await w.call('sendMessage', 'A', { chat: 'g_sec_contracts', msg: msg('m1', w.names.A) }));
    w.dir.get(A)!.perm = {};
    no(await w.call('sendMessage', 'A', { chat: 'g_sec_contracts', msg: msg('m2', w.names.A) }), 403, 'not_qualified');
    no(await w.call('messagesSince', 'A', { chat: 'g_sec_contracts', cursor: null }), 403);
    no(await w.call('getMessage', 'A', { chat: 'g_sec_contracts', id: 'm1' }), 403);
    no(await w.call('stateSince', 'A', { chat: 'g_sec_contracts', cursor: null }), 403);
    no(await w.call('markRead', 'A', { chat: 'g_sec_contracts', at: '2020-01-01T00:00:00Z' }), 403);
  });

  test('U11 بلا إضافة: لا وقت انضمامٍ ولا سطر · وإزالة من ليس فيها لا تغيّر شيئاً', async () => {
    const w = await world();
    await ownerGroup(w, 'g_masnoo1', [A]);
    ok(await w.call('removeMembers', 'O', { id: 'g_masnoo1', uids: [C] }));
    expect((await thread(w, 'g_masnoo1')).p).toEqual([ORG, A]);
  });
});

describe('الرسائل', () => {
  async function pair(w: W) {
    await w.seedDir();
    ok(await w.call('createThread', 'A', { id: dId(A, B), k: 'direct', p: uidSort(A, B), name: '' }));
    return dId(A, B);
  }

  test('M3 M4 M10 M11 طرفٌ يرسل باسمه في الدليل · وfrom ووقتها ورقم تسلسلها من الخادم · والإعادة لا تكرّرها', async () => {
    const w = await world();
    const t = await pair(w);
    no(await w.call('sendMessage', 'C', { chat: t, msg: msg('m1', w.names.C) }), 403, 'not_party');
    no(await w.call('sendMessage', 'A', { chat: t, msg: msg('m1', 'اسم حر') }), 403, 'name_mismatch');
    no(await w.call('sendMessage', 'A', { chat: t, msg: { ...msg('m1', w.names.A), from: B } }), 403, 'keys');
    no(await w.call('sendMessage', 'A', { chat: t, msg: { ...msg('m1', w.names.A), ts: '2020-01-01T00:00:00Z' } }), 403, 'keys');
    expect((ok(await w.call('sendMessage', 'A', { chat: t, msg: msg('m1', w.names.A) })) as { result?: string }).result).toBe('created');
    expect((ok(await w.call('sendMessage', 'A', { chat: t, msg: msg('m1', w.names.A) })) as { result?: string }).result).toBe('exists');
    const m = (ok(await w.call('getMessage', 'B', { chat: t, id: 'm1' })) as unknown as { message: WireMessage }).message;
    expect(m).toMatchObject({ from: A, name: w.names.A, ev: 0, sys: null });
    // باسمٍ لم يُكتب في الدليل بعد: مرفوض
    ok(await w.call('removeDirectory', 'A', { uid: A }));
    no(await w.call('sendMessage', 'A', { chat: t, msg: msg('m2', w.names.A) }), 403, 'name_mismatch');
  });

  test('M12 M13 M14 النص حتى ٤٠٠٠ · والربط بأنواعه وحدوده · والمرفقات مغلقة', async () => {
    const w = await world();
    const t = await pair(w);
    const send = (extra: Record<string, unknown>, id = 'm' + Math.random().toString(36).slice(2, 8)) => w.call('sendMessage', 'A', { chat: t, msg: msg(id, w.names.A, extra) });
    ok(await send({ body: 'ن'.repeat(BODY_MAX) }));
    no(await send({ body: 'ن'.repeat(BODY_MAX + 1) }), 403, 'body');
    no(await send({ body: 5 }), 403, 'body');
    for (const type of LINK_TYPES) ok(await send({ link: { type, id: 'r1', label: 'سجل مصطنع' } }));
    no(await send({ link: { type: 'invoice', id: 'r1', label: 'x' } }), 403, 'link');
    no(await send({ link: { type: 'unit', id: 'r'.repeat(65), label: 'x' } }), 403, 'link');
    no(await send({ link: { type: 'unit', id: 'r1', label: 'x'.repeat(201) } }), 403, 'link');
    no(await send({ link: { type: 'unit', id: 'r1', label: 'x', extra: 1 } }), 403, 'link');
    ok(await send({ att: null }));
    no(await send({ att: { name: 'ملف' } }), 403, 'attachments_closed');
  });

  test('M5 الاستطلاع: من ٢ إلى ١٠ خيارات نصية مجموعها ألف حرف · M6 الوسم من الثلاثة · M9 الإشارات ثلاثون بصيغتها', async () => {
    const w = await world();
    const t = await pair(w);
    let i = 0;
    const send = (extra: Record<string, unknown>) => w.call('sendMessage', 'A', { chat: t, msg: msg('m' + ++i, w.names.A, extra) });
    ok(await send({ poll: { o: Array(POLL_MIN).fill('خيار'), m: false } }));
    ok(await send({ poll: { o: Array(POLL_MAX).fill('خيار'), m: true } }));
    no(await send({ poll: { o: ['وحيد'], m: false } }), 403, 'poll');
    no(await send({ poll: { o: Array(POLL_MAX + 1).fill('خ'), m: false } }), 403, 'poll');
    no(await send({ poll: { o: ['خ'.repeat(600), 'خ'.repeat(401)], m: false } }), 403, 'poll');
    no(await send({ poll: { o: ['أ', 'ب'], m: 'yes' } }), 403, 'poll');
    no(await send({ poll: { o: [1, 2], m: false } }), 403, 'poll');
    for (const tag of TAGS) ok(await send({ tag }));
    no(await send({ tag: 'important' }), 403, 'tag');
    ok(await send({ men: ['u:' + B, 's:contracts'] }));
    no(await send({ men: ['@' + B] }), 403, 'mentions');
    no(await send({ men: Array(MENTIONS_MAX + 1).fill('u:' + B) }), 403, 'mentions');
  });

  test('M7 الإعلان المهم بتأكيد الاطلاع للمالك ولمسؤولي المجموعة وحدهم', async () => {
    const w = await world();
    const t = await pair(w);
    no(await w.call('sendMessage', 'A', { chat: t, msg: msg('m1', w.names.A, { ack: true }) }), 403, 'ack_admins_only');
    ok(await w.call('createThread', 'O', { id: dId(ORG, A), k: 'direct', p: uidSort(ORG, A), name: '' }));
    ok(await w.call('sendMessage', 'O', { chat: dId(ORG, A), msg: msg('m2', w.names.O, { ack: true }) }));
    await ownerGroup(w, 'g_masnoo1', [A, B], {}, [A]);
    ok(await w.call('sendMessage', 'A', { chat: 'g_masnoo1', msg: msg('m3', w.names.A, { ack: true }) }));
    no(await w.call('sendMessage', 'B', { chat: 'g_masnoo1', msg: msg('m4', w.names.B, { ack: true }) }), 403, 'ack_admins_only');
    no(await w.call('sendMessage', 'B', { chat: 'g_masnoo1', msg: msg('m4', w.names.B, { ack: 'yes' }) }), 403, 'ack');
  });

  test('M8 الرد على رسالةٍ موجودة في المحادثة نفسها', async () => {
    const w = await world();
    const t = await pair(w);
    ok(await w.call('sendMessage', 'A', { chat: t, msg: msg('m1', w.names.A) }));
    ok(await w.call('sendMessage', 'B', { chat: t, msg: msg('m2', w.names.B, { re: 'm1' }) }));
    no(await w.call('sendMessage', 'B', { chat: t, msg: msg('m3', w.names.B, { re: 'none' }) }), 403, 're');
    no(await w.call('sendMessage', 'B', { chat: t, msg: msg('m3', w.names.B, { re: 'bad id!' }) }), 403, 're');
  });

  test('MS من يرسل في المجموعة: كل أعضائها، أو مسؤولوها وحدهم إن قُيِّدت', async () => {
    const w = await world();
    await w.seedDir();
    await ownerGroup(w, 'g_masnoo1', [A, B], { w: 'admins' }, [A]);
    ok(await w.call('sendMessage', 'A', { chat: 'g_masnoo1', msg: msg('m1', w.names.A) }));
    no(await w.call('sendMessage', 'B', { chat: 'g_masnoo1', msg: msg('m2', w.names.B) }), 403, 'admins_only');
  });

  test('M1 M2 MV I1 سجل المنضم «من لحظة انضمامه»: لا يسرد، ويقرأ ما بعد انضمامه ورسائله هو · و«كل السابق» يسرد كله', async () => {
    const w = await world();
    await w.seedDir();
    await ownerGroup(w, 'g_masnoo1', [A], { h: 'join' });
    ok(await w.call('sendMessage', 'A', { chat: 'g_masnoo1', msg: msg('old', w.names.A) }));
    ok(await w.call('addMember', 'O', { id: 'g_masnoo1', uid: B }));
    ok(await w.call('sendMessage', 'A', { chat: 'g_masnoo1', msg: msg('new', w.names.A) }));
    no(await w.call('messagesSince', 'B', { chat: 'g_masnoo1', cursor: null }), 403, 'list_not_allowed');
    no(await w.call('getMessage', 'B', { chat: 'g_masnoo1', id: 'old' }), 403, 'history');
    ok(await w.call('getMessage', 'B', { chat: 'g_masnoo1', id: 'new' }));
    const jt = (await thread(w, 'g_masnoo1')).jt[B];
    const pageB = ok(await w.call('joinedPage', 'B', { chat: 'g_masnoo1', cursor: jt })) as unknown as { msgs: WireMessage[]; ids: number };
    expect(pageB.msgs.map((m) => m.id)).toEqual(['new']);
    // من مؤشرٍ قبل انضمامه: الصفحة كلها مرفوضة (كطلب الرسائل جملةً)
    no(await w.call('joinedPage', 'B', { chat: 'g_masnoo1', cursor: '2000-01-01T00:00:00Z' }), 403, 'history');
    no(await w.call('joinedPage', 'C', { chat: 'g_masnoo1', cursor: jt }), 403, 'not_party');
    // كل السابق
    await ownerGroup(w, 'g_masnoo2', [A]);
    ok(await w.call('sendMessage', 'A', { chat: 'g_masnoo2', msg: msg('old', w.names.A) }));
    ok(await w.call('addMember', 'O', { id: 'g_masnoo2', uid: B }));
    expect(((ok(await w.call('messagesSince', 'B', { chat: 'g_masnoo2', cursor: null })) as unknown as { items: WireMessage[] }).items).map((m) => m.id)).toEqual(['old']);
    no(await w.call('messagesSince', 'C', { chat: 'g_masnoo2', cursor: null }), 403);
  });

  test('الترتيب برقم تسلسل الخادم ووقته الذي لا يتكرر ولا يرجع ولو رجعت الساعة · والصفحة بعد (الوقت، الرقم)', async () => {
    const w = await world();
    const t = await pair(w);
    for (let i = 0; i < 7; i++) {
      if (i === 3) w.clock.now -= 4_000;          // الساعة ترجع (دون سماح رمز الدخول)
      ok(await w.call('sendMessage', i % 2 ? 'B' : 'A', { chat: t, msg: msg('z' + (9 - i), i % 2 ? w.names.B : w.names.A) }));
    }
    const all = (ok(await w.call('messagesSince', 'A', { chat: t, cursor: null })) as unknown as { items: WireMessage[] }).items;
    expect(all.map((m) => m.id)).toEqual(['z9', 'z8', 'z7', 'z6', 'z5', 'z4', 'z3']);
    expect(all.every((m, i) => i === 0 || m.ts > all[i - 1].ts)).toBe(true);
    expect(new Set(all.map((m) => m.ts)).size).toBe(7);
    const p1 = (ok(await w.call('messagesSince', 'A', { chat: t, cursor: null, limit: 3 })) as unknown as { items: WireMessage[] }).items;
    const last = p1[p1.length - 1];
    const p2 = (ok(await w.call('messagesSince', 'A', { chat: t, cursor: last.ts, limit: 3, after: { ts: last.ts, id: last.id } })) as unknown as { items: WireMessage[] }).items;
    expect([...p1, ...p2].map((m) => m.id)).toEqual(['z9', 'z8', 'z7', 'z6', 'z5', 'z4']);
    no(await w.call('messagesSince', 'A', { chat: t, cursor: 'أمس' }), 400, 'cursor');
  });

  test('M18 تعديل مرسلها وهو طرفٌ يرسل: النص والوسم برقمٍ يزيد واحداً، وما قبله في سجلها، وإشارةٌ في حال المحادثة · ولا تعديل لسطر نظام', async () => {
    const w = await world();
    const t = await pair(w);
    ok(await w.call('sendMessage', 'A', { chat: t, msg: msg('m1', w.names.A, { tag: 'urgent' }) }));
    no(await w.call('editMessage', 'B', { chat: t, id: 'm1', body: 'ليس لي', tag: null }), 403, 'not_sender');
    no(await w.call('editMessage', 'A', { chat: t, id: 'm1', body: 'ن'.repeat(BODY_MAX + 1), tag: null }), 403, 'body');
    no(await w.call('editMessage', 'A', { chat: t, id: 'm1', body: 'x', tag: 'important' }), 403, 'tag');
    expect((ok(await w.call('editMessage', 'A', { chat: t, id: 'm1', body: 'معدّلة', tag: 'decision' })) as unknown as { n: number }).n).toBe(1);
    expect((ok(await w.call('editMessage', 'A', { chat: t, id: 'm1', body: 'ثانية', tag: null })) as unknown as { n: number }).n).toBe(2);
    const m = (ok(await w.call('getMessage', 'B', { chat: t, id: 'm1' })) as unknown as { message: WireMessage }).message;
    expect(m).toMatchObject({ body: 'ثانية', tag: null, ev: 2 });
    expect(m.et! > m.ts).toBe(true);
    const edits = (ok(await w.call('editsOf', 'B', { chat: t, id: 'm1' })) as unknown as { items: Array<{ n: number; body: string; tag: string | null }> }).items;
    expect(edits.map((e) => [e.n, e.body, e.tag])).toEqual([[1, 'نص مصطنع m1', 'urgent'], [2, 'معدّلة', 'decision']]);
    const st = (ok(await w.call('stateSince', 'B', { chat: t, cursor: null })) as unknown as { items: WireState[] }).items;
    expect(st.find((s) => s.id === 'x_m1')).toMatchObject({ k: 'edit', m: 'm1', n: 2 });
    // سطر النظام
    await ownerGroup(w, 'g_masnoo1', [A]);
    ok(await w.call('setRole', 'O', { email: 'a@example.test', sup: ['contracts'] }));
    ok(await w.call('putDirectory', 'A', { name: w.names.A, sup: ['contracts'] }));
    ok(await w.call('createThread', 'A', { id: 'g_masnoo2', k: 'group', p: [A], name: 'م', s: {}, a: [] }));
    const j = ok(await w.call('joinGroup', 'O', { id: 'g_masnoo2', name: w.names.O })) as unknown as { lineId: string };
    no(await w.call('editMessage', 'O', { chat: 'g_masnoo2', id: j.lineId, body: 'x', tag: null }), 403, 'system_line');
    // وطرفٌ أُخرج لا يعدّل رسالته
    ok(await w.call('sendMessage', 'A', { chat: 'g_masnoo1', msg: msg('m9', w.names.A) }));
    ok(await w.call('removeMembers', 'O', { id: 'g_masnoo1', uids: [A] }));
    no(await w.call('editMessage', 'A', { chat: 'g_masnoo1', id: 'm9', body: 'x', tag: null }), 403, 'not_party');
  });

  test('E1 سجل التعديل لمن يقرأ الرسالة نفسها (والمنضم لاحقاً لا يقرأ سجل ما قبله)', async () => {
    const w = await world();
    await w.seedDir();
    await ownerGroup(w, 'g_masnoo1', [A], { h: 'join' });
    ok(await w.call('sendMessage', 'A', { chat: 'g_masnoo1', msg: msg('m1', w.names.A) }));
    ok(await w.call('editMessage', 'A', { chat: 'g_masnoo1', id: 'm1', body: 'معدلة', tag: null }));
    ok(await w.call('addMember', 'O', { id: 'g_masnoo1', uid: B }));
    no(await w.call('editsOf', 'B', { chat: 'g_masnoo1', id: 'm1' }), 403, 'history');
    ok(await w.call('editsOf', 'A', { chat: 'g_masnoo1', id: 'm1' }));
    no(await w.call('editsOf', 'C', { chat: 'g_masnoo1', id: 'm1' }), 403);
  });

  test('M17 حذف الحساب: اسمه في رسائله «عضو سابق» وحده، في كل محادثات المنشأة · ولا اسمٌ غيره', async () => {
    const w = await world();
    const t = await pair(w);
    await ownerGroup(w, 'g_masnoo1', [A]);
    ok(await w.call('sendMessage', 'A', { chat: t, msg: msg('m1', w.names.A) }));
    ok(await w.call('sendMessage', 'B', { chat: t, msg: msg('m2', w.names.B) }));
    ok(await w.call('sendMessage', 'A', { chat: 'g_masnoo1', msg: msg('m3', w.names.A) }));
    ok(await w.call('removeMembers', 'A', { id: 'g_masnoo1', uids: [A] }));
    no(await w.call('anonymizeMine', 'A', { label: 'أي اسم' }), 403, 'label');
    expect((ok(await w.call('anonymizeMine', 'A', { label: FORMER_MEMBER })) as unknown as { count: number }).count).toBe(2);
    const m = (id: string, chat = t) => w.storage.get<WireMessage>(`c:m:${chat}:${id}`);
    expect([(await m('m1'))!.name, (await m('m2'))!.name, (await m('m3', 'g_masnoo1'))!.name]).toEqual([FORMER_MEMBER, w.names.B, FORMER_MEMBER]);
  });
});

describe('حال المحادثة', () => {
  async function setup(w: W) {
    await w.seedDir();
    ok(await w.call('createThread', 'A', { id: dId(A, B), k: 'direct', p: uidSort(A, B), name: '' }));
    ok(await w.call('sendMessage', 'A', { chat: dId(A, B), msg: msg('m1', w.names.A) }));
    ok(await w.call('sendMessage', 'B', { chat: dId(A, B), msg: msg('poll1', w.names.B, { poll: { o: ['أ', 'ب', 'ج'], m: false } }) }));
    ok(await w.call('sendMessage', 'B', { chat: dId(A, B), msg: msg('poll2', w.names.B, { poll: { o: ['أ', 'ب', 'ج'], m: true } }) }));
    return dId(A, B);
  }
  const state = async (w: W, who: Who, t: string) => (ok(await w.call('stateSince', who, { chat: t, cursor: null })) as unknown as { items: WireState[] }).items;

  test('ST1 ST2 الحال لطرفٍ تحق له وحده · بوقت الخادم بالمؤشر', async () => {
    const w = await world();
    const t = await setup(w);
    ok(await w.call('setPin', 'A', { chat: t, id: 'm1', on: true }));
    no(await w.call('stateSince', 'C', { chat: t, cursor: null }), 403);
    no(await w.call('setPin', 'C', { chat: t, id: 'm1', on: true }), 403);
    no(await w.call('stateSince', 'O', { chat: t, cursor: null }), 403);
    const s = await state(w, 'B', t);
    expect(s.map((x) => x.id)).toEqual(['p_m1']);
    expect((ok(await w.call('stateSince', 'B', { chat: t, cursor: s[0].ts, after: { ts: s[0].ts, id: s[0].id } })) as unknown as { items: unknown[] }).items).toEqual([]);
  });

  test('ST3 قراءتي يكتبها صاحبها وحده بوقتٍ لا يتجاوز الآن', async () => {
    const w = await world();
    const t = await setup(w);
    const m = (ok(await w.call('getMessage', 'B', { chat: t, id: 'm1' })) as unknown as { message: WireMessage }).message;
    ok(await w.call('markRead', 'B', { chat: t, at: m.ts }));
    no(await w.call('markRead', 'B', { chat: t, at: '2999-01-01T00:00:00Z' }), 403, 'read_time');
    no(await w.call('markRead', 'B', { chat: t, at: 'أمس' }), 403, 'read_time');
    expect((await state(w, 'A', t)).find((s) => s.id === 'r_' + B)).toMatchObject({ k: 'read', at: m.ts });
  });

  test('ST4 التثبيت لرسالةٍ موجودة: لطرفي الفردية، ولمسؤولي المجموعة', async () => {
    const w = await world();
    const t = await setup(w);
    ok(await w.call('setPin', 'B', { chat: t, id: 'm1', on: true }));
    no(await w.call('setPin', 'B', { chat: t, id: 'none', on: true }), 403, 'no_message');
    no(await w.call('setPin', 'B', { chat: t, id: 'm1', on: 'yes' }), 403, 'on');
    await ownerGroup(w, 'g_masnoo1', [A, B], {}, [A]);
    ok(await w.call('sendMessage', 'B', { chat: 'g_masnoo1', msg: msg('g1', w.names.B) }));
    no(await w.call('setPin', 'B', { chat: 'g_masnoo1', id: 'g1', on: true }), 403, 'admin_only');
    ok(await w.call('setPin', 'A', { chat: 'g_masnoo1', id: 'g1', on: true }));
  });

  test('ST10 تأكيد الاطلاع على إعلانٍ يطلبه، مرةً وحدها، لمن يقرؤه', async () => {
    const w = await world();
    await w.seedDir();
    await ownerGroup(w, 'g_masnoo1', [A], { h: 'join' });
    ok(await w.call('sendMessage', 'O', { chat: 'g_masnoo1', msg: msg('ann', w.names.O, { ack: true }) }));
    ok(await w.call('sendMessage', 'O', { chat: 'g_masnoo1', msg: msg('plain', w.names.O) }));
    expect((ok(await w.call('acknowledge', 'A', { chat: 'g_masnoo1', id: 'ann' })) as { result?: string }).result).toBe('created');
    expect((ok(await w.call('acknowledge', 'A', { chat: 'g_masnoo1', id: 'ann' })) as { result?: string }).result).toBe('exists');
    no(await w.call('acknowledge', 'A', { chat: 'g_masnoo1', id: 'plain' }), 403, 'not_announcement');
    ok(await w.call('addMember', 'O', { id: 'g_masnoo1', uid: B }));
    no(await w.call('acknowledge', 'B', { chat: 'g_masnoo1', id: 'ann' }), 403, 'history');
  });

  test('ST6 المهمة: ينشئها من يرسل لرسالةٍ يقرؤها وليست سطر نظام، ومسؤولها من أطرافها، وعنوانها وموعدها بصيغتهما', async () => {
    const w = await world();
    const t = await setup(w);
    const task = { title: 'مهمة مصطنعة', as: B, due: '2026-12-01', done: false };
    no(await w.call('setTask', 'A', { chat: t, id: 'm1', task: { ...task, as: C } }), 403, 'assignee_not_party');
    no(await w.call('setTask', 'A', { chat: t, id: 'm1', task: { ...task, title: '' } }), 403, 'task');
    no(await w.call('setTask', 'A', { chat: t, id: 'm1', task: { ...task, title: 'ع'.repeat(201) } }), 403, 'task');
    no(await w.call('setTask', 'A', { chat: t, id: 'm1', task: { ...task, due: '1/12/2026' } }), 403, 'task');
    no(await w.call('setTask', 'A', { chat: t, id: 'none', task }), 403, 'no_message');
    ok(await w.call('setTask', 'A', { chat: t, id: 'm1', task }));
    expect((await state(w, 'B', t)).find((s) => s.id === 't_m1')).toMatchObject({ k: 'task', m: 'm1', by: A, as: B, done: false });
    // المجموعة المقيَّدة: من لا يرسل لا ينشئ · وسطر النظام لا مهمة له
    await ownerGroup(w, 'g_masnoo1', [A, B], { w: 'admins' });
    ok(await w.call('sendMessage', 'O', { chat: 'g_masnoo1', msg: msg('g1', w.names.O) }));
    no(await w.call('setTask', 'B', { chat: 'g_masnoo1', id: 'g1', task }), 403, 'admins_only');
    ok(await w.call('setRole', 'O', { email: 'a@example.test', sup: ['contracts'] }));
    ok(await w.call('putDirectory', 'A', { name: w.names.A, sup: ['contracts'] }));
    ok(await w.call('createThread', 'A', { id: 'g_masnoo2', k: 'group', p: [A], name: 'م', s: {}, a: [] }));
    const j = ok(await w.call('joinGroup', 'O', { id: 'g_masnoo2', name: w.names.O })) as unknown as { lineId: string };
    no(await w.call('setTask', 'A', { chat: 'g_masnoo2', id: j.lineId, task: { ...task, as: A } }), 403, 'system_line');
  });

  test('ST7 ST8 يعدّلها منشئها، وينجزها مسؤولها (الإنجاز وحده)، ويلغيها منشئها · والملغاة لا تُعدَّل ولا تُنجز', async () => {
    const w = await world();
    const t = await setup(w);
    ok(await w.call('setTask', 'A', { chat: t, id: 'm1', task: { title: 'مهمة', as: B, due: '2026-12-01', done: false } }));
    no(await w.call('setTask', 'B', { chat: t, id: 'm1', task: { title: 'غيّرها المسؤول', as: B, due: '2026-12-01', done: false } }), 403, 'creator_only');
    ok(await w.call('setTaskDone', 'B', { chat: t, id: 'm1', done: true }));
    // تعديل المنشئ لا يرجع ما أنجزه المسؤول، ومنشئها لا يتغير
    ok(await w.call('setTask', 'A', { chat: t, id: 'm1', task: { title: 'عنوان جديد', as: B, due: '2026-12-02', done: false } }));
    expect((await state(w, 'A', t)).find((s) => s.id === 't_m1')).toMatchObject({ title: 'عنوان جديد', done: true, by: A });
    no(await w.call('cancelTask', 'B', { chat: t, id: 'm1' }), 403, 'creator_only');
    no(await w.call('setTaskDone', 'B', { chat: t, id: 'none', done: true }), 404);
    ok(await w.call('cancelTask', 'A', { chat: t, id: 'm1' }));
    no(await w.call('setTaskDone', 'B', { chat: t, id: 'm1', done: false }), 403, 'cancelled');
    no(await w.call('setTask', 'A', { chat: t, id: 'm1', task: { title: 'إحياء', as: B, due: '2026-12-02', done: false } }), 403, 'cancelled');
    no(await w.call('cancelTask', 'A', { chat: t, id: 'm1' }), 403, 'cancelled');
  });

  test('ST7 مسؤولٌ غادر: لا تُنجز ولا تُعدَّل لغيره، ويلغيها منشئها', async () => {
    const w = await world();
    await w.seedDir();
    await ownerGroup(w, 'g_masnoo1', [A, B]);
    ok(await w.call('sendMessage', 'O', { chat: 'g_masnoo1', msg: msg('g1', w.names.O) }));
    ok(await w.call('setTask', 'O', { chat: 'g_masnoo1', id: 'g1', task: { title: 'مهمة', as: B, due: '2026-12-01', done: false } }));
    ok(await w.call('removeMembers', 'B', { id: 'g_masnoo1', uids: [B] }));
    no(await w.call('setTaskDone', 'O', { chat: 'g_masnoo1', id: 'g1', done: true }), 403, 'assignee_not_party');
    ok(await w.call('cancelTask', 'O', { chat: 'g_masnoo1', id: 'g1' }));
  });

  test('ST9 الصوت لنفسه ويُغيَّر · خياراتٌ بلا تكرار من خيارات الاستطلاع، وواحدٌ إلا إن سُمح بأكثر', async () => {
    const w = await world();
    const t = await setup(w);
    ok(await w.call('vote', 'A', { chat: t, id: 'poll1', o: [2] }));
    ok(await w.call('vote', 'A', { chat: t, id: 'poll1', o: [0] }));
    no(await w.call('vote', 'A', { chat: t, id: 'poll1', o: [0, 1] }), 403, 'single_choice');
    no(await w.call('vote', 'A', { chat: t, id: 'poll1', o: [3] }), 403, 'options');
    no(await w.call('vote', 'A', { chat: t, id: 'poll1', o: [] }), 403, 'options');
    no(await w.call('vote', 'A', { chat: t, id: 'poll2', o: [1, 1] }), 403, 'options');
    no(await w.call('vote', 'A', { chat: t, id: 'poll2', o: [0.5] }), 403, 'options');
    ok(await w.call('vote', 'A', { chat: t, id: 'poll2', o: [0, 2] }));
    no(await w.call('vote', 'A', { chat: t, id: 'm1', o: [0] }), 403, 'not_poll');
    const v = (await state(w, 'B', t)).filter((s) => s.k === 'vote');
    expect(v.map((s) => [s.id, s.o])).toEqual([['v_poll1_' + A, [0]], ['v_poll2_' + A, [0, 2]]]);
  });
});

describe('مراجعة المالك محادثةً بسبب', () => {
  async function setup(w: W) {
    await w.seedDir();
    ok(await w.call('createThread', 'A', { id: dId(A, B), k: 'direct', p: uidSort(A, B), name: '' }));
    ok(await w.call('sendMessage', 'A', { chat: dId(A, B), msg: msg('m1', w.names.A) }));
    ok(await w.call('editMessage', 'A', { chat: dId(A, B), id: 'm1', body: 'معدلة', tag: null }));
    return dId(A, B);
  }

  test('V1 V2 V4 V5 V6 M1 M2 E1 لا يقرأ المالك محادثةً ليس فيها إلا بمراجعةٍ مفتوحة بسببٍ مسجَّل · وتنتهي بإغلاقها أو بثلاثين دقيقة', async () => {
    const w = await world();
    const t = await setup(w);
    no(await w.call('messagesSince', 'O', { chat: t, cursor: null }), 403);
    no(await w.call('getMessage', 'O', { chat: t, id: 'm1' }), 403);
    no(await w.call('editsOf', 'O', { chat: t, id: 'm1' }), 403);
    no(await w.call('openReview', 'O', { chat: t, reason: '   ' }), 403, 'reason');
    no(await w.call('openReview', 'O', { chat: t, reason: 'س'.repeat(501) }), 403, 'reason');
    no(await w.call('openReview', 'O', { chat: 'd_none', reason: 'سبب' }), 403, 'no_chat');
    no(await w.call('openReview', 'A', { chat: t, reason: 'سبب' }), 403, 'owner_only');
    const { rid } = ok(await w.call('openReview', 'O', { chat: t, reason: 'سبب مصطنع' })) as unknown as { rid: string };
    expect((ok(await w.call('messagesSince', 'O', { chat: t, cursor: null })) as unknown as { items: unknown[] }).items).toHaveLength(1);
    ok(await w.call('getMessage', 'O', { chat: t, id: 'm1' }));
    ok(await w.call('editsOf', 'O', { chat: t, id: 'm1' }));
    ok(await w.call('stateSince', 'O', { chat: t, cursor: null }));
    ok(await w.call('closeReview', 'O', { chat: t }));
    no(await w.call('messagesSince', 'O', { chat: t, cursor: null }), 403);
    ok(await w.call('openReview', 'O', { chat: t, reason: 'سبب ثان' }));
    w.clock.now += REVIEW_TTL_MS + 1;
    no(await w.call('messagesSince', 'O', { chat: t, cursor: null }), 403);
    // V1 السجل للمالك وحده، بكل فتح وسببه ووقت الخادم
    const rv = (ok(await w.call('reviews', 'O')) as unknown as { items: Array<{ rid: string; chat: string; reason: string; by: string }> }).items;
    expect(rv.map((r) => [r.chat, r.reason, r.by])).toEqual([[t, 'سبب مصطنع', ORG], [t, 'سبب ثان', ORG]]);
    expect(rv[0].rid).toBe(rid);
    no(await w.call('reviews', 'A'), 403, 'owner_only');
    no(await w.call('closeReview', 'A', { chat: t }), 403, 'owner_only');
  });
});

describe('نافذة الحذف والمسح', () => {
  test('U12 M19 V3 E2 المسح للمالك في نافذة الحذف وحدها (ساعة بساعة الخادم) · والدليل والإشراف يبقيان مع keepDirectory', async () => {
    const w = await world();
    await w.seedDir();
    ok(await w.call('setRole', 'O', { email: 'a@example.test', sup: ['contracts'] }));
    ok(await w.call('createThread', 'A', { id: dId(A, B), k: 'direct', p: uidSort(A, B), name: '' }));
    ok(await w.call('sendMessage', 'A', { chat: dId(A, B), msg: msg('m1', w.names.A) }));
    ok(await w.call('editMessage', 'A', { chat: dId(A, B), id: 'm1', body: 'x', tag: null }));
    ok(await w.call('openReview', 'O', { chat: dId(A, B), reason: 'سبب' }));
    no(await w.call('purgeAll', 'O'), 403, 'deletion_window');
    no(await w.call('openDeletionWindow', 'A'), 403, 'owner_only');
    no(await w.call('purgeAll', 'A'), 403, 'owner_only');
    ok(await w.call('openDeletionWindow', 'O'));
    w.clock.now += DELETION_TTL_MS + 1;
    await w.renew();
    no(await w.call('purgeAll', 'O'), 403, 'deletion_window');
    ok(await w.call('openDeletionWindow', 'O'));
    expect((ok(await w.call('purgeAll', 'O', { keepDirectory: true })) as unknown as { count: number }).count).toBe(1);
    const keys = Object.keys(w.storage.dump()).filter((k) => k.startsWith('c:'));
    expect(keys.filter((k) => /^c:(t|m|e|s|rv|ro):/.test(k))).toEqual([]);
    expect(keys.filter((k) => /^c:(d|r):/.test(k)).length).toBe(5);
    ok(await w.call('purgeAll', 'O'));
    expect(Object.keys(w.storage.dump()).filter((k) => /^c:(d|r):/.test(k))).toEqual([]);
    ok(await w.call('closeDeletionWindow', 'O'));
    no(await w.call('purgeAll', 'O'), 403, 'deletion_window');
    // وما للهوية في التخزين نفسه باقٍ (مفاتيح المحادثة ببادئتها وحدها)
    ok(await w.call('myThreads', 'A'));
  });
});

describe('الحدود والنقطة الواحدة', () => {
  test('حدّ الرسائل لكل حساب بساعة الخادم: ٤٢٩ بمدة الانتظار ثم يُرفع بمرور دقيقته · ولا يمسّ غيره', async () => {
    const w = await world();
    await w.seedDir();
    ok(await w.call('createThread', 'A', { id: dId(A, B), k: 'direct', p: uidSort(A, B), name: '' }));
    for (let i = 0; i < RATE_LIMITS.send.n; i++) ok(await w.call('sendMessage', 'A', { chat: dId(A, B), msg: msg('r' + i, w.names.A) }));
    const r = await w.call('sendMessage', 'A', { chat: dId(A, B), msg: msg('rx', w.names.A) }) as unknown as Fail;
    expect([r.status, r.code, (r.waitMs ?? 0) > 0]).toEqual([429, 'rate_limited', true]);
    ok(await w.call('sendMessage', 'B', { chat: dId(A, B), msg: msg('rb', w.names.B) }));
    w.clock.now += RATE_LIMITS.send.windowMs;
    ok(await w.call('sendMessage', 'A', { chat: dId(A, B), msg: msg('rx', w.names.A) }));
  });

  test('حدّ الكتابة العامة', async () => {
    const w = await world();
    await w.seedDir();
    ok(await w.call('createThread', 'A', { id: dId(A, B), k: 'direct', p: uidSort(A, B), name: '' }));
    ok(await w.call('sendMessage', 'A', { chat: dId(A, B), msg: msg('m1', w.names.A) }));
    let last: { ok: boolean; status?: number } = { ok: true };
    for (let i = 0; i < RATE_LIMITS.write.n + 5 && last.ok; i++) last = await w.call('setPin', 'B', { chat: dId(A, B), id: 'm1', on: i % 2 === 0 });
    no(last, 429);
  });

  test('عمليةٌ لا تُعرف ٤٠٤ · ومعطياتٌ تالفة ٤٠٠ لا انهيار', async () => {
    const w = await world();
    no(await w.call('dropDatabase', 'O'), 404, 'unknown_op');
    no(await w.call('sendMessage', 'A', { chat: 'x', msg: 'نص' }), 400);
    no(await w.call('addMember', 'O', { id: 'g_masnoo1', uid: 'bad uid' }), 400, 'uid');
    ok(await w.chat.dispatch('myThreads', w.tok('A'), null));
    no(await w.chat.dispatch('myThreads', w.tok('X'), [1, 2]), 403, 'not_in_org');
  });
});

describe('المصدر', () => {
  const dir = join(__dirname, '..', 'server', 'chat');
  test('لا يستورد غير ملفاته وخادم الهوية · ولا Buffer ولا process ولا وحدات Node', () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const s = readFileSync(join(dir, f), 'utf8');
      for (const m of s.matchAll(/from\s+'([^']+)'/g)) expect([f, m[1]]).toEqual([f, expect.stringMatching(/^\.\/|^\.\.\/auth\//)]);
      expect([f, /\b(Buffer|process|require)\b/.test(s.replace(/\/\*[^]*?\*\/|\/\/.*$/gm, ''))]).toEqual([f, false]);
    }
  });

  test('الضوابط والقيم المخزّنة نفسها في التطبيق', () => {
    expect([OWNER_JOINED, FORMER_MEMBER, BODY_MAX, NAME_MAX, PARTIES_MAX, MENTIONS_MAX, POLL_MIN, POLL_MAX, [...TAGS], [...LINK_TYPES]]).toEqual([
      appTypes.OWNER_JOINED, appTypes.FORMER_MEMBER, appTypes.CHAT_BODY_MAX, appTypes.CHAT_NAME_MAX, appTypes.CHAT_GROUP_MAX, appTypes.MENTIONS_MAX,
      appTypes.POLL_MIN, appTypes.POLL_MAX, [...appTypes.CHAT_TAGS], [...appTypes.CHAT_LINK_TYPES]]);
  });

  test('كل قاعدةٍ في كتلة «<chat>» لها فحصٌ مذكورٌ برقمه في الخادم واختبارٌ هنا', () => {
    const rules = readFileSync(join(dir, 'rules.ts'), 'utf8') + readFileSync(join(dir, 'server.ts'), 'utf8');
    const me = readFileSync(__filename, 'utf8');
    const tests = me.slice(0, me.indexOf("describe('المصدر'"));
    const ids = ['C1', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'R1', 'R2', 'R3', 'T1', 'T2', 'T3', 'T4', 'T5', 'CH1', 'S1', 'S2', 'Q1',
      'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9', 'U10', 'U11', 'U12', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10',
      'M11', 'M12', 'M13', 'M14', 'M15', 'M17', 'M18', 'M19', 'MV', 'MS', 'I1', 'ST1', 'ST2', 'ST3', 'ST4', 'ST6', 'ST7', 'ST8', 'ST9', 'ST10',
      'E1', 'E2', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];
    for (const id of ids) {
      expect([id, new RegExp('\\b' + id + '\\b').test(rules)]).toEqual([id, true]);
      expect([id, new RegExp("(test|describe)\\('[^']*\\b" + id + '\\b').test(tests)]).toEqual([id, true]);
    }
  });
});

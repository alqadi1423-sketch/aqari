/**
 * خادم المحادثة (ق٠-٧ · F الاستقلال عن قوقل §٥.٢ · قرار المالك على السؤال ٣: (أ) المحادثة تنتقل مع المنشأة) · منطقٌ خالص يُختبر على
 * Node ويُنقل إلى كائن المنشأة الدائم على Cloudflare في ق٢ بلا تغيير، كخادم الهوية (server/auth): لا واجهات Cloudflare، وWebCrypto
 * القياسية وحدها، والتخزين خلف واجهة get/put/delete/list، والساعة تُحقن (ساعة الخادم وحدها: لا يقبل وقتاً من الجهاز إلا ما يقارنه بها).
 *
 *  - **منشأةٌ لكل خادم:** org رقم المالك (orgOwner في القواعد)، والأعضاء ومستندات عضويتهم من دليل المنشأة (OrgDirectory) · والمفاتيح كلها
 *    ببادئة «c:» فتسكن بجوار مفاتيح الهوية في كائن المنشأة نفسه.
 *  - **الهوية:** كل عملية برمز دخولٍ يتحقق منه خادم الهوية (verifyAccess)، والصلاحية من الرمز ومن العضوية لا من الطلب.
 *  - **القواعد:** كل قاعدة في كتلة «<chat>» من firestore.rules فحصٌ هنا برقمها (rules.ts وجدول اختبار الخادم)، ورفضها 403 كما في
 *    Firestore فيعرفه الجهاز رفضاً لا عارضاً.
 *  - **الترتيب:** كل رسالة برقم تسلسلٍ من الخادم (seq) ووقتٍ منه (ts) لا يتكرر ولا يرجع: وقت الساعة بأجزاء الألف، وبعده عدّادٌ من ستة
 *    أرقام · فالترتيب بالوقت هو الترتيب بالتسلسل، والمؤشر وقتٌ بالصيغة التي يعرفها الجهاز اليوم (normTs) ومعه (الوقت، الرقم) للصفحة.
 *  - **الحدود:** أحجام القواعد كما هي، وحدّ كتابةٍ لكل حساب بساعة الخادم (٤٢٩ عارضٌ يُعاد).
 *
 * الطلبات تُنفَّذ واحداً بعد واحد (قفلٌ في الذاكرة) فكل عملية ذرّية: تُفحص كلها ثم تُكتب · وفي الكائن الدائم كذلك.
 * والردود رموز أخطاءٍ لا نصوص (status كرمز HTTP، وcode للتطبيق).
 */
import type { AuthStorage } from '../auth/storage';
import type { Access, Fail, Result } from '../auth/server';
import { b64url, randomBytes } from '../auth/crypto';
import {
  BODY_MAX, NAME_MAX, PARTIES_MAX, SUP_MAX, REASON_MAX, REVIEW_TTL_MS, DELETION_TTL_MS, OWNER_JOINED, FORMER_MEMBER,
  ID_RE, UID_RE, CHAT_ID_RE, settingsOk, isAdmin, maySend, channelOk, qualifies, historyOk, msgVisible, chatIn, party, pollOk, linkOk,
  mentionsOk, tagOk, taskFieldsOk, plainGroupId, changedKeys, isStrList,
  type Caller, type ChatLink, type ChatPoll, type ChatTag, type ChannelRef, type GroupSettings, type OrgMember, type ThreadRec, type ChatKind,
} from './rules';

/* ═══ الضوابط ═══ */

/** حدّ الكتابة لكل حساب بساعة الخادم: الرسائل وحدها، وكل كتابةٍ غيرها · سخيٌّ فلا يبلغه استعمالٌ عادي */
export const RATE_LIMITS = { send: { n: 60, windowMs: 60_000 }, write: { n: 300, windowMs: 60_000 } } as const;
export const PAGE_MAX = 500;

/* ═══ الأنواع ═══ */

export type ChatStorage = AuthStorage;

/** دليل المنشأة: الأعضاء ومستندات عضويتهم (اليوم members/{uid} في Firestore، وبعد التحويل في كائن المنشأة نفسه) */
export interface OrgDirectory {
  /** عضوٌ قائم · null لمن ليس عضواً (والمالك ليس عضواً) */
  member(uid: string): Promise<OrgMember | null>;
  members(): Promise<OrgMember[]>;
}

export interface ChatServerOptions {
  /** رقم المنشأة: رقم مالكها */
  org: string;
  storage: ChatStorage;
  /** ساعة الخادم بالملّي ثانية · وحدها تحسم كل وقتٍ ومدةٍ وحدّ */
  clock: () => number;
  /** خادم الهوية (server/auth) أو ما يتحقق من رموزه */
  auth: { verifyAccess(token: string): Promise<Result<Access>> };
  directory: OrgDirectory;
  random?: (n: number) => Uint8Array;
}

/** ما يردّه الخادم بالشكل الذي يعرفه الجهاز (RemoteThread وRemoteMessage وRemoteState وRemoteEdit في src/chat/transport.ts) */
export interface WireThread {
  id: string; k: ChatKind; p: string[]; name: string; by: string; at: string;
  s: GroupSettings; a: string[]; jt: Record<string, string>; ch: ChannelRef | null;
}
export interface WireMessage {
  id: string; from: string; name: string; body: string; link: ChatLink | null; ts: string; sys: string | null;
  re: string | null; men: string[]; tag: ChatTag | null; ack: boolean; ev: number; et: string | null; poll: ChatPoll | null;
}
export interface WireState {
  id: string; k: string; ts: string; on?: boolean; by?: string; at?: string; m?: string; n?: number;
  title?: string; as?: string; due?: string; done?: boolean; o?: number[]; cx?: boolean;
}
export interface WireEdit { n: number; body: string; tag: ChatTag | null; at: string }
export interface PageAfter { ts: string; id: string }

interface MsgRec extends WireMessage { seq: number; att: null }
interface DirRec { name: string; sup: string[]; at: string }
interface ReviewRec { rid: string; chat: string; reason: string; by: string; at: number }
interface OpenReview { rid: string; at: number }

const fail = (status: Fail['status'], code: string, waitMs?: number): Fail => (waitMs === undefined ? { ok: false, status, code } : { ok: false, status, code, waitMs });
const deny = (code: string) => fail(403, code);
const bad = (code: string) => fail(400, code);

const K = {
  clock: 'c:clock', seq: 'c:seq', del: 'c:del',
  t: (id: string) => 'c:t:' + id, tP: 'c:t:',
  m: (c: string, id: string) => `c:m:${c}:${id}`, mP: (c: string) => `c:m:${c}:`,
  e: (c: string, m: string, n: number) => `c:e:${c}:${m}:${String(n).padStart(6, '0')}`, eP: (c: string, m: string) => `c:e:${c}:${m}:`, eC: (c: string) => `c:e:${c}:`,
  s: (c: string, sid: string) => `c:s:${c}:${sid}`, sP: (c: string) => `c:s:${c}:`,
  d: (u: string) => 'c:d:' + u, dP: 'c:d:',
  r: (email: string) => 'c:r:' + email, rP: 'c:r:',
  rv: (n: number) => 'c:rv:' + String(n).padStart(12, '0'), rvP: 'c:rv:',
  ro: (c: string) => 'c:ro:' + c, roP: 'c:ro:',
  rl: (kind: string, u: string) => `c:rl:${kind}:${u}`,
};

/** وقت الخادم بالصيغة التي يعرفها الجهاز (تسعة أجزاء من الثانية) · ما ليس وقتاً يُردّ null */
export function normTs(v: unknown): string | null {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(String(v ?? ''));
  return m ? m[1] + '.' + (m[2] ?? '').padEnd(9, '0') + 'Z' : null;
}
const stampOf = (ms: number, n: number) => new Date(ms).toISOString().slice(0, 23) + String(n).padStart(6, '0') + 'Z';
const normEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();
const emailOk = (e: string) => e.length > 0 && e.length <= 254 && !/[\s/]/.test(e);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const clampLimit = (n: unknown, def: number) => Math.max(1, Math.min(PAGE_MAX, Number.isInteger(n) ? (n as number) : def));

export function toWireThread(t: ThreadRec): WireThread {
  return { id: t.id, k: t.k, p: [...t.p], name: t.name, by: t.by, at: t.at, s: { ...(t.s ?? {}) }, a: [...(t.a ?? [])], jt: { ...(t.jt ?? {}) }, ch: t.ch ?? null };
}
function toWireMessage(m: MsgRec): WireMessage {
  return { id: m.id, from: m.from, name: m.name, body: m.body, link: m.link, ts: m.ts, sys: m.sys, re: m.re, men: [...m.men], tag: m.tag, ack: m.ack, ev: m.ev, et: m.et, poll: m.poll };
}
/** بعد (الوقت، الرقم) أو عنده: الصفحة التالية تبدأ بعد آخر ما أُخذ */
const pastAfter = (x: { ts: string; id: string }, after: PageAfter | null) => !after || x.ts > after.ts || (x.ts === after.ts && x.id > after.id);
const byTsThenId = (a: { ts: string; id: string }, b: { ts: string; id: string }) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function createChatServer(o: ChatServerOptions) {
  if (!UID_RE.test(String(o.org ?? ''))) throw new Error('org must be the owner uid');
  const st = o.storage;
  const now = o.clock;
  const random = o.random ?? randomBytes;

  let chain: Promise<unknown> = Promise.resolve();
  function serial<A extends unknown[], R>(f: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
    return (...a: A) => {
      const run = chain.then(() => f(...a));
      chain = run.catch(() => undefined);
      return run;
    };
  }

  /* ═══ أدوات داخلية ═══ */

  /** وقتٌ جديد من الخادم لا يتكرر ولا يرجع ولو رجعت الساعة */
  async function stamp(): Promise<string> {
    const t = now();
    const last = (await st.get<{ ms: number; n: number }>(K.clock)) ?? { ms: -1, n: 0 };
    let next = t > last.ms ? { ms: t, n: 0 } : { ms: last.ms, n: last.n + 1 };
    if (next.n > 999_999) next = { ms: next.ms + 1, n: 0 };
    await st.put(K.clock, next);
    return stampOf(next.ms, next.n);
  }
  /** «الآن» حدّاً أعلى للمقارنة (request.time) · لا يسبق آخر وقتٍ أُعطي */
  async function ceiling(): Promise<string> {
    const last = await st.get<{ ms: number; n: number }>(K.clock);
    const t = stampOf(now(), 999_999);
    const l = last ? stampOf(last.ms, last.n) : '';
    return l > t ? l : t;
  }
  async function nextSeq(): Promise<number> {
    const n = ((await st.get<number>(K.seq)) ?? 0) + 1;
    await st.put(K.seq, n);
    return n;
  }

  /** C1 · من ينادي من رمزه وعضويته · والمالك رقمه رقم المنشأة */
  async function who(token: string): Promise<Result<{ c: Caller }>> {
    const a = await o.auth.verifyAccess(String(token ?? ''));
    if (!a.ok) return a;
    const owner = a.uid === o.org;
    const member = owner ? null : await o.directory.member(a.uid);
    return { ok: true, c: { uid: a.uid, owner, member } };
  }
  async function inChat(token: string): Promise<Result<{ c: Caller }>> {
    const w = await who(token);
    if (!w.ok) return w;
    return chatIn(w.c) ? w : deny('not_in_org');
  }

  /** الحدّ: محاولات الكتابة تُحسب لصاحبها قبل فحصها · وما بلغ الحدّ ٤٢٩ بمدة الانتظار */
  async function rate(c: Caller, kind: keyof typeof RATE_LIMITS): Promise<Fail | null> {
    const { n, windowMs } = RATE_LIMITS[kind];
    const key = K.rl(kind, c.uid);
    const t = now();
    const recent = ((await st.get<number[]>(key)) ?? []).filter((x) => t - x < windowMs && x <= t);
    if (recent.length >= n) return fail(429, 'rate_limited', Math.max(1, recent[0] + windowMs - t));
    recent.push(t);
    await st.put(key, recent);
    return null;
  }

  /** D5 · chatSup: إشرافي من مستند الإشراف بإيميل عضويتي · والمالك لا إشراف له (لا يحتاجه) */
  async function supOf(c: Caller): Promise<string[]> {
    if (c.owner || !c.member?.email) return [];
    return (await st.get<{ sup: string[] }>(K.r(normEmail(c.member.email))))?.sup ?? [];
  }
  const thread = (id: string) => (CHAT_ID_RE.test(String(id ?? '')) ? st.get<ThreadRec>(K.t(id)) : Promise.resolve(undefined));
  const message = (chat: string, id: string) => (ID_RE.test(String(id ?? '')) ? st.get<MsgRec>(K.m(chat, id)) : Promise.resolve(undefined));
  /** V6 · chatReviewing: مراجعةٌ مفتوحة لهذه المحادثة لم تتجاوز ثلاثين دقيقة بساعة الخادم */
  async function reviewing(chat: string): Promise<boolean> {
    const r = await st.get<OpenReview>(K.ro(chat));
    return !!r && r.at > now() - REVIEW_TTL_MS;
  }
  async function deletionOpen(): Promise<boolean> {
    const d = await st.get<{ at: number }>(K.del);
    return !!d && now() < d.at + DELETION_TTL_MS;
  }
  /** طرفٌ فيها وتحق له (أساس كل قراءةٍ وكتابةٍ في المحادثة) */
  const member = (c: Caller, t: ThreadRec) => party(c, t) && qualifies(c, t);
  async function dirName(uid: string): Promise<string | undefined> {
    return (await st.get<DirRec>(K.d(uid)))?.name;
  }

  /* ═══ الدليل والإشراف ═══ */

  /** D2 D3 D4 D5 D6 · يكتب صاحبه وحده اسمه (اسم عضويته حرفاً، والمالك ما شاء) وإشرافه كما سجّله المالك، بوقت الخادم */
  async function putDirectory(token: string, r: { name: string; sup: string[] }): Promise<Result<object>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const c = g.c;
    const lim = await rate(c, 'write');
    if (lim) return lim;
    if (typeof r?.name !== 'string' || r.name.length > NAME_MAX) return deny('name');
    if (!c.owner && r.name !== (c.member?.name ?? '')) return deny('name_mismatch');
    if (!isStrList(r.sup) || !sameList(r.sup, await supOf(c))) return deny('sup_mismatch');
    await st.put<DirRec>(K.d(c.uid), { name: r.name, sup: [...r.sup], at: await stamp() });
    return { ok: true };
  }

  /** D1 · لكل من في المنشأة */
  async function directory(token: string): Promise<Result<{ items: Array<{ uid: string; name: string; sup: string[] }> }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const items = [...(await st.list<DirRec>(K.dP))].map(([k, v]) => ({ uid: k.slice(K.dP.length), name: v.name, sup: v.sup }));
    return { ok: true, items };
  }

  /** D7 · خروجٌ من الدليل: لصاحبه وللمالك */
  async function removeDirectory(token: string, r: { uid: string }): Promise<Result<object>> {
    const w = await who(token);
    if (!w.ok) return w;
    if (!UID_RE.test(String(r?.uid ?? ''))) return bad('uid');
    if (!(w.c.owner || w.c.uid === r.uid)) return deny('owner_or_self');
    const lim = await rate(w.c, 'write');
    if (lim) return lim;
    await st.delete(K.d(r.uid));
    return { ok: true };
  }

  /** R1 · الإشراف بإيميله: للمالك ولصاحبه وحده (الإيميل لا يراه غيرهما) */
  async function getRole(token: string, r: { email: string }): Promise<Result<{ sup: string[] }>> {
    const w = await who(token);
    if (!w.ok) return w;
    const email = normEmail(r?.email);
    if (!emailOk(email)) return bad('email');
    const c = w.c;
    if (!(c.owner || (chatIn(c) && normEmail(c.member?.email) === email))) return deny('owner_or_self');
    return { ok: true, sup: (await st.get<{ sup: string[] }>(K.r(email)))?.sup ?? [] };
  }

  /** R2 · يكتبه المالك وحده · قائمة أقسامٍ لا تتجاوز ثلاثين */
  async function setRole(token: string, r: { email: string; sup: string[] }): Promise<Result<object>> {
    const w = await who(token);
    if (!w.ok) return w;
    if (!w.c.owner) return deny('owner_only');
    const lim = await rate(w.c, 'write');
    if (lim) return lim;
    const email = normEmail(r?.email);
    if (!emailOk(email)) return bad('email');
    if (!isStrList(r.sup) || r.sup.length > SUP_MAX) return deny('sup');
    await st.put(K.r(email), { sup: [...r.sup] });
    return { ok: true };
  }

  /** R3 · حذف الإشراف للمالك */
  async function removeRole(token: string, r: { email: string }): Promise<Result<object>> {
    const w = await who(token);
    if (!w.ok) return w;
    if (!w.c.owner) return deny('owner_only');
    const email = normEmail(r?.email);
    if (!emailOk(email)) return bad('email');
    await st.delete(K.r(email));
    return { ok: true };
  }

  /** أعضاء المنشأة وصلاحياتهم · للمالك (يضبط بها القنوات) كما يسرد مستندات العضوية اليوم */
  async function members(token: string): Promise<Result<{ items: Array<{ uid: string; perm: Record<string, number>; all: boolean; props: string[] }> }>> {
    const w = await who(token);
    if (!w.ok) return w;
    if (!w.c.owner) return deny('owner_only');
    return { ok: true, items: (await o.directory.members()).map((m) => ({ uid: m.uid, perm: { ...m.perm }, all: m.all, props: [...m.props] })) };
  }

  /* ═══ المحادثات ═══ */

  /** T2 T3 T4 T5 · الإنشاء بقواعده، ثم «موجودة» لما وُجد (إعادةٌ بعد انقطاع) */
  async function createThread(token: string, r: { id: string; k: ChatKind; p: string[]; name: string; s?: GroupSettings; a?: string[]; ch?: ChannelRef }): Promise<Result<{ result: 'created' | 'exists' }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const c = g.c;
    const lim = await rate(c, 'write');
    if (lim) return lim;
    const id = String(r?.id ?? '');
    if (!CHAT_ID_RE.test(id)) return bad('chat_id');
    if (!Object.keys(r).every((k) => ['id', 'k', 'p', 'name', 's', 'a', 'ch'].includes(k))) return deny('keys');
    if (!isStrList(r.p) || !r.p.includes(c.uid) || r.p.length > PARTIES_MAX) return deny('parties');
    if (typeof r.name !== 'string' || r.name.length > NAME_MAX) return deny('name');
    if (r.k === 'direct') {
      // T3 · طرفان بترتيبٍ واحد ورقمٌ منهما، والآخر عضوٌ أو المالك
      if (r.p.length !== 2 || r.s !== undefined || r.a !== undefined || r.ch !== undefined) return deny('direct_shape');
      if (!(r.p[0] < r.p[1]) || id !== 'd_' + r.p[0] + '_' + r.p[1]) return deny('direct_id');
      const other = r.p[0] === c.uid ? r.p[1] : r.p[0];
      if (!(other === o.org || (await o.directory.member(other)))) return deny('peer');
    } else if (r.k === 'group') {
      if (!settingsOk({ p: r.p, s: r.s, a: r.a })) return deny('settings');
      if (r.ch === undefined) {
        // T4 · بمنشئها وحده (ومعه المالك إن كان فيها)، للمالك والمشرف · ويُضاف كل عضوٍ بعدها في طلبه
        if (!plainGroupId(id)) return deny('group_id');
        if (r.p.length > 2 || r.p.some((u) => u !== c.uid && u !== o.org)) return deny('group_parties');
        if (!(c.owner || (await supOf(c)).length > 0)) return deny('owner_or_supervisor');
      } else {
        // T5 · القناة للمالك وحده وهو فيها وحده، ورقمها من نوعها
        if (!c.owner) return deny('owner_only');
        if (!/^g_[A-Za-z0-9_-]{6,64}$/.test(id) || !channelOk(id, r.ch)) return deny('channel');
        if (r.p.length !== 1) return deny('channel_parties');
      }
    } else return deny('kind');
    if (await st.get(K.t(id))) return { ok: true, result: 'exists' };
    const rec: ThreadRec = { id, k: r.k, p: [...r.p], name: r.name, by: c.uid, at: await stamp() };
    if (r.k === 'group') {
      rec.s = { ...(r.s ?? {}) };
      rec.a = [...(r.a ?? [])];
      if (r.ch !== undefined) rec.ch = r.ch;
    }
    await st.put(K.t(id), rec);
    return { ok: true, result: 'created' };
  }

  /** T1 · لأطرافها وللمالك (أطرافها واسمها وإعداداتها بلا رسائلها) */
  async function getThread(token: string, r: { id: string }): Promise<Result<{ thread: WireThread }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const t = await thread(r?.id);
    if (!t) return g.c.owner ? fail(404, 'not_found') : deny('not_party');
    if (!(party(g.c, t) || g.c.owner)) return deny('not_party');
    return { ok: true, thread: toWireThread(t) };
  }

  async function allThreads(): Promise<ThreadRec[]> {
    return [...(await st.list<ThreadRec>(K.tP)).values()];
  }

  /** محادثاتي: ما أنا طرفٌ فيه */
  async function myThreads(token: string): Promise<Result<{ items: WireThread[] }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    return { ok: true, items: (await allThreads()).filter((t) => party(g.c, t)).map(toWireThread) };
  }

  /** محادثات المنشأة كلها بأطرافها بلا رسائلها · للمالك وحده */
  async function orgThreads(token: string): Promise<Result<{ items: WireThread[] }>> {
    const w = await who(token);
    if (!w.ok) return w;
    if (!w.c.owner) return deny('owner_only');
    return { ok: true, items: (await allThreads()).map(toWireThread) };
  }

  /** مجموعات عضو · للمالك، ولصاحبها عن نفسه (استعلام «أنا طرف» تجيزه القراءة) */
  async function groupsOf(token: string, r: { uid: string }): Promise<Result<{ items: Array<{ id: string; p: string[]; name: string }> }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    if (!(g.c.owner || g.c.uid === r?.uid)) return deny('owner_or_self');
    return { ok: true, items: (await allThreads()).filter((t) => t.k === 'group' && t.p.includes(r.uid)).map((t) => ({ id: t.id, p: [...t.p], name: t.name })) };
  }

  /**
   * U1 · تعديل المجموعة: الحال قبله وبعده يُفحصان كما تفحص القواعد (المفاتيح، والحدود، والإعدادات، والمغادرة أو الإدارة) ·
   * joinLine: سطر «انضم المالك» في الطلب نفسه (U8)
   */
  async function updateCheck(c: Caller, before: ThreadRec, after: ThreadRec, joinLine: boolean): Promise<Fail | null> {
    if (before.k !== 'group') return deny('not_group');
    const changed = changedKeys(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
    if (!changed.every((k) => ['p', 'name', 'jm', 's', 'a', 'jt', 'la'].includes(k))) return deny('keys');
    if (after.p.length > PARTIES_MAX || new Set(after.p).size !== after.p.length) return deny('parties');
    if (typeof after.name !== 'string' || after.name.length > NAME_MAX) return deny('name');
    if (!settingsOk(after)) return deny('settings');
    const added = after.p.filter((u) => !before.p.includes(u));
    const removed = before.p.filter((u) => !after.p.includes(u));
    // U2 · المغادرة: يُخرج نفسه وحده ومعه خروجه من المسؤولين
    const selfLeave = before.p.includes(c.uid) && changed.every((k) => k === 'p' || k === 'a')
      && removed.length === 1 && removed[0] === c.uid && added.length === 0
      && sameSet(after.a ?? [], (before.a ?? []).filter((u) => u !== c.uid));
    if (selfLeave) return null;
    const creatorIn = before.by === c.uid && before.p.includes(c.uid);
    // U3 · الاسم والإعدادات للمسؤولين · U4 والإعدادات لطرفٍ فيها
    if ((changed.includes('name') || changed.includes('s')) && !isAdmin(c, before)) return deny('admin_only');
    if (changed.includes('s') && !before.p.includes(c.uid)) return deny('settings_party_only');
    // U5 · تعيين المسؤولين و U6 · الإزالة للمالك والمنشئ
    if (changed.includes('a') && !(c.owner || creatorIn)) return deny('appoint_owner_or_creator');
    if (removed.length && !(c.owner || creatorIn)) return deny('remove_owner_or_creator');
    if (!added.length) {
      // U11 · لا إضافة: لا وقت انضمامٍ ولا سطر، ولا تغيّر في الأطراف إلا إزالة
      if (changed.some((k) => k === 'jt' || k === 'la' || k === 'jm')) return deny('join_fields');
      if (!removed.length && changed.includes('p')) return deny('parties');
      return null;
    }
    // U7 · إضافة عضوٍ واحد (la) بوقت انضمامه من الخادم وحده
    const la = after.la ?? '';
    if (added.length !== 1 || added[0] !== la) return deny('add_one');
    if (la === o.org ? !c.owner : !(await o.directory.member(la))) return deny('not_member');
    const jtChanged = changedKeys(before.jt ?? {}, after.jt ?? {});
    if (jtChanged.length !== 1 || jtChanged[0] !== la) return deny('join_time');
    if (c.owner && la === c.uid && !before.p.includes(c.uid)) {
      // U8 · المالك لنفسه بسطر «انضم المالك» وحده
      return joinLine ? null : deny('join_line_required');
    }
    if (changed.includes('jm')) return deny('join_line');
    if (!before.ch) {
      // U9 · المجموعة العادية: للمسؤولين، ولكل الأعضاء إن أُذن
      if (!(isAdmin(c, before) || ((before.s?.ad ?? 'admins') === 'all' && before.p.includes(c.uid)))) return deny('add_not_allowed');
    } else if (!(c.owner || (la === c.uid && qualifies(c, before)))) {
      // U10 · القناة: يضمه المالك، أو يضم العضو نفسه بصلاحيته
      return deny('channel_not_qualified');
    }
    return null;
  }
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

  /** إضافة عضوٍ واحد بوقت انضمامه من الخادم */
  async function addMember(token: string, r: { id: string; uid: string }): Promise<Result<object>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const lim = await rate(g.c, 'write');
    if (lim) return lim;
    if (!UID_RE.test(String(r?.uid ?? ''))) return bad('uid');
    const t = await thread(r.id);
    if (!t) return fail(404, 'not_found');
    const at = await stamp();
    const after: ThreadRec = { ...t, p: t.p.includes(r.uid) ? [...t.p] : [...t.p, r.uid], jt: { ...(t.jt ?? {}), [r.uid]: at }, la: r.uid };
    const f = await updateCheck(g.c, t, after, false);
    if (f) return f;
    await st.put(K.t(t.id), after);
    return { ok: true };
  }

  /** إزالة أعضاء ومعها خروجهم من المسؤولين · للمالك والمنشئ، ولصاحبه وحده بالمغادرة */
  async function removeMembers(token: string, r: { id: string; uids: string[] }): Promise<Result<object>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const lim = await rate(g.c, 'write');
    if (lim) return lim;
    if (!isStrList(r?.uids) || r.uids.length > PARTIES_MAX) return bad('uids');
    const t = await thread(r.id);
    if (!t) return fail(404, 'not_found');
    const after: ThreadRec = { ...t, p: t.p.filter((u) => !r.uids.includes(u)) };
    if (t.a !== undefined) after.a = t.a.filter((u) => !r.uids.includes(u));
    const f = await updateCheck(g.c, t, after, false);
    if (f) return f;
    await st.put(K.t(t.id), after);
    return { ok: true };
  }

  /** الاسم والإعدادات (للمسؤولين) وتعيين المسؤولين (للمالك والمنشئ) · ما يُمرَّر وحده */
  async function setGroupMeta(token: string, r: { id: string; name?: string; s?: GroupSettings; a?: string[] }): Promise<Result<object>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const lim = await rate(g.c, 'write');
    if (lim) return lim;
    const t = await thread(r?.id);
    if (!t) return fail(404, 'not_found');
    const after: ThreadRec = { ...t };
    if (r.name !== undefined) after.name = r.name;
    if (r.s !== undefined) after.s = r.s;
    if (r.a !== undefined) after.a = r.a;
    const f = await updateCheck(g.c, t, after, false);
    if (f) return f;
    await st.put(K.t(t.id), after);
    return { ok: true };
  }

  /** U8 وM15 · انضمام المالك إلى مجموعة ليس فيها ومعه سطر «انضم المالك» في الطلب نفسه · يردّ رقم السطر */
  async function joinGroup(token: string, r: { id: string; name: string }): Promise<Result<{ lineId: string }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const c = g.c;
    const lim = (await rate(c, 'send')) ?? (await rate(c, 'write'));
    if (lim) return lim;
    if (!c.owner) return deny('owner_only');
    const t = await thread(r?.id);
    if (!t) return fail(404, 'not_found');
    if (t.p.includes(c.uid)) return deny('already_party');
    // M11 · باسمه في الدليل
    if (r.name !== (await dirName(c.uid))) return deny('name_mismatch');
    let lineId = '';
    do lineId = 'j_' + b64url(random(12)); while (await st.get(K.m(t.id, lineId)));
    const at = await stamp();
    const after: ThreadRec = { ...t, p: [...t.p, c.uid], jt: { ...(t.jt ?? {}), [c.uid]: at }, la: c.uid, jm: lineId };
    const f = await updateCheck(c, t, after, true);
    if (f) return f;
    await st.put(K.t(t.id), after);
    await st.put<MsgRec>(K.m(t.id, lineId), {
      id: lineId, from: c.uid, name: r.name, body: OWNER_JOINED, link: null, att: null, ts: await stamp(), seq: await nextSeq(), sys: 'join',
      re: null, men: [], tag: null, ack: false, ev: 0, et: null, poll: null,
    });
    return { ok: true, lineId };
  }

  /* ═══ الرسائل ═══ */

  /** M3 إلى M14 (M3 M4 M5 M6 M7 M8 M9 M10 M11 M12 M13 M14) · الرسالة تُنشأ مرة بوقت الخادم ورقم تسلسله، ثم «موجودة» لما وُجد (إعادةٌ بعد انقطاع) */
  async function sendMessage(token: string, r: { chat: string; msg: { id: string; name: string; body: string; link: ChatLink | null; re?: string | null; men?: string[]; tag?: ChatTag | null; ack?: boolean; poll?: ChatPoll | null } }): Promise<Result<{ result: 'created' | 'exists' }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const c = g.c;
    const lim = (await rate(c, 'send')) ?? (await rate(c, 'write'));
    if (lim) return lim;
    const m = r?.msg;
    if (!m || typeof m !== 'object') return bad('msg');
    if (!ID_RE.test(String(m.id ?? ''))) return bad('msg_id');
    const t = await thread(r.chat);
    if (!t) return deny('not_party');
    // M3 · طرفٌ يرسل فيها وتحق له
    if (!party(c, t)) return deny('not_party');
    if (!maySend(c, t)) return deny('admins_only');
    if (!qualifies(c, t)) return deny('not_qualified');
    // M4 · المفاتيح (والمرفقات مغلقة M14، وسطر النظام لا يُرسل هنا M15)
    if (!Object.keys(m).every((k) => ['id', 'name', 'body', 'link', 're', 'men', 'tag', 'ack', 'poll', 'att'].includes(k))) return deny('keys');
    if ((m as { att?: unknown }).att !== undefined && (m as { att?: unknown }).att !== null) return deny('attachments_closed');
    if (m.poll !== undefined && m.poll !== null && !pollOk(m.poll)) return deny('poll');
    if (!tagOk(m.tag)) return deny('tag');
    if (m.ack !== undefined && m.ack !== null && typeof m.ack !== 'boolean') return deny('ack');
    // M7 · الإعلان المهم للمسؤولين وحدهم: المالك، وفي المجموعة مسؤولوها
    if (m.ack === true && !(c.owner || (t.k === 'group' && isAdmin(c, t)))) return deny('ack_admins_only');
    // M8 · الرد على رسالةٍ في المحادثة نفسها
    if (m.re !== undefined && m.re !== null && !(typeof m.re === 'string' && ID_RE.test(m.re) && (await message(t.id, m.re)))) return deny('re');
    if (m.men !== undefined && m.men !== null && !mentionsOk(m.men)) return deny('mentions');
    // M11 · اسم المرسل من الدليل لا نصٌّ حرّ
    const dn = await dirName(c.uid);
    if (dn === undefined || m.name !== dn) return deny('name_mismatch');
    // M12 · النص حتى ٤٠٠٠
    if (typeof m.body !== 'string' || m.body.length > BODY_MAX) return deny('body');
    if (!linkOk(m.link)) return deny('link');
    if (await st.get(K.m(t.id, m.id))) return { ok: true, result: 'exists' };
    // M10 · from وts وseq من الخادم
    await st.put<MsgRec>(K.m(t.id, m.id), {
      id: m.id, from: c.uid, name: m.name, body: m.body, link: m.link ? { type: m.link.type, id: m.link.id, label: m.link.label } : null, att: null,
      ts: await stamp(), seq: await nextSeq(), sys: null, re: m.re ?? null, men: m.men ? [...m.men] : [], tag: m.tag ?? null, ack: m.ack === true,
      ev: 0, et: null, poll: m.poll ? { o: [...m.poll.o], m: m.poll.m } : null,
    });
    return { ok: true, result: 'created' };
  }

  /** M1 · الرسالة الواحدة: لطرفٍ تحق له بسجله (أو رسالته هو)، وللمالك بمراجعةٍ مفتوحة */
  async function readable(c: Caller, t: ThreadRec, m: MsgRec): Promise<boolean> {
    return (member(c, t) && (historyOk(c, t, m.ts) || m.from === c.uid)) || (c.owner && (await reviewing(t.id)));
  }

  async function getMessage(token: string, r: { chat: string; id: string }): Promise<Result<{ message: WireMessage }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const t = await thread(r?.chat);
    const m = t ? await message(t.id, r.id) : undefined;
    if (!t || !m) {
      if (t && (member(g.c, t) || (g.c.owner && (await reviewing(t.id))))) return fail(404, 'not_found');
      return deny('not_party');
    }
    if (!(await readable(g.c, t, m))) return deny('history');
    return { ok: true, message: toWireMessage(m) };
  }

  async function sortedMessages(chat: string): Promise<MsgRec[]> {
    return [...(await st.list<MsgRec>(K.mP(chat))).values()].sort((a, b) => a.seq - b.seq);
  }
  function page<T extends { ts: string; id: string }>(items: T[], cursor: string | null, after: PageAfter | null, limit: number): T[] {
    return items.filter((x) => (!cursor || x.ts >= cursor) && pastAfter(x, after)).sort(byTsThenId).slice(0, limit);
  }
  function cursorArgs(r: { cursor?: unknown; after?: unknown }): { cursor: string | null; after: PageAfter | null } | null {
    const cursor = r.cursor === null || r.cursor === undefined ? null : normTs(r.cursor);
    if (r.cursor !== null && r.cursor !== undefined && !cursor) return null;
    const a = r.after as PageAfter | null | undefined;
    if (a === null || a === undefined) return { cursor, after: null };
    const ts = normTs(a.ts);
    return ts && typeof a.id === 'string' ? { cursor, after: { ts, id: a.id } } : null;
  }

  /** M2 · سرد الرسائل بعد مؤشر: لطرفٍ تحق له والسجل كل السابق، وللمالك بمراجعةٍ مفتوحة · والمنضم «من لحظة انضمامه» يسرد بالأرقام */
  async function messagesSince(token: string, r: { chat: string; cursor: string | null; limit?: number; after?: PageAfter | null }): Promise<Result<{ items: WireMessage[] }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const t = await thread(r?.chat);
    if (!t) return deny('not_party');
    const ok = (member(g.c, t) && (t.s?.h ?? 'all') === 'all') || (g.c.owner && (await reviewing(t.id)));
    if (!ok) return deny('list_not_allowed');
    const ca = cursorArgs(r);
    if (!ca) return bad('cursor');
    return { ok: true, items: page(await sortedMessages(t.id), ca.cursor, ca.after, clampLimit(r.limit, 200)).map(toWireMessage) };
  }

  /** I1 وM1 · «من لحظة انضمامه»: أرقام ما بعد المؤشر لطرفٍ تحق له، ثم كل رسالةٍ بقاعدتها (ورسالةٌ لا تُقرأ ترفض الصفحة كلها) */
  async function joinedPage(token: string, r: { chat: string; cursor: string; limit?: number; after?: PageAfter | null }): Promise<Result<{ msgs: WireMessage[]; ids: number; lastTs: string | null; lastId: string | null }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const t = await thread(r?.chat);
    if (!t || !member(g.c, t)) return deny('not_party');
    const ca = cursorArgs(r);
    if (!ca || !ca.cursor) return bad('cursor');
    const got = page(await sortedMessages(t.id), ca.cursor, ca.after, clampLimit(r.limit, 200));
    for (const m of got) if (!(await readable(g.c, t, m))) return deny('history');
    const last = got[got.length - 1];
    return { ok: true, msgs: got.map(toWireMessage), ids: got.length, lastTs: last?.ts ?? null, lastId: last?.id ?? null };
  }

  /** M18 · تعديل مرسلها وهو طرفٌ يرسل وتحق له: النص والوسم ورقم التعديل ووقته، وما قبله في سجلها، وإشارةٌ في حال المحادثة · معاً */
  async function editMessage(token: string, r: { chat: string; id: string; body: string; tag: ChatTag | null }): Promise<Result<{ n: number }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const c = g.c;
    const lim = await rate(c, 'write');
    if (lim) return lim;
    const t = await thread(r?.chat);
    const m = t ? await message(t.id, r.id) : undefined;
    if (!t || !m) return deny('not_found');
    if (m.from !== c.uid) return deny('not_sender');
    if (!party(c, t) || !maySend(c, t) || !qualifies(c, t)) return deny('not_party');
    if (m.sys !== null) return deny('system_line');
    if (typeof r.body !== 'string' || r.body.length > BODY_MAX) return deny('body');
    if (!tagOk(r.tag)) return deny('tag');
    const n = m.ev + 1;
    const at = await stamp();
    await st.put<WireEdit>(K.e(t.id, m.id, n), { n, body: m.body, tag: m.tag, at });
    await st.put<MsgRec>(K.m(t.id, m.id), { ...m, body: r.body, tag: r.tag ?? null, ev: n, et: at });
    await st.put<WireState>(K.s(t.id, 'x_' + m.id), { id: 'x_' + m.id, k: 'edit', m: m.id, n, ts: await stamp() });
    return { ok: true, n };
  }

  /** E1 · سجل التعديل لمن يقرأ الرسالة نفسها، وللمالك بمراجعته */
  async function editsOf(token: string, r: { chat: string; id: string }): Promise<Result<{ items: WireEdit[] }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const t = await thread(r?.chat);
    const m = t ? await message(t.id, r.id) : undefined;
    if (!t || !m) return deny('not_found');
    if (!((member(g.c, t) && msgVisible(g.c, t, m)) || (g.c.owner && (await reviewing(t.id))))) return deny('history');
    return { ok: true, items: [...(await st.list<WireEdit>(K.eP(t.id, m.id))).values()].sort((a, b) => a.n - b.n) };
  }

  /** M17 · العضو يحذف حسابه: اسمه في رسائله «عضو سابق» وحده · رسائله هو في كل محادثات المنشأة */
  async function anonymizeMine(token: string, r: { label: string }): Promise<Result<{ count: number }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    if (r?.label !== FORMER_MEMBER) return deny('label');
    let count = 0;
    for (const t of await allThreads()) {
      for (const m of await sortedMessages(t.id)) {
        if (m.from !== g.c.uid || m.name === FORMER_MEMBER) continue;
        await st.put<MsgRec>(K.m(t.id, m.id), { ...m, name: FORMER_MEMBER });
        count++;
      }
    }
    return { ok: true, count };
  }

  /* ═══ حال المحادثة ═══ */

  /** ST1 · لطرفٍ تحق له، وللمالك بمراجعته أو في نافذة الحذف */
  async function stateSince(token: string, r: { chat: string; cursor: string | null; limit?: number; after?: PageAfter | null }): Promise<Result<{ items: WireState[] }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const t = await thread(r?.chat);
    if (!t) return deny('not_party');
    if (!(member(g.c, t) || (g.c.owner && ((await reviewing(t.id)) || (await deletionOpen()))))) return deny('not_party');
    const ca = cursorArgs(r);
    if (!ca) return bad('cursor');
    return { ok: true, items: page([...(await st.list<WireState>(K.sP(t.id))).values()], ca.cursor, ca.after, clampLimit(r.limit, 300)) };
  }

  /** ST2 · كل كتابةٍ في الحال: طرفٌ تحق له، بوقت الخادم · ويردّ المحادثة لفحص ما بعده */
  async function stateWriter(token: string, chat: string): Promise<Result<{ c: Caller; t: ThreadRec }>> {
    const g = await inChat(token);
    if (!g.ok) return g;
    const lim = await rate(g.c, 'write');
    if (lim) return lim;
    const t = await thread(chat);
    if (!t || !member(g.c, t)) return deny('not_party');
    return { ok: true, c: g.c, t };
  }

  /** ST3 · قراءتي حتى وقتٍ لا يتجاوز الآن · يكتبها صاحبها وحده */
  async function markRead(token: string, r: { chat: string; at: string }): Promise<Result<object>> {
    const w = await stateWriter(token, r?.chat);
    if (!w.ok) return w;
    const at = normTs(r.at);
    if (!at || at > (await ceiling())) return deny('read_time');
    const sid = 'r_' + w.c.uid;
    await st.put<WireState>(K.s(w.t.id, sid), { id: sid, k: 'read', at, ts: await stamp() });
    return { ok: true };
  }

  /** ST4 · التثبيت لرسالةٍ موجودة: في المجموعة لمسؤوليها، وفي الفردية لطرفيها */
  async function setPin(token: string, r: { chat: string; id: string; on: boolean }): Promise<Result<object>> {
    const w = await stateWriter(token, r?.chat);
    if (!w.ok) return w;
    if (typeof r.on !== 'boolean') return deny('on');
    if (!(await message(w.t.id, r.id))) return deny('no_message');
    if (w.t.k === 'group' && !isAdmin(w.c, w.t)) return deny('admin_only');
    const sid = 'p_' + r.id;
    await st.put<WireState>(K.s(w.t.id, sid), { id: sid, k: 'pin', on: r.on, by: w.c.uid, ts: await stamp() });
    return { ok: true };
  }

  /** ST10 · تأكيد الاطلاع على إعلانٍ يطلبه، مرةً وحدها، لمن يقرؤه */
  async function acknowledge(token: string, r: { chat: string; id: string }): Promise<Result<{ result: 'created' | 'exists' }>> {
    const w = await stateWriter(token, r?.chat);
    if (!w.ok) return w;
    const m = await message(w.t.id, r.id);
    if (!m || !m.ack) return deny('not_announcement');
    if (!msgVisible(w.c, w.t, m)) return deny('history');
    const sid = `a_${m.id}_${w.c.uid}`;
    if (await st.get(K.s(w.t.id, sid))) return { ok: true, result: 'exists' };
    await st.put<WireState>(K.s(w.t.id, sid), { id: sid, k: 'ack', m: m.id, by: w.c.uid, ts: await stamp() });
    return { ok: true, result: 'created' };
  }

  /**
   * ST6 وST7 · المهمة من رسالة: ينشئها من يرسل لرسالةٍ يقرؤها وليست سطر نظام، ومسؤولها من أطرافها · ويعدّلها منشئها، ومنشئها
   * وإنجازها كما في الخادم (تعديل المنشئ لا يرجع ما أنجزه المسؤول) · والملغاة لا تُعدَّل
   */
  async function setTask(token: string, r: { chat: string; id: string; task: { title: string; as: string; due: string; done: boolean } }): Promise<Result<object>> {
    const w = await stateWriter(token, r?.chat);
    if (!w.ok) return w;
    const { c, t } = w;
    const task = r.task ?? ({} as never);
    if (!taskFieldsOk(task)) return deny('task');
    const m = await message(t.id, r.id);
    if (!m) return deny('no_message');
    const sid = 't_' + m.id;
    const cur = await st.get<WireState>(K.s(t.id, sid));
    if (!t.p.includes(task.as)) return deny('assignee_not_party');
    let next: WireState;
    if (!cur) {
      if (!maySend(c, t)) return deny('admins_only');
      if (m.sys !== null) return deny('system_line');
      if (!msgVisible(c, t, m)) return deny('history');
      next = { id: sid, k: 'task', m: m.id, title: task.title, as: task.as, due: task.due, done: task.done, by: c.uid, ts: '' };
    } else {
      if (cur.cx) return deny('cancelled');
      next = { id: sid, k: 'task', m: m.id, title: task.title, as: task.as, due: task.due, done: cur.done ?? false, by: cur.by ?? c.uid, ts: '' };
      const diff = changedKeys(stripTs(cur), stripTs(next)).filter((k) => k !== 'cx');
      if (!(cur.by === c.uid || (cur.as === c.uid && diff.every((k) => k === 'done')))) return deny('creator_only');
    }
    await st.put<WireState>(K.s(t.id, sid), { ...next, ts: await stamp() });
    return { ok: true };
  }
  const stripTs = (s: WireState) => { const { ts: _ts, ...rest } = s; return rest as Record<string, unknown>; };

  /** ST7 · الإنجاز وحده: لمنشئها ومسؤولها ما دام مسؤولها طرفاً وما لم تُلغَ */
  async function setTaskDone(token: string, r: { chat: string; id: string; done: boolean }): Promise<Result<object>> {
    const w = await stateWriter(token, r?.chat);
    if (!w.ok) return w;
    if (typeof r.done !== 'boolean') return deny('done');
    const sid = 't_' + String(r.id ?? '');
    const cur = ID_RE.test(String(r.id ?? '')) ? await st.get<WireState>(K.s(w.t.id, sid)) : undefined;
    if (!cur) return fail(404, 'not_found');
    if (cur.cx) return deny('cancelled');
    if (!(cur.by === w.c.uid || cur.as === w.c.uid)) return deny('creator_or_assignee');
    if (!w.t.p.includes(cur.as ?? '')) return deny('assignee_not_party');
    await st.put<WireState>(K.s(w.t.id, sid), { ...cur, done: r.done, ts: await stamp() });
    return { ok: true };
  }

  /** ST8 · الإلغاء لمنشئها وحده، ولو غادر مسؤولها · وتبقى «ملغاة» */
  async function cancelTask(token: string, r: { chat: string; id: string }): Promise<Result<object>> {
    const w = await stateWriter(token, r?.chat);
    if (!w.ok) return w;
    const sid = 't_' + String(r.id ?? '');
    const cur = ID_RE.test(String(r.id ?? '')) ? await st.get<WireState>(K.s(w.t.id, sid)) : undefined;
    if (!cur) return fail(404, 'not_found');
    if (cur.cx) return deny('cancelled');
    if (cur.by !== w.c.uid) return deny('creator_only');
    await st.put<WireState>(K.s(w.t.id, sid), { ...cur, cx: true, ts: await stamp() });
    return { ok: true };
  }

  /** ST9 · صوتي في استطلاع أقرؤه · خياراتٌ بلا تكرار من خياراته، وواحدٌ إلا إن سُمح بأكثر · ويُغيَّر */
  async function vote(token: string, r: { chat: string; id: string; o: number[] }): Promise<Result<object>> {
    const w = await stateWriter(token, r?.chat);
    if (!w.ok) return w;
    const m = await message(w.t.id, r.id);
    if (!m || !m.poll) return deny('not_poll');
    const opts = r.o;
    const n = m.poll.o.length;
    if (!Array.isArray(opts) || opts.length < 1 || opts.length > n || new Set(opts).size !== opts.length
      || !opts.every((x) => Number.isInteger(x) && x >= 0 && x < n)) return deny('options');
    if (!m.poll.m && opts.length !== 1) return deny('single_choice');
    if (!msgVisible(w.c, w.t, m)) return deny('history');
    const sid = `v_${m.id}_${w.c.uid}`;
    await st.put<WireState>(K.s(w.t.id, sid), { id: sid, k: 'vote', m: m.id, by: w.c.uid, o: [...opts], ts: await stamp() });
    return { ok: true };
  }

  /* ═══ مراجعة المالك محادثةً بسبب ═══ */

  /** V2 وV4 · سجلٌّ جديد بالمحادثة والسبب والمراجِع ووقت الخادم، ومعه فتح المراجعة · للمالك وحده */
  async function openReview(token: string, r: { chat: string; reason: string }): Promise<Result<{ rid: string }>> {
    const w = await who(token);
    if (!w.ok) return w;
    if (!w.c.owner) return deny('owner_only');
    const lim = await rate(w.c, 'write');
    if (lim) return lim;
    if (typeof r?.reason !== 'string' || !r.reason.trim() || r.reason.length > REASON_MAX) return deny('reason');
    const t = await thread(r.chat);
    if (!t) return deny('no_chat');
    // السجل بترتيب فتحه (رقمٌ من التسلسل) · ورقم المراجعة عشوائيٌّ لا يُخمَّن
    const rid = b64url(random(12));
    const at = now();
    await st.put<ReviewRec>(K.rv(await nextSeq()), { rid, chat: t.id, reason: r.reason, by: w.c.uid, at });
    await st.put<OpenReview>(K.ro(t.id), { rid, at });
    return { ok: true, rid };
  }

  /** V5 · إغلاق المحادثة ينهي المراجعة */
  async function closeReview(token: string, r: { chat: string }): Promise<Result<object>> {
    const w = await who(token);
    if (!w.ok) return w;
    if (!w.c.owner) return deny('owner_only');
    if (!CHAT_ID_RE.test(String(r?.chat ?? ''))) return bad('chat_id');
    await st.delete(K.ro(r.chat));
    return { ok: true };
  }

  /** V1 · سجل المراجعات للمالك وحده (لا إشعار لأحدٍ بمراجعةٍ بعينها) */
  async function reviews(token: string): Promise<Result<{ items: ReviewRec[] }>> {
    const w = await who(token);
    if (!w.ok) return w;
    if (!w.c.owner) return deny('owner_only');
    return { ok: true, items: [...(await st.list<ReviewRec>(K.rvP)).values()] };
  }

  /* ═══ نافذة الحذف والمسح ═══ */

  /** نافذة الحذف بساعة الخادم لساعة · للمالك («حذف حسابي» والمسح الشامل) */
  async function openDeletionWindow(token: string): Promise<Result<object>> {
    const w = await who(token);
    if (!w.ok) return w;
    if (!w.c.owner) return deny('owner_only');
    await st.put(K.del, { at: now() });
    return { ok: true };
  }
  async function closeDeletionWindow(token: string): Promise<Result<object>> {
    const w = await who(token);
    if (!w.ok) return w;
    if (!w.c.owner) return deny('owner_only');
    await st.delete(K.del);
    return { ok: true };
  }

  /** U12 وM19 وV3 وE2 · محادثات المنشأة كلها ورسائلها وحالها وسجلاتها في نافذة الحذف وحدها · والدليل والإشراف إلا مع keepDirectory */
  async function purgeAll(token: string, r: { keepDirectory?: boolean } = {}): Promise<Result<{ count: number }>> {
    const w = await who(token);
    if (!w.ok) return w;
    if (!w.c.owner) return deny('owner_only');
    if (!(await deletionOpen())) return deny('deletion_window');
    let count = 0;
    for (const t of await allThreads()) {
      for (const k of (await st.list(K.mP(t.id))).keys()) { await st.delete(k); count++; }
      for (const k of (await st.list(K.eC(t.id))).keys()) await st.delete(k);
      for (const k of (await st.list(K.sP(t.id))).keys()) await st.delete(k);
      await st.delete(K.t(t.id));
    }
    for (const p of [K.roP, K.rvP, ...(r?.keepDirectory ? [] : [K.dP, K.rP])]) {
      for (const k of (await st.list(p)).keys()) await st.delete(k);
    }
    return { ok: true, count };
  }

  const ops = {
    putDirectory, directory, removeDirectory, getRole, setRole, removeRole, members,
    createThread, getThread, myThreads, orgThreads, groupsOf, addMember, removeMembers, setGroupMeta, joinGroup,
    sendMessage, getMessage, messagesSince, joinedPage, editMessage, editsOf, anonymizeMine,
    stateSince, markRead, setPin, acknowledge, setTask, setTaskDone, cancelTask, vote,
    openReview, closeReview, reviews, openDeletionWindow, closeDeletionWindow, purgeAll,
  };
  type Ops = typeof ops;
  const serialOps = Object.fromEntries(Object.entries(ops).map(([k, f]) => [k, serial(f as (...a: unknown[]) => Promise<unknown>)])) as unknown as Ops;

  /**
   * نقطة دخولٍ واحدة لا تعرف HTTP: اسم العملية ورمز الدخول ومعطياتها · ما يناديه عامل Cloudflare من «POST /chat/<op>» بعد ق٢،
   * وما يناديه ناقل الجهاز في الاختبار
   */
  async function dispatch(op: string, token: string, args: unknown): Promise<Result<Record<string, unknown>>> {
    if (!Object.prototype.hasOwnProperty.call(ops, op)) return fail(404, 'unknown_op');
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const f = serialOps[op as keyof Ops] as unknown as (t: string, x: unknown) => Promise<Result<Record<string, unknown>>>;
    try {
      return await f(token, a);
    } catch {
      return bad('bad_request');
    }
  }

  return { ...serialOps, dispatch };
}

export type ChatServer = ReturnType<typeof createChatServer>;
export type ChatOp = Exclude<keyof ChatServer, 'dispatch'>;

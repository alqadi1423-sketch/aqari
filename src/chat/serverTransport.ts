/**
 * ناقل المحادثة إلى خادم المنشأة (ق٠-٧ · F §٥.٢ · قرار المالك على السؤال ٣: (أ)) · يطبّق ChatTransport على عمليات server/chat، ولا
 * يعرف HTTP: يتكلم مع عميلٍ يُحقن (ChatServerClient) يحمل اسم العملية ورمز الدخول ومعطياتها ويردّ ما ردّه الخادم.
 *
 * لا يُشغَّل قبل التحويل بإذن المالك (F §٨ ق٣ وق٤): لا منادي لـserverChatTransport ولا لـsetChatTransport في التطبيق، والاختبار
 * يشغّله على الخادم في الذاكرة طرفاً لطرف.
 *
 * رفض الخادم ChatTransportError برمزه (403 رفضٌ يوسم، و429 وغيره عارضٌ يُعاد) · وما يردّه يُقرأ بحذر كما يُقرأ Firestore اليوم.
 */
import type { ChatSession, ChatTransportFactory } from './index';
import {
  ChatTransportError, type ChatMemberPerm, type ChatTransport, type CreateResult, type JoinedPage, type OutgoingMessage, type PageAfter,
  type RemoteEdit, type RemoteMessage, type RemoteState, type RemoteThread,
} from './transport';
import { CHAT_LINK_TYPES, CHAT_TAGS, normTs, type ChannelRef, type ChatKind, type ChatLink, type ChatPerson, type ChatPoll, type ChatTag, type ChatTask, type GroupSettings } from './types';

/** عمليات خادم المحادثة بأسمائها في server/chat (dispatch) */
export type ChatServerOp =
  | 'putDirectory' | 'directory' | 'removeDirectory' | 'getRole' | 'setRole' | 'removeRole' | 'members'
  | 'createThread' | 'getThread' | 'myThreads' | 'orgThreads' | 'groupsOf' | 'addMember' | 'removeMembers' | 'setGroupMeta' | 'joinGroup'
  | 'sendMessage' | 'getMessage' | 'messagesSince' | 'joinedPage' | 'editMessage' | 'editsOf' | 'anonymizeMine'
  | 'stateSince' | 'markRead' | 'setPin' | 'acknowledge' | 'setTask' | 'setTaskDone' | 'cancelTask' | 'vote'
  | 'openReview' | 'closeReview' | 'openDeletionWindow' | 'closeDeletionWindow' | 'purgeAll';

export type ChatReply = ({ ok: true } & Record<string, unknown>) | { ok: false; status: number; code: string; waitMs?: number };

/** العميل: نداءٌ واحد لمنشأةٍ بعملية ورمز ومعطيات · بعد ق٢ «POST /orgs/<org>/chat/<op>» بالرمز في Authorization */
export interface ChatServerClient {
  call(org: string, op: ChatServerOp, token: string, args: Record<string, unknown>): Promise<ChatReply>;
}

export interface ServerTransportOptions {
  client: ChatServerClient;
  org: string;
  uid: string;
  /** رمز الدخول من مزوّد الهوية (AuthProvider.accessToken) */
  accessToken: () => Promise<string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const ts = (v: unknown): string => normTs(v);

function linkOf(v: unknown): ChatLink | null {
  if (!isObj(v)) return null;
  const type = String(v.type ?? '') as ChatLink['type'];
  if (!CHAT_LINK_TYPES.includes(type) || typeof v.id !== 'string') return null;
  return { type, id: v.id, label: String(v.label ?? '') };
}

function threadOf(v: unknown): RemoteThread {
  const d = isObj(v) ? v : {};
  const jt: Record<string, string> = {};
  for (const [k, x] of Object.entries(isObj(d.jt) ? d.jt : {})) if (typeof x === 'string') jt[k] = ts(x);
  return {
    id: String(d.id ?? ''), k: d.k === 'group' ? 'group' : 'direct', p: strList(d.p), name: String(d.name ?? ''), by: String(d.by ?? ''),
    at: typeof d.at === 'string' ? ts(d.at) : null, s: (isObj(d.s) ? d.s : {}) as GroupSettings, a: strList(d.a), jt,
    ch: isObj(d.ch) ? (d.ch as ChannelRef) : null,
  };
}

function messageOf(v: unknown): RemoteMessage {
  const d = isObj(v) ? v : {};
  const poll = isObj(d.poll) && Array.isArray(d.poll.o) ? { o: (d.poll.o as unknown[]).map(String), m: d.poll.m === true } : null;
  return {
    id: String(d.id ?? ''), from: String(d.from ?? ''), name: String(d.name ?? ''), body: String(d.body ?? ''), link: linkOf(d.link),
    ts: ts(d.ts), sys: typeof d.sys === 'string' ? d.sys : null, re: typeof d.re === 'string' ? d.re : null, men: strList(d.men),
    tag: CHAT_TAGS.includes(d.tag as ChatTag) ? (d.tag as ChatTag) : null, ack: d.ack === true, ev: typeof d.ev === 'number' ? d.ev : 0,
    et: typeof d.et === 'string' ? ts(d.et) : null, poll,
  };
}

function stateOf(v: unknown): RemoteState {
  const d = isObj(v) ? v : {};
  return {
    id: String(d.id ?? ''), k: String(d.k ?? ''), ts: ts(d.ts),
    ...(typeof d.on === 'boolean' ? { on: d.on } : {}), ...(typeof d.by === 'string' ? { by: d.by } : {}),
    ...(typeof d.at === 'string' ? { at: ts(d.at) } : {}),
    ...(typeof d.m === 'string' ? { m: d.m } : {}), ...(typeof d.n === 'number' ? { n: d.n } : {}),
    ...(typeof d.title === 'string' ? { title: d.title } : {}), ...(typeof d.as === 'string' ? { as: d.as } : {}),
    ...(typeof d.due === 'string' ? { due: d.due } : {}), ...(typeof d.done === 'boolean' ? { done: d.done } : {}),
    ...(Array.isArray(d.o) ? { o: (d.o as unknown[]).map(Number) } : {}),
    ...(typeof d.cx === 'boolean' ? { cx: d.cx } : {}),
  };
}

const list = (r: Record<string, unknown>, key = 'items'): unknown[] => (Array.isArray(r[key]) ? (r[key] as unknown[]) : []);

export class ServerChatTransport implements ChatTransport {
  constructor(private o: ServerTransportOptions) {}

  private async call(op: ChatServerOp, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const r = await this.o.client.call(this.o.org, op, await this.o.accessToken(), args);
    if (!r || r.ok !== true) {
      const f = (r ?? {}) as { status?: unknown; code?: unknown };
      throw new ChatTransportError(typeof f.status === 'number' ? f.status : 500, String(f.code ?? 'error'));
    }
    return r;
  }

  /* الدليل والإشراف */
  async putMyDirectory(name: string, sup: string[]): Promise<void> { await this.call('putDirectory', { name, sup }); }
  async directory(): Promise<ChatPerson[]> {
    return list(await this.call('directory')).filter(isObj).map((d) => ({ uid: String(d.uid ?? ''), name: String(d.name ?? ''), sup: strList(d.sup) }));
  }
  async removeFromDirectory(uid: string): Promise<void> { await this.call('removeDirectory', { uid }); }
  async role(email: string): Promise<string[]> { return strList((await this.call('getRole', { email: email.trim().toLowerCase() })).sup); }
  async setRole(email: string, sup: string[]): Promise<void> { await this.call('setRole', { email: email.trim().toLowerCase(), sup }); }
  async removeRole(email: string): Promise<void> { await this.call('removeRole', { email: email.trim().toLowerCase() }); }
  async members(): Promise<ChatMemberPerm[]> {
    return list(await this.call('members')).filter(isObj).map((m) => ({
      uid: String(m.uid ?? ''), perm: (isObj(m.perm) ? m.perm : {}) as Record<string, number>, all: m.all === true, props: strList(m.props),
    }));
  }

  /* المحادثات */

  /**
   * كما في ChatRemote: المجموعة تُنشأ بمنشئها وحده (ومعه المالك إن كان فيها) ثم يُضاف كل عضوٍ في طلبه فتُفحص عضويته، ثم يُعيَّن
   * المسؤولون · وإعادة المحاولة تكمل ما لم يُضف (قرار المالك 2026-10-15 «١٥»)
   */
  async createThread(t: { id: string; k: ChatKind; p: string[]; name: string; s?: GroupSettings; a?: string[] }): Promise<CreateResult> {
    if (t.k !== 'group') return this.create({ id: t.id, k: t.k, p: t.p, name: t.name });
    const base = t.p.filter((u) => u === this.o.uid || u === this.o.org).sort();
    const r = await this.create({ id: t.id, k: 'group', p: base, name: t.name, s: t.s ?? {}, a: (t.a ?? []).filter((u) => base.includes(u)) });
    const cur = await this.getThread(t.id);
    for (const u of t.p) if (!cur.p.includes(u)) await this.addMember(t.id, u);
    const admins = (t.a ?? []).filter((u) => !base.includes(u));
    if (admins.length) await this.setGroupMeta(t.id, { a: [...new Set([...(cur.a ?? []), ...(t.a ?? [])])] });
    return r;
  }
  private async create(args: Record<string, unknown>): Promise<CreateResult> {
    return (await this.call('createThread', args)).result === 'exists' ? 'exists' : 'created';
  }
  async createChannel(id: string, ch: ChannelRef, name: string): Promise<CreateResult> {
    const s: GroupSettings = { h: 'all', w: ch.t === 'announce' ? 'admins' : 'all', ad: 'admins' };
    return this.create({ id, k: 'group', p: [this.o.uid], name: name.slice(0, 80), s, a: [], ch });
  }
  async getThread(threadId: string): Promise<RemoteThread> { return threadOf((await this.call('getThread', { id: threadId })).thread); }
  async myThreads(): Promise<RemoteThread[]> { return list(await this.call('myThreads')).map(threadOf); }
  async orgThreads(): Promise<RemoteThread[]> { return list(await this.call('orgThreads')).map(threadOf); }
  async groupsOf(uid: string): Promise<Array<{ id: string; p: string[]; name: string }>> {
    return list(await this.call('groupsOf', { uid })).filter(isObj).map((g) => ({ id: String(g.id ?? ''), p: strList(g.p), name: String(g.name ?? '') }));
  }
  async addMember(threadId: string, uid: string): Promise<void> { await this.call('addMember', { id: threadId, uid }); }
  async removeMembers(threadId: string, uids: string[]): Promise<void> { await this.call('removeMembers', { id: threadId, uids }); }
  async leaveGroup(threadId: string): Promise<void> { await this.removeMembers(threadId, [this.o.uid]); }
  async setGroupMeta(threadId: string, m: { name?: string; s?: GroupSettings; a?: string[] }): Promise<void> {
    if (m.name === undefined && m.s === undefined && m.a === undefined) return;
    await this.call('setGroupMeta', { id: threadId, ...m });
  }
  async joinGroup(threadId: string, myName: string): Promise<string> {
    return String((await this.call('joinGroup', { id: threadId, name: myName })).lineId ?? '');
  }

  /* الرسائل */
  async sendMessage(threadId: string, m: OutgoingMessage): Promise<CreateResult> {
    const msg: Record<string, unknown> = { id: m.id, name: m.name, body: m.body, link: m.link };
    if (m.re) msg.re = m.re;
    if (m.men?.length) msg.men = m.men;
    if (m.tag) msg.tag = m.tag;
    if (m.ack) msg.ack = true;
    if (m.poll) msg.poll = { o: m.poll.o, m: m.poll.m } satisfies ChatPoll;
    return (await this.call('sendMessage', { chat: threadId, msg })).result === 'exists' ? 'exists' : 'created';
  }
  async getMessage(threadId: string, msgId: string): Promise<RemoteMessage> {
    return messageOf((await this.call('getMessage', { chat: threadId, id: msgId })).message);
  }
  async messagesSince(threadId: string, cursor: string | null, limit = 200, after: PageAfter | null = null): Promise<RemoteMessage[]> {
    return list(await this.call('messagesSince', { chat: threadId, cursor, limit, after })).map(messageOf);
  }
  async joinedPage(threadId: string, cursor: string, limit = 200, after: PageAfter | null = null): Promise<JoinedPage> {
    const r = await this.call('joinedPage', { chat: threadId, cursor, limit, after });
    return {
      msgs: list(r, 'msgs').map(messageOf), ids: typeof r.ids === 'number' ? r.ids : 0,
      lastTs: typeof r.lastTs === 'string' ? ts(r.lastTs) : null, lastId: typeof r.lastId === 'string' ? r.lastId : null,
    };
  }
  async editMessage(threadId: string, msgId: string, body: string, tag: ChatTag | null): Promise<number> {
    return Number((await this.call('editMessage', { chat: threadId, id: msgId, body, tag })).n ?? 0);
  }
  async editsOf(threadId: string, msgId: string): Promise<RemoteEdit[]> {
    return list(await this.call('editsOf', { chat: threadId, id: msgId })).filter(isObj)
      .map((e) => ({ n: Number(e.n), body: String(e.body ?? ''), tag: CHAT_TAGS.includes(e.tag as ChatTag) ? (e.tag as ChatTag) : null, at: ts(e.at) }))
      .sort((a, b) => a.n - b.n);
  }
  async anonymizeMine(label: string): Promise<number> { return Number((await this.call('anonymizeMine', { label })).count ?? 0); }

  /* حال المحادثة */
  async stateSince(threadId: string, cursor: string | null, limit = 300, after: PageAfter | null = null): Promise<RemoteState[]> {
    return list(await this.call('stateSince', { chat: threadId, cursor, limit, after })).map(stateOf);
  }
  async markReadUpTo(threadId: string, at: string): Promise<void> { await this.call('markRead', { chat: threadId, at }); }
  async setPin(threadId: string, msgId: string, on: boolean): Promise<void> { await this.call('setPin', { chat: threadId, id: msgId, on }); }
  async acknowledge(threadId: string, msgId: string): Promise<CreateResult> {
    return (await this.call('acknowledge', { chat: threadId, id: msgId })).result === 'exists' ? 'exists' : 'created';
  }
  async setTask(threadId: string, msgId: string, task: ChatTask): Promise<void> {
    await this.call('setTask', { chat: threadId, id: msgId, task: { title: task.title, as: task.as, due: task.due, done: task.done } });
  }
  async setTaskDone(threadId: string, msgId: string, done: boolean): Promise<void> { await this.call('setTaskDone', { chat: threadId, id: msgId, done }); }
  async cancelTask(threadId: string, msgId: string): Promise<void> { await this.call('cancelTask', { chat: threadId, id: msgId }); }
  async vote(threadId: string, msgId: string, options: number[]): Promise<void> { await this.call('vote', { chat: threadId, id: msgId, o: options }); }

  /* مراجعة المالك */
  async openReview(chatId: string, reason: string): Promise<string> { return String((await this.call('openReview', { chat: chatId, reason })).rid ?? ''); }
  async closeReview(chatId: string): Promise<void> { await this.call('closeReview', { chat: chatId }); }
  /** رسائل المحادثة كلها للمراجعة صفحةً صفحة بعد (الوقت، الرقم) · تُعرض ولا تُحفظ على الجهاز */
  async allMessages(threadId: string): Promise<RemoteMessage[]> {
    const out: RemoteMessage[] = [];
    let cursor: string | null = null;
    let after: PageAfter | null = null;
    for (let guard = 0; guard < 500; guard++) {
      const page = await this.messagesSince(threadId, cursor, 200, after);
      out.push(...page);
      if (page.length < 200) break;
      const last = page[page.length - 1];
      cursor = last.ts;
      after = { ts: last.ts, id: last.id };
    }
    return out;
  }

  /* نافذة الحذف والمسح (خصائص لا طرائق · حارس مناديها في index.ts) */
  readonly openDeletionWindow = async (): Promise<void> => { await this.call('openDeletionWindow'); };
  readonly closeDeletionWindow = async (): Promise<void> => { await this.call('closeDeletionWindow'); };
  readonly purgeAll = async (o: { keepDirectory?: boolean } = {}): Promise<number> =>
    Number((await this.call('purgeAll', { keepDirectory: o.keepDirectory === true })).count ?? 0);
}

/**
 * الناقل لكل جلسةٍ ومنشأة: رقمه من الجلسة، ورمزه من مزوّد الهوية (ChatSession.idToken يحمله اليوم) · يُمرَّر إلى setChatTransport عند
 * التحويل وحده
 */
export function serverChatTransport(client: ChatServerClient): ChatTransportFactory {
  return (s: ChatSession, org: string) => new ServerChatTransport({ client, org, uid: s.uid, accessToken: s.idToken });
}

/**
 * عميل المحادثة في Firestore عبر REST · مستقل عن عميل الصفوف (src/cloud/firestore.ts) ويستعمل ترميزه وحده.
 * الرسالة تُنشأ بشرط ألا تكون موجودة وبوقت الخادم (REQUEST_TIME)، فإعادة الإرسال بعد انقطاع لا تكررها.
 */
import { encodeFields, decodeFields, FirestoreHttpError } from '../cloud/firestore';

/** قيمة Firestore كما يفكّها العميل العام · بلا مسّ له */
type FsValue = Parameters<typeof decodeFields>[0][string];
import { CHAT_LINK_TYPES, CHAT_TAGS, OWNER_JOINED, channelSettings, normTs, type ChannelRef, type ChatKind, type ChatLink, type ChatPerson, type ChatPoll, type ChatTag, type ChatTask, type GroupSettings } from './types';
export { normTs } from './types';
import { uid as newId } from '../domain/ids';

export interface ChatRemoteOptions {
  projectId: string;
  org: string;
  uid: string;
  idToken: () => Promise<string>;
  /** للمحاكي في الاختبارات */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * المحادثة كما في الخادم · s إعدادات المجموعة، a مسؤولوها المعيَّنون، jt وقت انضمام من أُضيف بعد إنشائها
 * (قرار المالك 2026-10-08T05:31Z) · والأوائل وقت انضمامهم وقت إنشائها
 */
export interface RemoteThread {
  id: string; k: ChatKind; p: string[]; name: string; by: string; at: string | null;
  s?: GroupSettings; a?: string[]; jt?: Record<string, string>;
  /** القناة (الدفعة ٤) · null للمحادثة العادية */
  ch?: ChannelRef | null;
}
/** sys: سطر نظام لا رسالة · 'join' انضم المالك (قرار المالك 2026-10-08T04:11Z) */
export interface RemoteMessage {
  id: string; from: string; name: string; body: string; link: ChatLink | null; ts: string; sys?: string | null;
  /** الرد في سلسلة: رقم الرسالة الأصل · men الإشارات «u:رقم» و«s:قسم» (الدفعة ٢ · 2026-10-08T05:31Z) */
  re?: string | null; men?: string[];
  /** الدفعة ٣: الوسم، والإعلان المهم بتأكيد الاطلاع، وعدد تعديلاتها ووقت آخرها */
  tag?: ChatTag | null; ack?: boolean; ev?: number; et?: string | null;
  /** الدفعة ٥: الاستطلاع */
  poll?: ChatPoll | null;
}

/** ما قبل تعديلٍ في سجل الرسالة (الدفعة ٣) */
export interface RemoteEdit { n: number; body: string; tag: ChatTag | null; at: string }

/** حال المحادثة (st): التثبيت p_رقم وقراءة كل عضو r_رقمه · بوقت الخادم ts فتُسحب بمؤشر واحد */
export interface RemoteState {
  id: string; k: string; ts: string; on?: boolean; by?: string; at?: string; m?: string; n?: number;
  /** الدفعة ٥: المهمة (عنوانها ومسؤولها وموعدها وإنجازها) والصوت (أرقام خياراته) */
  title?: string; as?: string; due?: string; done?: boolean; o?: number[];
  /** المهمة ملغاة (قرار المالك 2026-10-08T10:24Z) */
  cx?: boolean;
}

const tail = (name: string) => name.slice(name.lastIndexOf('/') + 1);

function linkOf(v: unknown): ChatLink | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const type = String(o.type ?? '') as ChatLink['type'];
  if (!CHAT_LINK_TYPES.includes(type) || typeof o.id !== 'string') return null;
  return { type, id: o.id, label: String(o.label ?? '') };
}

function threadOf(doc: { name: string; fields: Record<string, FsValue> }): RemoteThread {
  const d = decodeFields(doc.fields);
  const jt: Record<string, string> = {};
  for (const [k, v] of Object.entries((d.jt && typeof d.jt === 'object' ? d.jt : {}) as Record<string, unknown>)) if (typeof v === 'string') jt[k] = normTs(v);
  return {
    id: tail(doc.name), k: d.k === 'group' ? 'group' : 'direct', p: Array.isArray(d.p) ? (d.p as string[]) : [],
    name: String(d.name ?? ''), by: String(d.by ?? ''), at: typeof d.at === 'string' ? normTs(d.at) : null,
    s: (d.s && typeof d.s === 'object' ? d.s : {}) as GroupSettings, a: Array.isArray(d.a) ? (d.a as string[]) : [], jt,
    ch: d.ch && typeof d.ch === 'object' ? (d.ch as ChannelRef) : null,
  };
}

function msgOf(doc: { name: string; fields: Record<string, FsValue> }): RemoteMessage {
  const d = decodeFields(doc.fields);
  return {
    id: tail(doc.name), from: String(d.from ?? ''), name: String(d.name ?? ''),
    body: String(d.body ?? ''), link: linkOf(d.link), ts: normTs(d.ts), sys: typeof d.sys === 'string' ? d.sys : null,
    re: typeof d.re === 'string' ? d.re : null,
    men: Array.isArray(d.men) ? (d.men as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    tag: CHAT_TAGS.includes(d.tag as ChatTag) ? (d.tag as ChatTag) : null,
    ack: d.ack === true, ev: typeof d.ev === 'number' ? d.ev : 0, et: typeof d.et === 'string' ? normTs(d.et) : null,
    poll: d.poll && typeof d.poll === 'object' && Array.isArray((d.poll as ChatPoll).o)
      ? { o: ((d.poll as ChatPoll).o as unknown[]).map(String), m: (d.poll as ChatPoll).m === true } : null,
  };
}


/** مسار حقلٍ في خريطة بمفتاحٍ قد يحوي أي حرف (رقم عضو) */
const mapKey = (field: string, key: string) => field + '.`' + key.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';

export class ChatRemote {
  private docsRoot: string;
  private root: string;
  private f: typeof fetch;

  constructor(private o: ChatRemoteOptions) {
    const base = (o.baseUrl ?? 'https://firestore.googleapis.com').replace(/\/$/, '');
    this.docsRoot = `projects/${o.projectId}/databases/(default)/documents`;
    this.root = `${base}/v1/${this.docsRoot}`;
    this.f = o.fetchImpl ?? fetch;
  }

  private orgPath(rel: string): string { return `orgs/${this.o.org}/${rel}`; }

  private async req(method: string, url: string, body?: unknown): Promise<unknown> {
    const token = await this.o.idToken();
    const res = await this.f(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new FirestoreHttpError(res.status, text);
    return text ? JSON.parse(text) : {};
  }

  /** إنشاء مستند لا يوجد · وما وُجد يُعدّ منشأً (إعادة بعد انقطاع) · ts بوقت الخادم إن طُلب */
  private async createOnce(rel: string, fields: Record<string, unknown>, serverTimeField?: string): Promise<'created' | 'exists'> {
    const write: Record<string, unknown> = {
      update: { name: `${this.docsRoot}/${rel}`, fields: encodeFields(fields) },
      currentDocument: { exists: false },
    };
    if (serverTimeField) write.updateTransforms = [{ fieldPath: serverTimeField, setToServerValue: 'REQUEST_TIME' }];
    try {
      await this.req('POST', `${this.root}:commit`, { writes: [write] });
      return 'created';
    } catch (e) {
      if (e instanceof FirestoreHttpError && (e.status === 409 || /ALREADY_EXISTS|FAILED_PRECONDITION/.test(e.message))) return 'exists';
      throw e;
    }
  }

  /* ─── المحادثات ─── */

  /** المجموعة بإعداداتها ومسؤوليها المعيَّنين عند الإنشاء (قرار المالك 2026-10-08T05:31Z) */
  async createThread(t: { id: string; k: ChatKind; p: string[]; name: string; s?: GroupSettings; a?: string[] }): Promise<'created' | 'exists'> {
    const fields: Record<string, unknown> = { k: t.k, p: t.p, name: t.name, by: this.o.uid };
    if (t.k === 'group') { fields.s = t.s ?? {}; fields.a = t.a ?? []; }
    return this.createOnce(this.orgPath(`chats/${t.id}`), fields, 'at');
  }

  /** قناة (الدفعة ٤) · للمالك وحده، وهو فيها، ويضم إليها الأعضاءُ أنفسَهم بصلاحيتهم */
  async createChannel(id: string, ch: ChannelRef, name: string): Promise<'created' | 'exists'> {
    return this.createOnce(this.orgPath(`chats/${id}`),
      { k: 'group', p: [this.o.uid], name: name.slice(0, 80), by: this.o.uid, s: channelSettings(ch), a: [], ch }, 'at');
  }

  /** أعضاء المنشأة وصلاحياتهم · للمالك (يضبط القنوات بها) */
  async members(): Promise<Array<{ uid: string; perm: Record<string, number>; all: boolean; props: string[] }>> {
    const out: Array<{ uid: string; perm: Record<string, number>; all: boolean; props: string[] }> = [];
    let page = '';
    for (let guard = 0; guard < 50; guard++) {
      const token = await this.o.idToken();
      const res = await this.f(`${this.root}/${this.orgPath('members')}?pageSize=300&mask.fieldPaths=perm&mask.fieldPaths=all&mask.fieldPaths=props${page ? '&pageToken=' + encodeURIComponent(page) : ''}`,
        { headers: { Authorization: 'Bearer ' + token } });
      const text = await res.text();
      if (!res.ok) throw new FirestoreHttpError(res.status, text);
      const j = (text ? JSON.parse(text) : {}) as { documents?: Array<{ name: string; fields?: Record<string, FsValue> }>; nextPageToken?: string };
      for (const doc of j.documents ?? []) {
        const f = decodeFields(doc.fields ?? {});
        out.push({ uid: tail(doc.name), perm: (f.perm && typeof f.perm === 'object' ? f.perm : {}) as Record<string, number>,
          all: f.all === true, props: Array.isArray(f.props) ? (f.props as string[]) : [] });
      }
      if (!j.nextPageToken) break;
      page = j.nextPageToken;
    }
    return out;
  }

  /** المحادثة كما في الخادم · لأطرافها والمالك */
  async getThread(threadId: string): Promise<RemoteThread> {
    const doc = (await this.req('GET', `${this.root}/${this.orgPath(`chats/${threadId}`)}`)) as { name: string; fields: Record<string, FsValue> };
    return threadOf(doc);
  }

  /** محادثاتي في المنشأة · مَن أنا من أطرافها */
  async myThreads(): Promise<RemoteThread[]> {
    const rows = (await this.req('POST', `${this.root}/orgs/${this.o.org}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: 'chats' }],
        where: { fieldFilter: { field: { fieldPath: 'p' }, op: 'ARRAY_CONTAINS', value: { stringValue: this.o.uid } } },
      },
    })) as Array<{ document?: { name: string; fields: Record<string, FsValue> } }>;
    return rows.filter((r) => r.document).map((r) => threadOf(r.document!));
  }

  /**
   * محادثات المنشأة كلها بأطرافها واسمها دون رسائلها · للمالك وحده (القواعد) · ليختار ما يراجعه أو ينضم إليه
   * عند طلبه وحده، لا في المزامنة (قرار المالك 2026-10-08T04:11Z)
   */
  async orgThreads(): Promise<RemoteThread[]> {
    const rows = (await this.req('POST', `${this.root}/orgs/${this.o.org}:runQuery`, {
      structuredQuery: { from: [{ collectionId: 'chats' }] },
    })) as Array<{ document?: { name: string; fields: Record<string, FsValue> } }>;
    return rows.filter((r) => r.document).map((r) => threadOf(r.document!));
  }

  /* ─── الرسائل ─── */

  /** كتابة الرسالة وفهرس رقمها بلا محتوى · في التزام واحد */
  private msgWrites(threadId: string, id: string, fields: Record<string, unknown>): unknown[] {
    const base = `${this.docsRoot}/${this.orgPath(`chats/${threadId}`)}`;
    return [
      {
        update: { name: `${base}/msgs/${id}`, fields: encodeFields(fields) },
        currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }],
      },
      { update: { name: `${base}/ids/${id}`, fields: {} }, currentDocument: { exists: false }, updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }] },
    ];
  }

  /**
   * الرسالة ومعها فهرس رقمها بلا محتوى (ids/{id}) في التزام واحد · المالك يسرد الفهرس ليحذف في نافذة الحذف
   * دون أن يقرأ الرسائل، فلا يقرؤها إلا أطرافها أو المالك بمراجعةٍ بسببها (قرار المالك 2026-10-08T04:11Z)
   */
  async sendMessage(threadId: string, m: {
    id: string; name: string; body: string; link: ChatLink | null; re?: string | null; men?: string[]; tag?: ChatTag | null; ack?: boolean;
    poll?: ChatPoll | null;
  }): Promise<'created' | 'exists'> {
    const fields: Record<string, unknown> = { from: this.o.uid, name: m.name, body: m.body, link: m.link, att: null };
    if (m.re) fields.re = m.re;
    if (m.men?.length) fields.men = m.men;
    if (m.tag) fields.tag = m.tag;
    if (m.ack) fields.ack = true;
    if (m.poll) fields.poll = { o: m.poll.o, m: m.poll.m };
    try {
      await this.req('POST', `${this.root}:commit`, { writes: this.msgWrites(threadId, m.id, fields) });
      return 'created';
    } catch (e) {
      if (e instanceof FirestoreHttpError && (e.status === 409 || /ALREADY_EXISTS|FAILED_PRECONDITION/.test(e.message))) return 'exists';
      throw e;
    }
  }

  /** سطر «انضم المالك» وحده · القواعد لا تقبله إلا مع انضمامه في الالتزام نفسه (joinGroup) */
  async sendSystemLine(threadId: string, id: string, myName: string): Promise<void> {
    await this.req('POST', `${this.root}:commit`, {
      writes: this.msgWrites(threadId, id, { from: this.o.uid, name: myName, body: OWNER_JOINED, link: null, att: null, sys: 'join' }),
    });
  }

  /**
   * انضمام المالك إلى مجموعة ليس فيها · ومعه سطر «انضم المالك» للأعضاء في الالتزام نفسه (قرار المالك 2026-10-08T04:11Z)
   */
  async joinGroup(threadId: string, myName: string): Promise<string> {
    const id = 'j_' + newId();
    await this.req('POST', `${this.root}:commit`, {
      writes: [
        this.addWrite(threadId, this.o.uid, { jm: id }),
        ...this.msgWrites(threadId, id, { from: this.o.uid, name: myName, body: OWNER_JOINED, link: null, att: null, sys: 'join' }),
      ],
    });
    return id;
  }

  /**
   * إضافة عضو واحد · بوقت انضمامه من الخادم (jt) ورقمه في la · فالخادم يفرض «من لحظة انضمامه» بوقتٍ لا يضعه الجهاز
   */
  private addWrite(threadId: string, uid: string, extra: Record<string, unknown> = {}): unknown {
    const fields = { la: uid, ...extra };
    return {
      update: { name: `${this.docsRoot}/${this.orgPath(`chats/${threadId}`)}`, fields: encodeFields(fields) },
      updateMask: { fieldPaths: Object.keys(fields) },
      currentDocument: { exists: true },
      updateTransforms: [
        { fieldPath: 'p', appendMissingElements: { values: [{ stringValue: uid }] } },
        { fieldPath: mapKey('jt', uid), setToServerValue: 'REQUEST_TIME' },
      ],
    };
  }

  async addMember(threadId: string, uid: string): Promise<void> {
    await this.req('POST', `${this.root}:commit`, { writes: [this.addWrite(threadId, uid)] });
  }

  /** إزالة أعضاء ومعها خروجهم من المسؤولين · للمالك والمنشئ (#19) · ولصاحبه وحده بالمغادرة */
  async removeMembers(threadId: string, uids: string[]): Promise<void> {
    const values = uids.map((u) => ({ stringValue: u }));
    await this.req('POST', `${this.root}:commit`, {
      writes: [{
        update: { name: `${this.docsRoot}/${this.orgPath(`chats/${threadId}`)}`, fields: {} },
        updateMask: { fieldPaths: [] },
        currentDocument: { exists: true },
        updateTransforms: [
          { fieldPath: 'p', removeAllFromArray: { values } },
          { fieldPath: 'a', removeAllFromArray: { values } },
        ],
      }],
    });
  }

  /** الاسم والإعدادات (للمسؤولين) وتعيين المسؤولين (للمالك والمنشئ) · ما يُمرَّر وحده */
  async setGroupMeta(threadId: string, m: { name?: string; s?: GroupSettings; a?: string[] }): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (m.name !== undefined) fields.name = m.name;
    if (m.s !== undefined) fields.s = m.s;
    if (m.a !== undefined) fields.a = m.a;
    if (!Object.keys(fields).length) return;
    await this.req('POST', `${this.root}:commit`, {
      writes: [{
        update: { name: `${this.docsRoot}/${this.orgPath(`chats/${threadId}`)}`, fields: encodeFields(fields) },
        updateMask: { fieldPaths: Object.keys(fields) },
        currentDocument: { exists: true },
      }],
    });
  }

  /* ─── حال المحادثة: التثبيت والقراءة (الدفعة ٢ · 2026-10-08T05:31Z) ─── */

  private stWrite(threadId: string, sid: string, fields: Record<string, unknown>, raw: Record<string, FsValue> = {}): unknown {
    return {
      update: { name: `${this.docsRoot}/${this.orgPath(`chats/${threadId}/st/${sid}`)}`, fields: { ...encodeFields(fields), ...raw } },
      updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }],
    };
  }

  /** تثبيت رسالة أو إلغاؤه · في المجموعة لمسؤوليها، وفي الفردية لطرفيها (القواعد) */
  async setPin(threadId: string, msgId: string, on: boolean): Promise<void> {
    await this.req('POST', `${this.root}:commit`, { writes: [this.stWrite(threadId, 'p_' + msgId, { k: 'pin', on, by: this.o.uid })] });
  }

  /** قرأتُ حتى وقت رسالةٍ في الخادم · كلٌّ يكتب قراءته وحده */
  async markReadUpTo(threadId: string, at: string): Promise<void> {
    await this.req('POST', `${this.root}:commit`, {
      writes: [this.stWrite(threadId, 'r_' + this.o.uid, { k: 'read' }, { at: { timestampValue: at } as FsValue })],
    });
  }

  /** حال المحادثة بعد مؤشر وقت الخادم · بلا محتوى رسائل */
  async stateSince(threadId: string, cursor: string | null, limit = 300): Promise<RemoteState[]> {
    const where = cursor
      ? { fieldFilter: { field: { fieldPath: 'ts' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: cursor } } }
      : undefined;
    const rows = (await this.req('POST', `${this.root}/orgs/${this.o.org}/chats/${threadId}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: 'st' }],
        ...(where ? { where } : {}),
        orderBy: [{ field: { fieldPath: 'ts' }, direction: 'ASCENDING' }],
        limit,
      },
    })) as Array<{ document?: { name: string; fields: Record<string, FsValue> } }>;
    return rows.filter((r) => r.document).map((r) => {
      const d = decodeFields(r.document!.fields);
      return {
        id: tail(r.document!.name), k: String(d.k ?? ''), ts: normTs(d.ts),
        ...(typeof d.on === 'boolean' ? { on: d.on } : {}), ...(typeof d.by === 'string' ? { by: d.by } : {}),
        ...(typeof d.at === 'string' ? { at: normTs(d.at) } : {}),
        ...(typeof d.m === 'string' ? { m: d.m } : {}), ...(typeof d.n === 'number' ? { n: d.n } : {}),
        ...(typeof d.title === 'string' ? { title: d.title } : {}), ...(typeof d.as === 'string' ? { as: d.as } : {}),
        ...(typeof d.due === 'string' ? { due: d.due } : {}), ...(typeof d.done === 'boolean' ? { done: d.done } : {}),
        ...(Array.isArray(d.o) ? { o: (d.o as unknown[]).map(Number) } : {}),
        ...(typeof d.cx === 'boolean' ? { cx: d.cx } : {}),
      };
    });
  }

  /* ─── الدفعة ٣ (2026-10-08T05:31Z): تأكيد الاطلاع، وتعديل الرسالة بسجلها ─── */

  /** تأكيد الاطلاع على إعلان مهم · كلٌّ وحده مرة · لرسالةٍ تطلبه */
  async acknowledge(threadId: string, msgId: string): Promise<'created' | 'exists'> {
    try {
      await this.req('POST', `${this.root}:commit`, {
      writes: [{
        update: { name: `${this.docsRoot}/${this.orgPath(`chats/${threadId}/st/a_${msgId}_${this.o.uid}`)}`, fields: encodeFields({ k: 'ack', m: msgId, by: this.o.uid }) },
        currentDocument: { exists: false },
        updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }],
      }],
      });
      return 'created';
    } catch (e) {
      if (e instanceof FirestoreHttpError && (e.status === 409 || /ALREADY_EXISTS|FAILED_PRECONDITION/.test(e.message))) return 'exists';
      throw e;
    }
  }

  /**
   * تعديل رسالتي · في التزام واحد: النص الجديد ورقم التعديل ووقته، وما قبله في سجلها (edits/رقم)، ورقمه في فهرسها
   * (فالمسح يحذف السجل بالأرقام دون قراءته)، وإشارةٌ في حال المحادثة يسحبها الأطراف · والحذف ممنوع كما قُرّر
   */
  async editMessage(threadId: string, msgId: string, body: string, tag: ChatTag | null): Promise<number> {
    const base = `${this.docsRoot}/${this.orgPath(`chats/${threadId}`)}`;
    const cur = msgOf((await this.req('GET', `${this.root}/${this.orgPath(`chats/${threadId}/msgs/${msgId}`)}`)) as { name: string; fields: Record<string, FsValue> });
    const n = (cur.ev ?? 0) + 1;
    await this.req('POST', `${this.root}:commit`, {
      writes: [
        {
          update: { name: `${base}/msgs/${msgId}`, fields: encodeFields({ body, tag, ev: n }) },
          updateMask: { fieldPaths: ['body', 'tag', 'ev'] },
          currentDocument: { exists: true },
          updateTransforms: [{ fieldPath: 'et', setToServerValue: 'REQUEST_TIME' }],
        },
        {
          update: { name: `${base}/msgs/${msgId}/edits/${n}`, fields: encodeFields({ body: cur.body, tag: cur.tag ?? null }) },
          currentDocument: { exists: false },
          updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
        },
        { update: { name: `${base}/ids/${msgId}`, fields: encodeFields({ ev: n }) }, updateMask: { fieldPaths: ['ev'] }, currentDocument: { exists: true } },
        this.stWrite(threadId, 'x_' + msgId, { k: 'edit', m: msgId, n }),
      ],
    });
    return n;
  }

  /** سجل تعديلات رسالة · ما قبل كل تعديل */
  async editsOf(threadId: string, msgId: string): Promise<RemoteEdit[]> {
    const token = await this.o.idToken();
    const res = await this.f(`${this.root}/${this.orgPath(`chats/${threadId}/msgs/${msgId}/edits`)}?pageSize=300`, { headers: { Authorization: 'Bearer ' + token } });
    const text = await res.text();
    if (!res.ok) throw new FirestoreHttpError(res.status, text);
    return (((text ? JSON.parse(text) : {}).documents ?? []) as Array<{ name: string; fields: Record<string, FsValue> }>).map((x) => {
      const d = decodeFields(x.fields);
      return { n: Number(tail(x.name)), body: String(d.body ?? ''), tag: CHAT_TAGS.includes(d.tag as ChatTag) ? (d.tag as ChatTag) : null, at: normTs(d.at) };
    }).sort((a, b) => a.n - b.n);
  }

  /* ─── الدفعة ٥ (2026-10-08T05:31Z): المهمة من رسالة، والتصويت ─── */

  /**
   * المهمة من رسالة (st/t_رقمها) · ينشئها من يرسل، ويعدّلها منشئها، وينجزها مسؤولها · ومنشئها يبقى كما هو
   */
  async setTask(threadId: string, msgId: string, task: ChatTask): Promise<void> {
    const sid = 't_' + msgId;
    let by = this.o.uid;
    let done = task.done;
    try {
      const cur = (await this.req('GET', `${this.root}/${this.orgPath(`chats/${threadId}/st/${sid}`)}`)) as { fields?: Record<string, FsValue> };
      const d = decodeFields(cur.fields ?? {});
      if (typeof d.by === 'string') by = d.by;
      // إنجازها كما في الخادم: تعديل المنشئ لا يرجع ما أنجزه المسؤول
      if (typeof d.done === 'boolean') done = d.done;
    } catch (e) { if (!(e instanceof FirestoreHttpError && e.status === 404)) throw e; }
    await this.req('POST', `${this.root}:commit`, {
      writes: [this.stWrite(threadId, sid, { k: 'task', m: msgId, title: task.title, as: task.as, due: task.due, done, by })],
    });
  }

  /** إلغاء المهمة · لمنشئها وحده · فتبقى بحالة «ملغاة» لا تُعدَّل ولا تُنجز ولا تُعاد (قرار المالك 2026-10-08T10:24Z) */
  async cancelTask(threadId: string, msgId: string): Promise<void> {
    await this.req('POST', `${this.root}:commit`, {
      writes: [{
        update: { name: `${this.docsRoot}/${this.orgPath(`chats/${threadId}/st/t_${msgId}`)}`, fields: encodeFields({ cx: true }) },
        updateMask: { fieldPaths: ['cx'] },
        currentDocument: { exists: true },
        updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }],
      }],
    });
  }

  /** إنجاز المهمة أو إعادة فتحها · يكتب الإنجاز وحده، فلا تُرجع نسخةٌ قديمة غيره */
  async setTaskDone(threadId: string, msgId: string, done: boolean): Promise<void> {
    await this.req('POST', `${this.root}:commit`, {
      writes: [{
        update: { name: `${this.docsRoot}/${this.orgPath(`chats/${threadId}/st/t_${msgId}`)}`, fields: encodeFields({ done }) },
        updateMask: { fieldPaths: ['done'] },
        currentDocument: { exists: true },
        updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }],
      }],
    });
  }

  /** صوتي في استطلاع · أرقام خياراتي · ويُغيَّر */
  async vote(threadId: string, msgId: string, options: number[]): Promise<void> {
    await this.req('POST', `${this.root}:commit`, {
      writes: [this.stWrite(threadId, `v_${msgId}_${this.o.uid}`, { k: 'vote', m: msgId, by: this.o.uid, o: options })],
    });
  }

  /** رسالة واحدة · لتحديث ما عُدِّل منها */
  async getMessage(threadId: string, msgId: string): Promise<RemoteMessage> {
    return msgOf((await this.req('GET', `${this.root}/${this.orgPath(`chats/${threadId}/msgs/${msgId}`)}`)) as { name: string; fields: Record<string, FsValue> });
  }

  /* ─── مراجعة المالك محادثةً بسبب (قرار المالك 2026-10-08T04:11Z) ─── */

  /**
   * سجلٌّ جديد بالمحادثة والسبب والمراجِع ووقت الخادم، ومعه فتح المراجعة في الالتزام نفسه ·
   * القواعد لا تجيز قراءة رسائلها للمالك إلا بها، ولا تفتحها بسجلٍّ سابق
   */
  async openReview(chatId: string, reason: string): Promise<string> {
    const rid = newId();
    await this.req('POST', `${this.root}:commit`, {
      writes: [
        {
          update: { name: `${this.docsRoot}/${this.orgPath(`chatReviews/${rid}`)}`, fields: encodeFields({ chat: chatId, reason, by: this.o.uid }) },
          currentDocument: { exists: false },
          updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
        },
        {
          update: { name: `${this.docsRoot}/${this.orgPath(`chatReviewOpen/${chatId}`)}`, fields: encodeFields({ rid }) },
          updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
        },
      ],
    });
    return rid;
  }

  /** إغلاق المحادثة ينهي المراجعة */
  async closeReview(chatId: string): Promise<void> {
    await this.deleteIn(`chatReviewOpen/${chatId}`);
  }

  /** رسائل المحادثة كلها للمراجعة · تُعرض ولا تُحفظ على الجهاز */
  async allMessages(threadId: string): Promise<RemoteMessage[]> {
    const out: RemoteMessage[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let guard = 0; guard < 50; guard++) {
      const page = await this.messagesSince(threadId, cursor, 200);
      for (const m of page) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
      if (page.length < 200) break;
      const last = page[page.length - 1].ts;
      if (last === cursor) break;
      cursor = last;
    }
    return out;
  }

  /**
   * رسائل مجموعة «من لحظة انضمامه» بعد مؤشر لا يسبق انضمامه: أرقامها من ids (بلا محتوى) ثم الرسائل رسالةً رسالة ·
   * فالخادم يفرض على كل رسالة أنها بعد انضمامه (قرار المالك 2026-10-08T05:31Z)
   */
  async messagesSinceJoined(threadId: string, cursor: string, limit = 200): Promise<RemoteMessage[]> {
    return (await this.joinedPage(threadId, cursor, limit)).msgs;
  }

  /** صفحة «من لحظة انضمامه»: الرسائل وعدد الأرقام التي جاءت بها (فالصفحة تُعدّ بالأرقام) */
  async joinedPage(threadId: string, cursor: string, limit = 200): Promise<{ msgs: RemoteMessage[]; ids: number; lastTs: string | null }> {
    const rows = (await this.req('POST', `${this.root}/orgs/${this.o.org}/chats/${threadId}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: 'ids' }],
        where: { fieldFilter: { field: { fieldPath: 'ts' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: cursor } } },
        orderBy: [{ field: { fieldPath: 'ts' }, direction: 'ASCENDING' }],
        limit,
      },
    })) as Array<{ document?: { name: string } }>;
    const docs = rows.filter((r) => r.document) as Array<{ document: { name: string; fields?: Record<string, FsValue> } }>;
    const names = docs.map((r) => r.document.name.replace('/ids/', '/msgs/'));
    if (!names.length) return { msgs: [], ids: 0, lastTs: null };
    const lastTs = normTs(decodeFields(docs[docs.length - 1].document.fields ?? {}).ts) || null;
    const got = (await this.req('POST', `${this.root}:batchGet`, { documents: names })) as Array<{ found?: { name: string; fields: Record<string, FsValue> } }>;
    const msgs = got.filter((g) => g.found).map((g) => msgOf(g.found!))
      .sort((a, b) => (normTs(a.ts) < normTs(b.ts) ? -1 : normTs(a.ts) > normTs(b.ts) ? 1 : 0));
    return { msgs, ids: names.length, lastTs };
  }

  /** رسائل محادثة بعد مؤشر وقت الخادم · بترتيبه */
  async messagesSince(threadId: string, cursor: string | null, limit = 200): Promise<RemoteMessage[]> {
    const where = cursor
      ? { fieldFilter: { field: { fieldPath: 'ts' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: cursor } } }
      : undefined;
    const rows = (await this.req('POST', `${this.root}/orgs/${this.o.org}/chats/${threadId}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: 'msgs' }],
        ...(where ? { where } : {}),
        orderBy: [{ field: { fieldPath: 'ts' }, direction: 'ASCENDING' }],
        limit,
      },
    })) as Array<{ document?: { name: string; fields: Record<string, FsValue> } }>;
    return rows.filter((r) => r.document).map((r) => msgOf(r.document!));
  }

  /* ─── تعديل المجموعة والحذف (قرارات المالك 2026-10-07 على مراجعة المحادثة) ─── */

  /**
   * أعضاء المجموعة واسمها كما يُراد · الاسم، ثم الإزالة، ثم الإضافة عضواً عضواً (كلٌّ بوقت انضمامه) · #19
   */
  async updateGroup(threadId: string, p: string[], name: string): Promise<void> {
    const cur = await this.getThread(threadId);
    const want = new Set(p.filter(Boolean));
    if (name !== cur.name) await this.setGroupMeta(threadId, { name });
    const gone = cur.p.filter((u) => !want.has(u));
    if (gone.length) await this.removeMembers(threadId, gone);
    for (const u of want) if (!cur.p.includes(u)) await this.addMember(threadId, u);
  }

  /** العضو يُخرج نفسه من مجموعة (مغادرة المنشأة) · القواعد تجيز إخراج نفسه وحده */
  async leaveGroup(threadId: string): Promise<void> {
    await this.removeMembers(threadId, [this.o.uid]);
  }

  /** مجموعات المنشأة التي فيها عضو · للمالك · #19 */
  async groupsOf(uid: string): Promise<Array<{ id: string; p: string[]; name: string }>> {
    const rows = (await this.req('POST', `${this.root}/orgs/${this.o.org}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: 'chats' }],
        where: { fieldFilter: { field: { fieldPath: 'p' }, op: 'ARRAY_CONTAINS', value: { stringValue: uid } } },
      },
    })) as Array<{ document?: { name: string; fields: Record<string, FsValue> } }>;
    const out: Array<{ id: string; p: string[]; name: string }> = [];
    for (const r of rows) {
      if (!r.document) continue;
      const d = decodeFields(r.document.fields);
      if (d.k !== 'group') continue;
      out.push({ id: tail(r.document.name), p: Array.isArray(d.p) ? (d.p as string[]) : [], name: String(d.name ?? '') });
    }
    return out;
  }

  /** العضو يحذف حسابه: اسمه في رسائله «عضو سابق» · رسائله وحده (القواعد) · #2 */
  async anonymizeMine(label: string): Promise<number> {
    let n = 0;
    for (const t of await this.myThreads()) {
      // رسائله هو في كل مجموعة، ولو كان سجلها «من لحظة انضمامه» (القواعد تجيز له رسائله دائماً)
      const rows = (await this.req('POST', `${this.root}/orgs/${this.o.org}/chats/${t.id}:runQuery`, {
        structuredQuery: {
          from: [{ collectionId: 'msgs' }],
          where: { fieldFilter: { field: { fieldPath: 'from' }, op: 'EQUAL', value: { stringValue: this.o.uid } } },
        },
      })) as Array<{ document?: { name: string } }>;
      const names = rows.filter((r) => r.document).map((r) => r.document!.name);
      for (let i = 0; i < names.length; i += 200) {
        await this.req('POST', `${this.root}:commit`, {
          writes: names.slice(i, i + 200).map((name) => ({
            update: { name, fields: encodeFields({ name: label }) }, updateMask: { fieldPaths: ['name'] }, currentDocument: { exists: true },
          })),
        });
        n += Math.min(200, names.length - i);
      }
    }
    return n;
  }

  /** نافذة الحذف بوقت الخادم (meta/deletion) · لساعة · للمالك */
  async openDeletionWindow(): Promise<void> {
    await this.req('POST', `${this.root}:commit`, {
      writes: [{ update: { name: `${this.docsRoot}/${this.orgPath('meta/deletion')}`, fields: {} }, updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }] }],
    });
  }
  async closeDeletionWindow(): Promise<void> {
    await this.deleteIn('meta/deletion');
  }

  /** حذف مستند في المنشأة (دليل أو إشراف) */
  async deleteIn(rel: string): Promise<void> {
    await this.req('POST', `${this.root}:commit`, { writes: [{ delete: `${this.docsRoot}/${this.orgPath(rel)}` }] });
  }

  /**
   * محادثات المنشأة كلها ورسائلها ودليلها وإشرافها · للمالك في نافذة الحذف (meta/deletion بوقت الخادم) ·
   * «حذف حسابي» للمالك (#2) و«مسح كل البيانات» (#28)
   */
  async purgeAll(o: { keepDirectory?: boolean } = {}): Promise<number> {
    const list = async (rel: string): Promise<string[]> => {
      const token = await this.o.idToken();
      const res = await this.f(`${this.root}/${rel}?pageSize=300&mask.fieldPaths=k`, { headers: { Authorization: 'Bearer ' + token } });
      const text = await res.text();
      if (!res.ok) throw new FirestoreHttpError(res.status, text);
      return ((text ? JSON.parse(text) : {}).documents ?? []).map((d: { name: string }) => d.name);
    };
    // أرقام الرسائل ومعها عدد تعديلاتها (ev) · بلا محتوى
    const listEv = async (rel: string): Promise<Array<{ name: string; ev: number }>> => {
      const token = await this.o.idToken();
      const res = await this.f(`${this.root}/${rel}?pageSize=300&mask.fieldPaths=ev`, { headers: { Authorization: 'Bearer ' + token } });
      const text = await res.text();
      if (!res.ok) throw new FirestoreHttpError(res.status, text);
      return (((text ? JSON.parse(text) : {}).documents ?? []) as Array<{ name: string; fields?: Record<string, FsValue> }>)
        .map((d) => ({ name: d.name, ev: Number(decodeFields(d.fields ?? {}).ev ?? 0) || 0 }));
    };
    const del = async (names: string[]) => {
      for (let i = 0; i < names.length; i += 300) {
        await this.req('POST', `${this.root}:commit`, { writes: names.slice(i, i + 300).map((name) => ({ delete: name })) });
      }
    };
    let n = 0;
    for (;;) {
      const chats = await list(this.orgPath('chats'));
      if (!chats.length) break;
      for (const c of chats) {
        const rel = c.slice(c.indexOf('/documents/') + '/documents/'.length);
        for (;;) {
          const st = await list(`${rel}/st`);
          if (!st.length) break;
          await del(st);
        }
        for (;;) {
          const ids = await listEv(`${rel}/ids`);
          if (!ids.length) break;
          // الرسالة وسجل تعديلاتها وفهرسها معاً · بالأسماء دون قراءة محتوى (المالك لا يقرأ إلا بمراجعة بسببها)
          await del(ids.flatMap(({ name, ev }) => {
            const msg = name.replace('/ids/', '/msgs/');
            return [...Array.from({ length: ev }, (_, i) => `${msg}/edits/${i + 1}`), msg, name];
          }));
          n += ids.length;
        }
      }
      await del(chats);
    }
    // وسجل المراجعات والمفتوح منها مع المحادثة · والدليل والإشراف إلا في المسح
    for (const sub of ['chatReviewOpen', 'chatReviews', ...(o.keepDirectory ? [] : ['chatDir', 'chatRoles'])]) {
      for (;;) {
        const docs = await list(this.orgPath(sub));
        if (!docs.length) break;
        await del(docs);
      }
    }
    return n;
  }

  /* ─── الدليل والإشراف ─── */

  /** يكتب العضو اسمه في الدليل · وإشرافه كما سجّله المالك (القواعد تطابقه بمستند الإشراف) */
  async putMyDirectory(name: string, sup: string[]): Promise<void> {
    await this.req('POST', `${this.root}:commit`, {
      writes: [{
        update: { name: `${this.docsRoot}/${this.orgPath(`chatDir/${this.o.uid}`)}`, fields: encodeFields({ name, sup }) },
        updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
      }],
    });
  }

  async directory(): Promise<ChatPerson[]> {
    const out: ChatPerson[] = [];
    let page = '';
    for (let guard = 0; guard < 100; guard++) {
      const token = await this.o.idToken();
      const res = await this.f(`${this.root}/${this.orgPath('chatDir')}?pageSize=300${page ? '&pageToken=' + encodeURIComponent(page) : ''}`, { headers: { Authorization: 'Bearer ' + token } });
      const text = await res.text();
      if (!res.ok) throw new FirestoreHttpError(res.status, text);
      const j = (text ? JSON.parse(text) : {}) as { documents?: Array<{ name: string; fields?: Record<string, FsValue> }>; nextPageToken?: string };
      for (const d of j.documents ?? []) {
        const f = decodeFields(d.fields ?? {});
        out.push({ uid: tail(d.name), name: String(f.name ?? ''), sup: Array.isArray(f.sup) ? (f.sup as string[]) : [] });
      }
      if (!j.nextPageToken) break;
      page = j.nextPageToken;
    }
    return out;
  }

  /** إشراف عضو بإيميله · يكتبه المالك عند الدعوة أو التعديل */
  async setRole(email: string, sup: string[]): Promise<void> {
    await this.req('POST', `${this.root}:commit`, {
      writes: [{ update: { name: `${this.docsRoot}/${this.orgPath(`chatRoles/${email.trim().toLowerCase()}`)}`, fields: encodeFields({ sup }) } }],
    });
  }

  async role(email: string): Promise<string[]> {
    const token = await this.o.idToken();
    const res = await this.f(`${this.root}/${this.orgPath(`chatRoles/${email.trim().toLowerCase()}`)}`, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 404) return [];
    const text = await res.text();
    if (!res.ok) throw new FirestoreHttpError(res.status, text);
    const f = decodeFields((JSON.parse(text) as { fields?: Record<string, FsValue> }).fields ?? {});
    return Array.isArray(f.sup) ? (f.sup as string[]) : [];
  }
}

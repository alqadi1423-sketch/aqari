/**
 * عميل المحادثة في Firestore عبر REST · مستقل عن عميل الصفوف (src/cloud/firestore.ts) ويستعمل ترميزه وحده.
 * الرسالة تُنشأ بشرط ألا تكون موجودة وبوقت الخادم (REQUEST_TIME)، فإعادة الإرسال بعد انقطاع لا تكررها.
 */
import { encodeFields, decodeFields, FirestoreHttpError } from '../cloud/firestore';

/** قيمة Firestore كما يفكّها العميل العام · بلا مسّ له */
type FsValue = Parameters<typeof decodeFields>[0][string];
import { CHAT_LINK_TYPES, OWNER_JOINED, type ChatKind, type ChatLink, type ChatPerson, type GroupSettings } from './types';
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
}
/** sys: سطر نظام لا رسالة · 'join' انضم المالك (قرار المالك 2026-10-08T04:11Z) */
export interface RemoteMessage { id: string; from: string; name: string; body: string; link: ChatLink | null; ts: string; sys?: string | null }

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
  for (const [k, v] of Object.entries((d.jt && typeof d.jt === 'object' ? d.jt : {}) as Record<string, unknown>)) if (typeof v === 'string') jt[k] = v;
  return {
    id: tail(doc.name), k: d.k === 'group' ? 'group' : 'direct', p: Array.isArray(d.p) ? (d.p as string[]) : [],
    name: String(d.name ?? ''), by: String(d.by ?? ''), at: typeof d.at === 'string' ? d.at : null,
    s: (d.s && typeof d.s === 'object' ? d.s : {}) as GroupSettings, a: Array.isArray(d.a) ? (d.a as string[]) : [], jt,
  };
}

function msgOf(doc: { name: string; fields: Record<string, FsValue> }): RemoteMessage {
  const d = decodeFields(doc.fields);
  return {
    id: tail(doc.name), from: String(d.from ?? ''), name: String(d.name ?? ''),
    body: String(d.body ?? ''), link: linkOf(d.link), ts: String(d.ts ?? ''), sys: typeof d.sys === 'string' ? d.sys : null,
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
  async sendMessage(threadId: string, m: { id: string; name: string; body: string; link: ChatLink | null }): Promise<'created' | 'exists'> {
    try {
      await this.req('POST', `${this.root}:commit`, {
        writes: this.msgWrites(threadId, m.id, { from: this.o.uid, name: m.name, body: m.body, link: m.link, att: null }),
      });
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
    const lastTs = String(decodeFields(docs[docs.length - 1].document.fields ?? {}).ts ?? '') || null;
    const got = (await this.req('POST', `${this.root}:batchGet`, { documents: names })) as Array<{ found?: { name: string; fields: Record<string, FsValue> } }>;
    const msgs = got.filter((g) => g.found).map((g) => msgOf(g.found!))
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
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
          const ids = await list(`${rel}/ids`);
          if (!ids.length) break;
          // الرسالة وفهرسها معاً · بالأسماء دون قراءة محتوى (المالك لا يقرأ إلا بمراجعة بسببها)
          await del(ids.flatMap((x) => [x.replace('/ids/', '/msgs/'), x]));
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

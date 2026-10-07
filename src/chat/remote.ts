/**
 * عميل المحادثة في Firestore عبر REST · مستقل عن عميل الصفوف (src/cloud/firestore.ts) ويستعمل ترميزه وحده.
 * الرسالة تُنشأ بشرط ألا تكون موجودة وبوقت الخادم (REQUEST_TIME)، فإعادة الإرسال بعد انقطاع لا تكررها.
 */
import { encodeFields, decodeFields, FirestoreHttpError } from '../cloud/firestore';

/** قيمة Firestore كما يفكّها العميل العام · بلا مسّ له */
type FsValue = Parameters<typeof decodeFields>[0][string];
import { CHAT_LINK_TYPES, type ChatKind, type ChatLink, type ChatPerson } from './types';

export interface ChatRemoteOptions {
  projectId: string;
  org: string;
  uid: string;
  idToken: () => Promise<string>;
  /** للمحاكي في الاختبارات */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface RemoteThread { id: string; k: ChatKind; p: string[]; name: string; by: string; at: string | null }
export interface RemoteMessage { id: string; from: string; name: string; body: string; link: ChatLink | null; ts: string }

const tail = (name: string) => name.slice(name.lastIndexOf('/') + 1);

function linkOf(v: unknown): ChatLink | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const type = String(o.type ?? '') as ChatLink['type'];
  if (!CHAT_LINK_TYPES.includes(type) || typeof o.id !== 'string') return null;
  return { type, id: o.id, label: String(o.label ?? '') };
}

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

  async createThread(t: { id: string; k: ChatKind; p: string[]; name: string }): Promise<'created' | 'exists'> {
    return this.createOnce(this.orgPath(`chats/${t.id}`), { k: t.k, p: t.p, name: t.name, by: this.o.uid }, 'at');
  }

  /** محادثاتي في المنشأة · مَن أنا من أطرافها */
  async myThreads(): Promise<RemoteThread[]> {
    const rows = (await this.req('POST', `${this.root}/orgs/${this.o.org}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: 'chats' }],
        where: { fieldFilter: { field: { fieldPath: 'p' }, op: 'ARRAY_CONTAINS', value: { stringValue: this.o.uid } } },
      },
    })) as Array<{ document?: { name: string; fields: Record<string, FsValue> } }>;
    const out: RemoteThread[] = [];
    for (const r of rows) {
      if (!r.document) continue;
      const d = decodeFields(r.document.fields);
      const k = d.k === 'group' ? 'group' : 'direct';
      out.push({
        id: tail(r.document.name), k, p: Array.isArray(d.p) ? (d.p as string[]) : [],
        name: String(d.name ?? ''), by: String(d.by ?? ''), at: typeof d.at === 'string' ? d.at : null,
      });
    }
    return out;
  }

  /* ─── الرسائل ─── */

  async sendMessage(threadId: string, m: { id: string; name: string; body: string; link: ChatLink | null }): Promise<'created' | 'exists'> {
    return this.createOnce(this.orgPath(`chats/${threadId}/msgs/${m.id}`), {
      from: this.o.uid, name: m.name, body: m.body, link: m.link, att: null,
    }, 'ts');
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
    const out: RemoteMessage[] = [];
    for (const r of rows) {
      if (!r.document) continue;
      const d = decodeFields(r.document.fields);
      out.push({
        id: tail(r.document.name), from: String(d.from ?? ''), name: String(d.name ?? ''),
        body: String(d.body ?? ''), link: linkOf(d.link), ts: String(d.ts ?? ''),
      });
    }
    return out;
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
    const token = await this.o.idToken();
    const res = await this.f(`${this.root}/${this.orgPath('chatDir')}?pageSize=300`, { headers: { Authorization: 'Bearer ' + token } });
    const text = await res.text();
    if (!res.ok) throw new FirestoreHttpError(res.status, text);
    const docs = ((text ? JSON.parse(text) : {}).documents ?? []) as Array<{ name: string; fields?: Record<string, FsValue> }>;
    return docs.map((d) => {
      const f = decodeFields(d.fields ?? {});
      return { uid: tail(d.name), name: String(f.name ?? ''), sup: Array.isArray(f.sup) ? (f.sup as string[]) : [] };
    });
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

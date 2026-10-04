/**
 * عميل Firestore عبر REST · بلا حزمة Firebase الكاملة: كل بيانات المستخدم تحت users/{uid}/rows،
 * والطلب يحمل رمز Firebase للمستخدم فتطبّق قواعد الأمان عليه.
 *
 * الأعداد الصحيحة تُرسل integerValue (نصّاً بأرقامه) وتعود أعداداً صحيحة · فالمبالغ بالهللات
 * تبقى صحيحة لا كسرية في Firestore كما هي في القاعدة المحلية.
 */
import type { Cursor, RemoteDoc, RemoteStore, RowData, WriteResult } from '../sync/types';
import { nextDeviceLetter } from '../domain/numbering';
import type { DB } from '../db/adapter';
import { OWNER_ACCESS, type Access } from '../domain/access/access';
import { annotate as aclAnnotate } from '../sync/acl';

type FsValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { mapValue: { fields?: Record<string, FsValue> } }
  | { arrayValue: { values?: FsValue[] } };

export function encodeValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v as Record<string, unknown>) } };
  return { stringValue: String(v) };
}
export function encodeFields(o: Record<string, unknown>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(o)) out[k] = encodeValue(v);
  return out;
}
export function decodeValue(v: FsValue): unknown {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {});
  return null;
}
export function decodeFields(f: Record<string, FsValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) out[k] = decodeValue(v);
  return out;
}

/** حقول المستند · ts يملؤه الخادم بتحويل REQUEST_TIME لا الجهاز */
export function docToFields(d: RemoteDoc): Record<string, FsValue> {
  const f: Record<string, unknown> = { t: d.t, k: d.k, d: d.d, u: d.u, dev: d.dev, del: d.del };
  if (d.lines) f.lines = d.lines;
  // حقول الرؤية في المنشأة وحدها (sync/acl.ts)
  if (d.g) f.g = d.g;
  if (d.pids) f.pids = d.pids;
  if (d.op) f.op = d.op;
  if (d.by) f.by = d.by;
  return encodeFields(f);
}
export function fieldsToDoc(id: string, fields: Record<string, FsValue>): RemoteDoc {
  const o = decodeFields(fields);
  return {
    id,
    t: String(o.t), k: String(o.k),
    d: (o.d as RowData | null) ?? null,
    lines: Array.isArray(o.lines) ? (o.lines as RowData[]) : undefined,
    u: String(o.u), dev: String(o.dev), del: Boolean(o.del),
    ts: typeof o.ts === 'string' ? o.ts : undefined,
    ...(Array.isArray(o.g) ? { g: o.g as string[] } : {}),
    ...(Array.isArray(o.pids) ? { pids: o.pids as string[] } : {}),
    ...(typeof o.op === 'string' ? { op: o.op } : {}),
    ...(typeof o.by === 'string' ? { by: o.by } : {}),
  };
}

export class FirestoreHttpError extends Error {
  constructor(public status: number, body: string) {
    super(`Firestore ${status}: ${body.slice(0, 300)}`);
    this.name = 'FirestoreHttpError';
  }
}

export interface FirestoreOptions {
  projectId: string;
  uid: string;
  /** رمز Firebase الحالي للمستخدم · يُجدَّد عند انتهائه */
  idToken: () => Promise<string>;
  /** للمحاكي في الاختبارات: http://127.0.0.1:8080 */
  baseUrl?: string;
  /**
   * المنشأة (docs/PERMISSIONS.md): المسار orgs/{org} بدل users/{uid} · ورموز العضو تحصر السحب
   * فيما تجيزه القواعد (null للمالك: كل شيء). والجداول التي يقرأ العضو مستندها الكامل يُهمل إسقاطها.
   */
  org?: string;
  memberTokens?: () => string[] | null;
  fullReadTables?: () => Set<string>;
  /** صلاحية من يكتب · لحقول الكتابة op و by */
  access?: () => Access;
  fetchImpl?: typeof fetch;
}

export class FirestoreRemote implements RemoteStore {
  private root: string;
  private docsRoot: string;
  private userPath: string;
  private relPath: string;
  private f: typeof fetch;

  constructor(private o: FirestoreOptions) {
    const base = (o.baseUrl ?? 'https://firestore.googleapis.com').replace(/\/$/, '');
    this.docsRoot = `projects/${o.projectId}/databases/(default)/documents`;
    this.root = `${base}/v1/${this.docsRoot}`;
    this.userPath = o.org ? `${this.docsRoot}/orgs/${o.org}` : `${this.docsRoot}/users/${o.uid}`;
    this.relPath = o.org ? `orgs/${o.org}` : `users/${o.uid}`;
    this.f = o.fetchImpl ?? fetch;
    this.memberMode = !!o.org && !!o.memberTokens?.();
    if (o.org) {
      this.annotate = (db, doc) => {
        const { doc: d, pub } = aclAnnotate(db, doc, o.access?.() ?? OWNER_ACCESS);
        return pub ? { ...d, companions: [pub] } : d;
      };
    }
  }

  private async call(url: string, body: unknown): Promise<unknown> {
    const token = await this.o.idToken();
    const res = await this.f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new FirestoreHttpError(res.status, text);
    return text ? JSON.parse(text) : {};
  }

  /** المنشأة وحدها: حقول الرؤية والكتابة وإسقاط المبالغ · وفي users/{uid} يبقى المستند كما هو */
  annotate?: (db: DB, doc: RemoteDoc) => RemoteDoc;
  memberMode?: boolean;

  docName(id: string): string {
    return `${this.userPath}/rows/${id}`;
  }

  /**
   * الكتابة بـ commit (ذرّي، ومتاح للعميل بقواعد الأمان · أما batchWrite فللخوادم وحدها).
   * إن رفضت القواعد كتابةً في الدفعة رُفضت الدفعة كلها · فتُقسم نصفين حتى يُعرف المرفوض بعينه
   * ويمرّ الباقي، فلا يحبس قيدٌ مرحّل نسخته في السحابة نهائية بقيةَ الطابور.
   */
  async write(docs: RemoteDoc[]): Promise<WriteResult[]> {
    if (!docs.length) return [];
    try {
      await this.call(`${this.root}:commit`, {
        // المستند وإسقاطه بلا مبالغ (companions) في دفعة واحدة ذرّية
        writes: docs.flatMap((d) => [d, ...(d.companions ?? [])]).map((d) => ({
          update: { name: this.docName(d.id), fields: docToFields(d) },
          updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }],
        })),
      });
      return docs.map(() => ({ ok: true, code: 'OK' }));
    } catch (e) {
      if (!(e instanceof FirestoreHttpError) || e.status !== 403) throw e;
      if (docs.length === 1) return [{ ok: false, code: 'PERMISSION_DENIED', message: e.message }];
      const mid = Math.ceil(docs.length / 2);
      return [...(await this.write(docs.slice(0, mid))), ...(await this.write(docs.slice(mid)))];
    }
  }

  /**
   * حرف هذا الجهاز في ترقيم الحساب (numbering.ts) · سجل واحد users/{uid}/meta/devices فيه حرف كل جهاز،
   * يُكتب بشرط ألا يكون تغيّر منذ قُرئ (أو ألا يكون موجوداً) فلا يأخذ جهازان الحرف نفسه أبداً.
   */
  async registerDevice(deviceId: string): Promise<string> {
    const url = `${this.root}/${this.relPath}/meta/devices`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const token = await this.o.idToken();
      const res = await this.f(url, { headers: { Authorization: 'Bearer ' + token } });
      let letters: Record<string, string> = {};
      let updateTime: string | null = null;
      if (res.status === 200) {
        const doc = (await res.json()) as { fields?: Record<string, FsValue>; updateTime?: string };
        letters = (decodeFields(doc.fields ?? {}).letters ?? {}) as Record<string, string>;
        updateTime = doc.updateTime ?? null;
      } else if (res.status !== 404) {
        throw new FirestoreHttpError(res.status, await res.text());
      }
      if (deviceId in letters) return letters[deviceId];
      const letter = nextDeviceLetter(Object.values(letters));
      try {
        await this.call(`${this.root}:commit`, {
          writes: [{
            update: { name: `${this.userPath}/meta/devices`, fields: encodeFields({ letters: { ...letters, [deviceId]: letter } }) },
            currentDocument: updateTime ? { updateTime } : { exists: false },
          }],
        });
        return letter;
      } catch (e) {
        // جهاز آخر سجّل في اللحظة نفسها · يُعاد القراءة والاختيار
        if (e instanceof FirestoreHttpError && [400, 409].includes(e.status)) continue;
        throw e;
      }
    }
    throw new Error('تعذّر تسجيل حرف الجهاز · أعد المحاولة');
  }

  /**
   * «حذف حسابي»: يُكتب طلب الحذف بوقت الخادم فتأذن القواعد ساعةً بحذف الصفوف (firestore.rules) ·
   * ثم تُحذف الصفوف دفعاتٍ، ثم مستندات meta، ثم مستند الحساب، وطلب الحذف آخراً. يعيد عدد الصفوف المحذوفة.
   */
  async deleteAllData(onProgress?: (deleted: number) => void): Promise<number> {
    await this.call(`${this.root}:commit`, {
      writes: [{
        update: { name: `${this.userPath}/meta/deletion`, fields: {} },
        updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
      }],
    });
    const list = async (collection: string): Promise<string[]> => {
      const token = await this.o.idToken();
      const res = await this.f(`${this.root}/${this.relPath}/${collection}?pageSize=300&mask.fieldPaths=u`,
        { headers: { Authorization: 'Bearer ' + token } });
      const text = await res.text();
      if (!res.ok) throw new FirestoreHttpError(res.status, text);
      return ((text ? JSON.parse(text) : {}).documents ?? []).map((d: { name: string }) => d.name);
    };
    let deleted = 0;
    for (;;) {
      const names = await list('rows');
      if (!names.length) break;
      await this.call(`${this.root}:commit`, { writes: names.map((name) => ({ delete: name })) });
      deleted += names.length;
      onProgress?.(deleted);
    }
    // ومع meta في المنشأة: أعضاؤها ودعواتها (والمسار القديم لا شيء فيهما)
    const meta = [
      ...(await list('meta')).filter((n) => !n.endsWith('/meta/deletion')),
      ...(await list('members')),
      ...(await list('invites')),
    ];
    await this.call(`${this.root}:commit`, {
      writes: [...meta.map((name) => ({ delete: name })), { delete: this.userPath }, { delete: `${this.userPath}/meta/deletion` }],
    });
    return deleted;
  }

  /* ─── مستندات المنشأة المفردة (العضوية والدعوات وحروف الأجهزة) · المسار نسبي لجذر المستندات ─── */

  /** قراءة مستند · null إن لم يوجد */
  async getDoc(path: string): Promise<Record<string, unknown> | null> {
    const token = await this.o.idToken();
    const res = await this.f(`${this.root}/${path}`, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new FirestoreHttpError(res.status, text);
    return decodeFields((JSON.parse(text) as { fields?: Record<string, FsValue> }).fields ?? {});
  }

  /** كتابة مستند كاملاً (استبدال) */
  async setDoc(path: string, data: Record<string, unknown>): Promise<void> {
    await this.call(`${this.root}:commit`, { writes: [{ update: { name: `${this.docsRoot}/${path}`, fields: encodeFields(data) } }] });
  }

  async deleteDoc(path: string): Promise<void> {
    await this.call(`${this.root}:commit`, { writes: [{ delete: `${this.docsRoot}/${path}` }] });
  }

  /** مستندات مجموعة واحدة (بلا ترقيم · العضوية والدعوات قليلة) */
  async listDocs(collectionPath: string): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
    const token = await this.o.idToken();
    const res = await this.f(`${this.root}/${collectionPath}?pageSize=300`, { headers: { Authorization: 'Bearer ' + token } });
    const text = await res.text();
    if (!res.ok) throw new FirestoreHttpError(res.status, text);
    const docs = ((text ? JSON.parse(text) : {}).documents ?? []) as Array<{ name: string; fields?: Record<string, FsValue> }>;
    return docs.map((d) => ({ id: d.name.slice(d.name.lastIndexOf('/') + 1), data: decodeFields(d.fields ?? {}) }));
  }

  /** دعوات هذا الإيميل بين المنشآت (استعلام مجموعة invites) · مع رقم منشأة كلٍّ من مساره */
  async invitesFor(email: string): Promise<Array<{ org: string; data: Record<string, unknown> }>> {
    const rows = (await this.call(`${this.root}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: 'invites', allDescendants: true }],
        where: { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } } },
      },
    })) as Array<{ document?: { name: string; fields: Record<string, FsValue> } }>;
    const out: Array<{ org: string; data: Record<string, unknown> }> = [];
    for (const r of rows) {
      if (!r.document) continue;
      const m = /\/orgs\/([^/]+)\/invites\//.exec(r.document.name);
      if (m) out.push({ org: m[1], data: decodeFields(r.document.fields) });
    }
    return out;
  }

  /** صفحة واحدة من الصفوف بعد مؤشر · بشرط رموز اختيارياً (array-contains-any حتى ٣٠ رمزاً) */
  private async page(cursor: Cursor | null, limit: number, tokens: string[] | null): Promise<RemoteDoc[]> {
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: 'rows' }],
      orderBy: [{ field: { fieldPath: 'ts' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit,
    };
    if (tokens) {
      structuredQuery.where = { fieldFilter: { field: { fieldPath: 'g' }, op: 'ARRAY_CONTAINS_ANY', value: encodeValue(tokens) } };
    }
    if (cursor) {
      structuredQuery.startAt = {
        values: [{ timestampValue: cursor.ts }, { referenceValue: this.docName(cursor.id) }],
        before: false,
      };
    }
    const rows = (await this.call(`${this.root}/${this.relPath}:runQuery`, { structuredQuery })) as
      Array<{ document?: { name: string; fields: Record<string, FsValue> } }>;
    const docs: RemoteDoc[] = [];
    for (const r of rows) {
      if (!r.document) continue;
      const id = r.document.name.slice(r.document.name.lastIndexOf('/') + 1);
      docs.push(fieldsToDoc(id, r.document.fields));
    }
    return docs;
  }

  async pull(cursor: Cursor | null, limit: number): Promise<{ docs: RemoteDoc[]; next: Cursor | null }> {
    const tokens = this.o.memberTokens?.() ?? null;
    if (!tokens) {
      const docs = await this.page(cursor, limit, null);
      const last = docs[docs.length - 1];
      return { docs, next: last && last.ts ? { ts: last.ts, id: last.id } : cursor };
    }
    // العضو: استعلام لكل ٣٠ رمزاً بمؤشره · والإسقاط يُحوَّل إلى جدوله ما لم يقرأ العضو المستند الكامل
    const full = this.o.fullReadTables?.() ?? new Set<string>();
    const parts: Record<string, Cursor> = { ...(cursor?.parts ?? {}) };
    const out: RemoteDoc[] = [];
    for (let i = 0; i * 30 < Math.max(tokens.length, 1); i++) {
      const chunk = tokens.slice(i * 30, i * 30 + 30);
      if (!chunk.length) break;
      const key = chunk.join(',');
      const docs = await this.page(parts[key] ?? null, limit, chunk);
      const last = docs[docs.length - 1];
      if (last && last.ts) parts[key] = { ts: last.ts, id: last.id };
      for (const d of docs) {
        const pub = d.t.endsWith('~pub');
        if (!pub) { out.push(d); continue; }
        const base = d.t.slice(0, -4);
        if (full.has(base)) continue;
        out.push({ ...d, id: base + '__' + d.k, t: base });
      }
    }
    const last = out[out.length - 1];
    return { docs: out, next: { ts: last?.ts ?? cursor?.ts ?? '', id: last?.id ?? cursor?.id ?? '', parts } };
  }
}

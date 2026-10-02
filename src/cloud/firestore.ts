/**
 * عميل Firestore عبر REST · بلا حزمة Firebase الكاملة: كل بيانات المستخدم تحت users/{uid}/rows،
 * والطلب يحمل رمز Firebase للمستخدم فتطبّق قواعد الأمان عليه.
 *
 * الأعداد الصحيحة تُرسل integerValue (نصّاً بأرقامه) وتعود أعداداً صحيحة · فالمبالغ بالهللات
 * تبقى صحيحة لا كسرية في Firestore كما هي في القاعدة المحلية.
 */
import type { Cursor, RemoteDoc, RemoteStore, RowData, WriteResult } from '../sync/types';

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
  fetchImpl?: typeof fetch;
}

export class FirestoreRemote implements RemoteStore {
  private root: string;
  private docsRoot: string;
  private userPath: string;
  private f: typeof fetch;

  constructor(private o: FirestoreOptions) {
    const base = (o.baseUrl ?? 'https://firestore.googleapis.com').replace(/\/$/, '');
    this.docsRoot = `projects/${o.projectId}/databases/(default)/documents`;
    this.root = `${base}/v1/${this.docsRoot}`;
    this.userPath = `${this.docsRoot}/users/${o.uid}`;
    this.f = o.fetchImpl ?? fetch;
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
        writes: docs.map((d) => ({
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

  async pull(cursor: Cursor | null, limit: number): Promise<{ docs: RemoteDoc[]; next: Cursor | null }> {
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: 'rows' }],
      orderBy: [{ field: { fieldPath: 'ts' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit,
    };
    if (cursor) {
      structuredQuery.startAt = {
        values: [{ timestampValue: cursor.ts }, { referenceValue: this.docName(cursor.id) }],
        before: false,
      };
    }
    const rows = (await this.call(`${this.root.replace(/\/documents$/, '')}/documents/users/${this.o.uid}:runQuery`, { structuredQuery })) as
      Array<{ document?: { name: string; fields: Record<string, FsValue> } }>;
    const docs: RemoteDoc[] = [];
    for (const r of rows) {
      if (!r.document) continue;
      const id = r.document.name.slice(r.document.name.lastIndexOf('/') + 1);
      docs.push(fieldsToDoc(id, r.document.fields));
    }
    const last = docs[docs.length - 1];
    return { docs, next: last && last.ts ? { ts: last.ts, id: last.id } : cursor };
  }
}

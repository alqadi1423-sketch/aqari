/**
 * عميل Firestore عبر REST · بلا حزمة Firebase الكاملة: كل بيانات المستخدم تحت users/{uid}/rows،
 * والطلب يحمل رمز Firebase للمستخدم فتطبّق قواعد الأمان عليه.
 *
 * الأعداد الصحيحة تُرسل integerValue (نصّاً بأرقامه) وتعود أعداداً صحيحة · فالمبالغ بالهللات
 * تبقى صحيحة لا كسرية في Firestore كما هي في القاعدة المحلية.
 */
import type { Cursor, PullPage, RemoteDoc, RemoteStore, RowData, WriteResult } from '../sync/types';
import { planBlocks, planInvoiceSeq, type BlockRequest, type ReservedBlock } from '../domain/numbering';
import type { DB } from '../db/adapter';
import { OWNER_ACCESS, type Access } from '../domain/access/access';
import { annotate as aclAnnotate, hiddenColumns } from '../sync/acl';

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
/** sv: رقم إصدار التطبيق (#36) · يُرفع مع صفوف المنشأة حين تكون قواعد الحد منشورة، وإلا فلا (مفتاحٌ لا تعرفه قواعدٌ أقدم) */
export function docToFields(d: RemoteDoc, sv: number | null = null): Record<string, FsValue> {
  const f: Record<string, unknown> = { t: d.t, k: d.k, d: d.d, u: d.u, dev: d.dev, del: d.del };
  if (sv != null && d.g) f.sv = sv;
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
  /** رقم إصدار التطبيق مع كل صف (#36) · null ما لم تُنشر قواعد الحد */
  sv?: () => number | null;
  fetchImpl?: typeof fetch;
}

/** أقصى كتابات الالتزام الواحد (حدّ Firestore التاريخي ٥٠٠ · دراسة ٨) */
export const MAX_COMMIT_WRITES = 500;

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
        const a = o.access?.() ?? OWNER_ACCESS;
        const { doc: d0, pub } = aclAnnotate(db, doc, a);
        // ما يقرؤه العضو إسقاطاً لا يُرفع منه: قيمته عنده افتراضها لا الحقيقية (المراجعة #17)
        const hidden = new Set(hiddenColumns(a, doc.t, doc.d as Record<string, unknown> | null));
        const d = hidden.size && d0.d
          ? { ...d0, partial: true, d: Object.fromEntries(Object.entries(d0.d).filter(([k]) => !hidden.has(k))) as typeof d0.d }
          : d0;
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
  /** وقت الالتزام في الخادم مقابل منتصف زمن الطلب على الجهاز · لفرق الساعة (المراجعة ٤.١٦) */
  private lastClock: { serverMs: number; localMs: number } | null = null;
  clockSample(): { serverMs: number; localMs: number } | null {
    const s = this.lastClock;
    this.lastClock = null;
    return s;
  }

  async write(docs: RemoteDoc[]): Promise<WriteResult[]> {
    if (!docs.length) return [];
    // سقف ٥٠٠ كتابة للالتزام (دراسة ٨ · قرار المالك 2026-10-09): الصف وإسقاطاته معاً، فتُقسم الدفعة بالصفوف لا بالكتابات
    const writes = docs.reduce((s, d) => s + 1 + (d.companions?.length ?? 0), 0);
    if (writes > MAX_COMMIT_WRITES && docs.length > 1) {
      const mid = Math.ceil(docs.length / 2);
      return [...(await this.write(docs.slice(0, mid))), ...(await this.write(docs.slice(mid)))];
    }
    try {
      const t0 = Date.now();
      const res = await this.call(`${this.root}:commit`, {
        // المستند وإسقاطه بلا مبالغ (companions) في دفعة واحدة ذرّية
        writes: docs.flatMap((d) => [d, ...(d.companions ?? [])]).map((d) => {
          const fields = docToFields(d, this.o.sv?.() ?? null);
          return {
            update: { name: this.docName(d.id), fields },
            // الجزئية: حقول المستند وحقول d الحاضرة وحدها · وما سواها يبقى في السحابة (المراجعة #17)
            ...(d.partial && d.d ? { updateMask: { fieldPaths: [...Object.keys(fields).filter((k) => k !== 'd'), ...Object.keys(d.d).map((c) => 'd.' + c)] } } : {}),
            updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }],
          };
        }),
      }) as { commitTime?: string };
      const commit = res && typeof res.commitTime === 'string' ? Date.parse(res.commitTime) : NaN;
      if (Number.isFinite(commit)) this.lastClock = { serverMs: commit, localMs: Math.round((t0 + Date.now()) / 2) };
      return docs.map(() => ({ ok: true, code: 'OK' }));
    } catch (e) {
      // ٤٠٠ (التزامٌ أكبر مما يقبله الخادم) يُقسم كما يُقسم ٤٠٣ (قرار المالك 2026-10-09) · والصف الواحد بـ٤٠٠ خطأٌ حقيقي
      if (e instanceof FirestoreHttpError && e.status === 400 && docs.length > 1) {
        const mid = Math.ceil(docs.length / 2);
        return [...(await this.write(docs.slice(0, mid))), ...(await this.write(docs.slice(mid)))];
      }
      if (!(e instanceof FirestoreHttpError) || e.status !== 403) throw e;
      if (docs.length === 1) return [{ ok: false, code: 'PERMISSION_DENIED', message: e.message }];
      const mid = Math.ceil(docs.length / 2);
      return [...(await this.write(docs.slice(0, mid))), ...(await this.write(docs.slice(mid)))];
    }
  }

  /**
   * عدّاد الترقيم (numbering.ts) · سجلٌ واحد meta/counters فيه آخر رقمٍ محجوز لكل سلسلة، يُكتب بشرط ألا يكون
   * تغيّر منذ قُرئ (أو ألا يكون موجوداً) فلا يأخذ جهازان الكتلة نفسها ولا الرقم نفسه أبداً.
   */
  private async bumpCounters<T>(fn: (cur: Record<string, number>) => { next: Record<string, number>; out: T }): Promise<T> {
    const url = `${this.root}/${this.relPath}/meta/counters`;
    for (let attempt = 0; attempt < 8; attempt++) {
      const token = await this.o.idToken();
      const res = await this.f(url, { headers: { Authorization: 'Bearer ' + token } });
      let cur: Record<string, number> = {};
      let updateTime: string | null = null;
      if (res.status === 200) {
        const doc = (await res.json()) as { fields?: Record<string, FsValue>; updateTime?: string };
        cur = decodeFields(doc.fields ?? {}) as Record<string, number>;
        updateTime = doc.updateTime ?? null;
      } else if (res.status !== 404) {
        throw new FirestoreHttpError(res.status, await res.text());
      }
      const { next, out } = fn(cur);
      try {
        await this.call(`${this.root}:commit`, {
          writes: [{
            update: { name: `${this.userPath}/meta/counters`, fields: encodeFields({ ...cur, ...next }) },
            currentDocument: updateTime ? { updateTime } : { exists: false },
          }],
        });
        return out;
      } catch (e) {
        // جهاز آخر حجز في اللحظة نفسها · يُعاد القراءة والحساب
        if (e instanceof FirestoreHttpError && [400, 409].includes(e.status)) continue;
        throw e;
      }
    }
    throw new Error('تعذّر حجز أرقام المستندات · أعد المحاولة');
  }

  /** كتلٌ لكل سلسلة بعد أعلى ما في العدّاد وما يعرفه الجهاز · وأول إنشاءٍ للسلسلة بعد أرضيته بفجوة */
  async reserveBlocks(req: BlockRequest[]): Promise<ReservedBlock[]> {
    if (!req.length) return [];
    return this.bumpCounters((cur) => planBlocks(cur, req));
  }

  /** رقم الفاتورة الضريبية التالي · العدّاد يتقدم واحداً فلا فجوة */
  async takeInvoiceSeq(floor: number): Promise<number> {
    return this.bumpCounters((cur) => planInvoiceSeq(cur, floor));
  }

  /**
   * «حذف حسابي»: يُكتب طلب الحذف بوقت الخادم فتأذن القواعد ساعةً بحذف الصفوف (firestore.rules) ·
   * ثم تُحذف الصفوف دفعاتٍ، ثم مستندات meta، ثم مستند الحساب، وطلب الحذف آخراً. يعيد عدد الصفوف المحذوفة.
   */
  /**
   * «مسح كل البيانات»: صفوف المسار كلها تُحذف بنافذة الحذف نفسها (طلبٌ بوقت الخادم يأذن ساعة) ·
   * ويبقى الحساب والمنشأة وأعضاؤها ودعواتها وحروف الأجهزة. يعيد عدد الصفوف المحذوفة.
   */
  async deleteRowsOnly(onProgress?: (deleted: number) => void): Promise<number> {
    await this.call(`${this.root}:commit`, {
      writes: [{
        update: { name: `${this.userPath}/meta/deletion`, fields: {} },
        updateTransforms: [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }],
      }],
    });
    let deleted = 0;
    for (;;) {
      const token = await this.o.idToken();
      const res = await this.f(`${this.root}/${this.relPath}/rows?pageSize=300&mask.fieldPaths=u`, { headers: { Authorization: 'Bearer ' + token } });
      const text = await res.text();
      if (!res.ok) throw new FirestoreHttpError(res.status, text);
      const names = ((text ? JSON.parse(text) : {}).documents ?? []).map((d: { name: string }) => d.name);
      if (!names.length) break;
      await this.call(`${this.root}:commit`, { writes: names.map((name: string) => ({ delete: name })) });
      deleted += names.length;
      onProgress?.(deleted);
    }
    await this.call(`${this.root}:commit`, { writes: [{ delete: `${this.userPath}/meta/deletion` }] });
    return deleted;
  }

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

  /** كتابة مستندات وحذف غيرها في التزامٍ واحد ذرّي (قبول الدعوة يحذفها مع إنشاء العضوية · مراجعة التثبيت #36) */
  async commitDocs(sets: Array<{ path: string; data: Record<string, unknown> }>, deletes: string[]): Promise<void> {
    await this.call(`${this.root}:commit`, {
      writes: [
        ...sets.map((x) => ({ update: { name: `${this.docsRoot}/${x.path}`, fields: encodeFields(x.data) } })),
        ...deletes.map((path) => ({ delete: `${this.docsRoot}/${path}` })),
      ],
    });
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

  async pull(cursor: Cursor | null, limit: number): Promise<PullPage> {
    const tokens = this.o.memberTokens?.() ?? null;
    if (!tokens) {
      const docs = await this.page(cursor, limit, null);
      const last = docs[docs.length - 1];
      // المالك يقرأ المستندات الكاملة · والإسقاط بلا مبالغ (t~pub) للأعضاء وحدهم فلا يُطبَّق عنده
      // (كان يُرفض «جدولاً خارج المزامنة» فيظهر مرفوضاً على كل تثبيت جديد)
      return { docs: docs.filter((d) => !d.t.endsWith('~pub')), next: last && last.ts ? { ts: last.ts, id: last.id } : cursor, more: docs.length >= limit };
    }
    // العضو: استعلام لكل ٣٠ رمزاً بمؤشره · والإسقاط يُحوَّل إلى جدوله ما لم يقرأ العضو المستند الكامل
    const full = this.o.fullReadTables?.() ?? new Set<string>();
    const parts: Record<string, Cursor> = { ...(cursor?.parts ?? {}) };
    const out: RemoteDoc[] = [];
    let more = false;
    for (let i = 0; i * 30 < Math.max(tokens.length, 1); i++) {
      const chunk = tokens.slice(i * 30, i * 30 + 30);
      if (!chunk.length) break;
      const key = chunk.join(',');
      const docs = await this.page(parts[key] ?? null, limit, chunk);
      const last = docs[docs.length - 1];
      if (last && last.ts) parts[key] = { ts: last.ts, id: last.id };
      if (docs.length >= limit) more = true;
      for (const d of docs) {
        const pub = d.t.endsWith('~pub');
        if (!pub) { out.push(d); continue; }
        const base = d.t.slice(0, -4);
        if (full.has(base)) continue;
        out.push({ ...d, id: base + '__' + d.k, t: base });
      }
    }
    const last = out[out.length - 1];
    return { docs: out, next: { ts: last?.ts ?? cursor?.ts ?? '', id: last?.id ?? cursor?.id ?? '', parts }, more };
  }
}

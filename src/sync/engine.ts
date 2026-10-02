/**
 * محرّك المزامنة · القاعدة المحلية مصدر الحقيقة والسحابة طبقة مضافة.
 *
 * الدورة: سحب ما كُتب في السحابة بعد المؤشر إلى صندوق وارد محفوظ ← تطبيقه بترتيب
 * الآباء قبل الأبناء ← دفع الطابور الصادر. كل خطوة تُستأنف إن انقطع الاتصال في منتصفها.
 *
 * القواعد:
 *  - التعارض يُحلّ على مستوى الصف: الأحدث تغييراً يغلب (وقت التغيير ثم هوية الجهاز عند التساوي)،
 *    ويُسجَّل في سجل العمليات إن اختلف المضمون فعلاً.
 *  - القيد المرحّل إضافة فقط: لا يُعدَّل ولا يُحذف بالمزامنة · يُسمح بربطه بقيده العكسي مرة واحدة.
 *  - كل ما يرد يمرّ بمحفّزات القاعدة نفسها (توازن القيد · سقف القسط · المفاتيح) · فالمرفوض
 *    يُحفظ في sync_rejects ويُسجَّل، ولا يكسر بقية الدفعة.
 *  - المبالغ أعداد صحيحة بالهللات كما هي في القاعدة.
 */
import type { DB, SqlValue } from '../db/adapter';
import { SYNC_TABLES, SYNC_RANK, syncTable } from '../db/syncTables';
import { logAudit } from '../domain/audit';
import { SEED_SCRIPTS, seedScriptId } from '../db/seed';
import type { Cursor, RemoteDoc, RemoteStore, RowData, SyncReport } from './types';

const nowIso = () => new Date().toISOString();

/* ═══════════ الحالة والالتقاط ═══════════ */

export function getSyncState(db: DB, k: string): string | null {
  return db.get<{ v: string | null }>(`SELECT v FROM sync_state WHERE k = ?`, [k])?.v ?? null;
}
export function setSyncState(db: DB, k: string, v: string | null): void {
  db.run(`INSERT INTO sync_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [k, v]);
}
export function setCapture(db: DB, on: boolean): void {
  db.run(`UPDATE sync_ctl SET v = ? WHERE k = 'capture'`, [on ? 1 : 0]);
}
export function captureOn(db: DB): boolean {
  return Number(db.get<{ v: number }>(`SELECT v FROM sync_ctl WHERE k = 'capture'`)?.v ?? 0) === 1;
}

/**
 * تفعيل المزامنة لحساب · أول تفعيل أو حساب مختلف عن السابق: كل الصفوف تدخل الطابور
 * ويُصفَّر مؤشر السحب، فيصل الحساب كل ما على الجهاز ويصل الجهاز كل ما في الحساب.
 * ونفس الحساب بعد خروج ودخول: يكمل من حيث توقف، والالتقاط لم يتوقف بالخروج فلم يفت تغيير.
 */
export function enableSync(db: DB, uid: string): { seeded: boolean } {
  return db.transaction(() => {
    const prev = getSyncState(db, 'uid');
    let seeded = false;
    if (prev !== uid) {
      db.run(`DELETE FROM sync_inbox`);
      setSyncState(db, 'cursor', null);
      setSyncState(db, 'uid', uid);
      unifySeedIds(db);
      seedOutbox(db);
      // الانضمام: ما في الحساب يغلب ما يقابله على هذا الجهاز في أول دورة، وما انفرد به الجهاز يُرفع ·
      // فجهاز ثانٍ فارغ لا يكتب قيمه الافتراضية فوق بيانات الأول
      setSyncState(db, 'joining', '1');
      seeded = true;
    }
    setCapture(db, true);
    return { seeded };
  });
}

/**
 * القوالب الافتراضية زُرعت في الإصدارات السابقة بمعرّفات عشوائية · فتُوحَّد إلى المعرّف الثابت
 * ما دام القالب كما زُرع، فيلتقي قالب الجهازين في صف واحد لا صفين.
 */
function unifySeedIds(db: DB): void {
  SEED_SCRIPTS.forEach((s, i) => {
    const target = seedScriptId(i);
    if (db.get(`SELECT id FROM message_scripts WHERE id = ?`, [target])) return;
    const row = db.get<{ id: string }>(
      `SELECT id FROM message_scripts WHERE audience = ? AND title = ? AND body = ? AND deleted_at IS NULL
       ORDER BY created_at LIMIT 1`, [s.audience, s.title, s.body]);
    if (row) db.run(`UPDATE message_scripts SET id = ? WHERE id = ?`, [target, row.id]);
  });
}

/** كل صف من كل جدول مزامَن إلى الطابور · بلا مسّ لما فيه أصلاً */
export function seedOutbox(db: DB): void {
  const at = nowIso();
  for (const t of SYNC_TABLES) {
    db.run(
      `INSERT INTO sync_outbox (tbl, pk, op, changed_at)
       SELECT '${t.name}', ${t.pk(t.name)}, 'upsert', ? FROM "${t.name}"
       WHERE true ON CONFLICT(tbl, pk) DO NOTHING`, [at]);
  }
}

/* ═══════════ بناء المستندات من الصفوف ═══════════ */

function pkWhere(table: string): string {
  const t = syncTable(table)!;
  return t.pkCols.map((c) => `"${c}" = ?`).join(' AND ');
}
function pkParams(table: string, key: string): string[] {
  const t = syncTable(table)!;
  if (t.pkCols.length === 1) return [key];
  const i = key.indexOf('|');
  return [key.slice(0, i), key.slice(i + 1)];
}
export const docId = (table: string, key: string) => `${table}__${key}`;

function readRow(db: DB, table: string, key: string): RowData | undefined {
  return db.get<RowData>(`SELECT * FROM "${table}" WHERE ${pkWhere(table)}`, pkParams(table, key));
}
function readLines(db: DB, entryId: string): RowData[] {
  return db.all<RowData>(`SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY id`, [entryId]);
}

export function buildDoc(db: DB, table: string, key: string, op: 'upsert' | 'delete', changedAt: string, deviceId: string): RemoteDoc {
  const base = { id: docId(table, key), t: table, k: key, u: changedAt, dev: deviceId };
  const row = op === 'upsert' ? readRow(db, table, key) : undefined;
  if (!row) return { ...base, d: null, del: true };
  const doc: RemoteDoc = { ...base, d: row, del: false };
  if (table === 'journal_entries') doc.lines = readLines(db, key);
  return doc;
}

interface OutRow { tbl: string; pk: string; op: 'upsert' | 'delete'; changed_at: string }

const RANK_CASE = `CASE tbl ${SYNC_TABLES.map((t, i) => `WHEN '${t.name}' THEN ${i}`).join(' ')} ELSE 999 END`;

export function pendingOutbox(db: DB, limit: number): OutRow[] {
  return db.all<OutRow & { rank: number }>(
    `SELECT tbl, pk, op, changed_at, ${RANK_CASE} AS rank FROM sync_outbox
     ORDER BY rank, changed_at, tbl, pk LIMIT ?`, [limit]);
}
export function outboxCount(db: DB): number {
  return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_outbox`)!.n);
}

/* ═══════════ الوارد: الحفظ ثم التطبيق ═══════════ */

export function stageInbox(db: DB, docs: RemoteDoc[]): void {
  db.transaction(() => {
    for (const d of docs) {
      db.run(
        `INSERT INTO sync_inbox (doc, tbl, pk, rank, payload, updated_at, device_id, attempts, last_error)
         VALUES (?,?,?,?,?,?,?,0,NULL)
         ON CONFLICT(doc) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at,
           device_id = excluded.device_id, attempts = 0, last_error = NULL
         WHERE excluded.updated_at >= sync_inbox.updated_at`,
        [d.id, d.t, d.k, SYNC_RANK[d.t] ?? 999, JSON.stringify(d), d.u, d.dev]);
    }
  });
}

/** نصّ القاعدة لمفتاح أجنبي ناقص · يُعاد المستند لاحقاً حين يصل أبوه */
const isMissingParent = (msg: string) => /FOREIGN KEY constraint failed/i.test(msg);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX_ATTEMPTS = 20;

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
}
/** مقارنة المضمون لا الشكل · فـ 5 و 5.0 والترتيب لا تُحسب اختلافاً */
function sameContent(a: RemoteDoc, b: RemoteDoc): boolean {
  const bare = (d: RowData | null) => (d ? { ...d, created_at: null } : null);
  return a.del === b.del && stable(bare(a.d)) === stable(bare(b.d)) && stable(a.lines ?? null) === stable(b.lines ?? null);
}

function columnsOf(db: DB, table: string): Set<string> {
  return new Set(db.all<{ name: string }>(`PRAGMA table_info("${table}")`).map((c) => c.name));
}

function upsertRow(db: DB, table: string, data: RowData, cols: Set<string>): void {
  const t = syncTable(table)!;
  const keys = Object.keys(data).filter((c) => cols.has(c));
  const nonPk = keys.filter((c) => !t.pkCols.includes(c));
  const sql = `INSERT INTO "${table}" (${keys.map((c) => `"${c}"`).join(',')})
    VALUES (${keys.map(() => '?').join(',')})
    ON CONFLICT(${t.pkCols.map((c) => `"${c}"`).join(',')}) DO ${nonPk.length
      ? 'UPDATE SET ' + nonPk.map((c) => `"${c}" = excluded."${c}"`).join(', ')
      : 'NOTHING'}`;
  db.run(sql, keys.map((c) => data[c] as SqlValue));
}

/**
 * القيد · الوحدة: القيد وسطوره معاً.
 * المرحّل محلياً لا يتغيّر إلا بربط قيده العكسي مرة واحدة · والوارد مرحّلاً يُنشأ مسودةً
 * بسطوره ثم يُرقّى فيمرّ بمحفّز التوازن كأي قيد.
 */
function applyJournal(db: DB, doc: RemoteDoc, cols: { e: Set<string>; l: Set<string> }): 'applied' | 'kept' {
  const d = doc.d!;
  const local = db.get<{ status: string; reversed_by: string | null }>(
    `SELECT status, reversed_by FROM journal_entries WHERE id = ?`, [doc.k]);
  const remoteRev = (d.reversed_by as string | null) ?? null;
  if (local?.status === 'مرحّل') {
    if (remoteRev && !local.reversed_by) {
      db.run(`UPDATE journal_entries SET reversed_by = ? WHERE id = ?`, [remoteRev, doc.k]);
      return 'applied';
    }
    return 'kept';
  }
  if (local) db.run(`DELETE FROM journal_lines WHERE entry_id = ?`, [doc.k]); // مسودة · سطورها تُستبدل
  const posted = d.status === 'مرحّل';
  const entry: RowData = { ...d, status: posted ? 'قيد الإنشاء' : d.status, reversed_by: null };
  upsertRow(db, 'journal_entries', entry, cols.e);
  for (const l of doc.lines ?? []) {
    const keys = Object.keys(l).filter((c) => cols.l.has(c));
    db.run(`INSERT INTO journal_lines (${keys.map((c) => `"${c}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((c) => l[c] as SqlValue));
  }
  if (posted) db.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = ?`, [doc.k]);
  if (remoteRev) db.run(`UPDATE journal_entries SET reversed_by = ? WHERE id = ?`, [remoteRev, doc.k]);
  return 'applied';
}

function deleteRow(db: DB, table: string, key: string): void {
  db.run(`DELETE FROM "${table}" WHERE ${pkWhere(table)}`, pkParams(table, key));
}

type ApplyOutcome = 'applied' | 'skipped' | 'conflict-local' | 'conflict-remote' | 'retry' | 'rejected';

function reject(db: DB, doc: RemoteDoc, reason: string): void {
  db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`,
    [doc.id, doc.t, doc.k, reason, JSON.stringify(doc), nowIso()]);
  try { logAudit(db, 'المزامنة', 'update', 'رفض وارد', `${doc.t} · ${doc.k} · ${reason}`.slice(0, 300)); } catch { /* السجل لا يعطّل */ }
}

function applyOne(db: DB, doc: RemoteDoc, deviceId: string, cache: Map<string, Set<string>>, joining: boolean): ApplyOutcome {
  const t = syncTable(doc.t);
  if (!t) { reject(db, doc, 'جدول خارج المزامنة'); return 'rejected'; }
  if (doc.dev === deviceId) return 'skipped'; // صدى ما كتبه هذا الجهاز

  const cols = (name: string) => {
    let s = cache.get(name);
    if (!s) { s = columnsOf(db, name); cache.set(name, s); }
    return s;
  };

  // التعارض على مستوى الصف · الأحدث تغييراً يغلب
  const pending = db.get<OutRow>(`SELECT tbl, pk, op, changed_at FROM sync_outbox WHERE tbl = ? AND pk = ?`, [doc.t, doc.k]);
  let conflict: 'conflict-remote' | null = null;
  if (pending) {
    const localDoc = buildDoc(db, doc.t, doc.k, pending.op, pending.changed_at, deviceId);
    if (sameContent(localDoc, doc)) {
      db.run(`DELETE FROM sync_outbox WHERE tbl = ? AND pk = ?`, [doc.t, doc.k]); // الطرفان متفقان
      return 'skipped';
    }
    const localWins = !joining && (pending.changed_at > doc.u || (pending.changed_at === doc.u && deviceId > doc.dev));
    if (localWins) {
      logAudit(db, 'المزامنة', 'update', 'تعارض مزامنة', `${doc.t} · ${doc.k} · غلب تعديل هذا الجهاز (${pending.changed_at}) على الوارد (${doc.u})`);
      return 'conflict-local';
    }
    conflict = 'conflict-remote';
  }

  try {
    db.transaction(() => {
      if (doc.del) {
        if (t.appendOnly) throw new Error('سجل لا يُحذف');
        deleteRow(db, doc.t, doc.k);
      } else if (doc.t === 'journal_entries') {
        applyJournal(db, doc, { e: cols('journal_entries'), l: cols('journal_lines') });
      } else if (t.appendOnly) {
        const keys = Object.keys(doc.d!).filter((c) => cols(doc.t).has(c));
        db.run(`INSERT OR IGNORE INTO "${doc.t}" (${keys.map((c) => `"${c}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
          keys.map((c) => doc.d![c] as SqlValue));
      } else {
        upsertRow(db, doc.t, doc.d!, cols(doc.t));
      }
      if (pending) db.run(`DELETE FROM sync_outbox WHERE tbl = ? AND pk = ?`, [doc.t, doc.k]);
      if (conflict) {
        logAudit(db, 'المزامنة', 'update', 'تعارض مزامنة', joining
          ? `${doc.t} · ${doc.k} · غلب ما في الحساب على نسخة هذا الجهاز عند انضمامه`
          : `${doc.t} · ${doc.k} · غلب الوارد (${doc.u}) على تعديل هذا الجهاز (${pending!.changed_at})`);
      }
    });
    return conflict ?? 'applied';
  } catch (e) {
    const msg = errText(e);
    if (isMissingParent(msg)) return 'retry';
    reject(db, doc, msg);
    return 'rejected';
  }
}

/**
 * تطبيق الصندوق الوارد كله · بترتيب الآباء قبل الأبناء، ومرور ثانٍ وثالث لما انتظر أباً
 * وصل في المرور نفسه (قيد عكسي بعد أصله مثلاً). ما بقي ينتظر أباه يبقى للدورة التالية.
 */
export function applyInbox(db: DB, deviceId: string): { applied: number; conflicts: number; rejected: number; waiting: number } {
  const cache = new Map<string, Set<string>>();
  const joining = getSyncState(db, 'joining') === '1';
  let applied = 0, conflicts = 0, rejected = 0;
  const wasOn = captureOn(db);
  setCapture(db, false); // الوارد لا يرتدّ صداه إلى الطابور الصادر
  try {
    for (let pass = 0; pass < 4; pass++) {
      let progress = 0;
      let lastRank = -1, lastU = '', lastDoc = '';
      for (;;) {
        const page = db.all<{ doc: string; rank: number; updated_at: string; payload: string; attempts: number }>(
          `SELECT doc, rank, updated_at, payload, attempts FROM sync_inbox
           WHERE (rank, updated_at, doc) > (?, ?, ?)
           ORDER BY rank, updated_at, doc LIMIT 300`, [lastRank, lastU, lastDoc]);
        if (!page.length) break;
        db.transaction(() => {
          for (const r of page) {
            const doc = JSON.parse(r.payload) as RemoteDoc;
            const out = applyOne(db, doc, deviceId, cache, joining);
            if (out === 'retry') {
              if (r.attempts + 1 >= MAX_ATTEMPTS) {
                reject(db, doc, 'سجل أب غير موجود بعد محاولات متكررة');
                db.run(`DELETE FROM sync_inbox WHERE doc = ?`, [r.doc]);
                rejected++;
              } else {
                db.run(`UPDATE sync_inbox SET attempts = attempts + 1, last_error = 'بانتظار سجل أب' WHERE doc = ?`, [r.doc]);
              }
              continue;
            }
            db.run(`DELETE FROM sync_inbox WHERE doc = ?`, [r.doc]);
            progress++;
            if (out === 'applied') applied++;
            else if (out === 'conflict-local' || out === 'conflict-remote') { conflicts++; if (out === 'conflict-remote') applied++; }
            else if (out === 'rejected') rejected++;
          }
        });
        const last = page[page.length - 1];
        lastRank = last.rank; lastU = last.updated_at; lastDoc = last.doc;
      }
      if (!progress) break;
      const left = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox`)!.n);
      if (!left) break;
    }
  } finally {
    setCapture(db, wasOn);
  }
  const waiting = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox`)!.n);
  return { applied, conflicts, rejected, waiting };
}

/* ═══════════ الدورة الكاملة ═══════════ */

const PULL_PAGE = 500;
const PUSH_BATCH = 400;

/** رفض قواعد الأمان لكتابةٍ على ما لا يُعدَّل (قيد مرحّل، سجل عمليات) · نسخته في السحابة نهائية */
function immutableDenied(doc: RemoteDoc, code?: string): boolean {
  if (code !== 'PERMISSION_DENIED') return false;
  if (doc.t === 'audit_log') return true;
  return doc.t === 'journal_entries' && doc.d?.status === 'مرحّل';
}

export async function syncOnce(
  db: DB,
  remote: RemoteStore,
  deviceId: string,
  onProgress?: (msg: string) => void
): Promise<SyncReport> {
  // ١) السحب إلى الصندوق الوارد · المؤشر يُحفظ بعد حفظ كل صفحة
  let pulled = 0;
  const saved = getSyncState(db, 'cursor');
  let cursor: Cursor | null = saved ? (JSON.parse(saved) as Cursor) : null;
  for (;;) {
    onProgress?.('جاري سحب التغييرات' + (pulled ? ' · ' + pulled : ''));
    const { docs, next } = await remote.pull(cursor, PULL_PAGE);
    if (docs.length) {
      stageInbox(db, docs);
      pulled += docs.length;
    }
    if (next) { cursor = next; setSyncState(db, 'cursor', JSON.stringify(next)); }
    if (docs.length < PULL_PAGE) break;
  }

  // ٢) التطبيق · ثم ينتهي الانضمام بعد أول تطبيق كامل لما في الحساب
  onProgress?.('جاري تطبيق الوارد');
  const a = applyInbox(db, deviceId);
  if (getSyncState(db, 'joining') === '1') setSyncState(db, 'joining', null);

  // ٣) الدفع
  let pushed = 0;
  for (;;) {
    const batch = pendingOutbox(db, PUSH_BATCH);
    if (!batch.length) break;
    onProgress?.('جاري رفع التغييرات · ' + pushed);
    const docs = batch.map((r) => buildDoc(db, r.tbl, r.pk, r.op, r.changed_at, deviceId));
    const results = await remote.write(docs);
    let progressed = 0;
    db.transaction(() => {
      results.forEach((res, i) => {
        const r = batch[i];
        if (res.ok || immutableDenied(docs[i], res.code)) {
          // لا يُحذف إن تغيّر الصف أثناء الرفع · يبقى للدفعة التالية بوقته الجديد
          db.run(`DELETE FROM sync_outbox WHERE tbl = ? AND pk = ? AND changed_at = ?`, [r.tbl, r.pk, r.changed_at]);
          if (res.ok) pushed++;
          progressed++;
        } else {
          db.run(`UPDATE sync_outbox SET last_error = ? WHERE tbl = ? AND pk = ?`,
            [(res.code ?? '') + ' ' + (res.message ?? ''), r.tbl, r.pk]);
        }
      });
    });
    if (!progressed) break; // كل الدفعة رُفضت · لا دوران بلا تقدّم
  }

  setSyncState(db, 'last_sync_at', nowIso());
  const pending = outboxCount(db);
  return { pulled, applied: a.applied, conflicts: a.conflicts, rejected: a.rejected, pushed, pending, waiting: a.waiting };
}

export interface SyncStatus {
  enabled: boolean;
  uid: string | null;
  lastSyncAt: string | null;
  pending: number;
  waiting: number;
  rejected: number;
  lastError: string | null;
}

export function syncStatus(db: DB): SyncStatus {
  const n = (sql: string) => Number(db.get<{ n: number }>(sql)!.n);
  return {
    enabled: captureOn(db),
    uid: getSyncState(db, 'uid'),
    lastSyncAt: getSyncState(db, 'last_sync_at'),
    pending: n(`SELECT COUNT(*) AS n FROM sync_outbox`),
    waiting: n(`SELECT COUNT(*) AS n FROM sync_inbox`),
    rejected: n(`SELECT COUNT(*) AS n FROM sync_rejects`),
    lastError: getSyncState(db, 'last_error'),
  };
}

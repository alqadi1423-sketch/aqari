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
 *  - كل صف وارد يُكتب داخل نقطة حفظ ثم يمرّ بفحصين قبل اعتماده: محفّزات القاعدة (توازن القيد ·
 *    سقف القسط · المفاتيح) ثم فحص الاستعادة نفسه semanticIssues محصوراً في الصف وما يمسّه
 *    (توازن القيد وسطوره · سقف القسط · الدفعة السالبة · الأعداد الصحيحة). أي إخفاق يُرجع نقطة
 *    الحفظ فلا يبقى من الصف أثر، ويُحفظ في sync_rejects ويُسجَّل، ولا يكسر بقية الدفعة.
 *  - المبالغ أعداد صحيحة بالهللات كما هي في القاعدة.
 */
import type { DB, SqlValue } from '../db/adapter';
import { SYNC_TABLES, SYNC_RANK, syncTable } from '../db/syncTables';
import { logAudit } from '../domain/audit';
import { moneyColumns, semanticIssues, type SemanticScope } from '../domain/backup/semantic';
import { SEED_SCRIPTS, seedScriptId } from '../db/seed';
import { DISCOUNT_ENTRY_SRC } from '../domain/contracts/installments';
import { recomputeInstallments, installmentsOfPayment } from '../domain/contracts/paid';
import { deviceLetterAssigned, setDeviceLetter } from '../domain/numbering';
import type { Cursor, RemoteDoc, RemoteStore, RowData, SyncReport, WriteResult } from './types';

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

/**
 * ما يُشتق ولا يُزامَن: مسدَّد القسط وحالته يُحسبان على كل جهاز من الدفعات وتوزيعها (paid.ts) ·
 * فلو سافر المسدَّد رقماً لغلب رقمُ جهازٍ رقمَ الآخر وضاع قبضٌ سُجّل على الجهازين بلا اتصال.
 * و«ملغية» قرارٌ لا حساب، فتسافر وحدها.
 */
export function stripDerived(table: string, row: RowData): RowData {
  if (table !== 'contract_installments') return row;
  const { paid_halalas: _paid, ...rest } = row;
  if (rest.status !== 'ملغية') delete rest.status;
  return rest;
}

export function buildDoc(db: DB, table: string, key: string, op: 'upsert' | 'delete', changedAt: string, deviceId: string): RemoteDoc {
  const base = { id: docId(table, key), t: table, k: key, u: changedAt, dev: deviceId };
  const row = op === 'upsert' ? readRow(db, table, key) : undefined;
  if (!row) return { ...base, d: null, del: true };
  const doc: RemoteDoc = { ...base, d: stripDerived(table, row), del: false };
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

/** ما يمسّه الصف الوارد من فحوص الاستعادة: صفه نفسه، وقيده، وقسطه، ودفعته */
function scopeOf(db: DB, doc: RemoteDoc): SemanticScope {
  const s: SemanticScope = { rows: [{ table: doc.t, where: pkWhere(doc.t), params: pkParams(doc.t, doc.k) }] };
  if (doc.t === 'journal_entries') {
    s.entryIds = [doc.k];
    // قيد خصم وارد يمسّ سقف قسطه: مربوط بالقسط نفسه، أو بدفعة فيُفحص قسطها وخصمها معها
    const e = db.get<{ t: string | null; s: string | null }>(`SELECT src_type AS t, src_id AS s FROM journal_entries WHERE id = ?`, [doc.k]);
    if (e?.t === DISCOUNT_ENTRY_SRC && e.s) {
      const p = db.get<{ i: string | null }>(`SELECT installment_id AS i FROM contract_payments WHERE id = ?`, [e.s]);
      if (p) { s.paymentIds = [e.s]; s.installmentIds = p.i ? [p.i] : []; }
      else s.installmentIds = [e.s];
    }
  }
  if (doc.t === 'contract_installments') s.installmentIds = [doc.k];
  if (doc.t === 'contract_payments') {
    s.paymentIds = [doc.k];
    const p = db.get<{ i: string | null }>(`SELECT installment_id AS i FROM contract_payments WHERE id = ?`, [doc.k]);
    s.installmentIds = p?.i ? [p.i] : [];
  }
  return s;
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

function applyOne(
  db: DB, doc: RemoteDoc, deviceId: string, cache: Map<string, Set<string>>, money: Map<string, string[]>, joining: boolean,
): ApplyOutcome {
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
        // ما أرسله جهازٌ بإصدار أقدم من مسدَّدٍ وحالة يُترك · فهما يُحسبان هنا بعد التطبيق
        upsertRow(db, doc.t, stripDerived(doc.t, doc.d!), cols(doc.t));
      }
      if (!doc.del) {
        // فحص الاستعادة نفسه على ما كُتب للتو · إخفاقه يُرجع نقطة الحفظ كلها
        const issues = semanticIssues(db, scopeOf(db, doc), money);
        if (issues.length) throw new Error('الوارد مرفوض · ' + issues.join(' · '));
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

/** sync_ctl.applying · تقرؤه محفّزات سقف الدفعة (الهجرة ٢١) */
function setApplying(db: DB, on: boolean): void {
  db.run(`INSERT INTO sync_ctl (k, v) VALUES ('applying', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [on ? 1 : 0]);
}

/** الأقساط التي يمسّ مسدَّدَها مستندٌ وارد · وحذفُ دفعةٍ أو توزيعٍ لا يُعرف قسطه فيُعاد حساب الكل */
function markTouched(db: DB, doc: RemoteDoc, touched: Set<string>): void {
  const d = doc.d;
  if (doc.t === 'contract_installments') touched.add(doc.k);
  else if (doc.t === 'contract_payments') {
    if (!d) { touched.add(ALL_INSTALLMENTS); return; }
    for (const id of installmentsOfPayment(db, doc.k)) touched.add(id);
  } else if (doc.t === 'payment_allocations') {
    if (!d) { touched.add(ALL_INSTALLMENTS); return; }
    if (d.installment_id) touched.add(String(d.installment_id));
  }
}
const ALL_INSTALLMENTS = '*';

/**
 * تطبيق الصندوق الوارد كله · بترتيب الآباء قبل الأبناء، ومرور ثانٍ وثالث لما انتظر أباً
 * وصل في المرور نفسه (قيد عكسي بعد أصله مثلاً). ما بقي ينتظر أباه يبقى للدورة التالية.
 */
export function applyInbox(db: DB, deviceId: string): { applied: number; conflicts: number; rejected: number; waiting: number } {
  const cache = new Map<string, Set<string>>();
  const money = moneyColumns(db); // مرة لكل تطبيق لا لكل صف
  const joining = getSyncState(db, 'joining') === '1';
  let applied = 0, conflicts = 0, rejected = 0;
  const wasOn = captureOn(db);
  setCapture(db, false); // الوارد لا يرتدّ صداه إلى الطابور الصادر
  // دفعةٌ سُجّلت على جهاز آخر لا يرفضها فحص «المتبقي» المحلي · يُحدّ المسدَّد بعد التطبيق ويظهر الزائد فائضاً
  setApplying(db, true);
  const touched = new Set<string>();
  try {
    for (let pass = 0; pass < 4; pass++) {
      let progress = 0;
      // شواهد الحذف أولاً والأبناء قبل الآباء (المفتاح الأجنبي يمنع حذف أبٍ له أبناء) · ثم الصفوف
      // والآباء قبل الأبناء · وإلا وصل صفٌّ جديد يحمل رقماً فريداً قبل حذف من كان يحمله فرُفض بلا رجعة
      // (وجده اختبار الثوابت: عقد حُذف باستعادة ثم أُنشئ غيره بالرقم نفسه)
      for (const deletes of [true, false]) {
        const key = deletes ? '(1000 - rank)' : 'rank';
        let lastKey = -1, lastU = '', lastDoc = '';
        for (;;) {
          const page = db.all<{ doc: string; k: number; updated_at: string; payload: string; attempts: number }>(
            `SELECT doc, ${key} AS k, updated_at, payload, attempts FROM sync_inbox
             WHERE COALESCE(json_extract(payload, '$.del'), 0) = ? AND (${key}, updated_at, doc) > (?, ?, ?)
             ORDER BY ${key}, updated_at, doc LIMIT 300`, [deletes ? 1 : 0, lastKey, lastU, lastDoc]);
          if (!page.length) break;
          db.transaction(() => {
            for (const r of page) {
              const doc = JSON.parse(r.payload) as RemoteDoc;
              const out = applyOne(db, doc, deviceId, cache, money, joining);
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
              if (out === 'applied' || out === 'conflict-remote') markTouched(db, doc, touched);
              if (out === 'applied') applied++;
              else if (out === 'conflict-local' || out === 'conflict-remote') { conflicts++; if (out === 'conflict-remote') applied++; }
              else if (out === 'rejected') rejected++;
            }
          });
          const last = page[page.length - 1];
          lastKey = last.k; lastU = last.updated_at; lastDoc = last.doc;
        }
      }
      if (!progress) break;
      const left = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox`)!.n);
      if (!left) break;
    }
  } finally {
    setApplying(db, false);
    // المسدَّد والحالة من الدفعات للأقساط التي مسّها الوارد · وما حُسب لا يرتدّ إلى الطابور
    try { recomputeInstallments(db, touched.has(ALL_INSTALLMENTS) ? undefined : [...touched]); }
    finally { setCapture(db, wasOn); }
  }
  const waiting = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox`)!.n);
  return { applied, conflicts, rejected, waiting };
}

/* ═══════════ اعتماد نسخة مستعادة واستبدال السحابة بها ═══════════ */

/**
 * ما في السحابة مقابل القاعدة بعد الاستعادة · يُقرأ والمزامنة متوقفة، قبل أن يُكتب شيء.
 * `tombstones` صفوفٌ في السحابة ليست في النسخة فتُحذف منها بشاهد حذف ·
 * و`immutable` ما لا تحذفه قواعد الأمان أصلاً: سطور سجل العمليات تُضمّ إلى النسخة (إضافةٌ لا تغيّر
 * رقماً، فلا يفترق بها جهازان) · والقيد المرحّل بعد النسخة يمنع الاعتماد (CloudReplaceBlockedError):
 * لا يُحذف من السحابة ولا يُترك فيها وحدها، فاستعادة نسخة أقدم منه تفرّق دفاتر الأجهزة.
 */
export interface CloudReplacePlan {
  /** آخر مؤشر في السحابة · المزامنة بعد الاعتماد تبدأ منه فلا تسحب ما استُبدل */
  cursor: Cursor | null;
  /** مستندات السحابة الحية · للعرض */
  cloudRows: number;
  tombstones: { t: string; k: string }[];
  immutable: { entries: number; audit: number };
  /** سطور سجل العمليات في السحابة وليست في النسخة · تُضمّ إليها عند الاعتماد */
  absorb: RemoteDoc[];
}

/** في السحابة قيود مرحّلة بعد النسخة · لا اعتماد */
export class CloudReplaceBlockedError extends Error {
  constructor(public entries: number) {
    super(`في السحابة ${entries} قيد مرحّل ليس في هذه النسخة (رُحّل بعد تاريخها من هذا الجهاز أو غيره) · `
      + 'القيد المرحّل لا يُحذف من السحابة، واستبدالها بنسخة أقدم منه يفرّق دفاتر الأجهزة · '
      + 'استعد نسخةً أحدث منه، أو ألغِ الاستعادة');
    this.name = 'CloudReplaceBlockedError';
  }
}

const PLAN_PAGE = 500;

/** صف السحابة موجود في القاعدة المحلية؟ · بمفتاحه الأساسي */
function existsLocally(db: DB, t: string, k: string): boolean {
  if (!syncTable(t)) return true; // جدول خارج المزامنة · لا يُمسّ
  return !!db.get(`SELECT 1 FROM "${t}" WHERE ${pkWhere(t)}`, pkParams(t, k));
}

export async function planCloudReplace(
  db: DB, remote: RemoteStore, onProgress?: (msg: string) => void
): Promise<CloudReplacePlan> {
  let cursor: Cursor | null = null;
  let cloudRows = 0;
  // آخر حالة لكل مستند · الصفحات مرتبة بوقت الخادم فالأحدث يغلب
  const last = new Map<string, { t: string; k: string; del: boolean; posted: boolean; doc: RemoteDoc | null }>();
  for (;;) {
    onProgress?.('جاري قراءة ما في السحابة' + (last.size ? ' · ' + last.size : ''));
    const { docs, next } = await remote.pull(cursor, PLAN_PAGE);
    for (const d of docs) {
      last.set(d.id, { t: d.t, k: d.k, del: d.del, posted: d.t === 'journal_entries' && d.d?.status === 'مرحّل', doc: d.t === 'audit_log' ? d : null });
    }
    if (next) cursor = next;
    if (docs.length < PLAN_PAGE) break;
  }
  const tombstones: { t: string; k: string }[] = [];
  const immutable = { entries: 0, audit: 0 };
  const absorb: RemoteDoc[] = [];
  for (const d of last.values()) {
    if (d.del) continue;
    cloudRows++;
    if (existsLocally(db, d.t, d.k)) continue;
    if (d.t === 'audit_log') { immutable.audit++; if (d.doc) absorb.push(d.doc); }
    else if (d.posted) immutable.entries++;
    else tombstones.push({ t: d.t, k: d.k });
  }
  return { cursor, cloudRows, tombstones, immutable, absorb };
}

/**
 * القاعدة المستعادة هي الحقيقة لهذا الحساب: كل صف فيها يدخل الطابور بوقت الآن فيغلب ما في
 * السحابة، وما في السحابة وليس فيها يُحذف بشاهد حذف، والمؤشر إلى آخر ما قُرئ فلا يعود الوارد
 * القديم فوقها. لا كتابة إلى السحابة هنا · الرفع في دورة المزامنة التالية بعد الاعتماد.
 */
export function adoptAsCloudTruth(db: DB, uid: string, plan: CloudReplacePlan): { queued: number } {
  if (plan.immutable.entries > 0) throw new CloudReplaceBlockedError(plan.immutable.entries);
  return db.transaction(() => {
    const at = nowIso();
    setCapture(db, false);
    // سجل العمليات في السحابة يُضمّ كما هو · إضافة فقط
    const cols = columnsOf(db, 'audit_log');
    for (const d of plan.absorb) {
      const keys = Object.keys(d.d ?? {}).filter((c) => cols.has(c));
      if (!keys.length) continue;
      db.run(`INSERT OR IGNORE INTO audit_log (${keys.map((c) => `"${c}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
        keys.map((c) => d.d![c] as SqlValue));
    }
    db.run(`DELETE FROM sync_inbox`);
    db.run(`DELETE FROM sync_outbox`);
    setSyncState(db, 'uid', uid);
    setSyncState(db, 'cursor', plan.cursor ? JSON.stringify(plan.cursor) : null);
    setSyncState(db, 'joining', null);
    setSyncState(db, 'restored_unadopted', null);
    unifySeedIds(db);
    for (const t of SYNC_TABLES) {
      db.run(
        `INSERT INTO sync_outbox (tbl, pk, op, changed_at)
         SELECT '${t.name}', ${t.pk(t.name)}, 'upsert', ? FROM "${t.name}" WHERE true`, [at]);
    }
    for (const x of plan.tombstones) {
      db.run(`INSERT INTO sync_outbox (tbl, pk, op, changed_at) VALUES (?,?, 'delete', ?)
              ON CONFLICT(tbl, pk) DO UPDATE SET op = 'delete', changed_at = excluded.changed_at`, [x.t, x.k, at]);
    }
    setCapture(db, true);
    return { queued: outboxCount(db) };
  });
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

/**
 * المزامنة الكبيرة الأولى (آلاف الصفوف) تصطدم بحصة الخادم أو انشغاله · فلا تُسقط الدورة كلها:
 * تنتظر وتعيد بمهلة تتضاعف، وتصغّر الدفعة، وإن طال الرفض أجّلت الدورات التالية مدةً ثم استأنفت
 * من الطابور نفسه. ولا ضياع ولا تكرار: الصف لا يخرج من الطابور إلا بعد قبول الخادم له،
 * ومعرّف المستند ثابت (الجدول__المفتاح) فإعادة الكتابة تستبدل ولا تضيف.
 */
export interface SyncOptions {
  /** للاختبار: انتظار بلا وقت حقيقي */
  sleep?: (ms: number) => Promise<void>;
  /** محاولات متتالية قبل التأجيل */
  maxRetries?: number;
  /** أول مهلة · تتضاعف حتى دقيقة */
  baseDelayMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_DELAY_MS = 60_000;
/** تأجيل الدورات بعد استنفاد المحاولات · ربع ساعة */
export const BACKOFF_PAUSE_MS = 15 * 60_000;
const MIN_PUSH_BATCH = 25;

/** خطأ عابر يستحق الانتظار والإعادة · الحصة والانشغال وانقطاع المهلة */
export function isTransientRemoteError(e: unknown): boolean {
  const status = (e as { status?: unknown })?.status;
  if (typeof status === 'number' && [408, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /RESOURCE_EXHAUSTED|UNAVAILABLE|ABORTED|DEADLINE_EXCEEDED|quota/i.test(msg);
}

/** المزامنة مؤجَّلة بعد رفضٍ متكرر؟ · تعيد وقت الاستئناف أو null */
export function syncBackoffUntil(db: DB, now: Date = new Date()): string | null {
  const v = getSyncState(db, 'backoff_until');
  return v && v > now.toISOString() ? v : null;
}

export class SyncBusyError extends Error {
  constructor(public pushed: number, public total: number, public until: string) {
    super(`السحابة مشغولة أو بلغت حصتها · رُفع ${pushed} من ${total} والباقي محفوظ في الطابور، ويُستأنف تلقائياً بعد ربع ساعة`);
    this.name = 'SyncBusyError';
  }
}

export async function syncOnce(
  db: DB,
  remote: RemoteStore,
  deviceId: string,
  onProgress?: (msg: string) => void,
  opts: SyncOptions = {}
): Promise<SyncReport> {
  const sleep = opts.sleep ?? realSleep;
  const maxRetries = opts.maxRetries ?? 6;
  const base = opts.baseDelayMs ?? 1000;

  /** النداء نفسه بإعادة بعد مهلة تتضاعف · وما ليس عابراً يُرمى فوراً */
  const retrying = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        if (!isTransientRemoteError(e) || attempt >= maxRetries) throw e;
        const delay = Math.min(base * 2 ** attempt, MAX_DELAY_MS);
        onProgress?.('السحابة مشغولة · إعادة المحاولة بعد ' + Math.ceil(delay / 1000) + ' ثانية');
        await sleep(delay);
      }
    }
  };
  const giveUp = (pushed: number, total: number): never => {
    const until = new Date(Date.now() + BACKOFF_PAUSE_MS).toISOString();
    setSyncState(db, 'backoff_until', until);
    throw new SyncBusyError(pushed, total, until);
  };

  // ٠) حرف الجهاز في ترقيم الحساب قبل أي كتابة · مرة واحدة (numbering.ts)
  if (remote.registerDevice && !deviceLetterAssigned(db)) {
    setDeviceLetter(db, await retrying(() => remote.registerDevice!(deviceId)));
  }

  // ١) السحب إلى الصندوق الوارد · المؤشر يُحفظ بعد حفظ كل صفحة
  let pulled = 0;
  const saved = getSyncState(db, 'cursor');
  let cursor: Cursor | null = saved ? (JSON.parse(saved) as Cursor) : null;
  for (;;) {
    onProgress?.('جاري سحب التغييرات' + (pulled ? ' · ' + pulled : ''));
    let page: { docs: RemoteDoc[]; next: Cursor | null };
    try { page = await retrying(() => remote.pull(cursor, PULL_PAGE)); }
    catch (e) { if (isTransientRemoteError(e)) giveUp(0, outboxCount(db)); throw e; }
    const { docs, next } = page!;
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

  // ٣) الدفع · على دفعات بتقدّم ظاهر «ن من م»، والدفعة تصغر عند الانشغال
  let pushed = 0;
  const total = outboxCount(db);
  let size = PUSH_BATCH;
  let failures = 0;
  for (;;) {
    const batch = pendingOutbox(db, size);
    if (!batch.length) break;
    onProgress?.('جاري رفع التغييرات · ' + pushed + ' من ' + total);
    const docs = batch.map((r) => buildDoc(db, r.tbl, r.pk, r.op, r.changed_at, deviceId));
    let results: WriteResult[];
    try {
      results = await remote.write(docs);
      failures = 0;
    } catch (e) {
      // انقطاع الاتصال وما ليس عابراً · الطابور كما هو ويُستأنف عند عودته
      if (!isTransientRemoteError(e)) throw e;
      if (failures >= maxRetries) giveUp(pushed, total);
      // الدفعة تُبنى من جديد أصغر · وتُنتظر مهلة تتضاعف
      size = Math.max(MIN_PUSH_BATCH, Math.floor(size / 2));
      const delay = Math.min(base * 2 ** failures, MAX_DELAY_MS);
      failures++;
      onProgress?.('السحابة مشغولة · إعادة المحاولة بعد ' + Math.ceil(delay / 1000) + ' ثانية');
      await sleep(delay);
      continue;
    }
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

  setSyncState(db, 'backoff_until', null);
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

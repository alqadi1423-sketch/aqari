/**
 * محرّك المزامنة · القاعدة المحلية مصدر الحقيقة والسحابة طبقة مضافة.
 *
 * الدورة: سحب ما كُتب في السحابة بعد المؤشر إلى صندوق وارد محفوظ ← تطبيقه بترتيب
 * الآباء قبل الأبناء ← دفع الطابور الصادر. كل خطوة تُستأنف إن انقطع الاتصال في منتصفها.
 *
 * القواعد:
 *  - التعارض يُحلّ على مستوى الصف: الأحدث تغييراً يغلب (وقت التغيير ثم هوية الجهاز عند التساوي)،
 *    ويُسجَّل في سجل العمليات إن اختلف المضمون فعلاً. ووقت التغيير بساعة الخادم: كل جهاز يقيس فرق ساعته
 *    من وقت الالتزام في كل كتابة، فيكتب u مصحَّحاً ويصحّح به تعديله المعلّق عند المقارنة (المراجعة ٤.١٦).
 *  - القيد المرحّل إضافة فقط: لا يُعدَّل ولا يُحذف بالمزامنة · يُسمح بربطه بقيده العكسي مرة واحدة.
 *  - كل صف وارد يُكتب داخل نقطة حفظ ثم يمرّ بفحصين قبل اعتماده: محفّزات القاعدة (توازن القيد ·
 *    سقف القسط · المفاتيح) ثم فحص الاستعادة نفسه semanticIssues محصوراً في الصف وما يمسّه
 *    (توازن القيد وسطوره · سقف القسط · الدفعة السالبة · الأعداد الصحيحة). أي إخفاق يُرجع نقطة
 *    الحفظ فلا يبقى من الصف أثر، ويُحفظ في sync_rejects ويُسجَّل، ولا يكسر بقية الدفعة.
 *  - المبالغ أعداد صحيحة بالهللات كما هي في القاعدة.
 */
import { SAME_KEY_SQL, sameKeyParams, keepInOrder, lineKeyBase, sameLineKey, statementsNeed, statementsKnown, statementWithRoom, resetStatementCounts } from '../domain/bankStatement/dedupe';
import { isSafeBlobName } from '../files/store';
import { mirrorIssue } from '../domain/accounting/mirror';
import { nextJournalNo } from '../domain/accounting/post';
import { nextPurchaseNo, PAY_LABEL } from '../domain/purchases';
import { postedAccum } from '../domain/assets/depreciation';
import { t as tr } from '../i18n';
import { isDbFault, TransactionAbortedError, type DB, type SqlValue } from '../db/adapter';
import { SYNC_TABLES, SYNC_RANK, LATER_SYNC_TABLES, syncTable } from '../db/syncTables';
import { logAudit } from '../domain/audit';
import { moneyColumns, semanticIssues, type SemanticScope } from '../domain/backup/semantic';
import { DISCOUNT_ENTRY_SRC, DEPOSIT_RENT_METHOD, DEPOSIT_RENT_SRC, DEPOSIT_RENT_EDIT_REASON, DEPOSIT_RENT_KEPT_REASON, SETTLEMENT_CLAIM_SOURCE } from '../domain/contracts/installments';
import { recomputeInstallments, installmentsOfPayment } from '../domain/contracts/paid';
import { paidFromDeposit, paidFromSettlement } from '../domain/contracts/cancelPayment';
import { depositCarryChain } from '../domain/contracts/depositChain';
import { blockRequests, addBlock } from '../domain/numbering';
import { markOrphans, recordForeignReview, foreignReviewRows, reviewState } from '../domain/accounting/orphans';
import { rentEntryIssue, allocationIssue, CREDIT_METHOD, type RentPaymentSrc, entryDimsIssue } from '../domain/accounting/derive';
import { filingRecordedAt } from '../domain/vatFilings';
import { isISODate } from '../domain/dates';
import { TS_DEDUCTIBLE } from '../domain/purchases';
import { walletCashBalance, bankBalance, ACC_OPENING_BALANCES } from '../domain/accounting/ledger';
import { MIGRATED_SYSTEM_ACCOUNTS } from '../db/seed';
import { CASH_DEPOSIT_SOURCE, CASH_WITHDRAW_SOURCE, TRANSFER_OUT_SOURCE, TRANSFER_IN_SOURCE } from '../domain/cashOps';
import { CRASH_ENTITY, FAILURE_ENTITY_PREFIX, retryCrashRank } from '../domain/crashReport';
import { memberSourceIssue, deductibleIssue, DERIVED_SOURCES, type SourceReader, type SrcLine } from '../domain/accounting/deriveSources';
import { RENT_REVENUE_GROUP, RENT_REVENUE_SQL } from '../domain/accounting/rentSplit';
import type { Cursor, PullPage, RemoteDoc, RemoteStore, RowData, SyncReport, WriteResult } from './types';
import { isoCmp, isoNorm } from './isoTime';
import { redactForReport } from '../domain/redact';
import { mulQty, pctOf, fmt } from '../domain/money';
import { OWNER_ONLY_COLS, POSTED_PURCHASE_COLS } from '../domain/access/opWrites';
import { READ_TABLE } from '../domain/access/readSections';

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

/** كل صف من كل جدول مزامَن إلى الطابور · بلا مسّ لما فيه أصلاً */
export function seedOutbox(db: DB): void {
  const at = nowIso();
  for (const t of syncedNow(db)) enqueueTable(db, t.name, at);
  // كل شيء يُرفع برموز الرؤية الحالية · فلا يلزمه رفعٌ آخر لها
  setSyncState(db, 'acl_version', String(ACL_VERSION));
}

/**
 * صفوف المرفقات تُزامَن حين يعمل تخزين الملفات وحده (sync_ctl.capture_files · الهجرة ٢٧) ·
 * فقبله لا تُلتقط ولا تُرفع، فلا يتغير شيء في السحابة حتى تُنشأ الحاوية وتُنشر قواعدها
 */
export function filesSyncOn(db: DB): boolean {
  return Number(db.get<{ v: number }>(`SELECT v FROM sync_ctl WHERE k = 'capture_files'`)?.v ?? 0) === 1;
}
const FILE_TABLES = new Set(LATER_SYNC_TABLES.map((t) => t.name));
/** جداول المزامنة الجارية الآن على هذا الجهاز */
function syncedNow(db: DB) {
  return filesSyncOn(db) ? SYNC_TABLES : SYNC_TABLES.filter((t) => !FILE_TABLES.has(t.name));
}

/** يشغّل مزامنة صفوف المرفقات أو يوقفها · وأول تشغيل يرفع ما فيها كله مرة · يعيد true إن تغيّر شيء */
export function setFilesSync(db: DB, on: boolean): boolean {
  if (filesSyncOn(db) === on) return false;
  db.transaction(() => {
    db.run(`INSERT INTO sync_ctl (k, v) VALUES ('capture_files', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [on ? 1 : 0]);
    if (on && captureOn(db)) { const at = nowIso(); for (const t of LATER_SYNC_TABLES) enqueueTable(db, t.name, at); }
  });
  return true;
}

function enqueueTable(db: DB, table: string, at: string): void {
  const t = syncTable(table)!;
  db.run(
    `INSERT INTO sync_outbox (tbl, pk, op, changed_at)
     SELECT '${t.name}', ${t.pk(t.name)}, 'upsert', ? FROM "${t.name}"
     WHERE true ON CONFLICT(tbl, pk) DO NOTHING`, [at]);
}

/**
 * إصدار قواعد الرؤية (acl.ts) · وما وسّع إصدارٌ قرّاءه من الجداول يُرفع مرة من جهاز المالك ليحمل رموزه الجديدة،
 * فالرموز تُحسب عند الرفع وما في السحابة يبقى بقديمها.
 * ٢: قيد المستند يقرؤه كل قسم مالي يقرأ مستنده (أعطال ٢٠٢٦-١٠-٠٥: دفعات عضو العقود تنتظر قيودها بلا نهاية).
 */
export const ACL_VERSION = 2;
const ACL_WIDENED: Record<number, string[]> = { 2: ['journal_entries'] };

/** يعيد عدد الجداول التي أُعيدت إلى الطابور · جهاز المالك في المنشأة وحده: العضو لا يملك تعديل ما لم يكتبه */
export function requeueForAcl(db: DB): number {
  if (getSyncState(db, 'membership') || !getSyncState(db, 'org')) return 0;
  const from = Number(getSyncState(db, 'acl_version') ?? 1);
  if (from >= ACL_VERSION) return 0;
  const tables = new Set<string>();
  for (let v = from + 1; v <= ACL_VERSION; v++) for (const t of ACL_WIDENED[v] ?? []) tables.add(t);
  db.transaction(() => {
    const at = nowIso();
    for (const t of tables) enqueueTable(db, t, at);
    setSyncState(db, 'acl_version', String(ACL_VERSION));
  });
  return tables.size;
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

/** فرق ساعة هذا الجهاز عن الخادم بالمللي ثانية (الخادم ناقص الجهاز) · صفر ما لم يُقس */
export function clockSkewMs(db: DB): number {
  const v = Number(getSyncState(db, 'clock_skew_ms'));
  return Number.isFinite(v) ? v : 0;
}

/** وقتٌ بساعة الجهاز إلى ساعة الخادم · بصيغة واحدة (أجزاء الألف) أياً كانت دقة كسوره (المراجعة الشاملة · البند ١٦) */
export function toServerClock(db: DB, iso: string): string {
  const skew = clockSkewMs(db);
  const t = Date.parse(isoNorm(iso));
  return skew && Number.isFinite(t) ? new Date(t + skew).toISOString() : isoNorm(iso);
}

/** وقتٌ بساعة الخادم إلى ساعة الجهاز · عكس toServerClock، فما يُدرج في الطابور بوقتٍ وارد يُرفع بالوقت نفسه */
export function fromServerClock(db: DB, iso: string): string {
  const skew = clockSkewMs(db);
  const t = Date.parse(isoNorm(iso));
  return skew && Number.isFinite(t) ? new Date(t - skew).toISOString() : isoNorm(iso);
}

/** فرقٌ دون ثانية ضجيجُ شبكة لا ساعة منحرفة · فلا يُحفظ */
const SKEW_NOISE_MS = 1000;
function recordClockSample(db: DB, s: { serverMs: number; localMs: number } | null | undefined): void {
  if (!s || !Number.isFinite(s.serverMs) || !Number.isFinite(s.localMs)) return;
  const skew = Math.round(s.serverMs - s.localMs);
  setSyncState(db, 'clock_skew_ms', Math.abs(skew) < SKEW_NOISE_MS ? null : String(skew));
}

export function buildDoc(db: DB, table: string, key: string, op: 'upsert' | 'delete', changedAt: string, deviceId: string): RemoteDoc {
  // u بساعة الخادم · فيقارنه كل جهاز بتعديله المصحَّح مثله (المراجعة ٤.١٦)
  // وعهد المسح الذي يعرفه الجهاز بعد أول مسح (المراجعة الخارجية ٧ · النتيجة ٢٣)
  const ep = Number(getSyncState(db, 'wipe_epoch') ?? 0);
  const base = { id: docId(table, key), t: table, k: key, u: toServerClock(db, changedAt), dev: deviceId, ...(ep > 0 ? { ep } : {}) };
  const row = op === 'upsert' ? readRow(db, table, key) : undefined;
  if (!row) {
    // حاذفه (المراجعة الخارجية ٧ · النتيجة ٢): القواعد تشترطه لحذف العضو، والأجهزة لا تُسلسل إلا حذف المالك
    const dby = getSyncState(db, 'uid');
    return { ...base, d: null, del: true, ...(dby ? { dby } : {}) };
  }
  const doc: RemoteDoc = { ...base, d: stripDerived(table, row), del: false };
  if (table === 'journal_entries') doc.lines = readLines(db, key);
  // والقيد نفسه برقمٍ آخر في السحابة يُرفع برقمه هناك (المدقق الخارجي Y٥: عكسه برقمه هنا كان يُرفض «نهائياً» كل مرة)
  if (table === 'journal_entries' && typeof doc.d!.no === 'string' && doc.d!.no) doc.d!.no = cloudJournalNo(db, doc.d!.no);
  if (table === 'bank_tx' && typeof doc.d!.journal_no === 'string' && doc.d!.journal_no) doc.d!.journal_no = cloudJournalNo(db, doc.d!.journal_no);
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

/** أسباب رفضٍ مصدرها مخطط الجهاز الأقدم: قيد CHECK أو عمودٌ أو جدولٌ لا يعرفه · يُعاد واردها بعد الترقية */
const SCHEMA_REJECT = /CHECK constraint failed|has no column named|no such column|no such table/i;

/**
 * رفضٌ دائم من السحابة لصفٍّ بعينه (المراجعة الشاملة · البند ١٥): مستندٌ يرفضه الخادم لبنيته أو لحجمه لا تفيده الإعادة، وبقاؤه في رأس
 * الطابور كان يسدّه · فيخرج إلى سجل المرفوض بسببه، ويعود إلى الطابور إن عُدّل الصف أو بعد ترقية التطبيق
 */
const PERMANENT_PUSH_CODES = new Set(['INVALID_ARGUMENT', 'DOC_TOO_LARGE']);
const PERMANENT_PUSH_REASON = 'رفضته السحابة رفضاً دائماً'; // i18n-exempt: بادئة سبب الرفض المخزَّن

/**
 * مرفوضٌ مما كتبه هذا الجهاز ولم يبلغ السحابة: لصلاحيته، أو رفضاً دائماً، أو قيدٌ نسخته في السحابة نهائية · لا ما رُفض تطبيقه من الوارد ·
 * فهو من «ما لم يُرفع من عمله» حين يخرج العضو من المنشأة (المراجعة الشاملة 2026-11-13 · B-4 · domain/memberExit.ts)
 */
export function isUploadReject(reason: string): boolean {
  return reason.startsWith('خارج صلاحيتك') || reason.startsWith(PERMANENT_PUSH_REASON) || reason === FINAL_IN_CLOUD; // i18n-exempt: بادئة سبب الرفض المخزَّن
}

/** مفتاح آخر إصدارٍ أُعيد فيه المرفوض */
export const REJECTS_REPLAYED_KEY = 'rejects_replayed_sv';

/**
 * بعد ترقية التطبيق، مرة لكل إصدار (التحقق المستقل من #36 والهجرة ٤٠): ما رُفض رفعه لصلاحيته يعود إلى الطابور، وما رُفض
 * تطبيقه من الوارد (قيد مخططٍ أقدم كمورد الغاز) يعود إلى صندوق الوارد · فلا يضيع ما كتبه إصدارٌ أقدم أو ما وصله
 */
export function replayRejectsAfterUpgrade(db: DB, sv: number): { requeued: number; restaged: number } {
  if (getSyncState(db, REJECTS_REPLAYED_KEY) === String(sv)) return { requeued: 0, restaged: 0 };
  let requeued = 0, restaged = 0;
  const rows = db.all<{ id: number; tbl: string; pk: string; reason: string; payload: string }>(
    `SELECT id, tbl, pk, reason, payload FROM sync_rejects ORDER BY id`);
  db.transaction(() => {
    for (const r of rows) {
      const t = syncTable(r.tbl);
      if (r.reason.startsWith('خارج صلاحيتك') || r.reason.startsWith(PERMANENT_PUSH_REASON)) { // i18n-exempt: بادئة سبب الرفض المخزَّن
        if (!t) continue;
        const where = t.pkCols.map((c) => `"${c}" = ?`).join(' AND ');
        const exists = !!db.get(`SELECT 1 FROM "${r.tbl}" WHERE ${where}`, pkParams(r.tbl, r.pk));
        db.run(`INSERT INTO sync_outbox (tbl, pk, op, changed_at) VALUES (?, ?, ?, ?) ON CONFLICT(tbl, pk) DO NOTHING`,
          [r.tbl, r.pk, exists ? 'upsert' : 'delete', nowIso()]);
        requeued++;
      } else {
        // لسبب المخطط وحده: ما رُفض لغيره قد طُبّق بعده أحدث منه، فإعادته تُرجع الصف إلى نسخته القديمة (التحقق المستقل من 21ff082)
        if (!SCHEMA_REJECT.test(r.reason)) continue;
        let doc: RemoteDoc | null = null;
        try { doc = JSON.parse(r.payload) as RemoteDoc; } catch { doc = null; }
        if (!doc || !doc.id || !doc.t) continue;
        stageInbox(db, [doc]);
        restaged++;
      }
      db.run(`DELETE FROM sync_rejects WHERE id = ?`, [r.id]);
    }
    setSyncState(db, REJECTS_REPLAYED_KEY, String(sv));
  });
  return { requeued, restaged };
}

export function stageInbox(db: DB, docs: RemoteDoc[]): void {
  db.transaction(() => {
    for (const d of docs) {
      // الأحدث بوقت الخادم وحده، ومن يغلب الصفَّ المحلي يقرّره التطبيق (المراجعة الخارجية ٧ · النتيجة ١٩: نسخةٌ بـ u = 2099 تنتظر أباها
      // كانت تغلب النسخة الأحدث الصحيحة فيُطبَّق القديم ويتجاوزه المؤشر · والمتحقق المستقل، الجولة ٣٠: وكاتبٌ ساعته متأخرة كذلك) ·
      // والوارد بلا وقت خادم بوقته المعلن كما كان
      // بصيغة واحدة: وقت الخادم بأجزاء المليون أو أقل، ووقت الجهاز بأجزاء الألف، والمقارنة نصاً بينهما تخطئ (البند ١٦)
      const at = isoNorm(d.ts || d.u);
      db.run(
        `INSERT INTO sync_inbox (doc, tbl, pk, rank, payload, updated_at, device_id, attempts, last_error, del)
         VALUES (?,?,?,?,?,?,?,0,NULL,?)
         ON CONFLICT(doc) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at,
           device_id = excluded.device_id, attempts = 0, last_error = NULL, del = excluded.del, waiting_since = NULL
         WHERE excluded.updated_at >= sync_inbox.updated_at`,
        [d.id, d.t, d.k, SYNC_RANK[d.t] ?? 999, JSON.stringify(d), at, d.dev, d.del ? 1 : 0]);
      // كاتب الصف يصل مع مستنده (المنشأة) · فيعرف الجهاز مسودة من هي، ويرسل العضو الكاتب نفسه عند التعديل · والوارد بلا كاتب
      // يُعلَّم «بلا كاتب» فلا يُرسَل له كاتب (القواعد: الكاتب لا يتغير · الهجرة ٤٢)
      db.run(`INSERT OR IGNORE INTO row_by (tbl, pk, uid) VALUES (?, ?, ?)`, [d.t.split('~')[0], d.k, d.by ?? '']);
    }
  });
}

/** نصّ القاعدة لمفتاح أجنبي ناقص · يُعاد المستند لاحقاً حين يصل أبوه */
const isMissingParent = (msg: string) => /FOREIGN KEY constraint failed/i.test(msg);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX_ATTEMPTS = 20;
/**
 * مهلة انتظار الأب بالزمن لا بالمرور (المراجعة الشاملة · البند ١٤): أبٌ غائب مؤقتاً (جهازٌ لم يرفع بعد، أو رفعٌ انقطع) كان يصير رفضاً
 * نهائياً بعد نحو عشر دورات · فلا رفض قبل ثلاثين يوماً من بدء الانتظار ولا قبل MAX_ATTEMPTS محاولة معاً
 */
const WAIT_LIMIT_MS = 30 * 24 * 3600 * 1000;
/** سبب رفض الانتظار الطويل · ويُعاد واردُه حين يصل أبوه */
const WAIT_REJECT = 'سجل أب غير موجود بعد محاولات متكررة';

/**
 * سطور مستند القيد كائناتٌ وحدها (المدقق الخارجي هـ٨: عنصرٌ null في سطور قيد عضوٍ كان يرمي خارج الحماية فتسقط دورة التطبيق كلها على كل
 * جهاز) · ومستندٌ سطوره ليست قائمة كائنات يُرفض وحده في applyOne
 */
const docLines = (doc: RemoteDoc | null | undefined): Array<Record<string, unknown>> =>
  (Array.isArray(doc?.lines) ? doc!.lines : []).filter((l): l is NonNullable<typeof l> => !!l && typeof l === 'object' && !Array.isArray(l)) as never;
// والسطر الذي في حقلٍ منه كائنٌ أو قائمة مشوَّهٌ كذلك (المدقق الخارجي G · M١: كان ينتظر ثلاثين يوماً ثم يرمي ربطه في إعادة الانتظار
// خارج الحماية فيتوقف التطبيق كله على جهاز المالك في كل دورة)
const scalar = (v: unknown) => v == null || typeof v !== 'object';
const linesMalformed = (doc: RemoteDoc): boolean =>
  doc.lines != null && (!Array.isArray(doc.lines) || doc.lines.some((l) => !l || typeof l !== 'object' || Array.isArray(l)
    || !Object.values(l as Record<string, unknown>).every(scalar)));

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
}
/** مقارنة المضمون لا الشكل · فـ 5 و 5.0 والترتيب لا تُحسب اختلافاً */
/**
 * المستند الوارد بمعرّف هذا الجهاز صدىً حقاً: محتواه كالصف المحلي (أو الصف محذوفٌ والمستند حذف) · أو للصف تعديلٌ هنا لم يُرفع
 * بعد، فالوارد كتابته الأقدم وتغلبه الأحدث عند رفعها (لا «تعارض» مع نفسه)
 */
function isEcho(db: DB, doc: RemoteDoc, deviceId: string): boolean {
  if (db.get(`SELECT 1 FROM sync_outbox WHERE tbl = ? AND pk = ?`, [doc.t, doc.k])) return true;
  // شاهد حذفٍ والصف قائمٌ هنا، أو بحاذفٍ غير صاحب هذا الجهاز: ليس صدى ما حذفه هذا الجهاز (المتحقق المستقل، الجولة ٣٧: عضوٌ
  // ينتحل معرّف جهاز المالك فيُتخطّى شاهده صامتاً)
  if (doc.del && ((doc.dby && doc.dby !== getSyncState(db, 'uid')) || readRow(db, doc.t, doc.k))) return false;
  try {
    const local = buildDoc(db, doc.t, doc.k, doc.del ? 'delete' : 'upsert', doc.u, deviceId);
    return sameContent(local, doc);
  } catch {
    return false;
  }
}

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
 * عقدٌ ملغى قُصّت نهايته (end = cancel_date) وصل ونهايته المتفق عليها غير معروفة: مستندٌ رفعه إصدارٌ قبل الهجرة ٤٨ بلا original_end
 * (والهجرة لا ترفع ما عبّأته)، أو جهازٌ لم يعرفها فرفعها فارغة · تبقى فارغةً فيشتقها الاستحقاق من جدول أقساطه بقاعدة الهجرة نفسها
 * (accrual.ts: agreedEnd) كما على الجهاز المرقّى · ومحفّز الإدراج كان يملؤها بالمقصوصة فتُحسب نهايةً معروفة، فلا يُفرَّق بينها وبين
 * عقدٍ أُلغي بعد الهجرة في يوم نهايته (المراجعة الشاملة · البند ٣ · تتمة المراجعة الأخيرة) · ومستندٌ بلا الحقل لصفٍّ قائم لا يمسّه
 */
function keepUnknownOriginalEnd(db: DB, id: string, row: RowData, fresh: boolean): void {
  if (row.original_end || (!('original_end' in row) && !fresh)) return;
  db.run(`UPDATE contracts SET original_end = NULL WHERE id = ? AND status = ? AND cancel_date IS NOT NULL AND end = cancel_date
            AND (original_end IS NULL OR original_end = end)`, [id, 'ملغى']); // i18n-exempt: حالة العقد المخزّنة
}

/**
 * القيد · الوحدة: القيد وسطوره معاً.
 * المرحّل محلياً لا يتغيّر إلا بربط قيده العكسي مرة واحدة · والوارد مرحّلاً يُنشأ مسودةً
 * بسطوره ثم يُرقّى فيمرّ بمحفّز التوازن كأي قيد.
 */
/**
 * ربط القيد بعاكسه · والعاكس لم يصل بعد (رفعٌ انقطع على جهاز آخر) لا يحبس القيد ولا دفعته في الوارد:
 * يُطبَّق القيد ويُحفظ الربط معلّقاً حتى يصل عاكسه (resolvePendingReversals)
 * والربط بمرآةٍ حقيقية وحدها (المراجعة الخارجية ٧ · النتيجة ١ · قرار المالك «رابعاً ١ (أ)»): عاكسٌ مزوّر بهللة كان يُلغي القيد
 * الحقيقي · فيُترك الربط ويُسجَّل رفضه، والقيد نفسه يُطبَّق
 */
const PENDING_REV = 'pending_reversal_links';
const linkRejected = (db: DB, entryId: string, why: string, doc?: RemoteDoc) =>
  reject(db, doc ?? ({ id: docId('journal_entries', entryId), t: 'journal_entries', k: entryId } as RemoteDoc), tr('mirror.linkRejected', { why, lng: 'ar' }));
/**
 * ربطٌ خمّنه جهاز المالك (memberReversalCheck: عاكسٌ قُبل ولم يصل ربطه) · والربط الذي يرسله جهاز العاكس هو المعتمد فيغلبه
 * (المتحقق المستقل، الجولة الثامنة عشرة: أصلان متطابقان، فخُمِّن أحدهما ثم وصل ربط الآخر فصار عاكسٌ واحد لأصلين)
 */
const GUESSED_REV = 'guessed_reversal_links';
const guessesOf = (db: DB) => JSON.parse(getSyncState(db, GUESSED_REV) ?? '{}') as Record<string, string>;

/**
 * الأصول المربوطة بالعاكس في خريطة ربطٍ محفوظة (المعلَّق والمخمَّن) · بفهرسٍ عكسي يُبنى مرةً لكل نصٍّ محفوظ (المدقق الخارجي B1: كانت
 * الخريطة تُحلَّل كاملةً لكل قيد عضو، ونصّها يكبر مع العواكس المنتظرة فيصير الفحص تربيعياً)
 */
const linkIndex = new Map<string, { raw: string; byRev: Map<string, string[]> }>();
function linksTo(key: string, raw: string | null, revId: string): string[] {
  const text = raw ?? '{}';
  let c = linkIndex.get(key);
  if (!c || c.raw !== text) {
    const byRev = new Map<string, string[]>();
    for (const [e, r] of Object.entries(JSON.parse(text) as Record<string, string>)) {
      const a = byRev.get(r);
      if (a) a.push(e); else byRev.set(r, [e]);
    }
    c = { raw: text, byRev };
    linkIndex.set(key, c);
  }
  return c.byRev.get(revId) ?? [];
}
const saveGuesses = (db: DB, g: Record<string, string>) => setSyncState(db, GUESSED_REV, Object.keys(g).length ? JSON.stringify(g) : null);

/**
 * الربط المعلَن: يُفكّ ما خُمِّن لهذا العاكس على أصلٍ آخر، ويغلب تخميناً على هذا الأصل (ويُعاد تخمين العاكس المُزاح) ·
 * والربط الحقيقي القائم لا يُمسّ · يعيد true إن رُبط
 */
function statedLink(db: DB, entryId: string, revId: string): boolean {
  const g = guessesOf(db);
  const cur = db.get<{ r: string | null }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [entryId])?.r ?? null;
  if (cur === revId) { if (g[entryId]) { delete g[entryId]; saveGuesses(db, g); } return true; }
  if (cur && g[entryId] !== cur) return false;
  for (const [e, r] of Object.entries(g)) {
    if (r === revId && e !== entryId) {
      db.run(`UPDATE journal_entries SET reversed_by = NULL WHERE id = ? AND reversed_by = ?`, [e, r]);
      delete g[e];
    }
  }
  delete g[entryId];
  db.run(`UPDATE journal_entries SET reversed_by = ? WHERE id = ?`, [revId, entryId]);
  saveGuesses(db, g);
  if (cur) guessLink(db, cur);
  return true;
}

function linkReversal(db: DB, entryId: string, revId: string, doc?: RemoteDoc): void {
  if (db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [revId])) {
    const why = mirrorIssue(db, entryId, revId);
    if (why) { linkRejected(db, entryId, why, doc); return; }
    statedLink(db, entryId, revId);
    return;
  }
  const pending = JSON.parse(getSyncState(db, PENDING_REV) ?? '{}') as Record<string, string>;
  pending[entryId] = revId;
  setSyncState(db, PENDING_REV, JSON.stringify(pending));
}
export function resolvePendingReversals(db: DB): number {
  const pending = JSON.parse(getSyncState(db, PENDING_REV) ?? '{}') as Record<string, string>;
  let done = 0, removed = 0;
  for (const [entryId, revId] of Object.entries(pending)) {
    if (!db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [revId])) continue;
    const why = mirrorIssue(db, entryId, revId);
    if (why) linkRejected(db, entryId, why);
    else if (statedLink(db, entryId, revId)) done++;
    delete pending[entryId];
    removed++;
  }
  // يُحفظ بكل ما خرج منه، رُبط أو رُفض (المتحقق المستقل: المرفوض كان يُسجَّل رفضه في كل دورة)
  if (removed) setSyncState(db, PENDING_REV, Object.keys(pending).length ? JSON.stringify(pending) : null);
  return done;
}

/** الأصل لم يصل بعد: يُعاد المستند في المرور التالي كالأب الناقص، ولا يُرفض (المتحقق المستقل، الجولة الحادية عشرة) */
class AwaitOriginal extends Error {}

/**
 * عكس سداد قسطٍ من التأمين أو إلغاء دفعته من عضو (المراجعة الشاملة 2026-11-13 · R12-DEP-3 · قرار A1-2: «لا تُلغى وحدها بل بتعديل
 * التسوية»): تعديل التسوية (reverseDepositRent) يكتب صفّ تسوية العقد صاحب التأمين في المعاملة نفسها، فشاهده نسخةٌ من الصف مكتوبةٌ معه أو
 * بعده هنا أو في الوارد ('ok') · وإلغاءٌ سببه غير سبب التعديل إلغاءٌ للدفعة وحدها (إصدارٌ قبل A1-2) فيُرفض ('no') · وما سواه ينتظر صفّ
 * التسوية ('await': يُرفع بعد القيود والدفعات وقد يصل في دفعةٍ بعدها، والمزوَّر يُرفض بطول انتظاره ولا أثر له قبل ذلك)
 */
function depositRentEdit(db: DB, depositContract: string, doc: RemoteDoc, reason: string | null | undefined): 'ok' | 'await' | 'no' {
  const at = incomingAt(doc);
  const inbox = db.get<{ payload: string }>(`SELECT payload FROM sync_inbox WHERE tbl = 'deposit_settlements' AND pk = ? AND del = 0`, [depositContract]);
  if (inbox && isoCmp(incomingAt(JSON.parse(inbox.payload) as RemoteDoc), at) >= 0) return 'ok';
  const seen = db.get<{ u: string }>(`SELECT u FROM sync_rowtime WHERE tbl = 'deposit_settlements' AND pk = ?`, [depositContract])?.u;
  if (seen && isoCmp(seen, at) >= 0) return 'ok';
  return reason != null && reason !== DEPOSIT_RENT_EDIT_REASON ? 'no' : 'await';
}

/**
 * العاكس المرحّل الوارد (المراجعة الخارجية ٧ · النتيجة ١ · المتحقق المستقل، الجولتان العاشرة والحادية عشرة): القواعد تقبل «_rev»
 * من الأعضاء بأي سطور وأي مصدر، والعضو بـ«كامل» يعدّل مسودة غيره فيبقى كاتبها · فجهاز المالك يفحص كل عاكسٍ مرحّل يصله أياً كان
 * كاتبه: مرآةً لأصلٍ قائم عنده (mirror.ts)، ولا عواكس أكثر من أصولها (كانت المرآة المكررة تضاعف أثر العكس) · وإلا رُفض المستند
 * كله فلا يدخل الدفتر · والأصل الذي لم يصل بعد يُنتظر · وجهاز العضو قد لا يرى الأصل فلا يُفحص فيه
 */
function memberReversalCheck(db: DB, doc: RemoteDoc): void {
  const src = (doc.d!.src_type as string | null) ?? null;
  if (!src || !src.endsWith('_rev') || getSyncState(db, 'membership')) return;
  const base = src.slice(0, -4);
  const srcId = (doc.d!.src_id as string | null) ?? '';
  // ولا استثناء لقيد عكس الإهلاك المحسوب في التراجع عن التحويل (assets/convert.ts: undoConversion): لا يستدعيه التطبيق بعد،
  // وكل استثناءٍ له كان ثغرةً وجدها المتحقق المستقل (الجولات ١٢ إلى ١٥) · يُعطى مصدراً خاصاً به حين تُبنى شاشته
  const originals = db.all<{ id: string }>(base === 'manual'
    // اليدوي بلا مصدر، أو بمصدر «manual» كما يقبله mirrorIssue
    ? `SELECT id FROM journal_entries WHERE id = ? AND (src_type IS NULL OR src_type = 'manual') AND status = 'مرحّل'` // i18n-exempt: حالة القيد المخزّنة
    : `SELECT id FROM journal_entries WHERE src_type = ? AND src_id = ? AND status = 'مرحّل'`, // i18n-exempt: حالة القيد المخزّنة
    base === 'manual' ? [srcId] : [base, srcId]);
  if (!originals.length) throw new AwaitOriginal(tr('mirror.noOriginal', { lng: 'ar' }));
  // وأصلٌ من المصدر نفسه في الوارد لم يُطبَّق بعد وهذا مرآته: يُنتظر ولا يُرفض العاكس (المدقق الخارجي I · L٧: إلغاء التقبيل واستعادته
  // ثم إلغاؤه ثانية، والعاكس الثاني يسبق نسخة الاستعادة بجزءٍ من الثانية، كان يُرفض نهائياً «عواكس أكثر من أصولها»)
  // والعاكس من عضوٍ بلا أصلٍ حرٍّ له هنا ينتظر ولا يُرفض: أصله قد يصل في دفعةٍ بعده (المدقق الخارجي K١ب: العضو يرفع على دفعات، فإن طبّق
  // المالك بينهما رُفض العاكس نهائياً) · والمزوَّر يُرفض بطول انتظاره ولا أثر له قبل ذلك
  const awaitPending = (extra: boolean) => {
    if (pendingOriginalOf(db, doc, base, srcId) || (extra && byMember(db, doc, true))) throw new AwaitOriginal(tr('mirror.noOriginal', { lng: 'ar' }));
  };
  // وأصلٌ في الوارد يسمّي هذا العاكس يُنتظر قبل أي تخمين، فلا يُقرن العاكس بغيره (K١)
  // (من مصدره نفسه، ولم يُرفض لطول انتظاره · المدقق الخارجي M٥: قيدٌ مزوَّر بمصدرٍ آخر ينتظر أبداً كان يحبس العاكس المشروع)
  if (db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND del = 0 AND json_extract(payload, '$.d.reversed_by') = ?
       AND json_extract(payload, '$.d.src_type') = ? AND json_extract(payload, '$.d.src_id') = ?
       AND pk NOT IN (SELECT id FROM journal_entries) AND doc NOT IN (SELECT doc FROM sync_rejects WHERE reason = ?)`, [doc.k, base, srcId, WAIT_REJECT])) {
    throw new AwaitOriginal(tr('mirror.noOriginal', { lng: 'ar' }));
  }
  const issues = originals.map((o) => mirrorIssue(db, o.id, doc.k));
  if (!issues.includes('')) { awaitPending(false); throw new Error(tr('mirror.revRejected', { why: issues[0], lng: 'ar' })); }
  // ولا يعكس عضوٌ قيد دفعةٍ سُدّدت من عربون الحجز (المراجعة الشاملة · البند ٢٧ · المتحقق المستقل: جهاز العضو بنسخة قديمة يلغيها،
  // و«الدفتر» يجيز له كل عكس) · وعكس المالك يُقبل كما كتبه، ورصيده العالق يُحمّر فحص عربون الحجوزات
  if (base === 'reservation_convert' && byMember(db, doc, true)
    && originals.some((o, i) => issues[i] === '' && db.get(`SELECT 1 FROM contract_payments /* تشمل الملغاة: ربط القيد بمستنده */ WHERE journal_entry_id = ?`, [o.id]))) { // i18n-exempt: تعليل الاستعلام لحارس الدفعات الملغاة
    throw new Error(tr('mirror.revRejected', { why: tr('payment.cancelFromDeposit', { lng: 'ar' }), lng: 'ar' }));
  }
  // ولا يعكس عضوٌ سداد قسطٍ من التأمين وحده (المراجعة الشاملة 2026-11-13 · R12-DEP-3 · كدفعة العربون أعلاه): يُعكس مع تعديل التسوية
  // وحده (depositRentEdit) · وإلغاء الدفعة وحدها من جهازٍ بإصدارٍ قبل A1-2 يُرفض فلا يعود القسط مستحقاً وقد سُدّد من التأمين
  if (base === DEPOSIT_RENT_SRC && byMember(db, doc, true)) {
    const matched = originals.filter((_, i) => issues[i] === '').map((o) => o.id);
    const pays = db.all<{ id: string }>(`SELECT id FROM contract_payments /* تشمل الملغاة: الدفعة التي يُلغيها هذا العاكس، ونسختها الواردة تحمل إلغاءه */ WHERE journal_entry_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(matched)]); // i18n-exempt: تعليل الاستعلام لحارس الدفعات الملغاة
    const reason = pays.map((p) => latestRowByKey<{ cancel_entry_id?: string | null; cancel_reason?: string | null }>(db, 'contract_payments', p.id))
      .find((p) => p?.cancel_entry_id === doc.k)?.cancel_reason;
    const edit = depositRentEdit(db, srcId, doc, reason);
    if (edit === 'await') throw new AwaitOriginal(tr('mirror.noOriginal', { lng: 'ar' }));
    if (edit === 'no') throw new Error(tr('mirror.revRejected', { why: tr('payment.cancelFromSettlement', { lng: 'ar' }), lng: 'ar' }));
  }
  // ولا يعكس عضوٌ قيد نقل أصلٍ ما دام حدث نقله قائماً (المدقق الخارجي ج٦): لا مسار في التطبيق يعكسه، وعكسه يعيد تكلفة الأصل في الدفتر
  // إلى وحدته القديمة وصفُّه وحدثه في الجديدة، فيُقبل به إهلاكٌ بالوحدة القديمة · وقيد النقل اليتيم (بلا حدثه) يُعكس كغيره
  // والحدث في الوارد لم يُطبَّق بعد كالقائم (المدقق الخارجي G · R١: أحداث الأصل تُطبَّق بعد القيود، فالنقل وحدثه وعاكسٌ مزوَّر في سحبٍ
  // واحد كانت تمرّر العاكس قبل الحدث)
  if (base === 'asset_transfer' && byMember(db, doc, true)
    && originals.some((o, i) => issues[i] === '' && (db.get(`SELECT 1 FROM asset_events WHERE entry_id = ?`, [o.id])
      // وجدول الأحداث بلا عمود حذف، فحقل «deleted_at» في مستنده لا يجعله محذوفاً (المدقق الخارجي I · R١ب)
      || db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'asset_events' AND del = 0 AND json_extract(payload, '$.d.entry_id') = ?`, [o.id])))) {
    throw new Error(tr('mirror.revRejected', { why: tr('mirror.transferLive', { lng: 'ar' }), lng: 'ar' }));
  }
  if (!freeOriginals(db, doc.k, src, srcId, originals.map((o) => o.id)).length) {
    awaitPending(true);
    // وعاكس المالك لأصلٍ يحجزه عاكسٌ في الوارد لم يُطبَّق بعد ينتظره ولا يُرفض: إن رُفض ذاك لطول انتظاره قُبل هذا (المدقق الخارجي O٣:
    // كان يُرفض نهائياً فيبقى أصل المالك حياً على جهازه الثاني وحده)
    if (originals.some((o) => inboxHeld(db, o.id, doc.k))) throw new AwaitOriginal(tr('mirror.noOriginal', { lng: 'ar' }));
    throw new Error(tr('mirror.revRejected', { why: tr('mirror.extra', { lng: 'ar' }), lng: 'ar' }));
  }
  guessLink(db, doc.k);
  const revs = db.all<{ id: string }>(
    `SELECT id FROM journal_entries WHERE src_type = ? AND src_id = ? AND status = 'مرحّل'`, [src, srcId]).length; // i18n-exempt: حالة القيد المخزّنة
  if (revs > originals.length) { awaitPending(true); throw new Error(tr('mirror.revRejected', { why: tr('mirror.extra', { lng: 'ar' }), lng: 'ar' })); }
}

/**
 * قيدٌ جديد من عضو لا يُنزل بنكاً تحت الصفر في دفاتر المالك (قرار المالك ٥٥ · المراجعة الشاملة 2026-11-13 · R12-SYN-3): عضو التحصيل
 * أو الفواتير أو المشتريات لا يقرأ حركات البنك (readSections.ts) فيرى رصيده افتتاحيّه وما كتبه هو، فحدّ A2.2 على جهازه (bankShortages)
 * يجيز إلغاء تحصيلٍ أو إعادة فاتورةٍ إلى «مستحقة» أو استعادة فاتورة شراءٍ مسدَّدة من بنكٍ سحب منه المالك · وجهاز المالك يرى كل حركة،
 * فيُرفض القيد نفسه قبل أن يدخل الدفتر، وتُرفض حركته البنكية معه (bankTxEntryRejected) وما يتبعه (bankShortFollowerIssue)، والفاتورة
 * المحصَّلة بقيدٍ حيّ تبقى (keepLocal) · وكان يُطبَّق كله لأن حركةً كُتبت مع قيدها لا تُفحص (Q٣ في memberBankTxCheck: فحصها وحدها
 * يُطبّق القيد ويمسك حركته فيختلف الجهازان)، والحكم هنا على القيد قبل حركته فلا نصف عملية · وما كتبه المالك من جهازه الآخر، أو عضوٌ
 * بقسمٍ يقرأ حركات البنك (البنوك والتقارير والدفتر: op المستند)، لا يُفحص هنا: حدّ A2.2 على جهازه رأى البنك كله، فلا يبقى إلا سدادٌ
 * متزامنٌ مع سحبٍ بلا اتصال، وهو مقبولٌ كما وثّقه Q٣ب (العملية حقيقية والبنك السالب ظاهرٌ للمالك، ورفضها يُسقط سداداً تمّ)
 */
function memberBankOutCheck(db: DB, doc: RemoteDoc): void {
  if (getSyncState(db, 'membership') || !byMember(db, doc, true)) return;
  if (typeof doc.op === 'string' && READ_TABLE.bank_tx.includes(doc.op as never)) return;
  const total = new Map<string, number>();
  const add = (m: Map<string, number>) => { for (const [b, a] of m) total.set(b, (total.get(b) ?? 0) + a); };
  add(entryBankEffect(db, doc));
  // حركات هذا القيد ونُسخ أخواته في الوارد محسوبةٌ في أثره، فلا تُحسب ثانيةً فيما ينتظر
  const own = new Set<string>([String(doc.d!.no ?? '')].filter(Boolean));
  // والاستعادة عمليةٌ واحدة: نُسخ قيود المستند نفسه (فاتورة الشراء وسدادها) تُقبل معاً أو تُرفض معاً، فلا تُستعاد الفاتورة بلا سدادها
  if (!String(doc.d!.src_type ?? '').endsWith('_rev') && repostSourceOf(db, doc)) {
    const sibs = siblingCopies(db, doc).filter((sib) => sib.k !== doc.k);
    for (const sib of sibs) {
      const why = bankShortRejectOf(db, sib.k);
      if (why) throw new Error(why);
      if (!db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [sib.k])) { add(entryBankEffect(db, sib)); if (sib.d!.no) own.add(String(sib.d!.no)); }
    }
    // ونسخة الفاتورة التي تنتظر نسخة سدادها في الطريق لا يُحكم عليها وحدها (مراجعة إصلاح R12-SYN-3)
    if (!sibs.some((sib) => sib.d!.src_type === 'purchase_pay') && payCopyAwaited(db, doc)) {
      throw new AwaitOriginal('purchase_pay copy in transit');
    }
  }
  for (const [bank, a] of total) {
    if (a >= 0) continue;
    const balance = bankBalance(db, bank) + pendingBankMoves(db, doc, bank, own);
    if (balance + a >= 0) continue;
    const name = db.get<{ n: string }>(`SELECT name AS n FROM banks WHERE id = ?`, [bank])?.n ?? '';
    const why = tr('bankTx.bankShort', { bank: name, balance: fmt(balance), amount: fmt(-a), lng: 'ar' });
    throw new Error(tr('sync.memberBankShort', { why, lng: 'ar' }));
  }
}

/**
 * أثر قيدٍ وارد في كل بنك: حركاته التي كُتبت معه وتنتظر في الوارد، وما لم يصل منها: العاكس حركات أصله معكوسةً، ونسخة الاستعادة حركات
 * القيد المعكوس الذي تنسخه · بالأشدّ منهما لكل بنك (ما يصل منها في دفعةٍ لاحقة لا يفوت الحكم)
 */
function entryBankEffect(db: DB, doc: RemoteDoc): Map<string, number> {
  const d = doc.d!;
  const out = new Map<string, number>();
  const take = (rows: Array<{ b: unknown; a: unknown }>, sign: number) => {
    const per = new Map<string, number>();
    for (const r of rows) if (r.b != null && r.b !== '') per.set(String(r.b), (per.get(String(r.b)) ?? 0) + sign * (Number(r.a) || 0));
    for (const [b, a] of per) out.set(b, Math.min(out.get(b) ?? 0, a));
  };
  const movesOf = (entryId: string, sign: number) => {
    const e = db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ?`, [entryId]);
    if (e) take(db.all(`SELECT bank_id AS b, amount_halalas AS a FROM bank_tx WHERE journal_no = ? AND deleted_at IS NULL`, [e.no]), sign);
  };
  if (typeof d.no === 'string' && d.no) {
    take(db.all(`SELECT json_extract(payload, '$.d.bank_id') AS b, json_extract(payload, '$.d.amount_halalas') AS a FROM sync_inbox
      WHERE tbl = 'bank_tx' AND del = 0 AND json_extract(payload, '$.d.journal_no') = ? AND json_extract(payload, '$.d.deleted_at') IS NULL`, [d.no]), 1);
  }
  if (String(d.src_type ?? '').endsWith('_rev')) for (const o of sourceReader(db).claimants(doc.k)) movesOf(o, -1);
  else {
    const copied = repostSourceOf(db, doc);
    if (copied) movesOf(copied, 1);
  }
  return out;
}

/**
 * ما ينتظر في الوارد من حركات البنك الجديدة مما يسبق هذا القيد (حركات البنك تُطبَّق بعد القيود، فما سبقه في السحابة لم يدخل الرصيد بعد):
 * حركات قيدٍ طُبّق هنا (تحصيلٌ وإلغاؤه وصلا معاً، وجهازٌ للمالك جديد يسحب الحساب كله)، أو قيدٍ في الوارد كُتب في السحابة قبله (بوقت
 * الخادم: ينتظر أباه)، ونقل النقد بلا قيد (السحب إلى المحفظة والإيداع والتحويل بين البنوك · cashOps.ts) كُتب قبله · وما كتبه المالك
 * أياً كان وقته: جهازه طبّقه قبل أن يصله قيد العضو، أو كتبه بعده في حدّ ما أبقاه · بالداخل والخارج معاً، فيُحكم بترتيب الكتابة في
 * السحابة لا بتوقيت السحب: كان الداخل وحده يُحسب، فجهاز المالك الذي يسحب في دورةٍ واحدة سحبَ المالك من جهازه الآخر (أو سحب عضو البنوك)
 * وإلغاءَ العضو بعده يرى البنك قبل السحب فيقبل ما رفضه جهازٌ سحب السحب قبله، وينزل البنك تحت الصفر (مراجعة إصلاح R12-SYN-3) · وما
 * كتبه عضوٌ بعد هذا القيد يُحكم عليه بعده بما يُبقيه هذا · own: أرقام القيد وأخواته المحسوبة في أثره
 * (لا يُطلب إلا حين لا يكفي البنك، فيُصفّى البنك هنا لا بفهرس)
 */
function pendingBankMoves(db: DB, doc: RemoteDoc, bank: string, own: Set<string>): number {
  const alias = noAliases(db);
  const at = db.get<{ u: string }>(`SELECT updated_at AS u FROM sync_inbox WHERE doc = ?`, [doc.id])?.u ?? '';
  /** كُتب في السحابة قبل هذا القيد، أو كتبه المالك */
  const counts = (x: { by?: unknown; op?: unknown }, before: unknown) => !!before || !byMember(db, x as RemoteDoc, true);
  const sure = new Map<string, boolean>();
  const entryCounts = (no: string): boolean => {
    let v = sure.get(no);
    if (v !== undefined) return v;
    v = !!db.get(`SELECT 1 FROM journal_entries WHERE no = ? AND status = ? AND deleted_at IS NULL`, [alias[no] ?? no, POSTED_ENTRY])
      || db.all<{ p: string; before: number }>(`SELECT payload AS p, (updated_at, doc) < (?, ?) AS before FROM sync_inbox
          WHERE tbl = 'journal_entries' AND del = 0 AND json_extract(payload, '$.d.no') = ?`, [at, doc.id, no])
        .some((r) => {
          try {
            const e = JSON.parse(r.p) as RemoteDoc;
            return e.d?.status === POSTED_ENTRY && e.d.deleted_at == null && counts(e, r.before);
          } catch { return false; }
        });
    sure.set(no, v);
    return v;
  };
  let n = 0;
  for (const r of db.all<{ b: unknown; a: unknown; x: unknown; no: unknown; by: unknown; op: unknown; before: number }>(`SELECT
      json_extract(payload, '$.d.bank_id') AS b, json_extract(payload, '$.d.amount_halalas') AS a, json_extract(payload, '$.d.deleted_at') AS x,
      json_extract(payload, '$.d.journal_no') AS no, json_extract(payload, '$.by') AS by, json_extract(payload, '$.op') AS op,
      (updated_at, doc) < (?, ?) AS before
    FROM sync_inbox WHERE tbl = 'bank_tx' AND del = 0 AND pk NOT IN (SELECT id FROM bank_tx)`, [at, doc.id])) {
    const no = r.no == null ? '' : String(r.no);
    if (String(r.b ?? '') !== bank || r.x != null || own.has(no)) continue;
    if (no ? entryCounts(no) : counts(r, r.before)) n += Number(r.a) || 0;
  }
  return n;
}

/**
 * نسخة قيد فاتورة شراءٍ تستعيدها من السلة تنتظر نسخة قيد سدادها (مراجعة إصلاح R12-SYN-3): الاستعادة عمليةٌ واحدة يُحكم على نسختيها
 * معاً، فإن وصلت نسخة الفاتورة في سحبٍ ونسخة السداد في سحبٍ بعده قُبلت الأولى ورُفضت الثانية لنقص البنك، فاستُعيدت الفاتورة بلا سدادها
 * وبقيت ذمّة المورد حيّة · فتنتظر ما دامت نسخة السداد في الطريق: صفّ الفاتورة الوارد يسمّي قيد سدادٍ لم يصل ولم يُرفض، أو (إن لم يصل
 * صفّها) فاتورتها هنا في السلة مسدَّدةٌ بقيدٍ معكوس فتعيده الاستعادة (restorePurchase) ولا نسخة سدادٍ حيّة له هنا · ساعةً بوقت الخادم
 * من كتابتها (LATE_LINK_MS كالربط المتأخر) ثم يُحكم عليها وحدها
 */
function payCopyAwaited(db: DB, doc: RemoteDoc): boolean {
  const d = doc.d!;
  if (d.src_type !== 'purchase' || d.src_id == null) return false;
  const pid = String(d.src_id);
  const row = db.get<{ e: unknown; p: unknown }>(`SELECT json_extract(payload, '$.d.journal_entry_id') AS e,
    json_extract(payload, '$.d.payment_journal_entry_id') AS p FROM sync_inbox WHERE tbl = 'purchases' AND del = 0 AND pk = ?`, [pid]);
  let missing: boolean;
  if (row && String(row.e ?? '') === doc.k) {
    const pay = row.p == null ? '' : String(row.p);
    missing = !!pay && !db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [pay])
      && !db.get(`SELECT 1 FROM sync_rejects WHERE tbl = 'journal_entries' AND pk = ?`, [pay]);
  } else {
    const here = db.get<{ x: unknown; paid: unknown; p: unknown }>(
      `SELECT deleted_at AS x, paid, payment_journal_entry_id AS p FROM purchases WHERE id = ?`, [pid]);
    missing = !!here && here.x != null && Number(here.paid) === 1 && here.p != null
      && !!db.get(`SELECT 1 FROM journal_entries WHERE id = ? AND status = ? AND reversed_by IS NOT NULL`, [String(here.p), POSTED_ENTRY])
      && !db.get(`SELECT 1 FROM journal_entries WHERE src_type = 'purchase_pay' AND src_id = ? AND status = ? AND reversed_by IS NULL
        AND deleted_at IS NULL`, [pid, POSTED_ENTRY]);
  }
  return missing && withinLateLink(db, doc);
}

/** كُتب المستند في السحابة منذ ساعةٍ أو أقل بوقت الخادم (LATE_LINK_MS) · وما لا يُعرف وقته لا ينتظر */
function withinLateLink(db: DB, doc: RemoteDoc): boolean {
  const at = Date.parse(isoNorm(doc.ts ?? doc.u));
  return Number.isFinite(at) && Date.parse(toServerClock(db, nowIso())) - at <= LATE_LINK_MS;
}

/** القيد المعكوس هنا الذي يعيده هذا القيد نسخةً (repostCopy: مصدره نفسه وسطوره نفسها) · أحدثه */
function repostSourceOf(db: DB, doc: RemoteDoc): string | null {
  const d = doc.d!;
  if (typeof d.src_type !== 'string' || d.src_id == null) return null;
  const want = netByAccount((doc.lines ?? []) as Array<Record<string, unknown>>);
  const same = (id: string) => {
    const got = netByAccount(db.all<Record<string, unknown>>(`SELECT account_code, debit_halalas, credit_halalas FROM journal_lines WHERE entry_id = ?`, [id]));
    return got.size === want.size && [...want].every(([k, v]) => got.get(k) === v);
  };
  return db.all<{ id: string }>(`SELECT id FROM journal_entries WHERE src_type = ? AND src_id = ? AND id != ? AND status = ?
    AND reversed_by IS NOT NULL AND deleted_at IS NULL ORDER BY created_at DESC`, [d.src_type, String(d.src_id), doc.k, POSTED_ENTRY])
    .map((x) => x.id).find(same) ?? null;
}

/** نُسخ الاستعادة الأخرى من عضو لقيود المستند نفسه (مصدره وسداده: «purchase» و«purchase_pay») · في الوارد أو مرفوضة */
function siblingCopies(db: DB, doc: RemoteDoc): RemoteDoc[] {
  const base = String(doc.d!.src_type).replace(/_pay$/, '');
  const srcId = String(doc.d!.src_id);
  const out: RemoteDoc[] = [];
  for (const r of db.all<{ p: string }>(`SELECT payload AS p FROM sync_inbox WHERE tbl = 'journal_entries' AND del = 0
      AND json_extract(payload, '$.d.src_id') = ? AND json_extract(payload, '$.d.src_type') IN (?, ?)
    UNION ALL SELECT payload AS p FROM sync_rejects WHERE tbl = 'journal_entries'
      AND json_extract(payload, '$.d.src_id') = ? AND json_extract(payload, '$.d.src_type') IN (?, ?)`,
  [srcId, base, base + '_pay', srcId, base, base + '_pay'])) {
    try {
      const sib = JSON.parse(r.p) as RemoteDoc;
      if (sib.d && sib.d.status === POSTED_ENTRY && byMember(db, sib, true) && repostSourceOf(db, sib)) out.push(sib);
    } catch { /* مستندٌ تالف لا يشهد */ }
  }
  return out;
}

/** سبب رفض القيد هنا لأنه يُنزل البنك تحت الصفر (memberBankOutCheck) · أو '' */
function bankShortRejectOf(db: DB, entryId: string): string {
  if (db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [entryId])) return '';
  const tail = tr('sync.memberBankShort', { why: '', lng: 'ar' });
  return db.all<{ r: string }>(`SELECT reason AS r FROM sync_rejects WHERE tbl = 'journal_entries' AND pk = ? ORDER BY id DESC`, [entryId])
    .map((x) => x.r).find((r) => r.endsWith(tail)) ?? '';
}

/**
 * ما يتبع قيداً من عضو رُفض هنا لأنه يُنزل البنك تحت الصفر (memberBankOutCheck · R12-SYN-3): وسم إلغاء الدفعة بعاكسه، وفاتورة الشراء
 * المستعادة بنسخ قيودها · يُرفض بالسبب نفسه وتُعاد نسخة المالك (فلا ينتظر قيداً لا يُطبَّق ثلاثين يوماً، ولا تُستعاد الفاتورة بلا سدادها)
 * · والفاتورة المعادة إلى «مستحقة» يُبقيها keepLocal محصَّلةً بقيدها الحيّ · سببُ الرفض أو ''
 */
function bankShortFollowerIssue(db: DB, doc: RemoteDoc): string {
  if (doc.del || !doc.d || getSyncState(db, 'membership') || !byMember(db, doc, false)) return '';
  const d = doc.d;
  const named = doc.t === 'contract_payments' ? (d.cancelled_at != null ? [d.cancel_entry_id] : [])
    : doc.t === 'purchases' ? [d.journal_entry_id, d.payment_journal_entry_id] : [];
  for (const id of named) {
    if (id == null || id === '') continue;
    const why = bankShortRejectOf(db, String(id));
    if (why) return why;
  }
  // وفاتورة الشراء المستعادة من السلة تنتظر قيديها: ما يسمّيه صفّها ولم يصل ولم يُرفض، في الوارد ينتظر أو في طريقه ساعةً بوقت الخادم ·
  // كانت تُطبَّق قبل أن يُحكم على نسخة سدادها فتخرج من السلة ولو رُفض سدادها بعدها (مراجعة إصلاح R12-SYN-3)
  if (doc.t === 'purchases' && d.deleted_at == null
    && db.get(`SELECT 1 FROM purchases WHERE id = ? AND deleted_at IS NOT NULL`, [doc.k])) {
    for (const id of named) {
      if (id == null || id === '' || db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [String(id)])) continue;
      if (db.get(`SELECT 1 FROM sync_rejects WHERE tbl = 'journal_entries' AND pk = ?`, [String(id)])) continue;
      if (db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ?`, [String(id)]) || withinLateLink(db, doc)) return LOCK_AWAIT;
    }
  }
  return '';
}

/** صافي كل حسابٍ في سطور قيد (مدينه ناقص دائنه) */
function netByAccount(ls: Array<Record<string, unknown>>): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of ls) m.set(String(l.account_code ?? ''), (m.get(String(l.account_code ?? '')) ?? 0) + (Number(l.debit_halalas) || 0) - (Number(l.credit_halalas) || 0));
  return m;
}

/** عاكسٌ في الوارد لم يُطبَّق بعد، سطوره مرآة سطور الأصل المطبَّق هنا (صافي كل حسابٍ بعكس إشارته) */
function inboxMirror(db: DB, originalId: string, revId: string): boolean {
  if (db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [revId])) return false;
  const p = db.get<{ payload: string }>(`SELECT payload FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ? AND del = 0`, [revId])?.payload;
  if (!p) return false;
  let rev: RemoteDoc;
  try { rev = JSON.parse(p) as RemoteDoc; } catch { return false; }
  if (linesMalformed(rev)) return false;
  const mine = netByAccount(db.all<Record<string, unknown>>(`SELECT account_code, debit_halalas, credit_halalas FROM journal_lines WHERE entry_id = ?`, [originalId]));
  const theirs = netByAccount(docLines(rev));
  return mine.size > 0 && theirs.size === mine.size && [...mine].every(([k, v]) => v !== 0 && (theirs.get(k) ?? 0) === -v);
}

/** أصلٌ يحجزه عاكسٌ مرآته في الوارد لم يُطبَّق بعد غير revId: بربطه هنا، أو بربطه المعلَّق، أو بنسخته الواردة */
function inboxHeld(db: DB, originalId: string, revId: string): boolean {
  const pending = JSON.parse(getSyncState(db, PENDING_REV) ?? '{}') as Record<string, string>;
  const by = db.get<{ r: string | null }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [originalId])?.r;
  const named = db.get<{ r: string | null }>(
    `SELECT json_extract(payload, '$.d.reversed_by') AS r FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ? AND del = 0`, [originalId])?.r;
  return [by, pending[originalId], named].some((x) => !!x && x !== revId && inboxMirror(db, originalId, x));
}

/** أصلٌ مرحّل من المصدر في الوارد لم يُطبَّق بعد، يسمّي هذا العاكس أو سطوره مرآة سطوره (صافي كل حسابٍ بعكس إشارته) */
function pendingOriginalOf(db: DB, rev: RemoteDoc, base: string, srcId: string): boolean {
  const net = (ls: Array<Record<string, unknown>>) => {
    const m = new Map<string, number>();
    for (const l of ls) m.set(String(l.account_code ?? ''), (m.get(String(l.account_code ?? '')) ?? 0) + (Number(l.debit_halalas) || 0) - (Number(l.credit_halalas) || 0));
    return m;
  };
  const mine = net(docLines(rev));
  return db.all<{ payload: string }>(
    `SELECT payload FROM sync_inbox WHERE tbl = 'journal_entries' AND del = 0 AND json_extract(payload, '$.d.src_type') = ? AND json_extract(payload, '$.d.src_id') = ? AND pk != ?`,
    [base, srcId, rev.k]).some((p) => {
    let o: RemoteDoc;
    try { o = JSON.parse(p.payload) as RemoteDoc; } catch { return false; }
    if (!o.d || o.d.status !== POSTED || linesMalformed(o) || db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [o.k])) return false;
    if (o.d.reversed_by === rev.k) return true;
    const theirs = net(docLines(o));
    return theirs.size === mine.size && [...theirs].every(([k, v]) => v !== 0 && (mine.get(k) ?? 0) === -v);
  });
}

/**
 * أصول المصدر التي يعكسها revId واحداً لواحد (المتحقق المستقل، الجولة السادسة عشرة): للمصدر أصولٌ عدة (فاتورةٌ عُدّلت فعُكس قيدها
 * ورُحِّل غيره)، فمرآة الأصل المعكوس كانت تُقبل ثانيةً في حدود العدد · فالأصل الحر: مرآته revId، ولم يُعكس بغيره (أو خُمِّن له
 * عاكسٌ يغلبه الربط المعلن)، ولا تقابله مرآةٌ أخرى غير مربوطة بأصلٍ آخر
 */
function freeOriginals(db: DB, revId: string, src: string, srcId: string, originals: string[]): string[] {
  const others = db.all<{ id: string }>(
    `SELECT id FROM journal_entries WHERE src_type = ? AND src_id = ? AND status = 'مرحّل' AND id != ?`, [src, srcId, revId]); // i18n-exempt: حالة القيد المخزّنة
  const pending = JSON.parse(getSyncState(db, PENDING_REV) ?? '{}') as Record<string, string>;
  return originals.filter((o) => {
    if (mirrorIssue(db, o, revId) !== '') return false;
    // وربطٌ بعاكسٍ لا وجود له هنا ولا في الوارد لا يحجز الأصل (المدقق الخارجي M١٠: عضوٌ ربط قيد المالك بعاكسٍ وهمي فرُفض عكس المالك
    // نفسه على جهازه الثاني) · ولا بعاكسٍ في الوارد ليس مرآته (O٣: قاعدة السحابة تجيز الربط بعاكسٍ قائمٍ فيها، فالمزوَّر يصل الوارد
    // وينتظر فيه ثلاثين يوماً بسطرٍ على حسابٍ لا وجود له)
    const exists = (id: string) => !!db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [id]) || inboxMirror(db, o, id);
    const by = db.get<{ r: string | null }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [o])!.r;
    if (by && by !== revId && exists(by)) return false;
    // ولا أصلٌ ربطُه المعلَّق أو نسخته الواردة تسمّي عاكساً آخر (المدقق الخارجي K١: كان يُخمَّن للعاكس أصلٌ خطأ فيُرفض الحقيقي بعده
    // «عاكسه طُبِّق قبله»)
    if (pending[o] && pending[o] !== revId && exists(pending[o])) return false;
    const named = db.get<{ r: string | null }>(
      `SELECT json_extract(payload, '$.d.reversed_by') AS r FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ? AND del = 0`, [o])?.r;
    if (named && named !== revId && exists(named)) return false;
    return !others.some((r2) => mirrorIssue(db, o, r2.id) === ''
      && !db.get(`SELECT 1 FROM journal_entries WHERE reversed_by = ? AND id != ?`, [r2.id, o]));
  });
}

/**
 * يربط العاكس المقبول بأصله على جهاز المالك (المتحقق المستقل، الجولة السابعة عشرة: عاكسٌ قُبل بلا ربطٍ يصل كان يترك الأصل «حياً»
 * فيُعكس ثانيةً) · المعلَن أولاً: ربطٌ معلّق أو وارد ينتظر يسمّي هذا العاكس، وإلا خُمِّن أول أصلٍ حر وسُجِّل تخميناً يغلبه الربط
 * المعلن متى وصل (statedLink)
 */
function guessLink(db: DB, revId: string): void {
  const r = db.get<{ src_type: string | null; src_id: string | null }>(`SELECT src_type, src_id FROM journal_entries WHERE id = ?`, [revId]);
  if (!r?.src_type?.endsWith('_rev')) return;
  if (db.get(`SELECT 1 FROM journal_entries WHERE reversed_by = ?`, [revId])) return;
  const base = r.src_type.slice(0, -4);
  const srcId = r.src_id ?? '';
  const originals = db.all<{ id: string }>(base === 'manual'
    ? `SELECT id FROM journal_entries WHERE id = ? AND (src_type IS NULL OR src_type = 'manual') AND status = 'مرحّل'` // i18n-exempt: حالة القيد المخزّنة
    : `SELECT id FROM journal_entries WHERE src_type = ? AND src_id = ? AND status = 'مرحّل'`, // i18n-exempt: حالة القيد المخزّنة
    base === 'manual' ? [srcId] : [base, srcId]).map((o) => o.id);
  const free = freeOriginals(db, revId, r.src_type, srcId, originals);
  if (!free.length) return;
  const pending = JSON.parse(getSyncState(db, PENDING_REV) ?? '{}') as Record<string, string>;
  const stated = free.find((o) => pending[o] === revId || db.get(
    `SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ? AND json_extract(payload, '$.d.reversed_by') = ?`, [o, revId]));
  if (stated) { statedLink(db, stated, revId); return; }
  db.run(`UPDATE journal_entries SET reversed_by = ? WHERE id = ? AND reversed_by IS NULL`, [revId, free[0]]);
  const g = guessesOf(db);
  g[free[0]] = revId;
  saveGuesses(db, g);
}

/**
 * أسماء أرقام القيود: قيدٌ واحد (بمعرّفه) رقمه على جهازٍ آخر غير رقمه هنا · فحركة البنك (تُربط برقم القيد journal_no) الواصلة
 * برقمه هناك تُترجَم إلى رقمه هنا، والقائمة هنا برقمه هناك تُعاد إليه (المراجعة الخارجية ٧ · النتيجة ٤ · المتحقق المستقل على
 * bea2251: حركة بنك الاستعادة كانت تشير على أحد الجهازين إلى رقمٍ لا قيد له، فيخطئها إلغاء التحصيل وموانع الاستعادة)
 */
const JE_NO_ALIAS = 'journal_no_aliases';
const noAliases = (db: DB) => JSON.parse(getSyncState(db, JE_NO_ALIAS) ?? '{}') as Record<string, string>;
function noteJournalNoAlias(db: DB, remoteNo: string, localNo: string): void {
  const a = noAliases(db);
  if (a[remoteNo] === localNo) return;
  a[remoteNo] = localNo;
  setSyncState(db, JE_NO_ALIAS, JSON.stringify(a));
  db.run(`UPDATE bank_tx SET journal_no = ? WHERE journal_no = ?`, [localNo, remoteNo]);
  // وما رُفع منها برقمه هنا يُرفع ثانيةً برقمه في السحابة (buildDoc)
  for (const t of db.all<{ id: string }>(`SELECT id FROM bank_tx WHERE journal_no = ?`, [localNo])) enqueue(db, 'bank_tx', t.id, 'upsert');
}
/** عاكسٌ لهذا القيد في الوارد لم يُطبَّق بعد، أو ربطه معلَّق: القيد في طريقه إلى العكس (A٢-٣ وB٢-٣) */
function reversalPending(db: DB, entryId: string, srcType: string, srcId: string): boolean {
  if (linksTo(PENDING_REV, getSyncState(db, PENDING_REV), entryId).length) return true;
  return !!db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND del = 0 AND json_extract(payload, '$.d.src_type') = ?
    AND json_extract(payload, '$.d.src_id') = ?`, [srcType + '_rev', srcId]);
}
/**
 * التحصيل الحيّ الحقيقي هنا للإيداع الذي يسمّيه سطر الكشف (بالبصمة لا بالمعرّف · B٢-٤): قيدٌ يحمل سطراً بالبصمة نفسها في البنك نفسه وله
 * حركةٌ في ذلك البنك بمبلغ السطر ويومه (B٢-١ وB٢-٢) · 'pending' إن كان عاكسه في الطريق · null إن لم يكن
 */
function liveDepositCollection(db: DB, lineId: string, exceptId: string): string | 'pending' | null {
  // والسطر الذي لم يُطبَّق بعد يُقرأ من الوارد: القيود تُطبَّق قبل سطور الكشف (المدقق الخارجي E٢-٤) · ولا ينتظره القيد (السطر ينتظر حركة
  // البنك، وحركة البنك تنتظر القيد)
  type L = { id: string; bank: string; key: string; amount: number; date: string; st: string; live: boolean; status: string; tx: string | null; c: string };
  const parse = (pk: string, p: string): L | null => {
    try {
      const d = JSON.parse(p)?.d;
      return d?.bank_id && d.line_key ? { id: pk, bank: String(d.bank_id), key: String(d.line_key), amount: Number(d.amount_halalas), date: String(d.date),
        st: String(d.statement_id ?? ''), live: d.deleted_at == null, status: String(d.status ?? 'open'), tx: d.bank_tx_id ?? null, c: String(d.created_at ?? '') } : null;
    } catch { return null; }
  };
  const SEL = `SELECT id, bank_id AS bank, line_key AS key, amount_halalas AS amount, date, COALESCE(statement_id, '') AS st, deleted_at IS NULL AS live,
    status, bank_tx_id AS tx, created_at AS c FROM bank_statement_lines`;
  let ln: L | null = db.get<L>(`${SEL} WHERE id = ?`, [lineId]) ?? null;
  if (!ln) {
    const p = db.get<{ p: string }>(`SELECT payload AS p FROM sync_inbox WHERE tbl = 'bank_statement_lines' AND pk = ? AND del = 0`, [lineId])?.p;
    ln = p ? parse(lineId, p) : null;
  }
  if (!ln) return null;
  // وسطور اليوم والمبلغ هنا وفي الوارد (G٢-٣ وG٢-٤: سطرٌ لم يصل كان لا يُعدّ إيداعاً ولا يُعدّ تحصيله)
  const base = lineKeyBase(ln.key);
  const lines = new Map<string, L>();
  // (والنسختان معاً لما طوبق يدوياً: هنا وفي الوارد · G٢-٢ وI٢-١)
  const versions: L[] = [];
  for (const x of db.all<L>(`${SEL} WHERE bank_id = ? AND line_key BETWEEN ? AND ?`, [ln.bank, base, base + '~'])) { lines.set(x.id, { ...x, live: !!x.live }); versions.push({ ...x, live: !!x.live }); }
  for (const r of db.all<{ pk: string; p: string }>(`SELECT pk, payload AS p FROM sync_inbox WHERE tbl = 'bank_statement_lines' AND del = 0
      AND json_extract(payload, '$.d.line_key') BETWEEN ? AND ?`, [base, base + '~'])) {
    // (ونسخة الوارد أحدث مما هنا: سطرٌ طابقه عضوٌ يدوياً ولم يُطبَّق بعد · المدقق الخارجي I٢-١)
    const x = parse(r.pk, r.p);
    if (x && x.bank === ln.bank) { lines.set(x.id, x); versions.push(x); }
  }
  if (!lines.has(ln.id)) lines.set(ln.id, ln);
  const genuine = (no: string) => txsOfNo(db, no).some((t) => t.bank === ln!.bank && t.amount === Number(ln!.amount) && t.date === ln!.date);
  const rows = db.all<{ id: string; no: string; src: string; sid: string; lid: string }>(
    `SELECT id, no, COALESCE(src_type, '') AS src, COALESCE(src_id, '') AS sid, stmt_line_id AS lid FROM journal_entries
     WHERE stmt_line_id IN (SELECT value FROM json_each(?)) AND id != ? AND reversed_by IS NULL AND status = ?`,
    [JSON.stringify([...lines.keys()]), exceptId, POSTED_ENTRY])
    .filter((e) => genuine(e.no))
    .map((e) => ({ ...e, k: lines.get(e.lid)?.key ?? '' }));
  // وما طابقه المالك هنا بحركة تحصيلٍ حيٍّ سجّله بنفسه (G٢-٢: الإيداع مطابَقٌ بتحصيلٍ يدوي فلا يسنده تحصيلٌ آخر من الكشف)
  const held = new Set(rows.map((e) => e.no));
  // (وحركة المطابقة اليدوية هنا أو في الوارد: الحركات تُطبَّق بعد القيود · I٢-١)
  // (بأحدث نسخها: نسخة الوارد قبل ما هنا، محذوفةً أو مستعادة · المدقق الخارجي Q٢-١ وQ٢-٢)
  const txNo = (id: string): string | null => {
    const inb = db.get<{ p: string; del: number }>(`SELECT payload AS p, del FROM sync_inbox WHERE tbl = 'bank_tx' AND pk = ?`, [id]);
    if (inb) {
      if (Number(inb.del)) return null;
      try {
        const d = JSON.parse(inb.p ?? 'null')?.d;
        return d && d.deleted_at == null ? String(d.journal_no ?? '') : null;
      } catch { return null; }
    }
    const t0 = db.get<{ n: string; del: string | null }>(`SELECT journal_no AS n, deleted_at AS del FROM bank_tx WHERE id = ?`, [id]);
    return t0 && t0.del == null ? String(t0.n ?? '') : null;
  };
  // (وكل حركةٍ حيّة في بنكها تحجز ما طابقته: بلا رقم قيد (إيداع نقدٍ من المحفظة · O٢-٢)، أو قيدها هنا أو في الوارد (O٢-١) · إلا حركة
  // القيد الوارد نفسه، وما عُكس قيده)
  let incomingNo = '';
  try { incomingNo = String(JSON.parse(db.get<{ p: string }>(`SELECT payload AS p FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ?`, [exceptId])?.p ?? 'null')?.d?.no ?? ''); } catch { incomingNo = ''; }
  const manualBy = new Map<string, L>();
  for (const x of versions) {
    if (!x.live || x.status !== 'matched' || !x.tx || manualBy.has(x.id)) continue;
    const no = txNo(x.tx);
    if (no == null || held.has(no) || (no && no === incomingNo)) continue;
    if (!no) { manualBy.set(x.id, x); continue; }
    const e = db.get<{ id: string; src: string; sid: string; r: string | null }>(`SELECT id, COALESCE(src_type, '') AS src, COALESCE(src_id, '') AS sid, reversed_by AS r
      FROM journal_entries WHERE no = ? AND status = ? AND id != ?`, [no, POSTED_ENTRY, exceptId]);
    // (ومطابقةٌ يدوية عكسُ قيدها في الوارد تُنتظر ولا تحجز · المدقق الخارجي K٢-٣)
    if (e && !e.r) manualBy.set(x.id, { ...x, pending: reversalPending(db, e.id, e.src, e.sid) } as L & { pending: boolean });
    else if (!e && db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND del = 0 AND json_extract(payload, '$.d.no') = ?`, [no])) manualBy.set(x.id, x);
  }
  const manual = [...manualBy.values()] as Array<L & { pending?: boolean }>;
  const manualLive = manual.filter((x) => !x.pending);
  const live = rows.filter((e) => !reversalPending(db, e.id, e.src, e.sid));
  if (rows.some((e) => e.k === ln!.key)) return live.find((e) => e.k === ln!.key)?.id ?? 'pending';
  const same = manual.find((x) => x.key === ln!.key);
  if (same) return same.pending ? 'pending' : same.tx ?? 'manual';
  // والإيداعات بعدّ التوائم نفسه (keepInOrder) وبصمات الكشوف هنا وفي الوارد
  const rankOf = (x: L) => lineRank({ id: x.id, status: x.status, c: x.c, k: x.key, st: x.st });
  const liveLines = [...lines.values()].filter((x) => x.live).sort((a, b) => (rankOf(a) < rankOf(b) ? -1 : 1));
  // (وكشوف البنك في الوارد كلها، ولو لم يُطبَّق لها سطرٌ في القاعدة · K٢-٢) · والمحذوف منها في الوارد لا يُعدّ، ولا نسخته الحيّة هنا
  // (المدقق الخارجي M٢-١: كشفٌ حذفه كاتبه لأنه خطأ كان يجيز تحصيلاً ثانياً) · وكلٌّ منها يُفكّ مرةً
  const inboxKeys = new Map<string, string[]>();
  const deletedIn = new Set<string>();
  for (const r of db.all<{ pk: string; p: string }>(`SELECT pk, payload AS p FROM sync_inbox WHERE tbl = 'bank_statements' AND del = 0`)) {
    try {
      const d = JSON.parse(r.p)?.d;
      if (String(d?.bank_id ?? '') !== ln.bank) continue;
      if (d.deleted_at != null) { deletedIn.add(r.pk); continue; }
      const keys = JSON.parse(String(d.shared_keys ?? '[]'));
      inboxKeys.set(r.pk, Array.isArray(keys) ? keys.map(String).filter((k: string) => lineKeyBase(k) === base) : []);
    } catch { /* مستندٌ تالف لا يشهد */ }
  }
  for (const r of db.all<{ pk: string }>(`SELECT pk FROM sync_inbox WHERE tbl = 'bank_statements' AND del = 1`)) deletedIn.add(r.pk);
  const stIds = [...liveLines.map((x) => x.st), ...bankStatementIds(db, ln.bank)].filter((id) => !deletedIn.has(id) && !inboxKeys.has(id));
  const known = statementsKnown(db, stIds, ln.key);
  let need = known.need;
  const bal = new Set(known.bal);
  for (const mine of inboxKeys.values()) {
    need = Math.max(need, mine.length);
    for (const k of mine) if (!k.includes('#')) bal.add(k);
  }
  need = Math.max(need, bal.size);
  const cap = Math.max(1, keepInOrder(liveLines.map((x) => x.key), () => need).filter(Boolean).length);
  const taken = rows.length + manual.length;
  if (taken < cap) return null;
  return live.length + manualLive.length >= cap ? (live[0]?.id ?? manualLive[0]?.tx ?? 'manual') : 'pending';
}

/** حركات البنك الحيّة برقم القيد، هنا وفي الوارد (البحث بالرقم المفهرس وحده، والباقي يُقارن هنا) */
function txsOfNo(db: DB, no: string): Array<{ bank: string; amount: number; date: string }> {
  const out = db.all<{ bank: string; amount: number; date: string }>(
    `SELECT bank_id AS bank, amount_halalas AS amount, date FROM bank_tx WHERE journal_no = ? AND deleted_at IS NULL`, [no])
    .map((t) => ({ bank: t.bank, amount: Number(t.amount), date: t.date }));
  for (const r of db.all<{ p: string }>(`SELECT payload AS p FROM sync_inbox WHERE tbl = 'bank_tx' AND del = 0 AND json_extract(payload, '$.d.journal_no') = ?`, [no])) {
    try {
      const d = JSON.parse(r.p)?.d;
      if (d && !d.deleted_at) out.push({ bank: String(d.bank_id), amount: Number(d.amount_halalas), date: String(d.date) });
    } catch { /* مستندٌ تالف لا يشهد */ }
  }
  return out;
}

/** النسخة المفتوحة فكٌّ للمطابقة: السطر نفسه إنشاءً، وعُدّلت بعد المطابقة · وإلا فهي قراءةٌ أخرى للكشف لا تمحو المطابقة */
function lineUndoes(openCreated: string, openAt: string, matchedCreated: string, matchedAt: string | null): boolean {
  return openCreated === matchedCreated && !!matchedAt && isoCmp(openAt, matchedAt) > 0;
}

/** سبب رفض القيد المرحّل الذي نسخته في السحابة نهائية */
const FINAL_IN_CLOUD = 'نهائي في السحابة · نسخة هذا الجهاز تختلف عنها ولم تُرفع'; // i18n-exempt: سبب الرفض المخزَّن
const PAID_INVOICE = 'مدفوعة'; // i18n-exempt: حالة الفاتورة المخزّنة
const COLLECTED_CLAIM = 'محصَّلة'; // i18n-exempt: حالة المطالبة المخزّنة
const POSTED_ENTRY = 'مرحّل'; // i18n-exempt: حالة القيد المخزّنة
/** سطور القيد الوارد سطور القيد هنا نفسها (الحساب والمدين والدائن) */
function sameEntryLines(db: DB, doc: RemoteDoc): boolean {
  const key = (a: unknown, d: unknown, c: unknown) => `${String(a)}|${Number(d) || 0}|${Number(c) || 0}`;
  const here = db.all<{ a: string; d: number; c: number }>(`SELECT account_code AS a, debit_halalas AS d, credit_halalas AS c FROM journal_lines WHERE entry_id = ?`, [doc.k])
    .map((l) => key(l.a, l.d, l.c)).sort();
  const there = (doc.lines ?? []).map((l) => key(l.account_code, l.debit_halalas, l.credit_halalas)).sort();
  return here.length === there.length && here.every((x, i) => x === there[i]);
}

/** رقم القيد في السحابة لرقمه هنا (صادراً) */
function cloudJournalNo(db: DB, localNo: string): string {
  for (const [remote, local] of Object.entries(noAliases(db))) if (local === localNo) return remote;
  return localNo;
}

/**
 * المراجعة الخارجية ٧ · النتيجة ٥ (قرار المالك «رابعاً ٣»: «إعادة الترقيم عند تعارض الرقم»): جهازٌ رقّم قيوده وفواتير شرائه
 * قبل الدخول (بلا كتلة ولا حرف) ثم انضم، فوصله رقمٌ من الحساب هو رقم قيدٍ له · كان الوارد يُرفض أبداً ويتباين الدفتران ·
 * وفي أول دورةٍ للجهاز (joining) ما عنده لم يُرفع بعد (السحب قبل الدفع) فيُعاد ترقيم ما عنده من كتلته الآن ويُطبَّق الوارد برقمه،
 * فيتفق الجهازان على الأرقام · والمرحّل لا يتغير رقمه إلا هنا (المحفّز يُرفع ويُعاد في المعاملة نفسها) · وحركات بنكه معه ·
 * ورقم العقد خارجه (قد يكون رقم إيجار الذي أدخله المستخدم فلا يُغيَّر)
 */
function renumberJoiningCollision(db: DB, table: 'journal_entries' | 'purchases', incomingId: string, no: unknown): void {
  if (typeof no !== 'string' || getSyncState(db, 'joining') !== '1') return;
  const mine = db.get<{ id: string }>(`SELECT id FROM "${table}" WHERE no = ? AND id != ?`, [no, incomingId]);
  if (!mine) return;
  if (table === 'purchases') {
    db.run(`UPDATE purchases SET no = ? WHERE id = ?`, [nextPurchaseNo(db), mine.id]);
  } else {
    const fresh = nextJournalNo(db);
    const trg = db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_je_frozen_hdr'`)?.sql;
    if (trg) db.exec('DROP TRIGGER trg_je_frozen_hdr');
    try { db.run(`UPDATE journal_entries SET no = ? WHERE id = ?`, [fresh, mine.id]); } finally { if (trg) db.exec(trg); }
    db.run(`UPDATE bank_tx SET journal_no = ? WHERE journal_no = ?`, [fresh, no]);
    for (const t of db.all<{ id: string }>(`SELECT id FROM bank_tx WHERE journal_no = ?`, [fresh])) enqueue(db, 'bank_tx', t.id, 'upsert');
  }
  enqueue(db, table, mine.id, 'upsert');
}

/** أحدث نسخةٍ لصفٍّ بمعرّفه: الوارد المنتظر إن وُجد (أحدث مما هنا)، وإلا القائم هنا */
function latestRow<T>(db: DB, table: string, id: string): T | null {
  const inbox = db.get<{ payload: string }>(`SELECT payload FROM sync_inbox WHERE tbl = ? AND pk = ? AND del = 0`, [table, id]);
  if (inbox) return ((JSON.parse(inbox.payload) as RemoteDoc).d ?? null) as T | null;
  return db.get<T>(`SELECT * FROM "${table}" WHERE id = ?`, [id]) ?? null;
}

/** صفوف الجدول بعمودٍ وقيمته: القائمة هنا، وإلا ما ينتظر في الوارد (الابن يتبع أباه في ترتيب التطبيق) */
function rowsHereOrInbox<T>(db: DB, table: string, col: string, value: string): T[] {
  const here = db.all<T>(`SELECT * FROM "${table}" WHERE "${col}" = ?`, [value]);
  if (here.length) return here;
  return db.all<{ payload: string }>(
    `SELECT payload FROM sync_inbox WHERE tbl = ? AND del = 0 AND json_extract(payload, '$.d.${col}') = ?`, [table, value])
    .map((r) => (JSON.parse(r.payload) as RemoteDoc).d as T);
}

/**
 * إعادة اشتقاق قيد العضو من مصدره · المرحلة الأولى (قرار المالك 2026-10-15 «١»: الدفعات والتحصيل أولاً): قيد التحصيل المرحّل
 * الذي كتبه عضو تُحسب سطوره على جهاز المالك من دفعته، ويُرفض كله إن خالفتها فلا يدخل الدفتر · والدفعة تتبع قيدها في ترتيب
 * التطبيق (مفتاحها الأجنبي إليه) فتُقرأ من الوارد المنتظر · وما لم يصل بعد يُنتظر كالأصل الناقص · وما كتبه المالك لا يُعاد
 */
function memberRentCheck(db: DB, doc: RemoteDoc): void {
  if (doc.d!.src_type !== 'rent' || getSyncState(db, 'membership')) return;
  if (!doc.by || doc.by === ownerUid(db)) return;
  // دفعةٌ واحدة لقيدٍ واحد (المتحقق المستقل، الجولة ٣٥ (أ٢))
  const pays = rowsHereOrInbox<RentPaymentSrc>(db, 'contract_payments', 'journal_entry_id', doc.k);
  if (pays.length > 1) throw new Error(tr('derive.rejected', { why: tr('derive.manyPayments', { lng: 'ar' }), lng: 'ar' }));
  const pay = pays[0];
  if (!pay || !db.get(`SELECT 1 FROM contracts WHERE id = ?`, [pay.contract_id])) {
    throw new AwaitOriginal(tr('derive.noPayment', { lng: 'ar' }));
  }
  // أبعاد السطور من عقد الدفعة كالحساب والمبلغ (التوجيه الثالث · ١)
  const dimsWhy = entryDimsIssue(db, doc.lines ?? [], pay.contract_id);
  if (dimsWhy) throw new Error(tr('derive.rejected', { why: dimsWhy, lng: 'ar' }));
  rentCheckAgainst(db, {
    srcId: String(doc.d!.src_id ?? ''),
    date: String(doc.d!.date ?? ''),
    lines: (doc.lines ?? []).map((l) => ({ account: String(l.account_code), debit: Number(l.debit_halalas) || 0, credit: Number(l.credit_halalas) || 0 })),
  }, pay, doc.ts);
}

/**
 * تاريخ قيد العضو بصيغة سنة-شهر-يوم ويومٍ قائم على جهاز المالك (المراجعة الشاملة 2026-11-13 · D2-R11-1): «2026-2-01» لا يعرفه قفل
 * الربع المقدَّم (quarterId) فكان يدخل ربعاً قُدِّم إقراره ويغيب من التقارير · من عضوٍ بإصدارٍ أقدم يمرّر حقلُه المكتوب، أو عابث ·
 * وما وصل الخادم قبل يوم هذا الإصلاح يُقبل كما قبله جهاز المالك القديم، فلا يرفضه وحده هاتفٌ بديل يسحب كل شيء (يظهر في «فحص
 * المطابقة» ويُصحَّح بعكسه) · فالحدّ ثابتٌ واحد على كل جهاز لا وقت ترقيته · واللحظة القديمة «2026-02-01T…» بيومها
 */
const MEMBER_ISO_DATE_SINCE = '2026-11-13T00:00:00.000Z';
function memberDateIssue(date: string, ts: string | undefined): string {
  if (isISODate(String(date ?? '').slice(0, 10))) return '';
  if (ts && isoCmp(ts, MEMBER_ISO_DATE_SINCE) < 0) return '';
  return tr('dates.invalidValue', { date, lng: 'ar' });
}

/** قيد التحصيل ودفعته: الفترة المقدَّمة، والتخصيص، ورصيد المستأجر الدائن، ثم السطور من الدفعة · يرمي بالسبب أو بالانتظار */
function rentCheckAgainst(db: DB, e: { srcId: string; date: string; lines: Array<{ account: string; debit: number; credit: number }> },
  pay: RentPaymentSrc, ts: string | undefined): void {
  const no = (why: string) => new Error(tr('derive.rejected', { why, lng: 'ar' }));
  // والتاريخ بغير صيغته قبل القفل: لا ربع له فلا يُرفض به (D2-R11-1)
  const dateWhy = memberDateIssue(e.date, ts);
  if (dateWhy) throw no(dateWhy);
  // القرار ٦ عبر المزامنة: ما وصل الخادم بعد تسجيل تقديم ربعه يُرفض (المتحقق المستقل، الجولة ٣٥ (أ٤))
  const filed = filingRecordedAt(db, e.date);
  if (filed && (!ts || isoCmp(ts, filed) > 0)) throw no(tr('vat.filedEntry', { lng: 'ar' }));
  const lines = rowsHereOrInbox<{ amount_halalas: number }>(db, 'payment_lines', 'payment_id', pay.id);
  const alloc = pay.installment_id ? [] : rowsHereOrInbox<{ installment_id: string; amount_halalas: number }>(db, 'payment_allocations', 'payment_id', pay.id);
  const allocWhy = alloc.length ? allocationIssue(db, pay, alloc) : '';
  if (allocWhy === 'await') throw new AwaitOriginal(tr('derive.noPayment', { lng: 'ar' }));
  if (allocWhy) throw no(allocWhy);
  // السداد من الرصيد الدائن بقدر رصيد مستأجر العقد في الدفتر (2410 بعُقوده)
  const cancelled = !!(pay as RentPaymentSrc & { cancelled_at?: string | null }).cancelled_at;
  if (cancelled) {
    const rev = (pay as RentPaymentSrc & { cancel_entry_id?: string | null }).cancel_entry_id;
    if (!rev) throw no(tr('derive.entryType', { lng: 'ar' }));
    if (!db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [rev]) && !rowsHereOrInbox(db, 'journal_entries', 'id', rev).length) {
      throw new AwaitOriginal(tr('derive.noPayment', { lng: 'ar' }));
    }
  }
  if (!cancelled && pay.method_label === CREDIT_METHOD && tenantCreditAvailable(db, pay.contract_id, pay.id) < (Number(pay.net_halalas) || 0)) {
    throw no(tr('derive.noCredit', { lng: 'ar' }));
  }
  const why = rentEntryIssue(db, e, pay,
    alloc.length ? alloc.reduce((s, a) => s + (Number(a.amount_halalas) || 0), 0) : null,
    lines.length ? lines.reduce((s, l) => s + (Number(l.amount_halalas) || 0), 0) : null);
  if (why === 'await') throw new AwaitOriginal(tr('derive.noPayment', { lng: 'ar' }));
  if (why) throw no(why);
}

/** أحدث نسخةٍ لصفٍّ بمفتاحه الأول (صفّ التسوية بعقده) · كـ latestRow */
function latestRowByKey<T>(db: DB, table: string, key: string): T | null {
  const inbox = db.get<{ payload: string }>(`SELECT payload FROM sync_inbox WHERE tbl = ? AND pk = ? AND del = 0`, [table, key]);
  if (inbox) return ((JSON.parse(inbox.payload) as RemoteDoc).d ?? null) as T | null;
  const col = syncTable(table)?.pkCols[0] ?? 'id';
  return db.get<T>(`SELECT * FROM "${table}" WHERE "${col}" = ?`, [key]) ?? null;
}

const POSTED = 'مرحّل'; // i18n-exempt: حالة القيد المخزّنة
const SRC_LINE_COLS = 'id, entry_id, account_code, debit_halalas, credit_halalas, contract_id, unit_id, property_id, asset_id';

/** قارئ مستندات القيد لإعادة الاشتقاق (deriveSources.ts) على جهاز المالك */
function sourceReader(db: DB): SourceReader {
  const linesHere = (id: string) => db.all<SrcLine>(`SELECT ${SRC_LINE_COLS} FROM journal_lines WHERE entry_id = ? ORDER BY rowid`, [id]);
  type Head = { id: string; src_type: string | null; src_id: string | null; reversed_by: string | null; no: string | null; status: string | null;
    date: string | null; created_at: string | null; deleted_at: string | null };
  return {
    row: <T>(table: string, key: string) => latestRowByKey<T>(db, table, key),
    asset: <T>(id: string) => {
      const here = db.get<T>(`SELECT * FROM assets WHERE id = ?`, [id]) ?? null;
      const p = db.get<{ payload: string }>(`SELECT payload FROM sync_inbox WHERE tbl = 'assets' AND pk = ? AND del = 0`, [id]);
      if (!p) return here;
      const doc = JSON.parse(p.payload) as RemoteDoc;
      if (!doc.d) return here;
      // صفٌّ واردٌ لا يُطبَّق بأساس إهلاكه (assetBasisIssue) لا يُشتق منه: يُشتق مما هنا
      return here && assetBasisIssue(db, doc, stripDerived('assets', doc.d)) !== '' ? here : (doc.d as T);
    },
    rows: <T>(table: string, col: string, value: string) => {
      // الصفوف هنا بعمودها، وما في الوارد أحدث منها ويغلبها بمفتاحه، والمحذوف في الوارد يُسقطها
      const pk = syncTable(table)?.pkCols[0] ?? 'id';
      const out = new Map<string, T>();
      for (const x of db.all<Record<string, unknown>>(`SELECT * FROM "${table}" WHERE "${col}" = ?`, [value])) out.set(String(x[pk]), x as T);
      // عبارتان مفهرستان لا «OR» واحدة (المدقق الخارجي B1: الـOR يُسقط فهرس العمود فيُمسح الوارد كله لكل قيد عضو)
      const byCol = db.all<{ pk: string; payload: string; del: number }>(
        `SELECT pk, payload, del FROM sync_inbox WHERE tbl = ? AND json_extract(payload, '$.d.${col}') = ?`, [table, value]);
      const seenPk = new Set(byCol.map((x) => x.pk));
      const byPk = out.size ? db.all<{ pk: string; payload: string; del: number }>(
        `SELECT pk, payload, del FROM sync_inbox WHERE tbl = ? AND pk IN (SELECT value FROM json_each(?))`,
        [table, JSON.stringify([...out.keys()])]).filter((x) => !seenPk.has(x.pk)) : [];
      for (const i of [...byCol, ...byPk]) {
        const d = (JSON.parse(i.payload) as RemoteDoc).d;
        if (i.del || !d || String(d[col] ?? '') !== value) out.delete(i.pk);
        else out.set(i.pk, d as T);
      }
      return [...out.values()];
    },
    entries: (srcType, srcId) => db.all<{ id: string; src_type: string | null; src_id: string | null; reversed_by: string | null; date: string | null }>(
      `SELECT id, src_type, src_id, reversed_by, date FROM journal_entries WHERE src_type = ? AND src_id = ? AND status = ?`, [srcType, srcId, POSTED])
      .map((e) => ({ ...e, lines: linesHere(e.id) })),
    entry: (id) => {
      const here = db.get<Head>(
        `SELECT id, src_type, src_id, reversed_by, no, status, date, created_at, deleted_at FROM journal_entries WHERE id = ? AND status = ?`, [id, POSTED]);
      if (here) return { ...here, here: true, key: here.id, lines: linesHere(id) };
      // كما سيُطبَّق من الوارد: أعمدة مستنده وسطوره، ومفتاحه في مستنده (applyOne يرفض ما خالف مفتاحُه مفتاحَ المستند)
      const p = db.get<{ payload: string }>(`SELECT payload FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ? AND del = 0`, [id]);
      const doc = p ? JSON.parse(p.payload) as RemoteDoc : null;
      const d = (doc?.d ?? null) as Partial<Record<keyof Head, unknown>> | null;
      if (!d || d.status !== POSTED) return null;
      // ومستندٌ مشوَّه السطور يُرفض حين يأتي دوره، فلا يُعدّ قيداً هنا (المدقق الخارجي I · K٢: أصلٌ مزوَّر «يصل معكوساً» كان يُقبل بعاكسٍ
      // مشوَّه في الوارد، ثم يُرفض العاكس ويبقى الأصل نقداً وإيراداً بلا مستند)
      if (linesMalformed(doc!)) return null;
      const s = (v: unknown) => (v == null || v === '' ? null : String(v));
      return { id, here: false, key: s(d.id), src_type: s(d.src_type), src_id: s(d.src_id), reversed_by: s(d.reversed_by), no: s(d.no),
        status: s(d.status), date: s(d.date), created_at: s(d.created_at), deleted_at: s(d.deleted_at), lines: docLines(doc) as unknown as SrcLine[] };
    },
    claimants: (revId) => {
      // عبارتان مفهرستان لا «UNION» (B1: الدمج المرتَّب كان يختار فهرس (tbl, pk) فيمسح قيود الوارد كلها، والدفتر بلا فهرسٍ للعاكس)
      const ids = new Set([
        ...db.all<{ id: string }>(`SELECT id FROM journal_entries WHERE reversed_by = ?`, [revId]).map((x) => x.id),
        ...db.all<{ id: string }>(`SELECT pk AS id FROM sync_inbox WHERE tbl = 'journal_entries' AND json_extract(payload, '$.d.reversed_by') = ? AND del = 0`,
          [revId]).map((x) => x.id),
      ]);
      for (const k of [PENDING_REV, GUESSED_REV]) for (const e of linksTo(k, getSyncState(db, k), revId)) ids.add(e);
      return [...ids];
    },
    taken: (no, lineIds, exceptId) => !!db.get(`SELECT 1 FROM journal_entries WHERE no = ? AND id != ?`, [no, exceptId])
      || !!db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND del = 0 AND pk != ? AND json_extract(payload, '$.d.no') = ?`, [exceptId, no])
      || !!db.get(`SELECT 1 FROM journal_lines WHERE entry_id != ? AND id IN (SELECT value FROM json_each(?))`, [exceptId, JSON.stringify(lineIds)])
      // سطور قيود الوارد من جدولها المفهرس (الهجرة ٥٢ · B1) لا بمسح كل حمولةٍ في الوارد
      // CROSS JOIN يُلزم المخطِّط بالبدء من معرّفات السطور (كان يبدأ من قيود الوارد كلها)
      || !!db.get(`SELECT 1 FROM sync_inbox_lines l CROSS JOIN sync_inbox i ON i.doc = l.doc
           WHERE l.line_id IN (SELECT value FROM json_each(?)) AND i.tbl = 'journal_entries' AND i.del = 0 AND i.pk != ?`,
           [JSON.stringify(lineIds), exceptId]),
    assetEntries: (assetId) => {
      const here = db.all<{ id: string; src_type: string | null; src_id: string | null; reversed_by: string | null; date: string | null }>(
        `SELECT id, src_type, src_id, reversed_by, date FROM journal_entries WHERE status = ? AND deleted_at IS NULL
           AND id IN (SELECT entry_id FROM journal_lines WHERE asset_id = ?)`, [POSTED, assetId]).map((e) => ({ ...e, here: true, lines: linesHere(e.id) }));
      const ids = new Set(here.map((e) => e.id));
      const s = (v: unknown) => (v == null || v === '' ? null : String(v));
      const inbox = db.all<{ pk: string; payload: string }>(
        `SELECT i.pk, i.payload FROM sync_inbox i WHERE i.tbl = 'journal_entries' AND i.del = 0 AND json_extract(i.payload, '$.d.status') = ?
           AND EXISTS (SELECT 1 FROM json_each(i.payload, '$.lines') j WHERE j.type = 'object' AND json_extract(j.value, '$.asset_id') = ?)`, [POSTED, assetId])
        .filter((x) => !ids.has(x.pk)).map((x) => {
          const doc = JSON.parse(x.payload) as RemoteDoc;
          const d = doc.d ?? {};
          return { id: x.pk, here: false, src_type: s(d.src_type), src_id: s(d.src_id), reversed_by: s(d.reversed_by), date: s(d.date), lines: docLines(doc) as unknown as SrcLine[] };
        });
      return [...here, ...inbox];
    },
    pending: (srcType, srcId) => db.all<{ pk: string }>(
      `SELECT i.pk FROM sync_inbox i WHERE i.tbl = 'journal_entries' AND i.del = 0 AND json_extract(i.payload, '$.d.src_type') = ?
         AND json_extract(i.payload, '$.d.src_id') = ? AND json_extract(i.payload, '$.d.status') = ?
         AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = i.pk AND e.status = ?)`, [srcType, srcId, POSTED, POSTED]).map((x) => x.pk),
  };
}

/**
 * إعادة اشتقاق قيد العضو من مستنده · بقية المراحل (التوجيه الثالث · ١ · قرار المالك 2026-10-15 «١» و2026-11-07): القيد المرحّل الذي
 * كتبه عضو بمصدرٍ من DERIVED_SOURCES تُحسب سطوره على جهاز المالك من مستنده بدوال الترحيل نفسها، ويُرفض كله إن خالفها حساباً أو
 * مبلغاً أو بُعداً أو تاريخاً · وما لم يصل مستنده بعد يُنتظر كالأصل الناقص · وما كتبه المالك لا يُعاد · وما وصل بعد تسجيل تقديم
 * ربعه يُرفض كقيد التحصيل (القرار ٦ عبر المزامنة)
 */
function memberSourceCheck(db: DB, doc: RemoteDoc): void {
  const src = (doc.d!.src_type as string | null) ?? '';
  if (!DERIVED_SOURCES[src] || getSyncState(db, 'membership') || !byMember(db, doc, true)) return;
  const no = (why: string) => new Error(tr('deriveSrc.rejected', { source: src, why, lng: 'ar' }));
  const date = String(doc.d!.date ?? '');
  // والتاريخ بغير صيغته قبل القفل (D2-R11-1)
  const dateWhy = memberDateIssue(date, doc.ts);
  if (dateWhy) throw no(dateWhy);
  const filed = filingRecordedAt(db, date);
  if (filed && (!doc.ts || isoCmp(doc.ts, filed) > 0)) throw no(tr('vat.filedEntry', { lng: 'ar' }));
  const reader = sourceReader(db);
  const issue = (reversedBy: string | null) => memberSourceIssue(db, reader, {
    id: doc.k, src_type: src, src_id: (doc.d!.src_id as string | null) ?? null, no: (doc.d!.no as string | null) ?? null, date,
    reversed_by: reversedBy, lines: (doc.lines ?? []) as SrcLine[],
  });
  const reversedBy = (doc.d!.reversed_by as string | null) ?? null;
  let why = issue(reversedBy);
  // والواصل معكوساً بعاكسٍ لا يُقبل (ليس مرآته، أو محجوزٌ لغيره) يُحكم عليه غير معكوس كما على الجهاز الذي سبق إليه: يُطبَّق إن طابق مستنده،
  // والربط معلَّقٌ كما هو هناك (المدقق الخارجي O٤: عضوٌ ربط قيد المالك بعاكسٍ مزوَّر فرفضه هاتف المالك البديل وحده نهائياً)
  if (why && why !== 'await' && reversedBy) why = issue(null) === '' ? '' : why;
  if (why === 'await') throw new AwaitOriginal(tr('deriveSrc.noDoc', { lng: 'ar' }));
  if (why) throw no(why);
}

/** قيد ترحيل تأمينٍ حيٌّ هنا للعقد المجدَّد (منطق depositCarried في الخدمة) */
const carryLiveHere = (db: DB, contractId: string): boolean => !!db.get(
  `SELECT 1 FROM journal_entries WHERE src_type = 'deposit_carry' AND src_id = ? AND reversed_by IS NULL AND deleted_at IS NULL AND status = ?`,
  [contractId, POSTED]);

/** تأمين العقد رُحِّل هنا إلى خلفٍ قائم بقيد ترحيلٍ حيّ (منطق depositCarried في الخدمة · deriveSources: carriedOn) */
const carriedOnHere = (db: DB, prevId: string): boolean => !!db.get(
  `SELECT 1 FROM contracts n JOIN journal_entries e ON e.src_type = 'deposit_carry' AND e.src_id = n.id
   WHERE n.renewed_from = ? AND n.deleted_at IS NULL AND e.reversed_by IS NULL AND e.deleted_at IS NULL AND e.status = ? LIMIT 1`, [prevId, POSTED]);

/** المصدر الحيّ هنا ومعه ما في الوارد مرحّلاً لم يُطبَّق بعد: مجموع دائن قيوده ناقصاً عواكسه */
function liveOrPendingTotal(db: DB, src: string, srcId: string): number {
  const here = (s: string) => Number(db.get<{ n: number }>(
    `SELECT COALESCE(SUM(l.credit_halalas), 0) AS n FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.src_type = ? AND e.src_id = ? AND e.status = ? AND e.deleted_at IS NULL`, [s, srcId, POSTED])!.n);
  const inbox = (s: string) => db.all<{ payload: string }>(
    `SELECT i.payload FROM sync_inbox i WHERE i.tbl = 'journal_entries' AND i.del = 0 AND json_extract(i.payload, '$.d.src_type') = ?
       AND json_extract(i.payload, '$.d.src_id') = ? AND json_extract(i.payload, '$.d.status') = ?
       AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = i.pk)`, [s, srcId, POSTED])
    .reduce((sum, r) => sum + docLines(JSON.parse(r.payload) as RemoteDoc).reduce((x, l) => x + (Number(l.credit_halalas) || 0), 0), 0);
  return here(src) + inbox(src) - here(src + '_rev') - inbox(src + '_rev');
}

/**
 * ترحيل تأمينٍ رفضه جهاز المالك لأن تأمين العقد السابق سُوّي (deriveSources: carryAfterSettle · المراجعة الشاملة 2026-11-13 · R12-DEP-1):
 * قيد deposit_carry للعقد المجدَّد في سجل المرفوض أو في الوارد ينتظر، وتسوية السابق هنا أو في الوارد، ولا ترحيل حيّاً هنا · فتأمين
 * العقد المجدَّد في صفّه (المرحَّل وزيادته في renewContract) يحمل ما لم يحتجزه له الدفتر، وتسويته تعرض ردّه ثانية · يعيد التأمين الذي
 * يحتجزه الدفتر له، أو null إن لم يكن ترحيلٌ ميت:
 *  - التأمين لدى المكتب أو المنصة: ما قُبض له فعلاً (قيود contract_deposit الحيّة هنا وما في الوارد منها، وهي الزيادة وحدها)، فالحساب
 *    واحدٌ من الصف المنفوخ أو المصحَّح (يُرفع المصحَّح ويعود من السحابة إلى كل جهاز، ولا يُطرح المرحَّل منه مرتين)
 *  - لدى طرف آخر (لم يدخل الدفتر): صفّه ناقصاً المرحَّل مرةً واحدة، يحفظها جهاز المالك (DEAD_CARRY)
 */
const DEAD_CARRY = 'dead_carry:';
function deadCarryDeposit(db: DB, contractId: string, row: Record<string, unknown>): number | null {
  const prevId = row.renewed_from == null ? '' : String(row.renewed_from);
  if (!prevId || getSyncState(db, 'membership') || carryLiveHere(db, contractId)) return null;
  if (!latestRowByKey(db, 'deposit_settlements', prevId)) return null;
  const docs = [
    ...db.all<{ payload: string }>(`SELECT payload FROM sync_rejects WHERE tbl = 'journal_entries'
      AND json_extract(payload, '$.d.src_type') = 'deposit_carry' AND json_extract(payload, '$.d.src_id') = ?`, [contractId]),
    ...db.all<{ payload: string }>(`SELECT payload FROM sync_inbox WHERE tbl = 'journal_entries' AND del = 0
      AND json_extract(payload, '$.d.src_type') = 'deposit_carry' AND json_extract(payload, '$.d.src_id') = ?`, [contractId]),
  ].map((x) => JSON.parse(x.payload) as RemoteDoc);
  const carried = Math.max(0, ...docs.map((d) => docLines(d).reduce((s, l) => s + (Number(l.credit_halalas) || 0), 0)));
  if (!(carried > 0)) return null;
  const deposit = Number(row.deposit_halalas) || 0;
  if (String(row.deposit_holder ?? '') !== 'طرف آخر') return Math.max(0, liveOrPendingTotal(db, 'contract_deposit', contractId)); // i18n-exempt: جهة مخزّنة
  const seen = getSyncState(db, DEAD_CARRY + contractId);
  return seen != null && Number.isFinite(Number(seen)) ? Number(seen) : Math.max(0, deposit - carried);
}

/** يصحّح تأمين العقد المجدَّد هنا إن كان ترحيله ميتاً · ويُرفع صفّه فيعود إلى السحابة وكل جهاز (بعد التطبيق: ترحيلٌ رُفض بعد صفّه) */
function fixDeadCarries(db: DB): void {
  if (getSyncState(db, 'membership')) return;
  const ids = db.all<{ k: string }>(`SELECT DISTINCT json_extract(payload, '$.d.src_id') AS k FROM sync_rejects WHERE tbl = 'journal_entries'
    AND json_extract(payload, '$.d.src_type') = 'deposit_carry'`).map((x) => String(x.k ?? '')).filter(Boolean);
  for (const id of ids) {
    const row = db.get<Record<string, unknown>>(`SELECT * FROM contracts WHERE id = ?`, [id]);
    if (!row) continue;
    const want = deadCarryDeposit(db, id, row);
    if (want === null || want === Number(row.deposit_halalas)) continue;
    db.run(`UPDATE contracts SET deposit_halalas = ? WHERE id = ?`, [want, id]);
    noteDeadCarry(db, id, row, want);
  }
}

/**
 * دفعة «من التأمين» حيّةٌ هنا وقيدها معكوسٌ بعاكسٍ مرحّل قُبل وربط: ملغاةٌ بعاكسه، قاعدة الدفعة الواردة نفسها (Z١-١ وZ٢-٢ في applyOne) ·
 * يُلغيها جهاز المالك بعد التطبيق ويرفعها: عضوٌ لا يرى الدفعة يعكس قيدها في تعديل التسوية ولا يلغيها (قسم «التأمينات» وحده لا يقرأ
 * الدفعات، أو وصله القيد قبل دفعته · service.ts: reverseDepositRent)، وإصلاح الدفعة الواردة لا يجري إلا حين تصل، والعضو لم يكتبها ·
 * وكانت تبقى حيّةً بقيدٍ معكوس فالقسط «مدفوع» من تأمينٍ رُدّ، ويحمرّ فحص «كل دفعة محصَّلة لها قيد مرحّل» ويفترق جهاز المالك وجهاز العضو
 * (المراجع المعاكس الثالث على R12-BAK-2) · بسبب تعديل التسوية وتاريخ العاكس كما يكتبهما الحفظ نفسه، فتطابق نسخة العضو إن كانت له ·
 * ونسختها في الوارد لم تُطبَّق بعد تُصلح حين تُطبَّق · والدفعة العادية لا: إلغاؤها يكتبه جهاز العاكس معه بسببه وتاريخه (cancelPayment)
 */
function cancelReversedDepositRent(db: DB, touched: Set<string>): void {
  if (getSyncState(db, 'membership')) return;
  for (const p of db.all<{ id: string; rev: string; d: string }>(
    `SELECT p.id, r.id AS rev, r.date AS d FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
       JOIN journal_entries r ON r.id = e.reversed_by
     WHERE p.method_label = ? AND p.cancelled_at IS NULL AND r.status = ? AND r.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM sync_inbox i WHERE i.tbl = 'contract_payments' AND i.pk = p.id AND i.del = 0)`,
    [DEPOSIT_RENT_METHOD, POSTED_ENTRY])) {
    db.run(`UPDATE contract_payments SET cancelled_at = ?, cancel_reason = ?, cancel_entry_id = ? WHERE id = ?`,
      [p.d, DEPOSIT_RENT_EDIT_REASON, p.rev, p.id]);
    for (const i of installmentsOfPayment(db, p.id)) touched.add(i);
    enqueue(db, 'contract_payments', p.id, 'upsert');
  }
}

/**
 * دفعة «من التأمين» ملغاةٌ بسبب الضمّ (DEPOSIT_RENT_KEPT_REASON) وعاكسها لم يعد خارج المطابقة على جهاز المالك: يعيد سببها سبب التعديل
 * ويرفعها، فتتفق ورقة التسوية على جهاز العضو (بالسبب) وعلى جهاز المالك (بالعلامات · depositArrearsPaid) · وذلك حين يحفظ التسوية عضوٌ
 * لا يرى الدفعات (قسم «التأمينات» وحده) فلا يعيده هو (reverseDepositRent)، وسطر حفظه يوثّق العاكس هنا (المراجع المستقل الخامس على R12-BAK-2) ·
 * ولا يعيده إلا بدليلٍ هنا: علامةٌ نافذة على عاكسها صار له مستند، أو أصلها نفسه خارج المطابقة · فجهاز مالكٍ آخر وصلته الدفعة قبل علامتها
 * لا يمسّها · والحساب مرةً حين توجد دفعةٌ بهذا السبب، وهي نادرة
 */
function unkeepDocumentedDepositRent(db: DB): void {
  if (getSyncState(db, 'membership')) return;
  const kept = db.all<{ id: string; je: string; ce: string }>(
    `SELECT id, journal_entry_id AS je, cancel_entry_id AS ce FROM contract_payments
     WHERE cancel_reason = ? AND method_label = ? AND cancelled_at IS NOT NULL`, [DEPOSIT_RENT_KEPT_REASON, DEPOSIT_RENT_METHOD]);
  if (!kept.length) return;
  const { out, marked } = reviewState(db);
  for (const p of kept) {
    if (!((marked.has(p.ce) && !out.has(p.ce)) || out.has(p.je))) continue;
    db.run(`UPDATE contract_payments SET cancel_reason = ? WHERE id = ?`, [DEPOSIT_RENT_EDIT_REASON, p.id]);
    enqueue(db, 'contract_payments', p.id, 'upsert');
  }
}

/** صفّ العقد صُحّح تأمينه هنا: يُذكر ويُرفع */
function noteDeadCarry(db: DB, id: string, row: Record<string, unknown>, want: number): void {
  if (String(row.deposit_holder ?? '') === 'طرف آخر') setSyncState(db, DEAD_CARRY + id, String(want)); // i18n-exempt: جهة مخزّنة
  enqueue(db, 'contracts', id, 'upsert');
  try {
    logAudit(db, 'المزامنة', 'update', 'تصحيح تأمين عقدٍ مجدَّد', // i18n-exempt: وحدة السجل ونوعه المخزّنان
      tr('sync.deadCarryDeposit', { no: String(row.contract_no ?? ''), from: fmt(Number(row.deposit_halalas) || 0), to: fmt(want), lng: 'ar' }));
  } catch { /* السجل لا يعطّل */ }
}

/**
 * حركة بنكٍ كتبها عضوٌ برقم قيد (المدقق الخارجي ك٢): لا تُطبَّق على جهاز المالك قبل قيدها · فرصيد البنك يُحسب من الحركات، وقيدٌ
 * مرفوض (عمولة تقبيلٍ بلا أبعاد من إصدارٍ أقدم مثلاً) كانت حركته تُطبَّق فيرتفع رصيد البنك بلا قيد · قيدها هنا تُطبَّق، وفي الوارد أو
 * لم يصل بعد تُنتظر، ومرفوضٌ تُرفض معه بسببه · والمحذوفة تُطبَّق (حذفها لا يُدخل مالاً)
 */
/** نقل النقد بلا قيد بين المحفظة والبنوك: مصدره وإشارته كما يكتبها التطبيق (cashOps.ts) */
const INTERNAL_BANK_SOURCES = new Map<string, number>([
  [CASH_DEPOSIT_SOURCE, 1], [CASH_WITHDRAW_SOURCE, -1], [TRANSFER_OUT_SOURCE, -1], [TRANSFER_IN_SOURCE, 1],
]);

interface BankTxState { bank: string; amount: number; no: string; source: string; live: boolean; date: string }

/**
 * سطر كشفٍ وارد «مطابَق» بشروط approveMatch نفسها على كل جهاز (المدقق الخارجي U٢٣): حركةٌ حيّة من بنك السطر بمبلغه، ولا يمسكها
 * سطرٌ آخر · وإلا عاد السطر مفتوحاً ويُعاد مصحَّحاً إلى السحابة (true) · وسطران يمسكان الحركة نفسها (جهازان بلا اتصال): الأصغر
 * معرّفاً يبقى، والآخر يعود مفتوحاً هنا أو في الوارد، فتتفق الأجهزة بالقاعدة نفسها · والتصحيح يرفعه جهاز المالك وحده (جهاز العضو
 * يصحّح نسخته، وقد لا تجيز له القواعد الكتابة)
 */
function statementLineCheck(db: DB, row: Record<string, unknown>, member = false): { changed: boolean; own: boolean } {
  const r = statementLineFix(db, row, member);
  const fixed = restoredFacts.delete(String(row.id));
  return { changed: r || fixed || ownMatch.has(String(row.id)), own: ownMatch.delete(String(row.id)) };
}
/** سطورٌ أبقى هذا الجهاز مطابقتها في الوارد المحيا: يرفعها ولو كان جهاز عضو (مطابقته هو · Y٧) */
const ownMatch = new Set<string>();
/** سطورٌ أعاد جهاز المالك وقائعها (E٢-٥): يرفع نسخته */
const restoredFacts = new Set<string>();
function statementLineFix(db: DB, row: Record<string, unknown>, member = false): boolean {
  let changed = false;
  // والسطر حيٌّ ما احتاجه كشفٌ حيّ (تخطّاه عند حفظه لأنه هنا · الهجرة ٥٨ · المدقق الخارجي V٤): جهازٌ حذف كشفه ولم يعرف ذاك يعيده إليه ·
  // وسطرٌ حيٌّ في كشفٍ محذوف (اعتُمد على جهازٍ آخر بعد الحذف · V٥) يُحذف معه
  const stmt = row.statement_id == null ? undefined
    : db.get<{ del: string | null }>(`SELECT deleted_at AS del FROM bank_statements WHERE id = ?`, [String(row.statement_id)]);
  if (row.deleted_at != null || stmt?.del != null) {
    const to = sharingStatement(db, String(row.bank_id ?? ''), String(row.line_key ?? ''), String(row.statement_id ?? ''), String(row.id));
    // ولا يُحيا وللبصمة سطرٌ حيٌّ آخر (المدقق الخارجي X١: قراءة الكشف ثانيةً بمعرّفاتٍ جديدة)
    const twin = to && dupOfLive(db, String(row.bank_id ?? ''), String(row.line_key ?? ''), String(row.id), to);
    if (to && twin) {
      if (row.deleted_at == null) { row.deleted_at = stmt?.del ?? new Date().toISOString(); changed = true; }
    } else if (to) {
      row.deleted_at = null; row.statement_id = to; changed = true;
      // والحذف تبعاً لكشفه لا يمحو مطابقةً حيّةً هنا للسطر نفسه (المدقق الخارجي Y٧: حذف المالك الأحدث كان يغلب اعتماد العضو)
      const here = db.get<{ status: string; tx: string | null; at: string | null; note: string; del: string | null }>(
        `SELECT status, bank_tx_id AS tx, matched_at AS at, note, deleted_at AS del FROM bank_statement_lines WHERE id = ?`, [String(row.id)]);
      // (تعديلٌ هنا لم يُرفع وحده: نسخةٌ قديمة من السحابة ألغى المالك مطابقتها بعدها لا تعود · Z١-٣)
      if (here && here.del == null && here.status !== 'open' && row.status === 'open'
        && db.get(`SELECT 1 FROM sync_outbox WHERE tbl = 'bank_statement_lines' AND pk = ?`, [String(row.id)])) {
        row.status = here.status; row.bank_tx_id = here.tx; row.matched_at = here.at; row.note = here.note;
        ownMatch.add(String(row.id));
      }
    } else if (row.deleted_at == null) { row.deleted_at = stmt!.del; changed = true; }
  }
  // وسطران حيّان بالبصمة نفسها (حُذف كشفٌ وأُعيدت قراءته بمعرّفاتٍ جديدة على جهاز، وأُحيي سطره القديم في كشفٍ متداخل على آخر · X١):
  // يبقى المطابَق أو المستبعَد، ثم الأقدم إنشاءً، ثم الأصغر معرّفاً، ويُحذف الآخر على كل جهاز
  // (بعدّ الحفظ نفسه بترتيب الأولوية، لا بالأزواج: حوالاتٌ بلا رصيد في يومٍ واحد حركاتٌ مختلفة · المدقق الخارجي C٢-١)
  if (row.deleted_at == null) {
    const me: LiveLine = { id: String(row.id), status: String(row.status ?? 'open'), c: String(row.created_at ?? ''), k: String(row.line_key ?? ''), st: String(row.statement_id ?? '') };
    const others = liveOfBase(db, String(row.bank_id ?? ''), me.k, me.id);
    const all = [...others, me].sort((a, b) => (lineRank(a) < lineRank(b) ? -1 : 1));
    const need = statementsNeed(db, [...all.map((x) => x.st), ...bankStatementIds(db, String(row.bank_id ?? ''))], me.k);
    const keep = keepInOrder(all.map((x) => x.k), () => need);
    // ووقائع الإيداع بأول ما قُرئ به هنا: سطرٌ جديدٌ من عضوٍ بالبصمة نفسها يحمل بيان السطر القائم ومرجعه (المدقق الخارجي E٢-٢: توأمٌ
    // مزوَّر بوقت إنشاءٍ أقدم وبيانٍ يسمّي مستأجراً آخر كان يغلب ويقلب الاقتراح)
    // (وكذلك سطرٌ قد يكون الإيداع نفسه بصيغةٍ أخرى: «@الرصيد» من العضو مكان «#1» للمالك يحمل بيانه ومرجعه ومطابقته · G٢-٥)
    const local = others.find((x) => x.k === me.k && !keep[all.indexOf(x)]) ?? others.find((x) => sameLineKey(x.k, me.k) && !keep[all.indexOf(x)]);
    if (member && local && keep[all.indexOf(me)]) {
      const f = db.get<{ descr: string; ref: string | null; vd: string | null; status: string; tx: string | null; at: string | null; note: string }>(
        `SELECT descr, ref, value_date AS vd, status, bank_tx_id AS tx, matched_at AS at, note FROM bank_statement_lines WHERE id = ?`, [local.id]);
      if (f && (f.descr !== row.descr || (f.ref ?? null) !== (row.ref ?? null) || (f.vd ?? null) !== (row.value_date ?? null))) {
        row.descr = f.descr; row.ref = f.ref; row.value_date = f.vd; changed = true;
      }
      // (ومطابقة سطر المالك الحيّة تنتقل إن كان الوارد مفتوحاً أو مطابقته لم تثبت: حركتها ليست هنا أو رُفضت · I٢-٤)
      const unproven = (row.status ?? 'open') === 'open' || !row.bank_tx_id
        || !db.get(`SELECT 1 FROM bank_tx WHERE id = ? AND deleted_at IS NULL`, [String(row.bank_tx_id)]);
      if (f && f.status !== 'open' && unproven
        && (f.status !== 'matched' || db.get(`SELECT 1 FROM bank_tx WHERE id = ? AND deleted_at IS NULL`, [f.tx ?? '']))) {
        row.status = f.status; row.bank_tx_id = f.tx; row.matched_at = f.at; row.note = f.note; changed = true;
      }
    }
    all.forEach((x, i) => {
      if (keep[i]) return;
      if (x.id === me.id) { row.deleted_at = new Date().toISOString(); changed = true; return; }
      db.run(`UPDATE bank_statement_lines SET deleted_at = ?, status = 'open', bank_tx_id = NULL, matched_at = NULL WHERE id = ?`, [new Date().toISOString(), x.id]);
      enqueueStmtFix(db, x.id);
    });
  }
  const demote = () => { row.status = 'open'; row.bank_tx_id = null; row.matched_at = null; return true; };
  if (row.deleted_at != null && (row.status !== 'open' || row.bank_tx_id != null)) return demote();
  if (row.status !== 'matched') return row.bank_tx_id != null ? demote() : changed;
  // والمحذوف لا يمسك حركة · ولا حركة: لا مطابقة
  const txId = row.bank_tx_id == null ? '' : String(row.bank_tx_id);
  if (row.deleted_at != null || !txId) return demote();
  const tx = db.get<{ b: string; a: number; del: string | null }>(`SELECT bank_id AS b, amount_halalas AS a, deleted_at AS del FROM bank_tx WHERE id = ?`, [txId]);
  // والسطر لحركةٍ ليست هنا وللسطر تحصيلٌ حيٌّ بقيده هنا: يُطابَق بحركة ذلك التحصيل (الإيداع الواحد اعتمده جهازان لهدفين فقُبل أحدهما ·
  // Z٢-١) · وحركةٌ رُفضت لا يُطابَق بها · وما لم يصل بعد يُرجئه المفتاح الأجنبي
  // ومطابقةٌ واردة لا تثبت (حركتها رُفضت أو من بنكٍ آخر) لا تمحو مطابقةً حيّةً هنا (G٢-٢: تحصيل المالك اليدوي)
  const keepHere = (): boolean => {
    const h = db.get<{ s: string; tx: string | null; at: string | null; note: string }>(
      `SELECT l.status AS s, l.bank_tx_id AS tx, l.matched_at AS at, l.note FROM bank_statement_lines l JOIN bank_tx t ON t.id = l.bank_tx_id
       WHERE l.id = ? AND l.deleted_at IS NULL AND l.status = 'matched' AND t.deleted_at IS NULL AND l.bank_tx_id != ?`, [String(row.id), txId]);
    if (!h) return demote();
    row.status = h.s; row.bank_tx_id = h.tx; row.matched_at = h.at; row.note = h.note;
    return true;
  };
  if (!tx) {
    // (بيوم السطر، ولا تمسكها سطرٌ آخر · B٢-٢)
    const alt = db.get<{ id: string }>(
      `SELECT t.id FROM journal_entries e JOIN bank_tx t ON t.journal_no = e.no AND t.bank_id = ? AND t.amount_halalas = ? AND t.date = ? AND t.deleted_at IS NULL
       WHERE e.stmt_line_id = ? AND e.reversed_by IS NULL AND e.status = ?
         AND NOT EXISTS (SELECT 1 FROM bank_statement_lines o WHERE o.bank_tx_id = t.id AND o.id != ? AND o.status = 'matched' AND o.deleted_at IS NULL) LIMIT 1`,
      [String(row.bank_id), Number(row.amount_halalas), String(row.date), String(row.id), POSTED_ENTRY, String(row.id)]);
    if (alt) { row.bank_tx_id = alt.id; return true; }
    if (db.get(`SELECT 1 FROM sync_rejects WHERE tbl = 'bank_tx' AND pk = ?`, [txId])) return keepHere();
    return changed;
  }
  if (tx.del != null || String(tx.b) !== String(row.bank_id) || Number(tx.a) !== Number(row.amount_halalas)) return keepHere();
  // ولا مطابقة بحركة قيدٍ عُكس (C٢-٢)
  if (db.get(`SELECT 1 FROM bank_tx t JOIN journal_entries e ON e.no = t.journal_no WHERE t.id = ? AND e.reversed_by IS NOT NULL`, [txId])) return demote();
  const rivals = db.all<{ id: string }>(
    `SELECT id FROM bank_statement_lines WHERE bank_tx_id = ? AND status = 'matched' AND deleted_at IS NULL AND id != ? ORDER BY id`, [txId, String(row.id)]);
  if (!rivals.length) return changed;
  if (rivals.some((r) => r.id < String(row.id))) return demote();
  for (const r of rivals) {
    db.run(`UPDATE bank_statement_lines SET status = 'open', bank_tx_id = NULL, matched_at = NULL WHERE id = ?`, [r.id]);
    enqueueStmtFix(db, r.id);
  }
  return changed;
}

/** سطور الكشف التي صحّحها جهاز المالك ولم تُرفع بعد: تصحيحٌ يغلبه أي تعديلٍ حقيقي وارد (Y٧) */
const STMT_FIXES = 'stmt_line_fixes';
// والعلامة بوقت صفّ الطابور الذي كتبه التصحيح: تعديلٌ لاحق هنا وقته غيره فلا يُعدّ تصحيحاً، والعلامة بلا صفٍّ في الطابور تُحذف
// (Z١-٦ وZ٢-٧: علامةٌ باقية كانت تجعل اعتماداً حقيقياً للمالك «تصحيحاً» يغلبه وارد أقدم)
function stmtFixes(db: DB): Map<string, string> {
  let raw: Record<string, string> = {};
  try { raw = JSON.parse(getSyncState(db, STMT_FIXES) ?? '{}') as Record<string, string>; } catch { raw = {}; }
  if (Array.isArray(raw)) raw = {};
  return new Map(Object.entries(raw));
}
function saveStmtFixes(db: DB, m: Map<string, string>): void {
  for (const k of [...m.keys()]) if (!db.get(`SELECT 1 FROM sync_outbox WHERE tbl = 'bank_statement_lines' AND pk = ? AND changed_at = ?`, [k, m.get(k)!])) m.delete(k);
  setSyncState(db, STMT_FIXES, m.size ? JSON.stringify(Object.fromEntries(m)) : null);
}
function markStmtFix(db: DB, id: string, on: boolean): void {
  const m = stmtFixes(db);
  if (on) {
    const at = db.get<{ c: string }>(`SELECT changed_at AS c FROM sync_outbox WHERE tbl = 'bank_statement_lines' AND pk = ?`, [id])?.c;
    if (at) m.set(id, at);
  } else m.delete(id);
  saveStmtFixes(db, m);
}
/** تصحيح سطر كشفٍ يرفعه جهاز المالك وحده، معلَّماً تصحيحاً */
function enqueueStmtFix(db: DB, id: string, at?: string): void {
  if (getSyncState(db, 'membership')) return;
  enqueue(db, 'bank_statement_lines', id, 'upsert', at);
  markStmtFix(db, id, true);
}

type LiveLine = { id: string; status: string; c: string; k: string; st: string };
/** كشوف البنك الحيّة كلها: المزامنة تعدّ بها كما يعدّ الحفظ (المدقق الخارجي K٢-١ وK٢-٢: كانت كشوف السطور الحيّة وحدها) */
const bankStatementIds = (db: DB, bankId: string): string[] =>
  db.all<{ id: string }>(`SELECT id FROM bank_statements WHERE bank_id = ? AND deleted_at IS NULL`, [bankId]).map((x) => x.id);
/** أولوية سطر الكشف بين سطور قاعدته: المطابَق أو المستبعَد، ثم الأقدم إنشاءً، ثم الأصغر معرّفاً */
const lineRank = (x: LiveLine): string => [x.status === 'open' ? 1 : 0, x.c, x.id].join('|');
/** السطور الحيّة للبنك بقاعدة البصمة (اليوم والمبلغ) بمدى الفهرس */
function liveOfBase(db: DB, bankId: string, key: string, exceptId: string): LiveLine[] {
  const base = lineKeyBase(key);
  return db.all<LiveLine>(
    `SELECT id, status, created_at AS c, line_key AS k, COALESCE(statement_id, '') AS st FROM bank_statement_lines
     WHERE bank_id = ? AND line_key BETWEEN ? AND ? AND id != ? AND deleted_at IS NULL`, [bankId, base, base + '~', exceptId]);
}
/** سطرٌ بهذه البصمة تكرارٌ لما هو حيٌّ هنا (لو أُحيي آخرَ سطور قاعدته) */
function dupOfLive(db: DB, bankId: string, key: string, exceptId: string, statementId: string): boolean {
  const others = liveOfBase(db, bankId, key, exceptId).sort((a, b) => (lineRank(a) < lineRank(b) ? -1 : 1));
  const need = statementsNeed(db, [...others.map((x) => x.st), statementId, ...bankStatementIds(db, bankId)], key);
  return !keepInOrder([...others.map((x) => x.k), key], () => need)[others.length];
}

/** كشفٌ حيٌّ آخر للبنك تخطّى سطراً ببصمته عند حفظه (الهجرة ٥٨) وما زال ينقصه (E٢-٣)، أو null */
function sharingStatement(db: DB, bankId: string, lineKey: string, exceptStatementId: string, exceptLineId = ''): string | null {
  return statementWithRoom(db, bankId, lineKey, exceptStatementId, exceptLineId);
}

/**
 * كشفٌ وارد وسطوره هنا (المدقق الخارجي V٤ وV٥): الحيّ يعيد إليه ما تخطّاه من سطورٍ حُذفت مع كشفها هنا، والمحذوف تُحذف معه سطوره الحيّة
 * هنا إلا ما احتاجه كشفٌ حيٌّ آخر فيُنقل إليه · ويرفع جهاز المالك ما صحّحه
 */
function statementCascade(db: DB, statementId: string, row: Record<string, unknown>, at: string): void {
  // بوقت الكشف الوارد لا بوقت الآن: نسخة سطرٍ أحدث منه (مطابقةٌ على جهازٍ آخر) تغلب الإحياء (المدقق الخارجي Y٧)
  const fix = (id: string) => enqueueStmtFix(db, id, at);
  const bankId = String(row.bank_id ?? '');
  if (row.deleted_at == null) {
    let keys: string[] = [];
    try { keys = JSON.parse(String(row.shared_keys ?? '[]')); } catch { keys = []; }
    for (const k of keys) {
      if (dupOfLive(db, bankId, k, '', statementId)) continue;
      const dead = db.get<{ id: string; k: string }>(`SELECT id, line_key AS k FROM bank_statement_lines WHERE bank_id = ? AND ${SAME_KEY_SQL('line_key')} AND deleted_at IS NOT NULL
        ORDER BY line_key = ? DESC, deleted_at DESC, id LIMIT 1`, [bankId, ...sameKeyParams(k), k]);
      // (والسطر المحيا ببصمته هو لا ببصمة الكشف: «#n» من قراءةٍ محذوفة قد يكون تكراراً لما هنا · المدقق الخارجي I٢-٥)
      if (!dead || (dead.k !== k && dupOfLive(db, bankId, dead.k, dead.id, statementId))) continue;
      db.run(`UPDATE bank_statement_lines SET deleted_at = NULL, statement_id = ? WHERE id = ?`, [statementId, dead.id]);
      fix(dead.id);
    }
    return;
  }
  for (const l of db.all<{ id: string; k: string }>(`SELECT id, line_key AS k FROM bank_statement_lines WHERE statement_id = ? AND deleted_at IS NULL`, [statementId])) {
    const to = sharingStatement(db, bankId, l.k, statementId, l.id);
    if (to) db.run(`UPDATE bank_statement_lines SET statement_id = ? WHERE id = ?`, [to, l.id]);
    else db.run(`UPDATE bank_statement_lines SET deleted_at = ?, status = 'open', bank_tx_id = NULL, matched_at = NULL WHERE id = ?`, [String(row.deleted_at), l.id]);
    fix(l.id);
  }
}

/**
 * حركة البنك من عضو على جهاز المالك (المدقق الخارجي هـ٩، ثم G١ إلى G٦ في الجولة الرابعة): رصيد البنك مجموع حركاته، والمحفظة نقد 1100
 * ناقصاً حركات البنوك كلها · فالحركة تُفحص بأثرها لا بنوعها:
 *  - حركة قيدٍ قائم لا تُحذف ولا تُنقل ولا يتغيّر مبلغها (التطبيق يُلغيها بعكس عمليتها) · والجديدة منها بإشارة نقد القيد كلها، ومجموعها
 *    لا يتجاوزه (G٦: حركاتٌ بإشارتين على بنكين كانت تضخّم بنكاً بلا حد)
 *  - وبلا قيد: نقل النقد بين المحفظة والبنوك وحده بمصدره وإشارته (الإيداع والسحب والتحويل بين بنكين · G١)
 *  - وكل تغييرٍ بلا قيد (إنشاءً أو حذفاً أو استعادةً أو نقلاً إلى بنكٍ آخر · G٣ وG٤ وG٥) لا يُنزل بنكاً ولا المحفظة تحت الصفر، وإلا
 *    انتظر: سحبٌ وإيداعه في رفعٍ واحد يُطبَّقان بأي ترتيب (G٢)، والمزوَّر لا يكفيه رصيدٌ أبداً فيُرفض بطول انتظاره
 * row فارغٌ لشاهد حذفٍ نهائي
 */
function memberBankTxCheck(db: DB, doc: RemoteDoc, row: Record<string, unknown> | null): void {
  if (getSyncState(db, 'membership') || !byMember(db, doc, true)) return;
  const old = db.get<{ b: string; a: number; n: string | null; s: string | null; del: string | null; d: string }>(
    `SELECT bank_id AS b, amount_halalas AS a, journal_no AS n, source AS s, deleted_at AS del, date AS d FROM bank_tx WHERE id = ?`, [doc.k]);
  const was: BankTxState | null = old
    ? { bank: String(old.b ?? ''), amount: Number(old.a) || 0, no: String(old.n ?? ''), source: String(old.s ?? ''), live: old.del == null, date: String(old.d ?? '') } : null;
  const now: BankTxState | null = row
    // والحذف قيمةٌ غير فارغة كما يعدّها الرصيد والسلة (deleted_at IS NOT NULL) · فالنص الفارغ حذف (المدقق الخارجي I٣: كان الحارس
    // يعدّه حيّاً فيمرّره «تعديلاً لا يمسّ شيئاً»، والرصيد يعدّه محذوفاً)
    ? { bank: String(row.bank_id ?? ''), amount: Number(row.amount_halalas) || 0, no: String(row.journal_no ?? ''), source: String(row.source ?? ''), live: row.deleted_at == null, date: String(row.date ?? '') }
    : null;
  // تعديلٌ لا يمسّ البنك ولا المبلغ ولا القيد ولا المصدر ولا الحذف (البيان أو المطابقة) يمرّ
  if (was && now && was.bank === now.bank && was.amount === now.amount && was.no === now.no && was.source === now.source && was.live === now.live && was.date === now.date) return;
  const wasLive = was?.live ? was : null;
  const nowLive = now?.live ? now : null;
  // ما في السلة يبقى فيها: لا أثر له في رصيد
  if (!wasLive && !nowLive) return;
  const entryOf = (no: string) => (no ? db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE no = ?`, [no]) : undefined);
  if (wasLive?.no && entryOf(wasLive.no)) {
    // حركة قيدٍ قائم: البيان والمصدر وحدهما (ولا تاريخها: إلغاءٌ ثانٍ بتاريخٍ آخر التقى في المعرّف · A٢-٦)
    if (!nowLive || nowLive.no !== wasLive.no || nowLive.bank !== wasLive.bank || nowLive.amount !== wasLive.amount || nowLive.date !== wasLive.date) {
      throw new Error(tr('sync.bankTxEntryLocked', { no: wasLive.no, lng: 'ar' }));
    }
    return;
  }
  if (nowLive?.no) {
    if (wasLive && wasLive.no !== nowLive.no) throw new Error(tr('sync.bankTxEntryLocked', { no: nowLive.no, lng: 'ar' }));
    const entry = entryOf(nowLive.no);
    if (entry) {
      const cash = Number(db.get<{ n: number }>(`SELECT COALESCE(SUM(debit_halalas - credit_halalas), 0) AS n FROM journal_lines WHERE entry_id = ? AND account_code = '1100'`, [entry.id])?.n ?? 0);
      const amounts = [...db.all<{ a: number }>(`SELECT amount_halalas AS a FROM bank_tx WHERE journal_no = ? AND id != ? AND deleted_at IS NULL`, [nowLive.no, doc.k]).map((r) => Number(r.a) || 0), nowLive.amount];
      const sum = amounts.reduce((x, y) => x + y, 0);
      if (!cash || amounts.some((x) => Math.sign(x) !== Math.sign(cash)) || Math.abs(sum) > Math.abs(cash)) {
        throw new Error(tr('sync.bankTxOver', { no: nowLive.no, lng: 'ar' }));
      }
      // والعملية النقدية لا حركة بنكٍ لها إلا الوارد البنكي والرسوم (cashOps.ts · المدقق الخارجي I٢: حركةٌ مزوَّرة برقم «إيداع المالك
      // نقداً» كانت تُدخل البنك نقداً صُرف) · وفحص المحفظة لحركة القيد أُزيل لأنه أوقف تدفقاً مشروعاً (K٢: القيود تُطبَّق قبل حركاتها)
      const head = db.get<{ s: string | null }>(`SELECT src_type AS s FROM journal_entries WHERE id = ?`, [entry.id]);
      if (head?.s === 'cash_op' && !db.get(`SELECT 1 FROM journal_lines WHERE entry_id = ? AND account_code IN ('4300', '5400')`, [entry.id])) {
        throw new Error(tr('sync.bankTxOver', { no: nowLive.no, lng: 'ar' }));
      }
      // وحركة القيد السالبة لا تُنزل بنكها تحت الصفر إن كانت ربطاً متأخراً بقيدٍ صُرف نقده (المدقق الخارجي O٢: حركةٌ برقم مصروفٍ نثري أو
      // سدادٍ نقداً من بنكٍ فارغ كانت تُدخل المحفظة نقداً لا وجود له) · والربط المتأخر: حركةٌ كُتبت بعد قيدها بأكثر من ساعة، أو لقيدٍ معكوسٍ
      // هنا، أو لعمليةٍ نقدية (والتطبيق يفحص كفاية الرسوم) · فتنتظر ما يكفيها، والمزوَّر لا يكفيه رصيدٌ فيُرفض بطول انتظاره · وما كُتب مع
      // قيده لا يُفحص: البنك يصير سالباً بشيكٍ مرتجع، أو بسدادٍ متزامنٍ مع سحب، أو باستعادة فاتورةٍ مسدَّدة (المدقق الخارجي Q٣: كان فحصه
      // يُطبّق القيد ويمسك حركته فيختلف الجهازان) · ومع رصيدٍ يكفي أثر المزوَّر نقلُ نقدٍ من البنك إلى المحفظة بلا قيد كالسحب (حدٌّ موثَّق)
      // وسداد فاتورة الشراء بطريقة سدادها في الفاتورة: لا حركة بنكٍ لسدادٍ نقداً (O٢)
      if (head?.s === 'purchase_pay') purchasePaidByBank(db, entry.id, nowLive.no);
      if (!wasLive && nowLive.amount < 0 && bankBalance(db, nowLive.bank) + nowLive.amount < 0
        && (head?.s === 'cash_op' || lateLink(db, entry.id, doc))) {
        throw new AwaitOriginal(tr('sync.bankTxShort', { lng: 'ar' }));
      }
      return;
    }
    // ورفضُ قيدها لطول انتظاره (WAIT_REJECT) مؤقتٌ يُعاد على التجربة، فتنتظر معه ولا تُرفض (المدقق الخارجي ج٣: كانت تُرفض نهائياً
    // ثم يعود القيد ويُطبَّق وحركته مرفوضة)
    const no = nowLive.no;
    if (db.get(`SELECT 1 FROM sync_rejects WHERE tbl = 'journal_entries' AND json_extract(payload, '$.d.no') = ? AND reason != ?
         AND NOT EXISTS (SELECT 1 FROM sync_rejects w WHERE w.tbl = 'journal_entries' AND w.reason = ? AND json_extract(w.payload, '$.d.no') = ?)
         AND NOT EXISTS (SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND json_extract(payload, '$.d.no') = ?)`, [no, WAIT_REJECT, WAIT_REJECT, no, no])) {
      throw new Error(tr('sync.bankTxEntryRejected', { no, lng: 'ar' }));
    }
    throw new AwaitOriginal(tr('deriveSrc.noDoc', { lng: 'ar' }));
  }
  if (nowLive && Math.sign(nowLive.amount) !== INTERNAL_BANK_SOURCES.get(nowLive.source)) throw new Error(tr('sync.bankTxNoEntry', { lng: 'ar' }));
  // والتطبيق لا يغيّر بنك حركةٍ بلا قيد ولا مبلغها ولا مصدرها (البيان والمطابقة وحدهما · G٥: نقل السحب إلى بنكٍ آخر)
  if (wasLive && nowLive && (wasLive.bank !== nowLive.bank || wasLive.amount !== nowLive.amount || wasLive.source !== nowLive.source)) {
    throw new Error(tr('sync.bankTxEdited', { lng: 'ar' }));
  }
  // أثر التغيير في كل بنكٍ وفي المحفظة · والمحفظة نقدٌ في اليد لا ينزل تحت الصفر، فما يُنقصها ينتظر
  const delta = new Map<string, number>();
  if (wasLive) delta.set(wasLive.bank, (delta.get(wasLive.bank) ?? 0) - wasLive.amount);
  if (nowLive) delta.set(nowLive.bank, (delta.get(nowLive.bank) ?? 0) + nowLive.amount);
  let wallet = 0;
  for (const [bank, d] of delta) {
    wallet -= d;
    // والبنك لا ينزل تحت الصفر بنقلٍ بلا قيد، كما في التطبيق (السحب والتحويل وحذف الإيداع واستعادة السحب) · فسحبٌ من بنكٍ فارغ لا يُدخل
    // المحفظة نقداً لا وجود له (G٥ وG٦) · وحدٌّ معروف: سحب عضوٍ بلا اتصال من بنكٍ سدّد منه غيره في الوقت نفسه ينتظر ثم يُرفض (L٦)،
    // فالجهاز لا يعرف ما رآه العضو · يُعالج بشاشة التعارضات في القسم ٥
    if (d < 0 && bankBalance(db, bank) + d < 0) throw new AwaitOriginal(tr('sync.bankTxShort', { lng: 'ar' }));
  }
  // ووارد التحويل بين بنكين نصفُ نقلٍ صادره هنا: لا يمسّ المحفظة (L٥: كان يُفحص وحده أمامها فينتظر إن كانت سالبة)
  // (للإنشاء وحده: استعادة الوارد من السلة تُنقص المحفظة وتُفحص · المدقق الخارجي M٦)
  if (nowLive?.source === TRANSFER_IN_SOURCE && !was && transferPaired(db, doc.k, row!)) return;
  if (wallet < 0 && walletCashBalance(db) + wallet < 0) throw new AwaitOriginal(tr('sync.bankTxShort', { lng: 'ar' }));
}


/**
 * فاتورة شراءٍ هذا القيدُ سدادُها القائم بطريقةٍ غير النقد · والفاتورة بمصدر القيد هنا أو في الوارد، وإلا انتظرت الحركة · وقيدُ سدادٍ
 * سابقٍ (عُكس أو بُدّل) يحكم عليه فحص الربط المتأخر لا طريقة السداد القائمة
 */
function purchasePaidByBank(db: DB, entryId: string, no: string): void {
  const pid = db.get<{ s: string | null }>(`SELECT src_id AS s FROM journal_entries WHERE id = ?`, [entryId])?.s ?? '';
  const here = db.get<{ e: string | null; m: string | null }>(`SELECT payment_journal_entry_id AS e, payment_method AS m FROM purchases WHERE id = ?`, [pid]);
  const p = here ?? db.get<{ e: string | null; m: string | null }>(
    `SELECT json_extract(payload, '$.d.payment_journal_entry_id') AS e, json_extract(payload, '$.d.payment_method') AS m
     FROM sync_inbox WHERE tbl = 'purchases' AND del = 0 AND pk = ?`, [pid]);
  if (!p) throw new AwaitOriginal(tr('deriveSrc.noDoc', { lng: 'ar' }));
  if (p.e === entryId && (!p.m || p.m === PAY_LABEL.cash)) throw new Error(tr('sync.bankTxOver', { no, lng: 'ar' }));
}

/** ساعةٌ بين كتابة القيد وحركته في السحابة: ما كُتب معه يُرفع في الدورة نفسها ولو على دفعات */
const LATE_LINK_MS = 60 * 60 * 1000;

/** حركة قيدٍ كُتبت بعد قيدها بأكثر من ساعة (بوقت الخادم)، أو لقيدٍ معكوسٍ هنا، أو لقيدٍ لم يُعرف وقته في السحابة */
function lateLink(db: DB, entryId: string, doc: RemoteDoc): boolean {
  if (db.get(`SELECT 1 FROM journal_entries WHERE id = ? AND reversed_by IS NOT NULL`, [entryId])) return true;
  // وربطٌ معلَّق بعاكسٍ لم يُطبَّق يجدّد وقت القيد، فهو كالمعكوس (المدقق الخارجي S١ب)
  const pendingLinks = JSON.parse(getSyncState(db, PENDING_REV) ?? '{}') as Record<string, string>;
  if (pendingLinks[entryId]) return true;
  // وكاتب الحركة غير كاتب القيد ربطٌ متأخر أياً كان وقته (S١: وقت «u» يكتبه العضو) · وقيدٌ بلا كاتبٍ وارد كتبه هذا الجهاز (المالك)
  const rb = db.get<{ uid: string }>(`SELECT uid FROM row_by WHERE tbl = 'journal_entries' AND pk = ?`, [entryId]);
  const creator = rb ? rb.uid : ownerUid(db) ?? '';
  if (creator && (doc.by ?? '') !== creator) return true;
  const at = db.get<{ u: string }>(`SELECT u FROM sync_rowtime WHERE tbl = 'journal_entries' AND pk = ?`, [entryId])?.u;
  if (!at) return true;
  // وبوقت الخادم وحده (ts تفرضه القاعدة)، لا بـ«u» الذي يكتبه العضو
  return Date.parse(isoNorm(doc.ts ?? doc.u)) - Date.parse(at) > LATE_LINK_MS;
}

/** صادرٌ مطبَّق للتحويل نفسه (التاريخ والبيان والمبلغ، ببنكٍ آخر) لم يُقابَل بواردٍ قبل هذا */
function transferPaired(db: DB, id: string, row: Record<string, unknown>): boolean {
  const amount = Number(row.amount_halalas) || 0;
  const args = [String(row.date ?? ''), String(row.descr ?? '')];
  // صادرٌ ببنكٍ آخر لهذا الوارد · والعدّ في البنوك كلها: الصادر الواحد يقابل وارداً واحداً لا وارداً في كل بنكٍ آخر (المدقق الخارجي K٣)
  const outs = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_tx WHERE source = ? AND amount_halalas = ? AND date = ? AND descr = ?
     AND deleted_at IS NULL AND journal_no = ''`, [TRANSFER_OUT_SOURCE, -amount, ...args])?.n ?? 0);
  const outOther = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_tx WHERE source = ? AND amount_halalas = ? AND date = ? AND descr = ? AND bank_id != ?
     AND deleted_at IS NULL AND journal_no = ''`, [TRANSFER_OUT_SOURCE, -amount, ...args, String(row.bank_id ?? '')])?.n ?? 0);
  const ins = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_tx WHERE source = ? AND amount_halalas = ? AND date = ? AND descr = ?
     AND deleted_at IS NULL AND journal_no = '' AND id != ?`, [TRANSFER_IN_SOURCE, amount, ...args, id])?.n ?? 0);
  return outOther > 0 && outs > ins;
}

/**
 * الرصيد الدائن المتاح لمستأجر العقد (المتحقق المستقل، الجولة ٣٦ (ع٣): كان سطر 2410 في قيد السداد منه بلا بُعد عقد، فلا ينقص به
 * الرصيد ويُصرف مرتين): 2410 على عقوده في الدفتر بلا قيود دفعات السداد منه ولا عواكسها، ناقصاً تلك الدفعات غير الملغاة هنا وفي
 * الوارد مرةً واحدة · فلا يتوقف على ترتيب وصول القيد وعكسه ودفعته، ودفعتان في دفعةٍ واحدة لا تصرفان الرصيد نفسه · except: المفحوصة
 */
function tenantCreditAvailable(db: DB, contractId: string, except: string): number {
  const contracts = db.all<{ id: string }>(
    `SELECT c2.id FROM contracts c1 JOIN contracts c2 ON c2.tenant_id = c1.tenant_id WHERE c1.id = ? AND c1.tenant_id IS NOT NULL`,
    [contractId]).map((r) => r.id);
  if (!contracts.includes(contractId)) contracts.push(contractId);
  const inC = JSON.stringify(contracts);
  const credit = new Map<string, { n: number; off: boolean }>();
  for (const r of db.all<{ id: string; n: number; c: string | null }>(
    `SELECT id, net_halalas AS n, cancelled_at AS c FROM contract_payments
     WHERE method_label = ? AND contract_id IN (SELECT value FROM json_each(?))`, [CREDIT_METHOD, inC])) {
    credit.set(r.id, { n: Number(r.n) || 0, off: !!r.c });
  }
  for (const r of db.all<{ payload: string }>(
    `SELECT payload FROM sync_inbox WHERE tbl = 'contract_payments' AND del = 0
       AND json_extract(payload, '$.d.method_label') = ? AND json_extract(payload, '$.d.contract_id') IN (SELECT value FROM json_each(?))`,
    [CREDIT_METHOD, inC])) {
    const d = (JSON.parse(r.payload) as RemoteDoc).d ?? {};
    const id = String(d.id ?? '');
    if (id && !credit.has(id)) credit.set(id, { n: Number(d.net_halalas) || 0, off: !!d.cancelled_at });
  }
  const ids = JSON.stringify([...credit.keys(), except]);
  // دائن 2410 الذي يُصرف: ما كتبه المالك، وفائض التحصيل الجماعي (قيد تحصيلٍ بمصدر العقد يُشتق من دفعته) بقدر نقده · وما سواهما
  // من قيود العضو لا يُعدّ حتى يُشتق مصدره في المرحلة الثانية (المتحقق المستقل، الجولتان ٣٨ و٣٩: مدين رأس المال أو الإيراد أو
  // التأمينات في قيدٍ يكتبه العضو لا يسند رصيداً) · ومدينه يُنقص الرصيد كاملاً أياً كان كاتبه
  const owner = ownerUid(db) ?? '';
  const rows = db.all<{ c: number; cash: number; w: string; t: string | null; s: string | null }>(
    `SELECT SUM(CASE WHEN l.account_code = '2410' AND l.contract_id IN (SELECT value FROM json_each(?)) THEN l.credit_halalas - l.debit_halalas ELSE 0 END) AS c,
            SUM(CASE WHEN l.account_code = '1100' THEN l.debit_halalas ELSE 0 END) AS cash,
            COALESCE((SELECT uid FROM row_by WHERE tbl = 'journal_entries' AND pk = e.id), '') AS w, e.src_type AS t, e.src_id AS s
     FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.status = ? AND e.id IN (SELECT entry_id FROM journal_lines WHERE account_code = '2410' AND contract_id IN (SELECT value FROM json_each(?)))
       AND NOT (e.src_type IN ('rent', 'rent_rev') AND e.src_id IN (SELECT value FROM json_each(?)))
     GROUP BY e.id`,
    [inC, 'مرحّل', inC, ids]); // i18n-exempt: حالة القيد المخزّنة
  const ledger = rows.reduce((sum, r) => {
    const c = Number(r.c);
    if (c <= 0 || r.w === '' || r.w === owner) return sum + c;
    return sum + (r.t === 'rent' && contracts.includes(r.s ?? '') ? Math.min(c, Number(r.cash)) : 0);
  }, 0);
  let spent = 0;
  for (const [id, c] of credit) if (id !== except && !c.off) spent += c.n;
  return ledger - spent;
}

/**
 * دفعة تحويل العربون (allocateDeposit) وقيدها: مدين 2450 بمبلغها ودائن الإيراد به، ولا سطر غيرهما · وحجزها قائمٌ محوَّلٌ إلى عقد
 * الدفعة، ومجموع ما حُوِّل منه لا يتجاوز عربونه ولا ما قُبض منه في الدفتر (المتحقق المستقل، الجولة ٣٧ (ر١): كان قيد التحويل بلا
 * حجزٍ وراءه يسدّد القسط)
 */
function reservationConvertCheck(db: DB, je: string, row: RowData): void {
  const no = (why: string) => new Error(tr('derive.rejected', { why, lng: 'ar' }));
  const rv = db.get<{ s: string | null }>(`SELECT src_id AS s FROM journal_entries WHERE id = ?`, [je])?.s ?? '';
  const rsv = latestRow<{ deposit_halalas: number; converted_contract_id: string | null }>(db, 'reservations', rv);
  if (!rsv) throw no(tr('derive.noReservation', { lng: 'ar' }));
  if (rsv.converted_contract_id !== row.contract_id) throw no(tr('derive.noReservation', { lng: 'ar' }));
  const prior = Number(db.get<{ n: number }>(
    `SELECT COALESCE(SUM(p.net_halalas), 0) AS n FROM contract_payments p JOIN journal_entries e ON e.id = p.journal_entry_id
     WHERE e.src_type = 'reservation_convert' AND e.src_id = ? AND p.cancelled_at IS NULL AND p.id != ?`, [rv, String(row.id ?? '')])!.n);
  const want = prior + (Number(row.net_halalas) || 0);
  // المقبوض: قيد الحجز الذي مدينه نقدٌ بقدر دائنه على 2450 ولا سطر غيرهما (المتحقق المستقل، الجولة ٣٨: كان أي دائنٍ على 2450 يُعدّ،
  // فقيد حجزٍ من رأس المال يُنشئ عربوناً بلا نقد) · ومصادرته وردّه يُنقصانه
  const received = db.all<{ t: string; n: number; cash: number; other: number }>(
    `SELECT e.src_type AS t, SUM(CASE WHEN l.account_code = '2450' THEN l.credit_halalas - l.debit_halalas ELSE 0 END) AS n,
            SUM(CASE WHEN l.account_code = '1100' THEN l.debit_halalas - l.credit_halalas ELSE 0 END) AS cash,
            SUM(CASE WHEN l.account_code NOT IN ('2450', '1100') THEN 1 ELSE 0 END) AS other
     FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.status = ? AND e.src_id = ? AND e.src_type IN ('reservation', 'reservation_forfeit', 'reservation_refund') GROUP BY e.id`,
    ['مرحّل', rv]) // i18n-exempt: حالة القيد المخزّنة
    .reduce((sum, r) => sum + (r.t === 'reservation'
      ? (Number(r.other) === 0 && Number(r.cash) === Number(r.n) && Number(r.n) > 0 ? Number(r.n) : 0)
      : Math.min(Number(r.n), 0)), 0);
  if (want > Number(rsv.deposit_halalas) || want > received) {
    if (rowsHereOrInbox(db, 'journal_entries', 'src_id', rv).length > db.all(`SELECT 1 FROM journal_entries WHERE src_id = ?`, [rv]).length) {
      throw new AwaitOriginal(tr('derive.noPayment', { lng: 'ar' }));
    }
    throw no(tr('derive.overDeposit', { lng: 'ar' }));
  }
  const net = Number(row.net_halalas) || 0;
  const lines = db.all<{ a: string; n: number }>(
    `SELECT account_code AS a, SUM(debit_halalas - credit_halalas) AS n FROM journal_lines WHERE entry_id = ? GROUP BY account_code`, [je]);
  const of = (a: string) => Number(lines.find((l) => l.a === a)?.n ?? 0);
  const revenue = lines.filter((l) => RENT_REVENUE_GROUP.includes(l.a)).reduce((s, l) => s - Number(l.n), 0);
  const others = lines.filter((l) => l.a !== '2450' && !RENT_REVENUE_GROUP.includes(l.a) && Number(l.n) !== 0);
  if (of('2450') !== net || revenue !== net || others.length) throw new Error(tr('derive.rejected', { why: tr('derive.entryType', { lng: 'ar' }), lng: 'ar' }));
}

/**
 * دفعة القسط المسدَّد من التأمين في تسويته (المراجعة الشاملة 2026-11-13 · A1-2) وقيدها: طريقتها «من التأمين»، وقيدها من عقدها، مدين
 * 2400 بمبلغها ودائن الإيراد به، ولا سطر غيرهما · وسقفه بالمخصوم في صفّ التسوية يفحصه اشتقاق القيد نفسه (deriveSources.ts)
 */
function depositRentCheck(db: DB, je: string, srcId: string | null, row: RowData): void {
  const bad = () => new Error(tr('derive.rejected', { why: tr('derive.entryType', { lng: 'ar' }), lng: 'ar' }));
  if (row.method_label !== DEPOSIT_RENT_METHOD || row.installment_id == null) throw bad();
  // وعقد الدفعة عقد القيد صاحب التأمين، أو عقدٌ رُحِّل تأمينه إليه بترحيلٍ حيٍّ هنا (R12-DEP-2)
  if (srcId !== row.contract_id && !depositCarryChain(db, srcId ?? '').includes(String(row.contract_id ?? ''))) throw bad();
  const net = Number(row.net_halalas) || 0;
  const lines = db.all<{ a: string; n: number }>(
    `SELECT account_code AS a, SUM(debit_halalas - credit_halalas) AS n FROM journal_lines WHERE entry_id = ? GROUP BY account_code`, [je]);
  const revenue = lines.filter((l) => RENT_REVENUE_GROUP.includes(l.a)).reduce((sum, l) => sum - Number(l.n), 0);
  const others = lines.filter((l) => l.a !== '2400' && !RENT_REVENUE_GROUP.includes(l.a) && Number(l.n) !== 0);
  if (net <= 0 || Number(lines.find((l) => l.a === '2400')?.n ?? 0) !== net || revenue !== net || others.length) throw bad();
}

/**
 * صفوف التحصيل على جهاز المالك (المتحقق المستقل، الجولة ٣٥ (أ٢ وأ٣ وأ٥)): الدفعة وسطورها وتخصيصها لا تتغير مبالغها ولا روابطها
 * بعد إنشائها أياً كان كاتبها (الإلغاء بـ cancelled_at، والتطبيق لا يعدّلها) · ودفعة العضو الجديدة: قيدٌ واحد لها، وقيدها
 * المرحّل يُعاد اشتقاقه منها · وسطورها وتخصيصها لا يتجاوزان المقبوض ولا المتبقي على أقساط عقدها
 */
const FROZEN_COLS: Record<string, string[]> = {
  // وحقائق سطر كشف البنك كما قُرئت: العضو يطابق ويستبعد ولا يغيّر بنكه ولا يومه ولا مبلغه ولا رصيده ولا بصمته (المدقق الخارجي B٢-٩)
  bank_statement_lines: ['bank_id', 'line_key', 'date', 'value_date', 'amount_halalas', 'balance_halalas', 'descr', 'ref'],
  contract_payments: ['contract_id', 'installment_id', 'date', 'gross_halalas', 'discount_halalas', 'net_halalas'],
  payment_lines: ['payment_id', 'method', 'bank_id', 'amount_halalas'],
  payment_allocations: ['payment_id', 'installment_id', 'amount_halalas'],
};
function collectionRowCheck(db: DB, doc: RemoteDoc, row: RowData): void {
  const frozen = FROZEN_COLS[doc.t];
  if (!frozen || getSyncState(db, 'membership')) return;
  const no = (why: string) => new Error(tr('derive.rejected', { why, lng: 'ar' }));
  const cur = db.get<Record<string, unknown>>(`SELECT * FROM "${doc.t}" WHERE id = ?`, [doc.k]);
  // (وحقائق سطر الكشف يجمّدها تعديل العضو وحده: قراءة الملف نفسه على جهازٍ للمالك تكتب الحقائق نفسها)
  if (cur && doc.t === 'bank_statement_lines' && !byMember(db, doc, true)) return;
  // ونسخة العضو بوقائع أخرى (تصديرٌ آخر للشهر نفسه ببيانٍ أطول، أو تعديلٌ لها) تُطبَّق بوقائع السطر هنا ويرفعها جهاز المالك، ولا تُرفض
  // فتضيع مطابقتها (المدقق الخارجي E٢-٥ · وتبقى B٢-٩: البنك والمبلغ لا يتغيّران، فمطابقته بحركة بنكٍ آخر تُفكّ)
  if (cur && doc.t === 'bank_statement_lines') {
    let restored = false;
    for (const c of frozen) if (c in row && String(cur[c] ?? '') !== String(row[c] ?? '')) { row[c] = cur[c] as never; restored = true; }
    if (restored) restoredFacts.add(doc.k);
    return;
  }
  if (cur) {
    if (frozen.some((c) => c in row && String(cur[c] ?? '') !== String(row[c] ?? ''))) throw no(tr('derive.frozen', { lng: 'ar' }));
    // والإلغاء نهائيٌّ بتاريخه وعاكسه: لا يغيّرهما إلغاءٌ ثانٍ من جهازٍ آخر (A٢-٦)
    if (doc.t === 'contract_payments' && cur.cancelled_at && row.cancelled_at
      && (String(row.cancelled_at) !== String(cur.cancelled_at) || String(row.cancel_entry_id ?? '') !== String(cur.cancel_entry_id ?? ''))) {
      throw no(tr('derive.frozen', { lng: 'ar' }));
    }
    // وقيد الدفعة لا يُستبدل بغيره (فكّه عند حذف قيده من السلة يبقى)
    if (doc.t === 'contract_payments' && row.journal_entry_id && cur.journal_entry_id && row.journal_entry_id !== cur.journal_entry_id) {
      throw no(tr('derive.frozen', { lng: 'ar' }));
    }
    // وإلغاء دفعةٍ لها قيد بعاكسٍ لقيدها وحده (المتحقق المستقل، الجولة ٣٧ (ر٥): كان الإلغاء بتعديلٍ وحده فيبقى قيدها لدفعةٍ ملغاة)
    if (doc.t === 'contract_payments' && row.cancelled_at && !cur.cancelled_at && cur.journal_entry_id) {
      // ودفعة العربون لا يلغيها عضو (المراجعة الشاملة · البند ٢٧ · المتحقق المستقل: جهاز العضو بنسخة قديمة يلغيها فيعود مبلغها
      // عالقاً في 2450) · وإلغاء المالك من جهازه الآخر يُقبل كما كتبه، فلا تفترق أجهزته، ورصيده العالق يُحمّر فحص عربون الحجوزات
      if (byMember(db, doc, false) && paidFromDeposit(db, doc.k)) throw no(tr('payment.cancelFromDeposit', { lng: 'ar' }));
      // ودفعة «من التأمين» لا يلغيها عضوٌ وحدها: تُلغى مع تعديل التسوية وحده (R12-DEP-3 · depositRentEdit)
      if (byMember(db, doc, false) && paidFromSettlement(db, doc.k)) {
        const holder = db.get<{ s: string | null }>(`SELECT src_id AS s FROM journal_entries WHERE id = ?`, [cur.journal_entry_id as string])?.s ?? '';
        const edit = depositRentEdit(db, holder, doc, (row.cancel_reason as string | null | undefined) ?? '');
        if (edit === 'await') throw new AwaitOriginal(tr('derive.noPayment', { lng: 'ar' }));
        if (edit === 'no') throw no(tr('payment.cancelFromSettlement', { lng: 'ar' }));
      }
      const rev = (row.cancel_entry_id as string | null) ?? null;
      const orig = db.get<{ t: string | null; s: string | null }>(`SELECT src_type AS t, src_id AS s FROM journal_entries WHERE id = ?`, [cur.journal_entry_id as string]);
      if (!rev || !orig) throw no(tr('derive.cancelNoReversal', { lng: 'ar' }));
      const r = latestRow<{ src_type: string | null; src_id: string | null }>(db, 'journal_entries', rev);
      if (!r) throw new AwaitOriginal(tr('derive.noPayment', { lng: 'ar' }));
      if (r.src_type !== (orig.t ?? 'manual') + '_rev' || (r.src_id ?? '') !== (orig.s ?? '')) throw no(tr('derive.cancelNoReversal', { lng: 'ar' }));
      // ومرحّلٌ هنا مرآةٌ لقيد الدفعة (المتحقق المستقل، الجولة ٣٨ (ر٥-ب): كان عاكسٌ بحالة «قيد الإنشاء» بهللةٍ يكفي)
      if (!db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [rev])) throw new AwaitOriginal(tr('derive.noPayment', { lng: 'ar' }));
      if (mirrorIssue(db, cur.journal_entry_id as string, rev) !== '') throw no(tr('derive.cancelNoReversal', { lng: 'ar' }));
    }
    return;
  }
  if (!doc.by || doc.by === ownerUid(db)) return;
  if (doc.t === 'contract_payments') {
    const je = (row.journal_entry_id as string | null) ?? null;
    if (!je) { if ((Number(row.net_halalas) || 0) > 0) throw no(tr('derive.noEntry', { lng: 'ar' })); return; }
    if (db.get(`SELECT 1 FROM contract_payments /* تشمل الملغاة: قيدها وقيد عكسها لا يُربطان بدفعةٍ أخرى */ WHERE (journal_entry_id = ? OR cancel_entry_id = ?) AND id != ?`, [je, je, doc.k])) throw no(tr('derive.manyPayments', { lng: 'ar' })); // i18n-exempt: تعليل الاستعلام لحارس الدفعات الملغاة
    if (!db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [je])) return; // قيدٌ لم يصل: المفتاح الأجنبي يُنتظر به
    const e = db.get<{ src_type: string | null; src_id: string | null; date: string }>(
      `SELECT src_type, src_id, date FROM journal_entries WHERE id = ? AND status = 'مرحّل'`, [je]); // i18n-exempt: حالة القيد المخزّنة
    // المتحقق المستقل، الجولة ٣٦ (ع١ وع٢): كانت دفعة العضو تُقبل بقيدٍ مرحّل من غير التحصيل (يدوي، أو عكس دفعةٍ ملغاة) فيُسدَّد
    // القسط بلا نقد
    if (e?.src_type === 'reservation_convert') { reservationConvertCheck(db, je, row); return; }
    if (e?.src_type === DEPOSIT_RENT_SRC) { depositRentCheck(db, je, e.src_id, row); return; }
    if (e?.src_type !== 'rent') throw no(tr('derive.entryType', { lng: 'ar' }));
    const lines = db.all<{ account_code: string; debit_halalas: number; credit_halalas: number }>(
      `SELECT account_code, debit_halalas, credit_halalas FROM journal_lines WHERE entry_id = ?`, [je]);
    rentCheckAgainst(db, { srcId: e.src_id ?? '', date: e.date,
      lines: lines.map((l) => ({ account: l.account_code, debit: Number(l.debit_halalas), credit: Number(l.credit_halalas) })) },
      row as unknown as RentPaymentSrc, doc.ts);
    return;
  }
  const pay = db.get<RentPaymentSrc & { journal_entry_id: string | null }>(`SELECT * FROM contract_payments WHERE id = ?`, [String(row.payment_id ?? '')]);
  if (!pay) return; // الأب الناقص يُنتظر بالمفتاح الأجنبي
  if (doc.t === 'payment_lines') {
    const sum = Number(db.get<{ n: number }>(`SELECT COALESCE(SUM(amount_halalas), 0) AS n FROM payment_lines WHERE payment_id = ?`, [pay.id])!.n);
    if (pay.method_label === CREDIT_METHOD || pay.method_label === DEPOSIT_RENT_METHOD
      || sum + (Number(row.amount_halalas) || 0) > (Number(pay.net_halalas) || 0)) throw no(tr('derive.method', { lng: 'ar' }));
    return;
  }
  // ودفعة التأمين من تسويته على قسطها وحده: لا سطور طرق سدادٍ لها ولا تخصيص ينقلها إلى قسطٍ آخر (A1-2)
  if (pay.method_label === DEPOSIT_RENT_METHOD) throw no(tr('derive.method', { lng: 'ar' }));
  // التخصيص: بمتبقي أقساط العقد، ومجموعه بما خصّصه قيدها (المقبوض ناقصاً الرصيد الدائن)
  const credit = pay.journal_entry_id ? Number(db.get<{ n: number }>(
    `SELECT COALESCE(SUM(credit_halalas - debit_halalas), 0) AS n FROM journal_lines WHERE entry_id = ? AND account_code = '2410'`, [pay.journal_entry_id])!.n) : 0;
  const prior = Number(db.get<{ n: number }>(`SELECT COALESCE(SUM(amount_halalas), 0) AS n FROM payment_allocations WHERE payment_id = ?`, [pay.id])!.n);
  const why = allocationIssue(db, pay, [{ installment_id: String(row.installment_id ?? ''), amount_halalas: Number(row.amount_halalas) || 0 }],
    (Number(pay.net_halalas) || 0) - credit - prior);
  if (why === 'await') return; // قسطٌ لم يصل: المفتاح الأجنبي يُنتظر به
  if (why) throw no(why);
}

/**
 * أساس إهلاك الأصل على جهاز المالك (التوجيه الثالث · ١ · المتحقق المستقل): تكلفته وعمره ومتبقيته وتاريخ شرائه وفئته لا يغيّرها عضو
 * بعد إثبات تكلفته هنا، كما يمنعها updateAssetInfo (lifeLocked) · فالإهلاك يُشتق من الصف، وعمرٌ مقصَّر فيه يُهلك التكلفة كلها في
 * شهرين · ويُقبل ما يكتبه التطبيق وحده:
 *  - تعديل فاتورة الشراء أو حذفها يعيد القطعة المربوطة بها «بانتظار تكلفة» (clearPurchaseAssets): التكلفة وربط الفاتورة يُفرَّغان
 *    وبقية الأساس كما هو.
 *  - وربطها ثانيةً ببندٍ جديد من فاتورتها (writePurchaseLines: linkAssetId) ولا إهلاك لها في الدفتر هنا ولا حركة (requirePurchaseAssetsFree):
 *    فئتها فئة البند، وتاريخ شرائها تاريخ الفاتورة، وعمرها ومتبقيتها كما هما.
 */
const ASSET_BASIS = ['cost_halalas', 'salvage_halalas', 'life_months', 'purchase_date', 'category'];
/** سبب رفض صفّ الأصل الوارد بأساس إهلاكه · '' إن قُبل · 'await' إن لم يصل بنده أو فاتورته */
function assetBasisIssue(db: DB, doc: RemoteDoc, row: RowData): string {
  if (doc.t !== 'assets' || getSyncState(db, 'membership') || !byMember(db, doc, false)) return '';
  const cur = db.get<Record<string, unknown>>(`SELECT * FROM assets WHERE id = ?`, [doc.k]);
  if (!cur || cur.cost_halalas == null) return '';
  const differs = (c: string) => c in row && String(cur[c] ?? '') !== String(row[c] ?? '');
  if (!ASSET_BASIS.some(differs)) return '';
  const locked = tr('deriveSrc.assetBasis', { lng: 'ar' });
  const same = ['salvage_halalas', 'life_months'].every((c) => !differs(c));
  if (row.cost_halalas == null) {
    return cur.purchase_id == null || row.purchase_id != null || !same || differs('category') || differs('purchase_date') ? locked : '';
  }
  const lineId = row.purchase_line_id == null ? null : String(row.purchase_line_id);
  if (!lineId || lineId === String(cur.purchase_line_id ?? '') || row.purchase_id == null || !same) return locked;
  const line = latestRow<{ purchase_id: string | null; asset_category: string | null }>(db, 'purchase_lines', lineId);
  const p = latestRow<{ date: string | null }>(db, 'purchases', String(row.purchase_id));
  if (!line || !p) return 'await';
  if (line.purchase_id !== row.purchase_id || String(line.asset_category ?? '') !== String(row.category ?? '')
    || String(p.date ?? '').slice(0, 10) !== String(row.purchase_date ?? '').slice(0, 10)) return locked;
  return postedAccum(db, doc.k) !== 0 || db.get(`SELECT 1 FROM asset_events WHERE asset_id = ? AND kind NOT IN ('cost', 'convert')`, [doc.k]) ? locked : '';
}
function assetBasisCheck(db: DB, doc: RemoteDoc, row: RowData): void {
  const why = assetBasisIssue(db, doc, row);
  if (why === 'await') throw new AwaitOriginal(tr('deriveSrc.noDoc', { lng: 'ar' }));
  if (why) throw new Error(why);
}

/** مالك المنشأة: صاحب هذا الجهاز إن لم يكن عضواً، وإلا المنشأة نفسها (معرّفها معرّف مالكها) */
const ownerUid = (db: DB): string | null => (getSyncState(db, 'membership') ? getSyncState(db, 'org') : getSyncState(db, 'uid'));

/**
 * كتب المستندَ عضو (المتحقق المستقل على البند ٢٧): القواعد تشترط «op» على كل كتابة عضو، إنشاءً وتعديلاً، والمالك لا يكتبه
 * (acl.ts: annotate) وكتابته كاملة تمحوه · و«by» كاتب الصف الأول: يدل على العضو في إنشاء الصف وحده، ويبقى على تعديله بعده
 * فلا يدل على من عدّل (من ألغى دفعةً أنشأها غيره) · created: المستند ينشئ الصف
 */
/**
 * العضو: بنكٌ أو حسابٌ في الطابور لم يصل السحابة بعد (لا وقت صفٍّ له) يُرفع بافتتاحيٍّ صفر كما تقضي قاعدتها (openingKept)، ويُصفَّر هنا معه
 * فيتفق الجهازان · نموذج ما قبل e8d6c19 كان يجيز للعضو افتتاحياً (المدقق الخارجي K٥، ثم O٥: القاعدة صارت ترفضه فكانت حركاته تعلق)
 */
export function prepareMemberUpload(db: DB): void {
  // (ولا كاتب له: صفوف ما قبل الهجرة ٤٣ بلا وقتٍ ولها كاتبها من الهجرة ٤٢ أو من الوارد · المدقق الخارجي Q٤)
  for (const [tbl, key] of [['banks', 'id'], ['accounts', 'code']] as const) {
    db.run(`UPDATE ${tbl} SET opening_halalas = 0 WHERE opening_halalas != 0
      AND ${key} IN (SELECT pk FROM sync_outbox WHERE tbl = '${tbl}') AND ${key} NOT IN (SELECT pk FROM sync_rowtime WHERE tbl = '${tbl}')
      AND ${key} NOT IN (SELECT pk FROM row_by WHERE tbl = '${tbl}')`);
  }
}

/** الجدولان اللذان افتتاحيّهما للمالك وحده (openingKept) */
const OPENING_TABLES = new Set(['banks', 'accounts']);
const keyCol = (t: string) => (t === 'accounts' ? 'code' : 'id');
/**
 * آخر افتتاحيٍّ عرفه هذا الجهاز في السحابة للصف (طبّقه أو رفعه) · فيُعرف هل غيّر المالك الافتتاحي هنا منذ ذلك (المدقق الخارجي S٢: كل تعديلٍ
 * معلَّق على الصف كان يُعدّ تعديلاً للافتتاحي، فيمحو افتتاحيّه القديمُ أحدثَ وضعه المالك من جهازه الآخر)
 */
const SEEN_OPENING = 'opening_seen:';
function noteSeenOpening(db: DB, t: string, k: string, o: unknown): void {
  setSyncState(db, SEEN_OPENING + t + ':' + k, String(Number(o) || 0));
}
/** افتتاحيّ هذا الجهاز غيّره المالك هنا منذ آخر ما عرفه من السحابة (وبلا معرفةٍ سابقة: له تعديلٌ معلَّق) */
function openingChangedHere(db: DB, t: string, k: string, hasPending: boolean): boolean {
  const seen = getSyncState(db, SEEN_OPENING + t + ':' + k);
  if (seen === null) return hasPending;
  const mine = db.get<{ o: number }>(`SELECT opening_halalas AS o FROM "${t}" WHERE ${keyCol(t)} = ?`, [k]);
  return !!mine && (Number(mine.o) || 0) !== Number(seen);
}
/** جهاز العضو: الافتتاحي من الوارد (حقل المالك)، فتحمله كل نسخةٍ يعيدها كما في السحابة (Q٢ وS٤) */
function adoptCloudOpening(db: DB, doc: RemoteDoc): void {
  if (!getSyncState(db, 'membership') || !OPENING_TABLES.has(doc.t) || !doc.d || doc.del) return;
  db.run(`UPDATE "${doc.t}" SET opening_halalas = ? WHERE ${keyCol(doc.t)} = ?`, [Number(doc.d.opening_halalas) || 0, doc.k]);
  noteSeenOpening(db, doc.t, doc.k, doc.d.opening_halalas);
}

/** حسابٌ عليه سطر قيدٍ هنا أو في قيدٍ وارد لم يُطبَّق بعد (الهاتف البديل يسحب الدليل والقيود في دورةٍ واحدة) */
function accountUsed(db: DB, code: string): boolean {
  return !!db.get(`SELECT 1 FROM journal_lines WHERE account_code = ? LIMIT 1`, [code])
    || !!db.get(`SELECT 1 FROM sync_inbox i, json_each(i.payload, '$.lines') l
         WHERE i.tbl = 'journal_entries' AND i.del = 0 AND json_extract(l.value, '$.account_code') = ? LIMIT 1`, [code]);
}

function byMember(db: DB, doc: RemoteDoc, created: boolean): boolean {
  if (typeof doc.op === 'string' && doc.op !== '') return true;
  return created && !!doc.by && doc.by !== ownerUid(db);
}

const DIM_COLS = ['property_id', 'unit_id', 'contract_id', 'cost_center_id', 'asset_id'] as const;
const DRAFT_CONTRACT = 'مسودة'; // i18n-exempt: حالة العقد المخزّنة

/** أبعاد سطورٍ قائمة من مستند وارد · بمعرّف السطر وحده، ولا مبلغ ولا حساب يُمسّ · يعيد عدد ما تغيّر */
function applyLineDims(db: DB, entryId: string, lines: RowData[]): number {
  let n = 0;
  for (const l of lines) {
    // مستندٌ من إصدارٍ بلا أبعاد لا يمحو أبعاداً قائمة
    if (!l.id || !DIM_COLS.some((c) => c in l)) continue;
    const cur = db.get<Record<string, string | null>>(
      `SELECT ${DIM_COLS.join(', ')} FROM journal_lines WHERE id = ? AND entry_id = ?`, [l.id as string, entryId]);
    if (!cur) continue;
    // تُملأ الفارغة وحدها، والقائمة لا تُستبدل (الترحيلة ٥١ · القاعدة ٩٩: القرارات المعلّقة القسم ٥ البند ٣): نسخةٌ تحمل بُعداً
    // آخر لسطرٍ مرحّل لا تغيّره ولا تُرفض به
    const next = DIM_COLS.map((c) => cur[c] ?? (l[c] as string | null | undefined) ?? null);
    if (DIM_COLS.every((c, i) => (cur[c] ?? null) === next[i])) continue;
    db.run(`UPDATE journal_lines SET ${DIM_COLS.map((c) => c + ' = ?').join(', ')} WHERE id = ?`, [...next, l.id as string]);
    n++;
  }
  return n;
}

function applyJournal(db: DB, doc: RemoteDoc, cols: { e: Set<string>; l: Set<string> }): 'applied' | 'kept' {
  const d = doc.d!;
  const local = db.get<{ status: string; reversed_by: string | null }>(
    `SELECT status, reversed_by FROM journal_entries WHERE id = ?`, [doc.k]);
  const remoteRev = (d.reversed_by as string | null) ?? null;
  if (local?.status === 'مرحّل') {
    // أبعاد سطور القيد المرحّل وحدها تصل (ملء القيود القديمة · الهجرة ٢٨) · ولا يتغير فيه غيرها
    const dimsChanged = cols.l.has('cost_center_id') ? applyLineDims(db, doc.k, doc.lines ?? []) : 0;
    if (remoteRev && !local.reversed_by) {
      linkReversal(db, doc.k, remoteRev, doc);
      return 'applied';
    }
    return dimsChanged ? 'applied' : 'kept';
  }
  const posted = d.status === 'مرحّل';
  // قبل إدخاله: توزيع الإيراد يُحسب من المرحَّل قبله
  if (posted) memberRentCheck(db, doc);
  if (posted) memberSourceCheck(db, doc);
  if (local) db.run(`DELETE FROM journal_lines WHERE entry_id = ?`, [doc.k]); // مسودة · سطورها تُستبدل
  renumberJoiningCollision(db, 'journal_entries', doc.k, d.no);
  const entry: RowData = { ...d, status: posted ? 'قيد الإنشاء' : d.status, reversed_by: null };
  upsertRow(db, 'journal_entries', entry, cols.e);
  for (const l of doc.lines ?? []) {
    const keys = Object.keys(l).filter((c) => cols.l.has(c));
    db.run(`INSERT INTO journal_lines (${keys.map((c) => `"${c}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((c) => l[c] as SqlValue));
  }
  if (posted) db.run(`UPDATE journal_entries SET status = 'مرحّل' WHERE id = ?`, [doc.k]);
  if (posted) memberReversalCheck(db, doc);
  if (posted) memberBankOutCheck(db, doc);
  if (remoteRev) linkReversal(db, doc.k, remoteRev, doc);
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

/** صفوفٌ في جداول المزامنة تشير إلى جدولٍ بمفتاح أجنبي · والقيد وسجل العمليات لا يُمسّان أبداً */
function fkChildren(db: DB, parent: string): Array<{ child: string; from: string; to: string; notNull: boolean }> {
  const out: Array<{ child: string; from: string; to: string; notNull: boolean }> = [];
  for (const t of SYNC_TABLES) {
    if (t.name === 'journal_entries' || t.appendOnly) continue;
    const fks = db.all<{ table: string; from: string; to: string | null }>(`PRAGMA foreign_key_list("${t.name}")`).filter((k) => k.table === parent);
    if (!fks.length) continue;
    const info = db.all<{ name: string; notnull: number }>(`PRAGMA table_info("${t.name}")`);
    for (const k of fks) {
      out.push({ child: t.name, from: k.from, to: k.to ?? syncTable(parent)!.pkCols[0], notNull: !!info.find((c) => c.name === k.from)?.notnull });
    }
  }
  return out;
}

/** وقت آخر نسخةٍ عرفها الجهاز للصف · لا يرجع إلى الوراء (الهجرة ٤٣) */
function noteRowTime(db: DB, table: string, key: string, u: string): void {
  db.run(`INSERT INTO sync_rowtime (tbl, pk, u) VALUES (?, ?, ?) ON CONFLICT(tbl, pk) DO UPDATE SET u = excluded.u WHERE excluded.u > sync_rowtime.u`,
    [table, key, isoNorm(u)]);
}

/**
 * صفٌّ إلى الطابور · بوقت الآن، أو بوقتٍ وارد بساعة الخادم (serverAt) حين يُرفع الصف لأن وارداً مسّه لا لأن المستخدم عدّله
 * (المراجعة الشاملة · البندان ١ و١٣): وقت الآن كان يغلب نسخةً أحدث منه في الدفعة نفسها أو في جهاز آخر · وتعديلٌ محلي
 * معلّق أحدث من الوقت الوارد يبقى بوقته
 */
function enqueue(db: DB, table: string, key: string, op: 'upsert' | 'delete', serverAt?: string): void {
  if (serverAt === undefined) {
    db.run(`INSERT INTO sync_outbox (tbl, pk, op, changed_at) VALUES (?,?,?,?)
            ON CONFLICT(tbl, pk) DO UPDATE SET op = excluded.op, changed_at = excluded.changed_at`, [table, key, op, nowIso()]);
    return;
  }
  db.run(`INSERT INTO sync_outbox (tbl, pk, op, changed_at) VALUES (?,?,?,?)
          ON CONFLICT(tbl, pk) DO UPDATE SET op = excluded.op, changed_at = MAX(sync_outbox.changed_at, excluded.changed_at)`,
    [table, key, op, fromServerClock(db, serverAt)]);
}

/** حذفٌ وارد ينتظر نسخ أبنائه الواردة في الصندوق نفسه (المراجعة الشاملة · البند ١) */
class AwaitChildren extends Error {}

/** وقت المستند الوارد للمقارنة: لا يتجاوز وقت كتابته في الخادم (مراجعة التثبيت #56) · بصيغة واحدة (البند ١٦) */
const incomingAt = (doc: RemoteDoc): string => isoNorm(doc.ts && isoCmp(doc.ts, doc.u) < 0 ? doc.ts : doc.u);

/**
 * نسخة الابن الواردة غير الحذف التي تنتظر في الصندوق ويُتوقع أن تُطبَّق: لا أقدم مما عرفه الجهاز للصف (وإلا غلبها ما هنا كما في
 * applyOne فلا تُطبَّق) · null إن لم تكن
 */
function incomingVersion(db: DB, table: string, key: string, joining: boolean): RowData | null {
  const r = db.get<{ payload: string }>(`SELECT payload FROM sync_inbox WHERE tbl = ? AND pk = ? AND del = 0`, [table, key]);
  if (!r) return null;
  const doc = JSON.parse(r.payload) as RemoteDoc;
  if (!doc.d) return null;
  if (!joining) {
    const seen = db.get<{ u: string }>(`SELECT u FROM sync_rowtime WHERE tbl = ? AND pk = ?`, [table, key])?.u;
    if (seen && isoCmp(incomingAt(doc), seen) < 0) return null;
  }
  return doc.d;
}

/**
 * حذفٌ وارد لصفٍّ له هنا أبناء لم يعرفهم الحاذف (كُتبوا على هذا الجهاز قبل أن يصله الحذف، كدفعةٍ على عقدٍ
 * حذفته استعادةُ نسخة على جهاز آخر): الحاذف يغلب على المستندات كما تغلب الاستعادة. فالابن الذي لا يقوم
 * بلا أبيه (مفتاحه إليه إلزامي) يُحذف معه، والابن الذي يقوم بلا أبيه يُفكّ ربطه (دفعةٌ حُذف قسطها تبقى
 * فائضاً على عقدها يظهر للرد) · ويُرفع ما حُذف وما فُكّ فتتطابق الأجهزة. والقيد المرحّل لا يُحذف:
 * ما غاب مستنده يُعلَّم للمراجعة بعد اكتمال الوارد (orphans.ts).
 * ويُرفع ما حُذف وما فُكّ بوقت الحذف الوارد (at بساعة الخادم) لا بوقت الآن (المراجعة الشاملة · البند ١): فنسخة الابن الأحدث
 * في جهاز آخر تغلبه ولا يغلبها.
 * والابن الذي تنتظر له في الصندوق نسخةٌ واردة تنقله عن هذا الأب (الدمج: العقد إلى الوجهة) ومفتاحه يقبل الفراغ يُفكّ هنا وحده،
 * بلا طابور ولا مسّ لوقته، فيُحذف الأب في خطوة الحذف نفسها وتعيد نسخته الواردة ربطه في مرحلة الصفوف من المرور نفسه (البند ١ ·
 * المراجعة الأخيرة: تأجيل الأب كله إلى المرور التالي كان يبقيه حاملاً قيمةً فريدة يحتاجها صفٌّ وارد، كهوية المدموج في الوجهة،
 * فيُرفض ذلك الصف أبداً، أو يتعطّل الأب والابن ووجهته الجديدة معاً) · وإن فشلت نسخته بعدُ بقيت في الصندوق تُعاد حتى يصل ما
 * تنتظره، ولم يُرفع منه شيء · وما لا يُفكّ (مفتاحه إلزامي) أو تبقيه نسخته على هذا الأب يُطبَّق أولاً ويعود الحذف في المرور التالي
 */
function deleteOverChildren(db: DB, table: string, key: string, at: string, joining: boolean, depth = 0): void {
  if (depth > 8) throw new Error('تسلسل أبناء أعمق من المتوقع');
  const row = readRow(db, table, key);
  if (!row) return;
  for (const c of fkChildren(db, table)) {
    const ct = syncTable(c.child)!;
    const kids = db.all<{ k: string }>(`SELECT ${ct.pk(`"${c.child}"`)} AS k FROM "${c.child}" WHERE "${c.from}" = ?`, [row[c.to] as SqlValue]);
    for (const kid of kids) {
      const next = incomingVersion(db, c.child, kid.k, joining);
      if (next) {
        const moves = c.from in next && String(next[c.from] ?? '') !== String(row[c.to] ?? '');
        if (!moves || c.notNull) throw new AwaitChildren();
        db.run(`UPDATE "${c.child}" SET "${c.from}" = NULL WHERE ${pkWhere(c.child)}`, pkParams(c.child, kid.k));
        continue;
      }
      // بوقت آخر نسخةٍ عرفها الجهاز للابن إن سبقت الحذف (التحقق المستقل على البند ١: رفعٌ منقسم يصل فيه الحذف قبل نقل الابن) ·
      // فمآل الابن الذي يرفعه الحاذف (نقله في الدمج ثم إفراغ السلة، أو فكّه) أحدث منه فيغلبه · وتعديلٌ معلّق هنا يبقى بوقته
      const when = childTime(db, c.child, kid.k, at);
      if (c.notNull) { deleteOverChildren(db, c.child, kid.k, at, joining, depth + 1); enqueue(db, c.child, kid.k, 'delete', when); }
      else { db.run(`UPDATE "${c.child}" SET "${c.from}" = NULL WHERE ${pkWhere(c.child)}`, pkParams(c.child, kid.k)); enqueue(db, c.child, kid.k, 'upsert', when); }
    }
  }
  deleteRow(db, table, key);
}

/**
 * صفٌّ وارد يخالف فهرساً فريداً وحاملُ القيمة هنا ينتظر حذفُه في الصندوق (المراجعة الشاملة · البند ١ · المراجعة الأخيرة): الحذف
 * مؤجَّلٌ لابنٍ تُطبَّق نسخته أولاً، فالقيمة تُفرَغ في المرور التالي · فيُعاد الصف ولا يُرفض أبداً · وكذلك إن رُفض الحذف لطول انتظار
 * ابنه، فهو يعود حين تُطبَّق نسخة الابن (المتحقق المستقل)
 */
function uniqueHolderLeaving(db: DB, doc: RemoteDoc, msg: string): boolean {
  if (doc.del || !doc.d) return false;
  const m = /UNIQUE constraint failed: ([^\n]+)/i.exec(msg);
  if (!m) return false;
  const named = /^index '([^']+)'/.exec(m[1].trim());
  const cols = named
    ? db.all<{ name: string | null }>(`PRAGMA index_info("${named[1].replace(/"/g, '')}")`).map((c) => c.name)
    : m[1].split(',').map((p) => p.trim()).map((p) => (p.startsWith(doc.t + '.') ? p.slice(doc.t.length + 1) : null));
  if (!cols.length || cols.some((c) => !c || !(c in doc.d!))) return false;
  const t = syncTable(doc.t)!;
  const holders = db.all<{ k: string }>(
    `SELECT ${t.pk(`"${doc.t}"`)} AS k FROM "${doc.t}" WHERE ${cols.map((c) => `"${c}" = ?`).join(' AND ')}`,
    cols.map((c) => doc.d![c as string] as SqlValue));
  return holders.some((h) => h.k !== doc.k && (!!db.get(`SELECT 1 FROM sync_inbox WHERE tbl = ? AND pk = ? AND del = 1`, [doc.t, h.k])
    || deleteWaitRejected(db, doc.t, h.k)));
}

/**
 * حذفٌ وارد للصف رُفض لطول انتظار ابنه وما زال يُعاد حين تُطبَّق نسخة الابن (restageArrivedParents) · فحامل القيمة ما زال مغادراً
 * (البند ١ · المتحقق المستقل: الصف الوارد بقيمته كان يُرفض بالفهرس الفريد رفضاً لا يعود، فيبقى غائباً بعد أن يُحذف حاملها)
 */
function deleteWaitRejected(db: DB, table: string, key: string): boolean {
  return db.all<{ payload: string }>(`SELECT payload FROM sync_rejects WHERE tbl = ? AND pk = ? AND reason = ?`, [table, key, WAIT_REJECT])
    .some((r) => {
      try { return (JSON.parse(r.payload) as RemoteDoc).del === true; } catch { return false; }
    });
}

/** وقت رفع ما فُكّ أو حُذف من ابنٍ بحذف أبيه الوارد: آخر ما عرفه الجهاز للابن إن سبق وقت الحذف، وإلا وقت الحذف */
function childTime(db: DB, table: string, key: string, at: string): string {
  const seen = db.get<{ u: string }>(`SELECT u FROM sync_rowtime WHERE tbl = ? AND pk = ?`, [table, key])?.u;
  return seen && isoCmp(seen, at) < 0 ? seen : at;
}

/*
 * الأب المقفل أمام كتابة العضو (المراجعة الشاملة 2026-11-13 · B-1): «الفاتورة الصادرة مقفلة: لا تُعدَّل ولا تعود مسودة ولا تُحذف» (قرار
 * المالك 2026-10-07 على #30 · DESIGN §١٣.١٣)، وجدول أقساط العقد المؤكَّد «يُولَّد آلياً عند الإنشاء ولا يُعاد توليده» · والقفل كان في
 * الشاشة وحدها (saveInvoice وconfirmContract)، فسطرٌ يكتبه عضوٌ في السحابة لفاتورةٍ صادرة، أو قسطٌ لعقدٍ مؤكَّد لغيره، كان يطبّقه جهاز
 * المالك كما هو فيتغيّر الإقرار والفاتورة المطبوعة وجدول المستأجر بعد إصدارها · وما يكتبه التطبيق نفسه يصل على دفعات (دفعة العضو ثمانية
 * صفوف: MEMBER_PUSH_BATCH) بعد رأسه في ترتيب الرفع، فالأب الصادر في الطريق لم تكتمل أبناؤه بعد، وما بعد اكتمالها مزوَّر
 */
const DRAFT_INVOICE = 'مسودة'; // i18n-exempt: حالة الفاتورة المخزّنة
const KIND_CREDIT_NOTE = 'credit_note';
/** حالات الفاتورة الصادرة التي يكتبها التطبيق بعد إصدارها: التأخر والتحصيل وعكسه (setInvoiceStatus وpayInvoice) */
const ISSUED_INVOICE_STATUSES = new Set(['مستحقة', 'متأخرة', PAID_INVOICE]); // i18n-exempt: حالات الفاتورة المخزّنة
/**
 * ما يغيّره التطبيق في الفاتورة الصادرة (المراجعة الشاملة 2026-11-13 · B-1 ب · المدقق المستقل R11-B1-2: كانت قائمة منعٍ فاتها رابط قيد
 * الإصدار، فمحاه «كامل» فرحّل تعليمُها «متأخرة» عند المالك قيد إصدارٍ ثانياً) · قائمة سماح: الحالة (ISSUED_INVOICE_STATUSES)، وحقول
 * التحصيل، وعقارها بنقل وحدتها (unitMove.ts) · وما سواها لا يتغيّر من عضو، إلا قيد الإصدار في حالتيه (namedEntryIssue) والإخراج من السلة
 */
const ISSUED_INVOICE_OPEN = new Set(['status', 'paid_date', 'payment_method', 'payment_bank_id', 'payment_journal_entry_id', 'property_id']);
/** حقول سطر الفاتورة كما يكتبها saveInvoice · تغيّر أيٍّ منها تعديلٌ للسطر */
const INVOICE_LINE_COLS = ['invoice_id', 'descr', 'qty', 'price_halalas', 'tax_pct', 'sort', 'tax_code'];
/** حكم الأب المقفل: ينتظر ما في الوارد (قيدٌ أو تأكيدٌ أو جدولٌ في الطريق) ولا يُرفض بعد */
const LOCK_AWAIT = '\u0000await';

/** كاتب الصف الأول إن كان عضواً (row_by) · وما كتبه المالك هنا أو بلا كاتبٍ معروف (ما قبل الهجرة ٤٢) null */
function memberWriterOf(db: DB, table: string, key: string): string | null {
  const w = db.get<{ uid: string }>(`SELECT uid FROM row_by WHERE tbl = ? AND pk = ?`, [table, key])?.uid ?? '';
  return w && w !== ownerUid(db) ? w : null;
}

/**
 * الأب المقفل صار صادراً أو مؤكَّداً هنا بمستند عضو (المراجعة الشاملة 2026-11-13 · المدقق المستقل R11-B1-4 وR11-B1-5) · فأبناؤه من
 * عضوٍ قد تكون في الطريق بعده: الفاتورة التي كتبها المالك وأصدرها «كامل» الفواتير (فحص الاكتمال لا القفل التام)، ومسودة عضوٍ أكّدها
 * عضوٌ آخر («كامل» العقود يكتب جدولها لا كاتبها) · ويُعلَّم ما لا يُعرف بكاتبه وحده: فاتورة المالك، وعقد العضو الذي كان هنا مسودة
 */
const VIA_MEMBER = 'locked_via_member:';
const viaMember = (db: DB, t: string, k: string): boolean => getSyncState(db, VIA_MEMBER + t + ':' + k) != null;
function noteViaMember(db: DB, doc: RemoteDoc, row: RowData): void {
  if ((doc.t !== 'invoices' && doc.t !== 'contracts') || getSyncState(db, 'membership') || !byMember(db, doc, false)) return;
  if (row.status == null || row.status === DRAFT_INVOICE) return;
  const cur = db.get<{ s: string }>(`SELECT status AS s FROM "${doc.t}" WHERE id = ?`, [doc.k]);
  const member = memberWriterOf(db, doc.t, doc.k) != null;
  // (حالة المسودة في الجدولين «مسودة»: DRAFT_INVOICE وDRAFT_CONTRACT)
  const mark = doc.t === 'invoices' ? !member && (!cur || cur.s === DRAFT_INVOICE) : member && cur?.s === DRAFT_CONTRACT;
  if (mark) setSyncState(db, VIA_MEMBER + doc.t + ':' + doc.k, '1');
}

/**
 * فاتورةٌ صادرة هنا مقفلةٌ أمام سطور العضو (المراجعة الشاملة 2026-11-13 · B-1): ما صدر هنا لا بمستند عضو (كتبها المالك وأصدرها هو)
 * لا سطور له في الطريق، فهي مقفلة كيفما كانت سطورها (المدقق المستقل R11-B1-5: فاتورةٌ قديمة بلا سطور كان «كامل» يضيف لها سطوراً
 * يُحسب بها البند ١) · وما أصدره عضو (فاتورته، أو فاتورة المالك أصدرها «كامل» · noteViaMember) مقفلٌ متى اكتملت سطوره: سطوره هنا تعيد
 * رأسه كما صدر (صافيه، وضريبته بنسبة كل سطر كما يحسبها invoiceTotals، والإشعار الدائن بصافيه: ضريبته من باقي فاتورته لا من سطوره ·
 * creditNoteAmounts) · وقبل اكتمالها يُقبل ما يكتبه التطبيق مع إصدارها: فاتورةٌ جديدة صادرة، ومسودةٌ عُدّلت وصدرت في حفظٍ واحد فحُذفت
 * سطورها القديمة، والإشعار الدائن
 */
function issuedInvoiceSealed(db: DB, id: string): boolean {
  const v = db.get<Record<string, unknown>>(`SELECT * FROM invoices WHERE id = ?`, [id]);
  if (!v || v.status === DRAFT_INVOICE) return false;
  if (!memberIssued(db, id)) return true;
  const lines = db.all<InvLine>(`SELECT qty, price_halalas, tax_pct FROM invoice_lines WHERE invoice_id = ?`, [id]);
  return lines.length > 0 && linesMatchHeader(v, lines);
}

type InvLine = { qty: unknown; price_halalas: unknown; tax_pct: unknown };
/** أصدرها عضو: فاتورته، أو فاتورة المالك أصدرها «كامل» (noteViaMember) · فلسطورها ما في الطريق */
const memberIssued = (db: DB, id: string): boolean => !!memberWriterOf(db, 'invoices', id) || viaMember(db, 'invoices', id);
/** السطور تعيد رأس الفاتورة كما صدر: صافيه، وضريبته بنسبة كل سطر كما يحسبها invoiceTotals (والإشعار الدائن بصافيه) */
function linesMatchHeader(v: Record<string, unknown>, lines: InvLine[]): boolean {
  let net = 0, tax = 0;
  for (const l of lines) {
    const n = mulQty(Number(l.qty), Number(l.price_halalas));
    net += n;
    tax += pctOf(n, Number(l.tax_pct));
  }
  return net === Number(v.subtotal_halalas) && (v.kind === KIND_CREDIT_NOTE || tax === Number(v.tax_halalas));
}

/**
 * وقت إصدار فاتورة العضو كما عرفه جهاز المالك: وقت الخادم لمستند رأسها الذي وصلها صادرةً وهي هنا غائبةٌ أو مسودة (المراجعة الشاملة
 * 2026-11-13 · R12-SYN-2) · لا يتقدّم بما يُكتب في رأسها بعد الإصدار (التأخر والتحصيل)
 */
const INVOICE_ISSUED = 'invoice_issued:';
function noteInvoiceIssued(db: DB, doc: RemoteDoc, row: RowData): void {
  if (doc.t !== 'invoices' || getSyncState(db, 'membership') || !byMember(db, doc, true)) return;
  if (row.status == null || row.status === DRAFT_INVOICE) return;
  const cur = db.get<{ s: string }>(`SELECT status AS s FROM invoices WHERE id = ?`, [doc.k]);
  if (!cur || cur.s === DRAFT_INVOICE) setSyncState(db, INVOICE_ISSUED + doc.k, serverAt(doc));
}
/** وقت المستند بساعة الخادم (ts تفرضه القاعدة) · لا «u» الذي يكتبه العضو فيقدّمه أو يؤخّره */
const serverAt = (doc: RemoteDoc): string => isoNorm(doc.ts ?? doc.u);

/**
 * سطرٌ يُنشأ أو يُعدَّل أو يُحذف لفاتورةٍ صادرة (المراجعة الشاملة 2026-11-13 · B-1 · R12-SYN-2) · سببُ الرفض أو '' أو LOCK_AWAIT:
 * قبل اكتمال سطورها يُقبل (ما يكتبه التطبيق مع إصدارها في الطريق) · وبعد اكتمالها كان يُرفض كل سطر، فسطرٌ بسعرٍ صفر (بندٌ مجاني أو سطرٌ
 * تُرك فارغاً) أو سطرا إضافةٍ وخصمٍ بالمبلغ نفسه، كُتبت مع الإصدار ووصلت بعد ما اكتمل به المجموع، كانت تُرفض وتُحذف من السحابة ومن جهاز
 * العضو · فما كُتب في ساعة إصدار فاتورة العضو (LATE_LINK_MS بوقت الخادم، كأقساط العقد) يُقبل إن بقيت السطور بعده، مع ما في الوارد من
 * سطورها، تعيد رأسها كما صدر، وإلا انتظر بقيتها حتى تمضي الساعة · وما بعد الساعة، أو ما يغيّر مبالغها، مرفوض كما كان · ويبقى أن سطراً
 * لا يغيّر المبالغ يُكتب في ساعة الإصدار يُقبل: لا عدد سطورٍ ولا بصمةَ لها في رأسها بلا تغيير المخطط
 */
function issuedLineIssue(db: DB, invoiceId: string, doc: RemoteDoc): string {
  if (!issuedInvoiceSealed(db, invoiceId)) return '';
  const locked = tr('sync.issuedInvoiceLocked', { lng: 'ar' });
  const at = memberIssued(db, invoiceId) ? getSyncState(db, INVOICE_ISSUED + invoiceId) : null;
  const end = at ? Date.parse(at) + LATE_LINK_MS : NaN;
  if (!Number.isFinite(end) || Date.parse(serverAt(doc)) > end) return locked;
  // السطور بعد هذا المستند وما في الوارد من سطورها (غيره): ما هنا، ثم نسخ الوارد، ثم هو
  const lines = new Map<string, InvLine>();
  for (const l of db.all<InvLine & { id: string }>(`SELECT id, qty, price_halalas, tax_pct FROM invoice_lines WHERE invoice_id = ?`, [invoiceId])) lines.set(l.id, l);
  const put = (d: RemoteDoc) => {
    if (!d.del && d.d && String(d.d.invoice_id ?? '') === invoiceId) lines.set(d.k, d.d as InvLine);
    else lines.delete(d.k);
  };
  for (const r of db.all<{ p: string }>(`SELECT payload AS p FROM sync_inbox WHERE tbl = 'invoice_lines' AND doc != ?
      AND (json_extract(payload, '$.d.invoice_id') = ? OR (del = 1 AND pk IN (SELECT id FROM invoice_lines WHERE invoice_id = ?)))`,
    [doc.id, invoiceId, invoiceId])) {
    try { put(JSON.parse(r.p) as RemoteDoc); } catch { /* مستندٌ تالف لا يشهد */ }
  }
  put(doc);
  const v = db.get<Record<string, unknown>>(`SELECT * FROM invoices WHERE id = ?`, [invoiceId])!;
  if (linesMatchHeader(v, [...lines.values()])) return '';
  return Date.parse(toServerClock(db, nowIso())) <= end ? LOCK_AWAIT : locked;
}

/** قيدٌ مرحّلٌ حيٌّ هنا (لم يُعكس ولم يُحذف) */
const liveEntry = (db: DB, id: unknown): boolean => id != null && id !== ''
  && !!db.get(`SELECT 1 FROM journal_entries WHERE id = ? AND status = ? AND reversed_by IS NULL AND deleted_at IS NULL`, [String(id), POSTED_ENTRY]);
/** قيدٌ ينتظر في الوارد */
const entryInbox = (db: DB, id: string): boolean =>
  !!db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ? AND del = 0`, [id]);
/**
 * القيد الذي يسمّيه رأس المصدر الوارد بدل قيده هنا (قيد إصدار الفاتورة · قيد فاتورة الشراء): قيدُ المصدر نفسه مرحّلٌ حيٌّ هنا (وقد طابق
 * رأسه الوارد في إعادة الاشتقاق: memberSourceCheck)، وقيده القديم ليس حيّاً هنا · وما في الوارد منهما ينتظر · سببُ الرفض أو '' أو LOCK_AWAIT
 */
function namedEntryIssue(db: DB, src: string, srcId: string, oldId: unknown, newId: unknown, why: string): string {
  const next = newId == null ? '' : String(newId);
  if (!next || next === String(oldId ?? '')) return why;
  if (!db.get(`SELECT 1 FROM journal_entries WHERE id = ? AND status = ? AND src_type = ? AND src_id = ? AND reversed_by IS NULL AND deleted_at IS NULL`,
    [next, POSTED_ENTRY, src, srcId])) return entryInbox(db, next) ? LOCK_AWAIT : why;
  if (!liveEntry(db, oldId)) return '';
  // وقيده القديم في طريقه إلى العكس: عاكسه أو نسخته المعكوسة في الوارد
  return reversalPending(db, String(oldId), src, srcId)
    || db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ? AND del = 0 AND json_extract(payload, '$.d.reversed_by') IS NOT NULL`, [String(oldId)])
    ? LOCK_AWAIT : why;
}

/**
 * حارس الأب المقفل على جهاز المالك (المراجعة الشاملة 2026-11-13 · B-1) · سببُ الرفض أو '' أو LOCK_AWAIT · والمرفوض تُعاد نسخة المالك منه
 * إلى الطابور (وما ليس عنده شاهدُ حذف: buildDoc) فتعود السحابة وكل جهازٍ إليها · والقواعد ترفض منه ما يسعه حدّ الألف تعبير (rulesGen.ts:
 * سطر «إدخال» لفاتورةٍ غير مسودة، وما صدرت به الفاتورة من «كامل» ورابط قيد إصدارها)، وما لا يسعه هنا وحده: سطر «كامل» وتعديله وحذفه
 * (حذف السطور القديمة لمسودةٍ صدرت في حفظٍ واحد يصل بعد رأسها الصادر)، وأعمدة الصادرة التي أُضيفت بعد المخطط الأول، وقسط العقد كله
 * (إنشاء العقد أثقل كتابات العضو: اختبار الميزانية)، وفاتورة الشراء المرحّلة
 */
const LOCKED_PARENT_TABLES = new Set(['invoices', 'invoice_lines', 'contract_installments', 'purchases']);
function lockedParentIssue(db: DB, doc: RemoteDoc): string {
  // الجدول أولاً: ما سواها لا يدفع قراءةً لكل وارد (فحص المالك خطيٌّ في حجم الوارد · tests/d4.memberScale.test.ts)
  if (!LOCKED_PARENT_TABLES.has(doc.t) || getSyncState(db, 'membership')) return '';
  const d = (doc.d ?? {}) as Record<string, unknown>;
  // ١) رأس الفاتورة الصادرة: لا تعود مسودة ولا تُحذف، ولا يتغيّر منها إلا ما يكتبه التطبيق (ISSUED_INVOICE_OPEN)
  if (doc.t === 'invoices' && (doc.del ? doc.dby !== ownerUid(db) : byMember(db, doc, false))) {
    const cur = db.get<Record<string, unknown>>(`SELECT * FROM invoices WHERE id = ?`, [doc.k]);
    if (!cur || cur.status === DRAFT_INVOICE) return '';
    const locked = tr('sync.issuedInvoiceLocked', { lng: 'ar' });
    if (doc.del || ('status' in d && !ISSUED_INVOICE_STATUSES.has(String(d.status)))) return locked;
    const trashed = cur.deleted_at != null;
    // الحقل الغائب عن المستند لا يمسّه التطبيق (upsertRow)، فيُقارن الحاضر وحده (مستندٌ من إصدارٍ أقدم بلا عمودٍ أُضيف بعده)
    for (const c of Object.keys(cur)) {
      if (!(c in d) || String(cur[c] ?? '') === String(d[c] ?? '') || ISSUED_INVOICE_OPEN.has(c)) continue;
      // والمحذوفة قبل القفل تخرج من السلة (restoreInvoice) ولا تدخلها صادرةٌ حيّة
      if (c === 'deleted_at' && trashed && d.deleted_at == null) continue;
      // وقيد الإصدار يتغيّر في حالتين يكتبهما التطبيق: صادرةٌ بلا قيدٍ حيّ (setInvoiceStatus لصادرةٍ قديمة بلا قيد)، والإخراج من السلة
      // بقيدٍ جديد · وقيدها الجديد قيدُ إصدارها هنا (طابق رأسها)
      if (c === 'journal_entry_id') {
        const why = namedEntryIssue(db, 'invoice', doc.k, cur.journal_entry_id, d.journal_entry_id, locked);
        if (why) return why;
        continue;
      }
      return locked;
    }
    return '';
  }
  // ٢) سطر الفاتورة: إنشاؤه أو تعديله أو حذفه لفاتورةٍ صادرة مقفلة هنا (قبلها وبعدها: invoice_id هنا وفي المستند)
  if (doc.t === 'invoice_lines') {
    const cur = db.get<Record<string, unknown>>(`SELECT ${INVOICE_LINE_COLS.join(', ')} FROM invoice_lines WHERE id = ?`, [doc.k]);
    if (!(doc.del ? doc.dby !== ownerUid(db) : byMember(db, doc, !cur))) return '';
    // ونسخةٌ مطابقة لما هنا ليست تعديلاً (إعادة رفعٍ بلا تغيير)
    const changed = doc.del ? !!cur : !cur || INVOICE_LINE_COLS.some((c) => String(cur[c] ?? '') !== String(d[c] ?? ''));
    if (!changed) return '';
    const parents = new Set([cur?.invoice_id, doc.del ? null : d.invoice_id].filter((x) => x != null && x !== '').map(String));
    const whys = [...parents].map((p) => issuedLineIssue(db, p, doc));
    return whys.find((w) => w && w !== LOCK_AWAIT) ?? whys.find((w) => w === LOCK_AWAIT) ?? '';
  }
  // ٣) قسطٌ جديد من عضو: جدول العقد يكتبه من أكّده مع تأكيده (confirmContract وrenewContract)، والمسودة بلا أقساط
  if (doc.t === 'contract_installments' && !doc.del && doc.d && !db.get(`SELECT 1 FROM contract_installments WHERE id = ?`, [doc.k])
    && byMember(db, doc, true)) {
    return installmentIssue(db, doc, String(d.contract_id ?? ''));
  }
  // ٤) فاتورة الشراء المرحّلة: صافيها وضريبتها وإجماليها ووضعها الضريبي وتاريخها لا تتغيّر من عضوٍ إلا بقيدها الجديد وعكس القديم
  // (المدقق المستقل R11-B1-3: كان «كامل» المشتريات يضاعف البند ٧ من رأسها والدفتر كما هو)
  if (doc.t === 'purchases' && !doc.del && doc.d && byMember(db, doc, false)) {
    const cur = db.get<Record<string, unknown>>(`SELECT * FROM purchases WHERE id = ?`, [doc.k]);
    if (!cur || !POSTED_PURCHASE_COLS.some((c) => c in d && c in cur && String(cur[c] ?? '') !== String(d[c] ?? ''))) return '';
    return namedEntryIssue(db, 'purchase', doc.k, cur.journal_entry_id, d.journal_entry_id, tr('sync.postedPurchaseLocked', { lng: 'ar' }));
  }
  return '';
}

/**
 * قسطٌ جديد من عضو (المراجعة الشاملة 2026-11-13 · B-1 ب · المدقق المستقل R11-B1-1 وR11-B1-4) · سببُ الرفض أو '' أو LOCK_AWAIT:
 *  - المسودة: لا أقساط لها في التطبيق (يولّدها التأكيد في معاملته)، فقسطٌ لها ينتظر تأكيدها الوارد، ولا يُقبل إلا من كاتبها (قرار المالك
 *    2026-10-04: «صاحب إدخال يعدّل مسودته هو فقط») · كان يُقبل من أي عضو، فيصير قسطه المزروع جدول العقد كله حين يؤكّده المالك
 *    (confirmContract لا يولّد جدولاً لعقدٍ له أقساط).
 *  - عقدٌ كاتبه عضو (row_by): جدوله لكاتبه، فلا يُقبل قسطُ غيره ما دام لكاتبه قسطٌ هنا أو في الوارد · وغيرُه يكتبه حين أكّد مسودته
 *    («كامل» العقود)، فيُقبل من أول كاتبٍ لأقساطه إن كان العقد هنا مسودةً حين وصل تأكيده (noteViaMember) · وإلا (عقدٌ وصل مؤكَّداً)
 *    ينتظر أقساط كاتبه ساعةً بوقت الخادم من آخر نسخةٍ لرأسه (LATE_LINK_MS: ما كُتب معه يُرفع في دورته ولو على دفعات)، ثم أول كاتب ·
 *    كان «أول كاتب» وحده، فقسطٌ يسبق به عضوٌ أقساطَ صاحب العقد يملك جدوله وتُرفض أقساط صاحبه كلها.
 *  - عقدٌ بلا كاتبٍ عضو (مسودة المالك أكّدها «كامل» العقود، أو ما قبل الهجرة ٤٢): أول كاتبٍ لأقساطه، أو أقساطه هنا كلها من كاتب هذا
 *    القسط.
 * ويبقى في «أول كاتب» ما لا يعرفه جهاز المالك: عضوٌ يسبق مؤكِّد المسودة بقسطٍ وهو في الطريق، أو يسبق صاحب العقد بعد أن انقطع رفعه
 * أكثر من ساعة · وسدّه حقلُ «آخر كاتب» تفرضه القاعدة (الكاتب «by» لا يتغيّر بعد الإنشاء)، أو صلاحية كل عضوٍ على جهاز المالك
 */
function installmentIssue(db: DB, doc: RemoteDoc, cid: string): string {
  const c = db.get<{ s: string }>(`SELECT status AS s FROM contracts WHERE id = ?`, [cid]);
  // العقد لم يصل بعد: ينتظره القسط بمفتاحه الأجنبي
  if (!c) return '';
  const locked = tr('sync.installmentLocked', { lng: 'ar' });
  const by = String(doc.by ?? '');
  const writer = memberWriterOf(db, 'contracts', cid);
  if (!by) return locked;
  if (c.s === DRAFT_CONTRACT) {
    // تأكيدها في الوارد لم يُطبَّق بعد (ينتظر أباً): ينتظره قسطه
    if (db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'contracts' AND pk = ? AND del = 0 AND json_extract(payload, '$.d.status') != ?`,
      [cid, DRAFT_CONTRACT])) return LOCK_AWAIT;
    return writer && by === writer ? '' : locked;
  }
  // كاتب كل قسطٍ هنا: من وصل بالمزامنة بكاتبه (stageInbox)، وما أنشأه المالك هنا بلا كاتب
  const writers = db.all<{ w: string }>(`SELECT COALESCE(b.uid, '') AS w FROM contract_installments i
    LEFT JOIN row_by b ON b.tbl = 'contract_installments' AND b.pk = i.id WHERE i.contract_id = ?`, [cid]).map((x) => x.w);
  const firstWriter = writers.every((w) => w === by) ? '' : locked;
  if (!writer || by === writer) return firstWriter;
  if (writers.includes(writer) || db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'contract_installments' AND del = 0
    AND json_extract(payload, '$.d.contract_id') = ? AND json_extract(payload, '$.by') = ?`, [cid, writer])) return locked;
  if (viaMember(db, 'contracts', cid)) return firstWriter;
  const at = db.get<{ u: string }>(`SELECT u FROM sync_rowtime WHERE tbl = 'contracts' AND pk = ?`, [cid])?.u;
  return at && Date.parse(toServerClock(db, nowIso())) - Date.parse(at) <= LATE_LINK_MS ? LOCK_AWAIT : firstWriter;
}

/**
 * إعدادات المالك وحده في صفّ المنشأة (المراجعة الشاملة 2026-11-13 · B-3): تسجيل ضريبة القيمة المضافة في «المالية» للمالك وحده
 * (app/settings.tsx · admin)، لكنه عمودٌ في جدولٍ يملكه قسم «المنشأة والقوالب»، فعضوٌ له «كامل» فيه كان يطفئه من السحابة فيسقط البند ١
 * من الإقرار على كل جهاز · ولا يحذف العضو صفّ المنشأة · والقاعدة ترفضهما (rulesGen.ts)، وجهاز المالك يرفضهما ويعيد نسخته · والأعمدة
 * في OWNER_ONLY_COLS (opWrites.ts) · سببُ الرفض أو ''
 */
function ownerColsIssue(db: DB, doc: RemoteDoc): string {
  const cols = OWNER_ONLY_COLS[doc.t];
  if (!cols || getSyncState(db, 'membership')) return '';
  if (!(doc.del ? doc.dby !== ownerUid(db) : byMember(db, doc, false))) return '';
  if (doc.del) return tr('sync.companyOwnerOnly', { lng: 'ar' });
  const cur = readRow(db, doc.t, doc.k);
  const d = (doc.d ?? {}) as Record<string, unknown>;
  return cur && cols.some((c) => c in d && String(d[c] ?? '') !== String(cur[c] ?? ''))
    ? tr('sync.companyOwnerOnly', { lng: 'ar' }) : '';
}
/** جهاز العضو: إعداد المالك في صفّه من الوارد ولو غلب تعديله، فلا يرفع قيمةً قديمة ترفضها القاعدة (B-3 · كالافتتاحي adoptCloudOpening) */
function adoptOwnerCols(db: DB, doc: RemoteDoc): void {
  const cols = OWNER_ONLY_COLS[doc.t];
  if (!cols || !getSyncState(db, 'membership') || !doc.d || doc.del) return;
  for (const c of cols) {
    if (c in doc.d) db.run(`UPDATE "${doc.t}" SET "${c}" = ? WHERE ${pkWhere(doc.t)}`, [doc.d[c] as SqlValue, ...pkParams(doc.t, doc.k)]);
  }
}

type ApplyOutcome = 'applied' | 'skipped' | 'conflict-local' | 'conflict-remote' | 'retry' | 'rejected';

function reject(db: DB, doc: RemoteDoc, reason: string): void {
  // المستند نفسه يُسحب ثانيةً في نافذة الأمان (البند ٢) · فرفضه بالسبب نفسه لا يتكرر في السجل ولا في سجل العمليات (التحقق المستقل)
  const payload = JSON.stringify(doc);
  if (db.get(`SELECT 1 FROM sync_rejects WHERE doc = ? AND reason = ? AND payload = ?`, [doc.id, reason, payload])) return;
  db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`,
    [doc.id, doc.t, doc.k, reason, payload, nowIso()]);
  // سبب الرفض كاملاً في sync_rejects على الجهاز، وفي سجل العمليات المزامَن محجوباً كنص العطل (المراجعة الشاملة · البند ١٧ ونظيره)
  // والسجل لا يعطّل إلا إن ألغت SQLite المعاملة عنده (قرصٌ ممتلئ): كان يُبتلع فيذهب سطر الرفض مع الإلغاء ويُحذف المستند من الصندوق
  // خارج أي معاملة فيضيع بلا أثر · فيُكتب في معاملةٍ متداخلة يكشف مديرها الإلغاء، ويُعاد رمي عطل القاعدة (مراجعة إصلاح R12-SYN-1)
  try {
    db.transaction(() => logAudit(db, 'المزامنة', 'update', 'رفض وارد', `${doc.t} · ${doc.k} · ${redactForReport(reason)}`.slice(0, 300)));
  } catch (e) { if (isDbFault(e)) throw e; /* السجل لا يعطّل */ }
}

/** بنود محضر الاستلام والتسليم كما يكتبها updateHandover ونوعه · وما سواها (السلة ونقل الوحدة) يمضي بالحسم المعتاد */
const HANDOVER_FORM = ['type', 'employee_name', 'tenant_name', 'id_number', 'phone', 'address', 'unit_floor', 'contract_period',
  'date', 'other_notes', 'tenant_sign', 'company_sign', 'sections_json'] as const;
const handoverForm = (row: Record<string, unknown>): string => stable(HANDOVER_FORM.map((c) => {
  const v = row[c];
  if (c === 'sections_json' && typeof v === 'string') { try { return JSON.parse(v) as unknown; } catch { return v; } }
  return v ?? '';
}));

/**
 * أول ما عرف هذا الجهاز نسخته المقفلة من المحضر في السحابة (رفعها أو طبّقها) بساعة الخادم، وهل رفعها هو فأقفله هنا · لا يتقدّم بما
 * يمضي على المقفَل بعده (نقل الوحدة والسلة وإعادة الرفع للرؤية) فيُرتَّب به قفلان مختلفان (المراجعة الشاملة 2026-11-13 · E-1/R11-3:
 * وقت الصف ووقت الطابور كانا يتقدّمان بنقل الوحدة فيغلب الإقفالُ الثاني الأول) · ويبقى حتى يغلب قفلٌ آخر فيُستبدل
 */
const LOCK_SEEN = 'handover_lock:';
function lockSeen(db: DB, k: string): { at: string; own: boolean } | null {
  try {
    const o = JSON.parse(getSyncState(db, LOCK_SEEN + k) ?? 'null') as { at?: unknown; own?: unknown } | null;
    return o && typeof o.at === 'string' ? { at: o.at, own: o.own === true } : null;
  } catch { return null; }
}
function noteLockSeen(db: DB, k: string, at: string, own: boolean, replace: boolean): void {
  if (!replace && lockSeen(db, k)) return;
  setSyncState(db, LOCK_SEEN + k, JSON.stringify({ at: isoNorm(at), own }));
}

/**
 * المحضر المُقفَل نهائي والقفل باتجاهٍ واحد (المراجعة الشاملة 2026-11-13 · E-1 · قرار المالك س٢٩): حسم الصف كله بالأحدث كان يجعل
 * تعديلاً متأخراً من نسخةٍ غير مقفلة (جهازٌ بلا اتصال) يفتح القفل ويغيّر البنود على الأجهزة كلها · فالمقفلة تغلب غير المقفلة أياً كان
 * وقتها · وبين مقفلتين مختلفتين يغلب ما بلغ السحابة أولاً: قفلٌ هنا لم يُرفع بعد تعديلٌ متأخر لمحضرٍ أُقفل هناك، وقفلان رُفعا (سباق
 * الرفع) يُرتَّبان بأول ما عرفه كل جهاز (lockSeen) لا بوقت الصف · وقبل القفل الحسم المعتاد
 * act 'keep': يبقى ما هنا · 'take': يغلب الوارد ولو كان أقدم أو لهذا الجهاز تعديلٌ معلَّق · null: الحسم المعتاد
 * late: البنود مختلفة فالساقط تعديلٌ متأخر يُسجَّل مرفوضاً · وغير المقفلة ببنود المقفلة نفسها نسخةُ ما قبل القفل (نافذة أمان السحب
 * تعيدها) لا تعديل (E-1/R11-2) · at: وقت ما هنا يُعاد به إلى السحابة إن بقي
 */
function handoverLock(db: DB, doc: RemoteDoc, pending: OutRow | undefined, deviceId: string, joining: boolean): { act: 'keep' | 'take'; late: boolean; at?: string } | null {
  if (doc.t !== 'handovers' || doc.del || !doc.d) return null;
  const here = readRow(db, doc.t, doc.k);
  if (!here) return null;
  const mineLocked = Number(here.locked) === 1;
  const theirsLocked = Number(doc.d.locked) === 1;
  if (!mineLocked && !theirsLocked) return null;
  const differ = handoverForm(here) !== handoverForm(doc.d);
  if (!theirsLocked) return { act: 'keep', late: differ };
  // (ونسخة هذا الجهاز غير المقفلة بلا تعديلٍ معلَّق هي ما عرفه من السحابة: لا يسقط منه شيء · ولا بذرة الانضمام: ليست تعديلاً)
  if (!mineLocked) return { act: 'take', late: differ && !!pending && !joining };
  if (!differ) return null;
  const mine = lockSeen(db, doc.k)?.at
    ?? (pending ? undefined : db.get<{ u: string }>(`SELECT u FROM sync_rowtime WHERE tbl = ? AND pk = ?`, [doc.t, doc.k])?.u);
  if (!mine) return pending ? { act: 'take', late: true } : null;
  const order = isoCmp(mine, incomingAt(doc));
  return order < 0 || (order === 0 && deviceId < doc.dev) ? { act: 'keep', late: true, at: mine } : { act: 'take', late: true };
}

function applyOne(
  db: DB, doc: RemoteDoc, deviceId: string, cache: Map<string, Set<string>>, money: Map<string, string[]>, joining: boolean,
): ApplyOutcome {
  const t = syncTable(doc.t);
  if (!t) { reject(db, doc, 'جدول خارج المزامنة'); return 'rejected'; }
  // حذف رمز 3300 الذي أنشأه المستخدم (غير نظاميٍّ محذوف، أو شاهد حذفه) · حارسه أدناه
  const stale3300 = doc.t === 'accounts' && doc.k === ACC_OPENING_BALANCES
    && (doc.del || (!!doc.d && Number(doc.d.is_system) !== 1 && doc.d.deleted_at != null));
  // صدى ما كتبه هذا الجهاز · بمحتواه لا بمعرّف الجهاز وحده: العضو يكتب «dev» فينتحل الجهاز (مراجعة التثبيت #56) · إلا صدى حذفه رمز 3300
  // ولا تعديل له هنا لم يُرفع: الكاتب نفسه يمرّ بحارس 3300 كمن استقبل الحذف، فيحلّ محلّه حساب النظام عنده أيضاً ولا يفترق دفتره عن
  // أجهزة المنشأة (مراجعة R12-BAK-5: كان الحارس على المستقبِل وحده، فالجهاز الذي حذف يبقى بلا حساب النظام وأخوه عليه)
  if (doc.dev === deviceId && isEcho(db, doc, deviceId)
    && !(stale3300 && !db.get(`SELECT 1 FROM sync_outbox WHERE tbl = ? AND pk = ?`, [doc.t, doc.k]))) return 'skipped';
  // مفتاح الصف داخل المستند هو مفتاحه (المراجعة #20): وإلا استبدل مستندٌ صفاً آخر
  if (!doc.del && doc.d) {
    const want = pkParams(doc.t, doc.k);
    if (t.pkCols.some((c, i) => String((doc.d as Record<string, unknown>)[c] ?? '') !== want[i])) {
      reject(db, doc, 'مفتاح الصف لا يطابق مفتاح المستند'); // i18n-exempt: سببٌ يُخزَّن في سجل المرفوض كأسبابه الأخرى
      return 'rejected';
    }
    if (doc.t === 'journal_entries' && linesMalformed(doc)) {
      reject(db, doc, 'سطور القيد ليست سطوراً'); // i18n-exempt: سببٌ يُخزَّن في سجل المرفوض
      return 'rejected';
    }
    // سطور القيد الواردة لقيدها وحده: سطرٌ يحمل قيداً آخر يُدرَج في ذلك القيد (التحقق المستقل، نظير #20 للسطور)
    if (doc.t === 'journal_entries' && (doc.lines ?? []).some((l) => l.entry_id != null && String(l.entry_id) !== doc.k)) {
      reject(db, doc, 'سطرٌ لقيدٍ آخر في مستند القيد'); // i18n-exempt: سببٌ يُخزَّن في سجل المرفوض
      return 'rejected';
    }
    // بصمة الملف وامتداده يُبنى منهما مسار على هذا الجهاز (المراجعة #21) · والمرفق بصمته وحدها (امتداده في blobs)
    if ((doc.t === 'blobs' && !isSafeBlobName(doc.d.sha256, doc.d.ext))
      || (doc.t === 'attachments' && !isSafeBlobName(doc.d.sha256, 'bin'))) {
      reject(db, doc, 'اسم ملف غير آمن'); // i18n-exempt: سببٌ يُخزَّن في سجل المرفوض كأسبابه الأخرى
      return 'rejected';
    }
  }

  // حساب النظام 3300 «أرصدة افتتاحية» (الهجرة ٦٢ · A2.4 · قرار المالك س٢) يحلّ على كل جهاز محلّ رمزٍ 3300 أنشأه المستخدم ثم حذفه، والهجرة
  // لا ترفع شيئاً (R11-A2.4-3) · فمستند السحابة لذلك الرمز (غير نظاميٍّ محذوف، أو شاهد حذفه إن كُنس من السلة) قديمٌ أبداً: لا يُكتب فوق
  // حساب النظام الحيّ هنا (جوالٌ بدأ من السحابة بعد الترقية، أو جهازٌ ترقّى قبل صدى حذفه) · وحسابٌ غير نظاميٍّ هنا (ترقّى وهو حيّ) يصله
  // حذفه بلا سطر قيدٍ عليه يحلّ محلّه حساب النظام بقاعدة الهجرة نفسها · فأجهزة المنشأة كلها على دفترٍ واحد (المراجعة ١٢ · R12-BAK-5) ·
  // والجهاز الذي كتب الحذف (مالكاً أو عضواً) يمرّ هنا بصداه، فيتحوّل عند أول مزامنةٍ بعد الحذف كغيره، ولا يُرفع شيء (R11-A2.4-3)
  if (stale3300) {
    const here = db.get<{ s: number; del: string | null }>(`SELECT is_system AS s, deleted_at AS del FROM accounts WHERE code = ?`, [doc.k]);
    if (here && Number(here.s) === 1) return 'skipped';
    const sys = MIGRATED_SYSTEM_ACCOUNTS.find((a) => a.code === doc.k);
    if (sys && !db.get(`SELECT 1 FROM journal_lines WHERE account_code = ?`, [doc.k])) {
      db.run(`DELETE FROM accounts WHERE code = ? AND is_system = 0`, [doc.k]);
      db.run(`INSERT OR IGNORE INTO accounts (code, name, type, grp, opening_halalas, is_system, created_at) VALUES (?,?,?,?,0,1,?)`,
        [sys.code, sys.name, sys.type, sys.grp, nowIso()]);
      return 'applied';
    }
  }

  // القيد نفسه برقمٍ آخر في السحابة (استعادةٌ على جهازين بمعرّفٍ حتمي · المتحقق المستقل على bea2251): رقم المرحّل لا يتغير، فرقمه
  // في السحابة اسمٌ لرقمه هنا تُترجَم به حركات البنك المربوطة برقم القيد · ويُعرف قبل التعارض فمسار التعارض لا يفوته
  // والاسم من قيدٍ هو هو وحده: سطوره سطور القيد هنا، ورقمه ليس رقم قيدٍ آخر هنا (المدقق الخارجي Y٦: مستند عضوٍ بالمعرّف نفسه ورقم قيدٍ آخر
  // كان يعيد ربط حركات ذلك القيد بهذا قبل أي فحص) · وما رُفض «نهائياً» من نسخة هذا الجهاز للقيد نفسه ليس رفضاً (Y٥)
  if (doc.t === 'journal_entries' && doc.d && typeof doc.d.no === 'string') {
    const here = db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ? AND status = 'مرحّل'`, [doc.k]); // i18n-exempt: حالة القيد المخزّنة
    // (وبتاريخه نفسه: إلغاءان بتاريخين التقيا في المعرّف ليسا القيد نفسه · A٢-٦)
    const sameDate = String(db.get<{ d: string }>(`SELECT date AS d FROM journal_entries WHERE id = ?`, [doc.k])?.d ?? '').slice(0, 10) === String(doc.d.date ?? '').slice(0, 10);
    if (here && here.no !== doc.d.no && sameDate && !db.get(`SELECT 1 FROM journal_entries WHERE no = ? AND id != ?`, [doc.d.no, doc.k]) && sameEntryLines(db, doc)) {
      noteJournalNoAlias(db, doc.d.no, here.no);
      db.run(`DELETE FROM sync_rejects WHERE tbl = 'journal_entries' AND pk = ? AND reason = ?`, [doc.k, FINAL_IN_CLOUD]);
    }
  }

  // والإلغاء لا رجعة فيه (المدقق الخارجي Y١): نسخةٌ تُحيي دفعةً ملغاة هنا (اعتمادٌ على جهازٍ آخر بالمعرّفات نفسها بعد الإلغاء) لا تُطبَّق،
  // ويرفع جهاز المالك نسخته · والفاتورة «مدفوعة» بقيد تحصيلٍ معكوسٍ هنا كذلك (Y٢)
  // والتحصيل نهائيٌّ كذلك: مطالبةٌ محصَّلة هنا بقيدٍ حيّ لا تعود مفتوحةً ولا تُحذف ولا يتغيّر مبلغها، وفاتورةٌ مدفوعة هنا بقيدٍ حيّ لا تعود
  // مستحقة إلا بعكس قيدها (Z٢-٣ وZ٢-٤: نسخة عضوٍ بلا اتصال كانت تغلب التحصيل) · وصفّ الكشف أو سطره المنشأ ثانيةً بالمعرّف نفسه (قراءة
  // الكشف على جهازٍ آخر) لا يغلب الأقدم إنشاءً وما عُدّل فيه (Z١-٤: كان يمحو اعتماداً واستبعاداً)
  const keepLocal = (): boolean => {
    const d = (doc.d ?? {}) as Record<string, unknown>;
    if (doc.t === 'contract_payments' && !doc.del && d.cancelled_at == null) {
      return !!db.get(`SELECT 1 FROM contract_payments WHERE id = ? AND cancelled_at IS NOT NULL`, [doc.k]);
    }
    if (doc.t === 'invoices' && !doc.del && d.status === PAID_INVOICE && d.payment_journal_entry_id) {
      return !!db.get(`SELECT 1 FROM journal_entries WHERE id = ? AND reversed_by IS NOT NULL`, [String(d.payment_journal_entry_id)]);
    }
    if (doc.t === 'invoices' && (doc.del || d.status !== PAID_INVOICE)) {
      return !!db.get(`SELECT 1 FROM invoices v JOIN journal_entries e ON e.id = v.payment_journal_entry_id
        WHERE v.id = ? AND v.status = ? AND e.reversed_by IS NULL`, [doc.k, PAID_INVOICE]);
    }
    if (doc.t === 'claims') {
      const cur = db.get<{ a: number; del: string | null }>(`SELECT amount_halalas AS a, deleted_at AS del FROM claims WHERE id = ? AND status = ?
        AND EXISTS (SELECT 1 FROM journal_entries e WHERE e.src_type = 'claim_collect' AND e.src_id = claims.id AND e.reversed_by IS NULL)`, [doc.k, COLLECTED_CLAIM]);
      return !!cur && (doc.del || d.status !== COLLECTED_CLAIM || d.deleted_at != null || Number(d.amount_halalas) !== Number(cur.a));
    }
    if (doc.t === 'bank_statements' && !doc.del && d.created_at) {
      const cur = db.get<{ c: string }>(`SELECT created_at AS c FROM "${doc.t}" WHERE id = ?`, [doc.k]);
      return !!cur && String(d.created_at) > String(cur.c);
    }
    // وسطر الكشف: المطابَق أو المستبعَد هنا يغلب نسخةً واردة مفتوحة إلا أن تكون فكّاً له (السطر نفسه إنشاءً، عُدّل بعد مطابقته) ·
    // فقراءة الكشف على جهازٍ آخر قبل الاعتماد أو بعده لا تمحوه (Z١-٤ وA٢-٤ وB٢-٨)
    if (doc.t === 'bank_statement_lines' && !doc.del && d.deleted_at == null && d.status === 'open') {
      const cur = db.get<{ s: string; c: string; at: string | null; del: string | null }>(
        `SELECT status AS s, created_at AS c, matched_at AS at, deleted_at AS del FROM bank_statement_lines WHERE id = ?`, [doc.k]);
      return !!cur && cur.del == null && cur.s !== 'open' && !lineUndoes(String(d.created_at ?? ''), incomingAt(doc), cur.c, cur.at);
    }
    return false;
  };
  if (keepLocal()) {
    if (!getSyncState(db, 'membership')) enqueue(db, doc.t, doc.k, 'upsert');
    return 'conflict-local';
  }
  // ودفعةٌ تصل حيّةً وقيدها معكوسٌ هنا ملغاةٌ بعاكسه (Z١-١ وZ٢-٢: عضوٌ اعتمد الإيداع نفسه بعد إلغاء عضوٍ آخر فغلبت نسخته في السحابة) ·
  // تُصلح هنا ويرفعها جهاز المالك
  let repaired = false;
  // (وكذلك دفعةٌ ملغاة بعاكسٍ ليس عاكس قيدها هنا: إلغاءٌ ثانٍ من جهازٍ آخر بتاريخٍ آخر رُفض عاكسه هنا · A٢-٦)
  if (doc.t === 'contract_payments' && !doc.del && doc.d && doc.d.journal_entry_id) {
    const rev = db.get<{ id: string; date: string }>(`SELECT r.id, r.date FROM journal_entries e JOIN journal_entries r ON r.id = e.reversed_by WHERE e.id = ?`,
      [String(doc.d.journal_entry_id)]);
    if (rev && (doc.d.cancelled_at == null || String(doc.d.cancel_entry_id ?? '') !== rev.id)) {
      doc.d = { ...doc.d, cancelled_at: rev.date, cancel_entry_id: rev.id };
      repaired = true;
    }
  }
  // وعكس قيد مطالبةٍ محصَّلةٍ هنا أو قيدٌ ثانٍ لها من عضو (حذفها أو تعديل مبلغها على جهازٍ لم يعرف التحصيل · Z٢-٣) مرفوض: الذمة تبقى كما حُصّلت
  if (doc.t === 'journal_entries' && !doc.del && doc.d && !getSyncState(db, 'membership') && byMember(db, doc, true)
    && (doc.d.src_type === 'claim_rev' || doc.d.src_type === 'claim') && !db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [doc.k])
    && db.get(`SELECT 1 FROM claims c WHERE c.id = ? AND c.status = ? AND EXISTS (SELECT 1 FROM journal_entries e WHERE e.src_type = 'claim_collect'
         AND e.src_id = c.id AND e.reversed_by IS NULL)`, [String(doc.d.src_id ?? ''), COLLECTED_CLAIM])
    && (doc.d.src_type === 'claim_rev'
      || db.get(`SELECT 1 FROM journal_entries WHERE src_type = 'claim' AND src_id = ? AND reversed_by IS NULL`, [String(doc.d.src_id ?? '')]))) {
    reject(db, doc, tr('sync.collectedTwice', { lng: 'ar' }));
    return 'rejected';
  }
  // وفاتورةٌ يصل صفّها من عضوٍ «مدفوعة» بقيد تحصيلٍ ليس هنا: تنتظره إن كان في الوارد، وإلا (رُفض) تبقى كما هي هنا ويُرفع صفّها (A٢-١)
  if (doc.t === 'invoices' && !doc.del && doc.d?.status === PAID_INVOICE && doc.d.payment_journal_entry_id && !getSyncState(db, 'membership')
    && byMember(db, doc, true) && !db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [String(doc.d.payment_journal_entry_id)])) {
    if (db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ? AND del = 0`, [String(doc.d.payment_journal_entry_id)])) return 'retry';
    if (db.get(`SELECT 1 FROM invoices WHERE id = ?`, [doc.k])) enqueue(db, doc.t, doc.k, 'upsert');
    reject(db, doc, tr('sync.collectedTwice', { lng: 'ar' }));
    return 'rejected';
  }
  // ومطالبةٌ يصل صفّها «محصَّلة» من عضوٍ بلا قيد تحصيلٍ حيٍّ لها هنا: تنتظر قيدها إن كان في الوارد، وإلا (رُفض تحصيلاً ثانياً لإيداعٍ
  // واحد · Z٢-١) تبقى كما هي هنا ويُرفع صفّها
  if (doc.t === 'claims' && !doc.del && doc.d?.status === COLLECTED_CLAIM && !getSyncState(db, 'membership') && byMember(db, doc, true)
    && !db.get(`SELECT 1 FROM claims WHERE id = ? AND status = ?`, [doc.k, COLLECTED_CLAIM])
    && !db.get(`SELECT 1 FROM journal_entries WHERE src_type = 'claim_collect' AND src_id = ? AND reversed_by IS NULL AND status = ?`, [doc.k, POSTED_ENTRY])) {
    if (db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND del = 0 AND json_extract(payload, '$.d.src_type') = 'claim_collect'
         AND json_extract(payload, '$.d.src_id') = ?`, [doc.k])) return 'retry';
    if (db.get(`SELECT 1 FROM claims WHERE id = ?`, [doc.k])) enqueue(db, doc.t, doc.k, 'upsert');
    reject(db, doc, tr('sync.collectedTwice', { lng: 'ar' }));
    return 'rejected';
  }
  // وعاكس العضو لتحصيلٍ من الكشف لا يُقبل بلا عكس ماله: ينتظر حركات البنك السالبة برقمه هنا أو في الوارد (الإلغاء الحقيقي يكتبها)، فعاكسٌ
  // وحيد مزوَّر يُرفض بطول انتظاره ولا يُلغي الدفعة وإيداعها في البنك (B٢-٥) · وكذلك ربط أصله به، فالعاكس وأصله يُطبَّقان معاً
  if (doc.t === 'journal_entries' && !doc.del && doc.d && !getSyncState(db, 'membership') && byMember(db, doc, true)) {
    const d = doc.d;
    const pairOf = (origId: string, revId: string, revNo: string | null): boolean => {
      const orig = db.get<{ no: string; s: string | null }>(`SELECT no, stmt_line_id AS s FROM journal_entries WHERE id = ?`, [origId]);
      if (!orig?.s) return true;
      const txs = db.all<{ b: string; a: number }>(`SELECT bank_id AS b, amount_halalas AS a FROM bank_tx WHERE journal_no = ? AND deleted_at IS NULL`, [orig.no]);
      const no = revNo ?? db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ?`, [revId])?.no
        ?? String(JSON.parse(db.get<{ p: string }>(`SELECT payload AS p FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ?`, [revId])?.p ?? '{}')?.d?.no ?? '');
      const back = no ? txsOfNo(db, no) : [];
      return txs.every((t) => back.some((x) => x.bank === t.b && x.amount === -Number(t.a)));
    };
    if (typeof d.src_type === 'string' && d.src_type.endsWith('_rev') && !db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [doc.k])) {
      const origs = sourceReader(db).claimants(doc.k);
      if (origs.some((o) => !pairOf(o, doc.k, typeof d.no === 'string' ? d.no : null))) return 'retry';
    }
    if (d.reversed_by && db.get(`SELECT 1 FROM journal_entries WHERE id = ? AND reversed_by IS NULL AND stmt_line_id IS NOT NULL`, [doc.k])
      && !pairOf(doc.k, String(d.reversed_by), null)) return 'retry';
  }
  // والإيداع الواحد يسند تحصيلاً واحداً: قيدٌ حيٌّ من عضوٍ لسطر كشفٍ له هنا قيدٌ حيٌّ آخر مرفوض (Z٢-١: جهازان اعتمداه لهدفين مختلفين)
  // (والتحصيل القائم تحصيلٌ حقيقي من الإيداع: له حركةٌ في بنك السطر بمبلغه ويومه، فمعرّف سطرٍ مكتوبٌ على قيدٍ آخر لا يحجزه · B٢-١ وB٢-٢ ·
  // والسطر بالبصمة لا بالمعرّف: كشفٌ أُعيدت قراءته بسطرٍ جديد للإيداع نفسه · B٢-٤ · وقيدٌ عاكسه في الوارد ينتظر ولا يُرفض · A٢-٣ وB٢-٣)
  if (doc.t === 'journal_entries' && !doc.del && doc.d?.stmt_line_id && doc.d.reversed_by == null && !getSyncState(db, 'membership')
    && byMember(db, doc, true) && !db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [doc.k])) {
    const held = liveDepositCollection(db, String(doc.d.stmt_line_id), doc.k);
    if (held === 'pending') return 'retry';
    if (held) { reject(db, doc, tr('sync.collectedTwice', { lng: 'ar' })); return 'rejected'; }
  }
  // والتحصيل الثاني الحيّ للمطالبة نفسها أو الفاتورة نفسها من عضوٍ مرفوض (Z٢-٦: تحصيلان بطريقتين على جهازين كانا ينتظر كلٌّ منهما الآخر)
  if (doc.t === 'journal_entries' && !doc.del && doc.d && !getSyncState(db, 'membership') && byMember(db, doc, true)
    && (doc.d.src_type === 'claim_collect' || doc.d.src_type === 'invoice_pay') && doc.d.reversed_by == null
    && !db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [doc.k])) {
    const live = db.all<{ id: string; no: string }>(`SELECT id, no FROM journal_entries WHERE src_type = ? AND src_id = ? AND id != ? AND reversed_by IS NULL AND status = ?`,
      [String(doc.d.src_type), String(doc.d.src_id ?? ''), doc.k, POSTED_ENTRY]);
    if (live.some((e) => reversalPending(db, e.id, String(doc.d!.src_type), String(doc.d!.src_id ?? '')))) return 'retry';
    if (live.length) { reject(db, doc, tr('sync.collectedTwice', { lng: 'ar' })); return 'rejected'; }
  }

  const cols = (name: string) => {
    let s = cache.get(name);
    if (!s) { s = columnsOf(db, name); cache.set(name, s); }
    return s;
  };

  // عقارات المستأجر المشترك كما في السحابة لكل وارد، ولو غلب بعده التعديل المحلي: يرفع المحصور اتحادها بعقاراته فلا يُسقط
  // عقاراً لا يعرفه (التحقق المستقل)
  if (doc.t === 'tenants' && !doc.del && doc.pids?.length) {
    db.run(`INSERT INTO sync_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [TENANT_PIDS + doc.k, JSON.stringify(doc.pids)]);
  }
  // التعارض على مستوى الصف · الأحدث تغييراً يغلب
  const pending = db.get<OutRow>(`SELECT tbl, pk, op, changed_at FROM sync_outbox WHERE tbl = ? AND pk = ?`, [doc.t, doc.k]);
  // والمحضر المُقفَل لا يُفتح ولا يغلبه تعديلٌ متأخر (E-1 · س٢٩): الوارد المرفوض في سجل المرفوض فيظهر في «حالة المزامنة»، وتُرفع
  // النسخة المقفلة بوقتها فتعود إلى السحابة · وما يغلبه القفل الوارد من تعديلٍ معلَّق هنا أو قفلٍ لاحق يُسجَّل مرفوضاً كذلك ·
  // والتصحيح بعد القفل بنموذجٍ تصحيحي منفصل
  const lock = handoverLock(db, doc, pending, deviceId, joining);
  /** نسخة هذا الجهاز التي يُسقطها القفل الوارد · تُسجَّل مرفوضةً بعد أن يُطبَّق */
  let dropped: RemoteDoc | null = null;
  if (lock) {
    const seen = db.get<{ u: string }>(`SELECT u FROM sync_rowtime WHERE tbl = ? AND pk = ?`, [doc.t, doc.k])?.u;
    if (lock.act === 'keep') {
      // يرفعها جهاز المالك، وجهاز العضو إن كان هو مُقفلها فرفع قفله (E-1/R11-1: قفل المندوب يكتب فوقه في السحابة رفعٌ متسابق من
      // جوال المالك فلا يعرفه المالك ليعيده، ولا كان العضو يعيده فيبقى مقفلاً عنده وحده)
      if (!pending && (!getSyncState(db, 'membership') || lockSeen(db, doc.k)?.own)) enqueue(db, doc.t, doc.k, 'upsert', lock.at ?? seen);
      if (!lock.late) return 'conflict-local';
      reject(db, doc, tr('sync.handoverLocked', { lng: 'ar' }));
      return 'rejected';
    }
    if (lock.late) dropped = buildDoc(db, doc.t, doc.k, 'upsert', pending?.changed_at ?? (seen ? fromServerClock(db, seen) : nowIso()), deviceId);
  }
  let conflict: 'conflict-remote' | null = null;
  // ما يُبقيه جهاز المالك من قيمه في الصف الوارد (الافتتاحي وإعداد المالك) فيُعاد الصف مدموجاً إلى السحابة
  let keepOwnerValue = false;
  // افتتاحيّ السحابة كما وصل (قبل أن يُبقي جهاز المالك افتتاحيّه) · يُذكر بعد التطبيق
  const cloudOpening = OPENING_TABLES.has(doc.t) && doc.d && !doc.del ? Number(doc.d.opening_halalas) || 0 : null;
  if (pending) {
    const localDoc = buildDoc(db, doc.t, doc.k, pending.op, pending.changed_at, deviceId);
    if (sameContent(localDoc, doc)) {
      db.run(`DELETE FROM sync_outbox WHERE tbl = ? AND pk = ?`, [doc.t, doc.k]); // الطرفان متفقان
      return 'skipped';
    }
    // الطرفان بساعة الخادم: تعديل هذا الجهاز مصحَّحاً بفرق ساعته، والوارد مكتوب مصحَّحاً من جهازه
    const mine = toServerClock(db, pending.changed_at);
    // الوقت الوارد لا يتجاوز وقت كتابته في الخادم: «u» يكتبه الجهاز فيقدّمه العضو ليغلب كل تعارض (مراجعة التثبيت #56)
    const theirs = doc.ts && isoCmp(doc.ts, doc.u) < 0 ? doc.ts : doc.u;
    // باللحظة لا بالنص (المراجعة الشاملة · البند ١٦): «…00.995Z» أحدث من «…00.99Z» ونصّه أصغر
    const order = isoCmp(mine, theirs);
    // وتصحيح سطر الكشف الذي رفعه جهاز المالك (إحياءٌ أو حذفٌ تبعاً لكشفه) يغلبه أي تعديلٍ حقيقي وارد ولو تساوى الوقت (المدقق الخارجي Y٧)
    const correction = doc.t === 'bank_statement_lines' && stmtFixes(db).get(doc.k) === pending.changed_at;
    // والأقدم إنشاءً من صفّ الكشف أو سطره يغلب ما أُنشئ ثانيةً هنا بالمعرّف نفسه (Z١-٤)
    const recreated = doc.t === 'bank_statements' && !doc.del && doc.d?.created_at != null
      && String(doc.d.created_at) < String(db.get<{ c: string }>(`SELECT created_at AS c FROM "${doc.t}" WHERE id = ?`, [doc.k])?.c ?? '');
    // والسطر الوارد مطابَقاً أو مستبعَداً يغلب نسخته هنا المفتوحة إلا أن تكون فكّاً له (A٢-٤ وB٢-٨)
    const lineHere = doc.t === 'bank_statement_lines' && !doc.del && doc.d && doc.d.deleted_at == null && doc.d.status !== 'open'
      ? db.get<{ s: string; c: string }>(`SELECT status AS s, created_at AS c FROM bank_statement_lines WHERE id = ? AND deleted_at IS NULL`, [doc.k]) : undefined;
    const advanced = !!lineHere && lineHere.s === 'open'
      && !lineUndoes(lineHere.c, toServerClock(db, pending.changed_at), String(doc.d!.created_at ?? ''), (doc.d!.matched_at as string | null) ?? null);
    // والعكس نهائي: القيد الوارد معكوساً يغلب نسخته هنا بلا عاكس (Z١-١: جهازٌ اعتمد الإيداع نفسه بعد إلغاء غيره كان يبقى قيده بلا عاكسه)
    const reversed = doc.t === 'journal_entries' && !doc.del && doc.d?.reversed_by != null
      && !db.get<{ r: string | null }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [doc.k])?.r;
    const localWins = !joining && !correction && !recreated && !reversed && !advanced && lock?.act !== 'take' && (order > 0 || (order === 0 && deviceId > doc.dev));
    if (localWins) {
      // والافتتاحي للمالك وحده (openingKept): جهاز العضو يأخذه من الوارد ولو غلب تعديله، فتحمله نسخته المرفوعة كما في السحابة
      // (المدقق الخارجي Q٢: كان يبقى بالافتتاحي القديم فتُرفض كل تسميةٍ منه ويخطئ رصيد البنك عنده)
      adoptCloudOpening(db, doc);
      adoptOwnerCols(db, doc);
      logAudit(db, 'المزامنة', 'update', 'تعارض مزامنة', `${doc.t} · ${doc.k} · غلب تعديل هذا الجهاز (${mine}) على الوارد (${doc.u})`);
      return 'conflict-local';
    }
    conflict = 'conflict-remote';
    // وجهاز المالك: تعديل افتتاحيّه المعلَّق يبقى ولو غلب الوارد من عضوٍ بقية الصف، ويُعاد إلى السحابة (المدقق الخارجي Q١: كان يضيع
    // تعديل المالك من جهازه ومن السحابة إن سمّى عضوٌ الصفّ بعده وقتاً)
    // (لا في الانضمام: المعلَّق حينها الدليل المزروع لا تعديل المالك)
    if (!joining && OPENING_TABLES.has(doc.t) && doc.d && !doc.del && !getSyncState(db, 'membership') && byMember(db, doc, false)
      && openingChangedHere(db, doc.t, doc.k, true)) {
      const mineOpening = db.get<{ o: number }>(`SELECT opening_halalas AS o FROM "${doc.t}" WHERE ${doc.t === 'accounts' ? 'code' : 'id'} = ?`, [doc.k]);
      if (mineOpening) { doc.d = { ...doc.d, opening_halalas: Number(mineOpening.o) || 0 }; keepOwnerValue = true; }
    }
    // وإعداد المالك في صفّ المنشأة كذلك (المراجعة الشاملة 2026-11-13 · B-3 · المدقق المستقل R11-B3-1): تعديله المعلَّق هنا يبقى ولو
    // غلب الوارد من عضوٍ بقية الصف، ويُطبَّق الباقي ويُعاد الصف مدموجاً · كان الصف كله يُرفض (ownerColsIssue) فيضيع تعديل العضو المشروع
    // لاسم المنشأة · ونسخة عضوٍ بقيمةٍ مزوَّرة لا تغلب هنا على حالٍ، فقيمة المالك هي الباقية
    if (!joining && OWNER_ONLY_COLS[doc.t] && doc.d && !doc.del && !getSyncState(db, 'membership') && byMember(db, doc, false)) {
      const mineRow = readRow(db, doc.t, doc.k);
      const kept = mineRow ? OWNER_ONLY_COLS[doc.t].filter((c) => c in doc.d! && c in mineRow && String(doc.d![c] ?? '') !== String(mineRow[c] ?? '')) : [];
      if (kept.length) { doc.d = { ...doc.d, ...Object.fromEntries(kept.map((c) => [c, mineRow![c]])) }; keepOwnerValue = true; }
    }
  }
  // الوقت الوارد لا يتجاوز وقت كتابته في الخادم (#56)
  const theirs0 = incomingAt(doc);
  // ولا طابور: الوارد أقدم مما عرفه الجهاز للصف (رفعه أو طبّقه) لا يكتب فوقه، ويُرفع ما عنده فيتفق الأجهزة (المراجعة الخارجية ٧ ·
  // النتيجة ٨: دورة جهازٍ سحبت قبل تعديل غيره ودفعت بعده فكان الأقدم يغلب بلا أثر) · وأول دورةٍ للجهاز ما في الحساب يغلب
  // (والقفل الوارد يغلب ولو كان أقدم مما عرفه الجهاز · E-1)
  if (!pending && !joining && !t.appendOnly && lock?.act !== 'take') {
    const seen = db.get<{ u: string }>(`SELECT u FROM sync_rowtime WHERE tbl = ? AND pk = ?`, [doc.t, doc.k])?.u;
    if (seen && isoCmp(theirs0, seen) < 0) {
      adoptCloudOpening(db, doc);
      // بوقت النسخة المعروفة لا بوقت الآن (المراجعة الشاملة · البند ١٣): إعادة التأكيد لا تجعل النسخة أحدث مما هي، فلا تغلب تعديلاً
      // أحدث منها من جهازٍ آخر يصل بعدها في الدفعة نفسها أو بعدها
      enqueue(db, doc.t, doc.k, readRow(db, doc.t, doc.k) ? 'upsert' : 'delete', seen);
      logAudit(db, 'المزامنة', 'update', 'تعارض مزامنة', // i18n-exempt: وحدة السجل ونوعه المخزّنان
        tr('sync.olderIncoming', { t: doc.t, k: doc.k, seen, theirs: theirs0, lng: 'ar' }));
      return 'conflict-local';
    }
  }

  // وأحداث الأصل لا يحذفها التطبيق ولا يعدّلها (المدقق الخارجي هـ٥: عضوٌ يحذف حدث النقل ويعكس قيده في دفعةٍ واحدة كان يتخطى حارس العكس
  // فيُقبل بعده إهلاكٌ بالوحدة القديمة) · فحذف العضو أو تعديله لحدثٍ قائم يُرفض على جهاز المالك
  if (doc.t === 'asset_events' && !getSyncState(db, 'membership') && (doc.del ? doc.dby !== ownerUid(db) : byMember(db, doc, true))) {
    const cur = db.get<Record<string, unknown>>(`SELECT asset_id, kind, date, entry_id, from_unit_id, to_unit_id FROM asset_events WHERE id = ?`, [doc.k]);
    const changed = cur && !doc.del && ['asset_id', 'kind', 'date', 'entry_id', 'from_unit_id', 'to_unit_id']
      .some((c) => String(cur[c] ?? '') !== String((doc.d as Record<string, unknown> | undefined)?.[c] ?? ''));
    if (cur && (doc.del || changed)) {
      // ونسخة المالك تُعاد إلى السحابة فلا تبقى محذوفةً أو معدَّلةً فيها
      enqueue(db, doc.t, doc.k, 'upsert');
      reject(db, doc, tr('sync.assetEventLocked', { lng: 'ar' }));
      return 'rejected';
    }
  }

  // والرصيد الافتتاحي للبنك ولحسابات الدليل يضعه المالك وحده (المدقق الخارجي I١ وM٧ · القاعدة ٩٩)، وحارسه قاعدة السحابة (openingKept في
  // rulesGen.ts): العضو ينشئ بافتتاحيٍّ صفر ويحمل في كل تعديلٍ افتتاحيّ النسخة السابقة كما هو · فافتتاحيّ نسخة العضو افتتاحيّ المالك
  // الأخير، ويُطبَّق كما هو كما يُوثق بكاتبها (op وby) · وكان جهاز المالك يقارنه بما عنده فيرفضه أو يصفّره ثم يعيد نسخته، فجهازٌ لم يرَ
  // افتتاحيّ المالك بعد (غائبٌ عن الشبكة أو هاتفٌ بديل) يمحوه من السحابة ومن أجهزته كلها (المدقق الخارجي O٥)
  // والحساب النظامي أو المستعمل في قيد (هنا أو في الوارد) لا يغيّر العضو نوعه ولا يحذفه، ولا مجموعة حسابٍ ولا كونه نظامياً (التطبيق لا
  // يغيّرهما) · كما يمنعه saveAccount وdeleteBlocker (O١: نوع 1100 «خصم» أو حذفه الناعم كان يُدخل المحفظة مالاً بلا قيد) · فتُعاد
  // نسخة هذا الجهاز وفيها افتتاحيّ نسخة العضو، فلا تمحو إعادتُها افتتاحياً لم يصل هذا الجهاز بعد
  if (doc.t === 'accounts' && !doc.del && !getSyncState(db, 'membership') && byMember(db, doc, false)) {
    const d = (doc.d ?? {}) as Record<string, unknown>;
    const cur = db.get<{ type: string; grp: string | null; s: number; del: string | null }>(
      `SELECT type, grp, is_system AS s, deleted_at AS del FROM accounts WHERE code = ?`, [doc.k]);
    const locked = !!cur && (Number(cur.s) === 1 || accountUsed(db, doc.k));
    const forged = cur
      ? String(d.grp ?? '') !== String(cur.grp ?? '') || (Number(d.is_system) || 0) !== (Number(cur.s) || 0)
        || (locked && (String(d.type ?? '') !== cur.type || (d.deleted_at == null) !== (cur.del == null)))
      : (Number(d.is_system) || 0) !== 0;
    if (forged) {
      if (cur) {
        // إلا أن يكون للصف تعديلٌ معلَّق هنا: افتتاحيّه أحدث (المدقق الخارجي Q١ب)
        if (!openingChangedHere(db, doc.t, doc.k, !!db.get(`SELECT 1 FROM sync_outbox WHERE tbl = ? AND pk = ?`, [doc.t, doc.k]))) {
          db.run(`UPDATE accounts SET opening_halalas = ? WHERE code = ?`, [Number(d.opening_halalas) || 0, doc.k]);
          noteSeenOpening(db, doc.t, doc.k, d.opening_halalas);
        }
        enqueue(db, doc.t, doc.k, 'upsert');
      }
      reject(db, doc, tr('sync.accountLocked', { lng: 'ar' }));
      return 'rejected';
    }
  }
  // وافتتاحي البنك في الدفتر منذ الهجرة ٦٢ (مدين 1100 ودائن 3300 من البنوك الحية): حذف العضو بنكاً افتتاحيه غير صفر أو استعادته من السلة
  // يغيّر المال بلا قيد، والافتتاحي للمالك وحده (القاعدة ٩٩ · I١ وM٧ وO٥، وكحذف الحساب النظامي في O١) · فيُرفض على جهاز المالك وتُعاد
  // نسخته وفيها افتتاحيّ نسخة العضو كفرع الحساب أعلاه (المراجعة الشاملة 2026-11-13 · R11-A2.4-2)
  if (doc.t === 'banks' && !getSyncState(db, 'membership') && (doc.del ? doc.dby !== ownerUid(db) : byMember(db, doc, false))) {
    const d = (doc.d ?? {}) as Record<string, unknown>;
    const cur = db.get<{ o: number; del: string | null }>(`SELECT opening_halalas AS o, deleted_at AS del FROM banks WHERE id = ?`, [doc.k]);
    const moved = !!cur && (doc.del ? cur.del == null : (d.deleted_at == null) !== (cur.del == null));
    if (cur && moved && ((Number(cur.o) || 0) !== 0 || (Number(d.opening_halalas) || 0) !== 0)) {
      if (doc.d && !openingChangedHere(db, doc.t, doc.k, !!db.get(`SELECT 1 FROM sync_outbox WHERE tbl = ? AND pk = ?`, [doc.t, doc.k]))) {
        db.run(`UPDATE banks SET opening_halalas = ? WHERE id = ?`, [Number(d.opening_halalas) || 0, doc.k]);
        noteSeenOpening(db, doc.t, doc.k, d.opening_halalas);
      }
      enqueue(db, doc.t, doc.k, 'upsert');
      reject(db, doc, tr('sync.bankOpeningLocked', { lng: 'ar' }));
      return 'rejected';
    }
  }

  // الأب المقفل (الفاتورة الصادرة وسطورها، وأقساط العقد المؤكَّد · المراجعة الشاملة 2026-11-13 · B-1) وإعداد المالك في صفّ المنشأة (B-3):
  // كتابة العضو تُرفض وتُعاد نسخة المالك إلى الطابور (وما ليس عنده شاهدُ حذف) فتعود السحابة وكل جهازٍ إليها، ويظهر الرفض في حالة المزامنة
  const lockedWhy = lockedParentIssue(db, doc) || ownerColsIssue(db, doc) || bankShortFollowerIssue(db, doc);
  // (وما في طريقه إليه قيدٌ أو تأكيدٌ أو جدولٌ في الوارد ينتظر كالأب الناقص)
  if (lockedWhy === LOCK_AWAIT) return 'retry';
  if (lockedWhy) {
    enqueue(db, doc.t, doc.k, 'upsert');
    reject(db, doc, lockedWhy);
    return 'rejected';
  }

  if (doc.del && doc.t === 'contract_installments' && !getSyncState(db, 'membership') && doc.dby !== ownerUid(db)) {
    const c = db.get<{ s: string }>(`SELECT c.status AS s FROM contract_installments i JOIN contracts c ON c.id = i.contract_id WHERE i.id = ?`, [doc.k]);
    // مسودة العقد تُستبدل أقساطها فتُحذف · وأقساط المؤكَّد تبقى (قرار المالك 2026-10-15 «٨» · المتحقق المستقل، الجولة ٣٦)
    if (c && c.s !== DRAFT_CONTRACT) {
      enqueue(db, doc.t, doc.k, 'upsert');
      reject(db, doc, tr('derive.installmentDelete', { lng: 'ar' }));
      return 'rejected';
    }
  }

  // وتسوية تأمينٍ رُحِّل إلى التجديد من عضو (المراجعة الشاملة 2026-11-13 · R12-DEP-1 · مرآة carryAfterSettle): صفّ التسوية لعقدٍ له
  // قيد ترحيلٍ حيٌّ هنا لخلفه يُرفض كقيود تسويته (deriveSources: settleAfterCarry)، فلا يبدو العقد مُسوّى بلا قيد ولا يُردّ التأمين مرتين ·
  // ونسخة المالك تُعاد إن كانت له هنا تسوية (قرارا المالك ٦٢ و٦٣: دفاتر المالك تغلب ويظهر الرفض في حالة المزامنة)
  if (doc.t === 'deposit_settlements' && !doc.del && doc.d && !joining && !getSyncState(db, 'membership') && byMember(db, doc, true)
    && carriedOnHere(db, doc.k)) {
    const cur = db.get<Record<string, unknown>>(`SELECT * FROM deposit_settlements WHERE contract_id = ?`, [doc.k]);
    const d = doc.d;
    const same = !!cur && ['date', 'deduction_halalas', 'refund_halalas'].every((c) => String(cur[c] ?? '') === String(d[c] ?? ''));
    if (!same) {
      if (cur) enqueue(db, doc.t, doc.k, 'upsert');
      reject(db, doc, tr('sync.settleAfterCarry', { lng: 'ar' }));
      return 'rejected';
    }
  }
  // ومطالبة زيادة تلك التسوية (applyDepositSettlement: مصدرها «تسوية تأمين») جزءٌ منها تُرفض معها، فلا تبقى على العقد ذمةً لتسويةٍ
  // مرفوضة يطالَب بها المستأجر في كشفه وتنشأ ثانيةً حين يُسوّى المجدَّد (المراجع المعاكس على R12-DEP-1) · والقائمة هنا قبلها تمرّ كما هي
  if (doc.t === 'claims' && !doc.del && doc.d && !joining && !getSyncState(db, 'membership') && byMember(db, doc, true)
    && doc.d.source === SETTLEMENT_CLAIM_SOURCE && doc.d.contract_id != null && !db.get(`SELECT 1 FROM claims WHERE id = ?`, [doc.k])
    && carriedOnHere(db, String(doc.d.contract_id))) {
    reject(db, doc, tr('sync.settleAfterCarry', { lng: 'ar' }));
    return 'rejected';
  }
  // وتأمين العقد المجدَّد بقدر ما يحتجزه له الدفتر حين رُفض ترحيله (R12-DEP-1 · deadCarryDeposit): يُطبَّق الصف به ويُرفع
  let deadCarry: { want: number; was: Record<string, unknown> } | null = null;
  if (doc.t === 'contracts' && !doc.del && doc.d && !joining) {
    const want = deadCarryDeposit(db, doc.k, doc.d);
    if (want !== null && want !== Number(doc.d.deposit_halalas)) {
      deadCarry = { want, was: doc.d };
      doc.d = { ...doc.d, deposit_halalas: want };
    }
  }

  // سطر كشفٍ صُحّحت مطابقته هنا يُعاد إلى السحابة مصحَّحاً (وما أبقى فيه هذا الجهاز مطابقته يرفعه تعديلاً منه لا تصحيحاً)
  let relink = false;
  let relinkOwn = false;
  try {
    db.transaction(() => {
      if (doc.del) {
        if (t.appendOnly) throw new Error('سجل لا يُحذف');
        // وحذف حركة بنكٍ حيّة نهائياً بأثره كحذفها إلى السلة (التطبيق لا يحذف نهائياً إلا ما في السلة)
        if (doc.t === 'bank_tx') memberBankTxCheck(db, doc, null);
        try { deleteRow(db, doc.t, doc.k); } catch (e) {
          if (!isMissingParent(errText(e))) throw e;
          // حذفٌ له هنا أبناء يُسلسل من المالك وحده، بحاذفه (المراجعة الخارجية ٧ · النتيجة ٢ · قرار المالك «رابعاً ٢»): حذف العضو
          // كان يفكّ العقد عن وحدته ويحذف الحجز ويعيد نشرهما للمنشأة كلها · وشاهدٌ بلا حاذف لا يُسلسل (إنشاء شاهد حذفٍ لصفٍّ ليس
          // في السحابة لا تفحص القواعد حاذفه، فكلفته على إنشاء العضو فوق ميزانية القواعد)
          if (doc.dby !== ownerUid(db)) throw new Error(tr('sync.cascadeNotOwner', { lng: 'ar' }));
          // ولابنٍ نسخةٌ واردة لم تُطبَّق بعد: يُفكّ هنا وحده لتعيد ربطه، أو يُطبَّق أولاً ويعود الحذف (المراجعة الشاملة · البند ١)
          deleteOverChildren(db, doc.t, doc.k, theirs0, joining);
        }
      } else if (doc.t === 'journal_entries') {
        applyJournal(db, doc, { e: cols('journal_entries'), l: cols('journal_lines') });
      } else if (t.appendOnly) {
        const keys = Object.keys(doc.d!).filter((c) => cols(doc.t).has(c));
        db.run(`INSERT OR IGNORE INTO "${doc.t}" (${keys.map((c) => `"${c}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
          keys.map((c) => doc.d![c] as SqlValue));
      } else {
        // ما أرسله جهازٌ بإصدار أقدم من مسدَّدٍ وحالة يُترك · فهما يُحسبان هنا بعد التطبيق
        const row = stripDerived(doc.t, doc.d!);
        if (doc.t === 'purchases') renumberJoiningCollision(db, 'purchases', doc.k, row.no);
        collectionRowCheck(db, doc, row);
        assetBasisCheck(db, doc, row);
        // وصفّ فاتورة الشراء «قابلة للخصم» من عضوٍ والمنشأة غير مسجّلة (المدقق الخارجي ض١): الإقرار يقرأ الوضع المخزّن، فلا يُطبَّق
        if (doc.t === 'purchases' && !getSyncState(db, 'membership') && byMember(db, doc, true) && row.tax_status === TS_DEDUCTIBLE
          && deductibleIssue(db, doc.k)) throw new Error(tr('deriveSrc.rejected', { source: 'purchases', why: tr('deriveSrc.notRegistered', { lng: 'ar' }), lng: 'ar' }));
        // حركة البنك برقم قيدها على هذا الجهاز (noteJournalNoAlias)
        // ويُفحص كل صفّ حركة، برقم قيده نصاً (كان رقمٌ غير نصيٍّ يتخطى الفحص)
        if (doc.t === 'bank_tx') {
          row.journal_no = row.journal_no == null ? '' : String(row.journal_no);
          const alias = noAliases(db)[row.journal_no as string];
          if (alias) row.journal_no = alias;
          memberBankTxCheck(db, doc, row);
        }
        if (doc.t === 'bank_statement_lines') { const c = statementLineCheck(db, row, !getSyncState(db, 'membership') && byMember(db, doc, true)); relink = c.changed && (c.own || !getSyncState(db, 'membership')); relinkOwn = c.own; }
        const fresh = doc.t === 'contracts' && !db.get(`SELECT 1 FROM contracts WHERE id = ?`, [doc.k]);
        noteViaMember(db, doc, row);
        noteInvoiceIssued(db, doc, row);
        upsertRow(db, doc.t, row, cols(doc.t));
        if (doc.t === 'contracts') keepUnknownOriginalEnd(db, doc.k, row, fresh);
        if (deadCarry) noteDeadCarry(db, doc.k, deadCarry.was, deadCarry.want);
        if (doc.t === 'bank_statements') { resetStatementCounts(db, doc.k); statementCascade(db, doc.k, row, theirs0); }
      }
      if (!doc.del) {
        // فحص الاستعادة نفسه على ما كُتب للتو · إخفاقه يُرجع نقطة الحفظ كلها ·
        // ومسدَّد القسط الذي يمسّه الصف يُحسب قبل الفحص لا بعد الوارد كله: خصمٌ وصل على قسطٍ سُدّد من
        // جهاز آخر يُقرأ مع مسدَّدٍ محدود بمبلغه ناقصاً الخصم، لا مع رقمٍ مخزَّن قبل وصوله (وجده الاختبار العشوائي)
        const scope = scopeOf(db, doc);
        const insts = new Set(scope.installmentIds ?? []);
        if (doc.t === 'contract_payments') for (const i of installmentsOfPayment(db, doc.k)) insts.add(i);
        // ويُترك الحساب إن أخرج قسطاً مختلّاً (دفعة سالبة أو خصم فوق المبلغ) · فيسمّي الفحص العلّة بنص الاستعادة
        if (insts.size) {
          try {
            db.transaction(() => {
              recomputeInstallments(db, [...insts]);
              if (db.get(`SELECT 1 FROM contract_installments WHERE id IN (SELECT value FROM json_each(?)) AND paid_halalas < 0`, [JSON.stringify([...insts])]))
                throw new Error('مسدَّد سالب');
            });
          } catch (e) { if (isDbFault(e)) throw e; /* المخزَّن كما هو */ }
        }
        const issues = semanticIssues(db, scope, money);
        if (issues.length) throw new Error('الوارد مرفوض · ' + issues.join(' · '));
      }
      if (pending) db.run(`DELETE FROM sync_outbox WHERE tbl = ? AND pk = ?`, [doc.t, doc.k]);
      if (keepOwnerValue || (repaired && !getSyncState(db, 'membership'))) enqueue(db, doc.t, doc.k, 'upsert');
      if (relink && relinkOwn) enqueue(db, doc.t, doc.k, 'upsert');
      // (بوقت النسخة الواردة لا بوقت الآن: تعديلٌ حقيقي للعضو بعدها يغلب التصحيح · المدقق الخارجي G٢-٧ كـY٧)
      else if (relink) enqueueStmtFix(db, doc.k, theirs0);
      if (conflict) {
        logAudit(db, 'المزامنة', 'update', 'تعارض مزامنة', joining
          ? `${doc.t} · ${doc.k} · غلب ما في الحساب على نسخة هذا الجهاز عند انضمامه`
          : `${doc.t} · ${doc.k} · غلب الوارد (${doc.u}) على تعديل هذا الجهاز (${pending!.changed_at})`);
      }
    });
    noteRowTime(db, doc.t, doc.k, theirs0);
    if (cloudOpening !== null) noteSeenOpening(db, doc.t, doc.k, cloudOpening);
    // والقفل الوارد أول ما عرفه الجهاز في السحابة · ويستبدل ما قبله إن غلب (E-1/R11-3)
    if (doc.t === 'handovers' && !doc.del && Number(doc.d?.locked) === 1) noteLockSeen(db, doc.k, theirs0, false, lock?.act === 'take');
    if (dropped) reject(db, dropped, tr('sync.handoverLocked', { lng: 'ar' }));
    return conflict ?? 'applied';
  } catch (e) {
    // عطل القاعدة لا المستند (قرصٌ ممتلئ، خطأ إدخال وإخراج، معاملةٌ ألغتها SQLite بنفسها) لا يُرفض به المستند: يُرمى فتُلغى الصفحة كلها
    // ويبقى ما فيها في الصندوق للدورة التالية · وإلا كُتب رفضه وحُذف من الصندوق خارج أي معاملة فضاع إلى الأبد (R12-SYN-1)
    if (isDbFault(e)) throw e;
    const msg = errText(e);
    if (isMissingParent(msg) || e instanceof AwaitOriginal || e instanceof AwaitChildren || uniqueHolderLeaving(db, doc, msg)) return 'retry';
    reject(db, doc, msg);
    return 'rejected';
  }
}

type FkRow = { table: string; from: string; to: string | null };

/**
 * ما ينتظره المستند بمفاتيحه الأجنبية · مفاتيح جدوله، وللقيد مفاتيح سطوره كما يُدرجها applyJournal (الحساب account_code، وأي مفتاحٍ
 * أجنبي يُضاف إليها كمراكز التكلفة) لا جدوله وحده (المراجعة الشاملة · البند ١٤ · المراجعة الأخيرة: مفتاحه الوحيد reversed_by، فقيدٌ انتظر حساباً
 * في سطوره لم يكن يعود أبداً) · والقيد لا ينتظر قيداً: عاكسه يُربط معلّقاً حتى يصل (linkReversal)، والسطر لقيده نفسه
 */
/** قيمةٌ لا يصل أصلها أبداً (مفتاحٌ ليس قيمة) */
const NEVER = '\u0000never';
function awaitedRefs(doc: RemoteDoc, fkOf: (t: string) => FkRow[]): Array<{ table: string; to: string; value: SqlValue }> {
  const out: Array<{ table: string; to: string; value: SqlValue }> = [];
  const add = (table: string, row: RowData) => {
    for (const k of fkOf(table)) {
      if ((table === 'journal_entries' || table === 'journal_lines') && k.table === 'journal_entries') continue;
      const v = row[k.from];
      if (v == null || v === '') continue;
      // ومفتاحٌ ليس قيمةً لا يصل أصله أبداً: يُعدّ منتظراً فلا يُربط في استعلام (G · M١)
      out.push({ table: k.table, to: k.to ?? syncTable(k.table)?.pkCols[0] ?? 'id', value: scalar(v) ? v : (NEVER as SqlValue) });
    }
  };
  add(doc.t, doc.d!);
  if (doc.t === 'journal_entries') for (const l of docLines(doc)) add('journal_lines', l as never);
  return out;
}

/** لأحد أبناء الصف (أو أبنائهم بالتسلسل نفسه) نسخةٌ مرفوضة لطول انتظارها · فحذفه يُنتظر حتى تعود وتُطبَّق أولاً */
function kidWaitRejected(db: DB, table: string, key: string, depth = 0): boolean {
  if (depth > 8) return true;
  const row = readRow(db, table, key);
  if (!row) return false;
  for (const c of fkChildren(db, table)) {
    const ct = syncTable(c.child)!;
    const kids = db.all<{ k: string }>(`SELECT ${ct.pk(`"${c.child}"`)} AS k FROM "${c.child}" WHERE "${c.from}" = ?`, [row[c.to] as SqlValue]);
    for (const kid of kids) {
      if (db.get(`SELECT 1 FROM sync_rejects WHERE tbl = ? AND pk = ? AND reason = ?`, [c.child, kid.k, WAIT_REJECT])) return true;
      if (c.notNull && kidWaitRejected(db, c.child, kid.k, depth + 1)) return true;
    }
  }
  return false;
}

/** وقت انتظارٍ قديم يُعطى لما يُعاد من المرفوض على التجربة · فإن احتاج الانتظار ثانيةً عاد إليه في المرور نفسه */
const PROBATION_SINCE = '1970-01-01T00:00:00.000Z';

/**
 * الوارد المرفوض لطول انتظاره يعود إلى الصندوق حين يصل ما ينتظره (المراجعة الشاملة · البند ١٤): كل مفتاحٍ أجنبي فيه يشير إلى صفٍّ
 * موجود الآن، وللقيد مفاتيح سطوره (awaitedRefs) · وما ينتظر غير المفاتيح (العاكس ينتظر أصله، والدفعة قيد إلغائها، والصف قيمةً فريدة
 * يُفرغها حذفٌ مؤجَّل) يُجرَّب كذلك ما دامت مفاتيحه حاضرة، فلا يبقى مرفوضاً بعد وصول ما ينتظره (المراجعة الأخيرة: كان يبقى «حتى
 * إعادة الترقية» وإعادة الترقية لا تعيد إلا أسباب المخطط) · وحذفٌ انتظر نسخة ابنه يعود حين لا يبقى من أبنائه مرفوضٌ بالانتظار
 * (نسخة الابن تُطبَّق أولاً، وإلا سلسله الحذف كأنه بلا نسخة) · وكلٌّ على التجربة: سجل رفضه يبقى حتى يُطبَّق، فإن بقي ينتظر عاد إلى
 * المرفوض في المرور نفسه بصمت (لا يُعدّ ولا يُسجَّل ثانيةً) ولا ينتظر ثلاثين يوماً أخرى في الصندوق
 */
function restageArrivedParents(db: DB, waitRejected?: Set<string>): number {
  const rows = db.all<{ doc: string; payload: string }>(`SELECT doc, payload FROM sync_rejects WHERE reason = ?`, [WAIT_REJECT]);
  const fks = new Map<string, FkRow[]>();
  const fkOf = (t: string) => {
    let f = fks.get(t);
    if (!f) { f = db.all<FkRow>(`PRAGMA foreign_key_list("${t}")`); fks.set(t, f); }
    return f;
  };
  let n = 0;
  for (const r of rows) {
    waitRejected?.add(r.doc);
    let doc: RemoteDoc | null = null;
    try { doc = JSON.parse(r.payload) as RemoteDoc; } catch { doc = null; }
    if (!doc || !doc.id || !syncTable(doc.t)) continue;
    // ومستندٌ واحدٌ يرمي فحصه لا يوقف الإعادة كلها (G · M١)
    try {
      if (doc.d) {
        const arrived = awaitedRefs(doc, fkOf).every((k) => k.value !== NEVER && !!db.get(`SELECT 1 FROM "${k.table}" WHERE "${k.to}" = ?`, [k.value]));
        if (!arrived) continue;
      } else if (!doc.del || kidWaitRejected(db, doc.t, doc.k)) continue;
    } catch { continue; }
    stageInbox(db, [doc]);
    // ونسخةٌ أحدث منه في الصندوق تبقى على انتظارها
    db.run(`UPDATE sync_inbox SET attempts = ?, waiting_since = ? WHERE doc = ? AND payload = ?`,
      [MAX_ATTEMPTS, PROBATION_SINCE, doc.id, JSON.stringify(doc)]);
    n++;
  }
  return n;
}

/** sync_ctl.applying · تقرؤه محفّزات سقف الدفعة (الهجرة ٢١) */
function setApplying(db: DB, on: boolean): void {
  db.run(`INSERT INTO sync_ctl (k, v) VALUES ('applying', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [on ? 1 : 0]);
}

/** الأقساط التي يمسّ مسدَّدَها مستندٌ وارد · وحذفُ دفعةٍ أو توزيعٍ لا يُعرف قسطه فيُعاد حساب الكل */
function markTouched(db: DB, doc: RemoteDoc, touched: Set<string>): void {
  const d = doc.d;
  if (doc.del && (doc.t === 'contracts' || doc.t === 'contract_installments')) { touched.add(ALL_INSTALLMENTS); return; }
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
export interface ApplyResult { applied: number; conflicts: number; rejected: number; waiting: number }

/**
 * التطبيق خطوات (أعطال ٢٠٢٦-١٠-٠٥: المزامنة لا تحجب الواجهة) · كل صفحة في معاملتها، والالتقاط مطفأ داخلها وحدها،
 * فما يكتبه المستخدم بين الصفحات يُلتقط ويُرفع كالمعتاد. تُعطي بعد كل صفحة عدد ما طُبّق.
 */
function* applySteps(db: DB, deviceId: string, out: ApplyResult, pageSize: number): Generator<number, void> {
  const cache = new Map<string, Set<string>>();
  resetStatementCounts(db);
  const money = moneyColumns(db); // مرة لكل تطبيق لا لكل صف
  const joining = getSyncState(db, 'joining') === '1';
  const touched = new Set<string>();
  /** ما له رفضُ انتظار (يملؤه restageArrivedParents في كل مرور) · فلا يُبحث في سجل المرفوض لكل صفٍّ يُطبَّق */
  const waitRejected = new Set<string>();
  /**
   * معاملةٌ والوارد لا يرتدّ صداه إلى الطابور، ودفعةٌ سُجّلت على جهاز آخر لا يرفضها فحص «المتبقي» المحلي · وإن رمى ما فيها أعاد إلغاؤها
   * العلامتين كما كانتا، فلا تُكتبان بعده: إن ألغتها SQLite بنفسها (قرصٌ ممتلئ) وقعت كتابتهما خارج أي معاملة (R12-SYN-1)
   */
  const quiet = (fn: () => void) => db.transaction(() => {
    const wasOn = captureOn(db);
    setCapture(db, false);
    setApplying(db, true);
    fn();
    setApplying(db, false);
    setCapture(db, wasOn);
  });
  for (let pass = 0; pass < 4; pass++) {
    let progress = 0;
    // ما رُفض لانتظار أبيه ووصل أبوه قبل هذه الدورة يعود إلى الصندوق فيُطبَّق فيها (البند ١٤)
    if (pass === 0) quiet(() => { restageArrivedParents(db, waitRejected); });
    // شواهد الحذف أولاً والأبناء قبل الآباء (المفتاح الأجنبي يمنع حذف أبٍ له أبناء) · ثم الصفوف
    // والآباء قبل الأبناء · وإلا وصل صفٌّ جديد يحمل رقماً فريداً قبل حذف من كان يحمله فرُفض بلا رجعة
    // (وجده اختبار الثوابت: عقد حُذف باستعادة ثم أُنشئ غيره بالرقم نفسه)
    for (const deletes of [true, false]) {
      const key = deletes ? '(1000 - rank)' : 'rank';
      let lastKey = -1, lastU = '', lastDoc = '';
      for (;;) {
        // علامة الحذف عمودٌ مفهرس (الهجرة ٢٥) · فلا تُفكّ الحمولات لكل صفحة
        const page = db.all<{ doc: string; k: number; updated_at: string; payload: string; attempts: number; waiting_since: string | null }>(
          `SELECT doc, ${key} AS k, updated_at, payload, attempts, waiting_since FROM sync_inbox
           WHERE del = ? AND (${key}, updated_at, doc) > (?, ?, ?)
           ORDER BY ${key}, updated_at, doc LIMIT ${pageSize}`, [deletes ? 1 : 0, lastKey, lastU, lastDoc]);
        if (!page.length) break;
        quiet(() => {
          for (const r of page) {
            const doc = JSON.parse(r.payload) as RemoteDoc;
            const res = applyOne(db, doc, deviceId, cache, money, joining);
            // معاملة الصفحة ما زالت قائمة: إلغاءٌ من SQLite ابتلعه مستدعٍ في الطريق لا يُحذف بعده المستند من الصندوق خارج أي معاملة
            // فيضيع، ولا يُطبَّق ما بعده والالتقاط عاد مفعّلاً (مراجعة إصلاح R12-SYN-1)
            if (db.inTransaction?.() === false) throw new TransactionAbortedError(new Error('no transaction is active'));
            if (res === 'retry') {
              // بالزمن لا بالمرور (البند ١٤): المرور الواحد قد يتكرر أربع مرات في الدورة
              const since = r.waiting_since ? Date.parse(r.waiting_since) : NaN;
              if (r.attempts + 1 >= MAX_ATTEMPTS && Number.isFinite(since) && Date.now() - since > WAIT_LIMIT_MS) {
                // وما أُعيد على التجربة (restageArrivedParents) ولم يصل ما ينتظره يرجع بصمت: سجله باقٍ بحمولته نفسها · ونسخةٌ أحدث تحلّ محله
                if (!db.get(`SELECT 1 FROM sync_rejects WHERE doc = ? AND reason = ? AND payload = ?`, [r.doc, WAIT_REJECT, r.payload])) {
                  db.run(`DELETE FROM sync_rejects WHERE doc = ? AND reason = ?`, [r.doc, WAIT_REJECT]);
                  reject(db, doc, WAIT_REJECT);
                  out.rejected++;
                }
                db.run(`DELETE FROM sync_inbox WHERE doc = ?`, [r.doc]);
              } else {
                db.run(`UPDATE sync_inbox SET attempts = attempts + 1, last_error = 'بانتظار سجل أب',
                        waiting_since = COALESCE(waiting_since, ?) WHERE doc = ?`, [nowIso(), r.doc]);
              }
              continue;
            }
            db.run(`DELETE FROM sync_inbox WHERE doc = ?`, [r.doc]);
            // انتهى انتظاره (طُبّق أو غلبه ما هنا أو رُفض لسببٍ آخر يُسجَّل بنفسه) · فلا يبقى له رفضُ انتظار
            if (waitRejected.has(r.doc)) db.run(`DELETE FROM sync_rejects WHERE doc = ? AND reason = ?`, [r.doc, WAIT_REJECT]);
            progress++;
            if (res === 'applied' || res === 'conflict-remote') markTouched(db, doc, touched);
            if (res === 'applied') out.applied++;
            else if (res === 'conflict-local' || res === 'conflict-remote') { out.conflicts++; if (res === 'conflict-remote') out.applied++; }
            else if (res === 'rejected') out.rejected++;
          }
        });
        const last = page[page.length - 1];
        lastKey = last.k; lastU = last.updated_at; lastDoc = last.doc;
        yield out.applied + out.rejected;
      }
    }
    if (!progress) break;
    // ووصل أبوه في هذا المرور: يُطبَّق في المرور التالي من الدورة نفسها
    quiet(() => { restageArrivedParents(db, waitRejected); });
    const left = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox`)!.n);
    if (!left) break;
  }
  // المسدَّد والحالة من الدفعات للأقساط التي مسّها الوارد · وما حُسب لا يرتدّ إلى الطابور
  quiet(() => {
    resolvePendingReversals(db);
    // وترحيل تأمينٍ رُفض بعد أن طُبِّق صفّ عقده المجدَّد (R12-DEP-1): يُصحَّح تأمينه هنا ويُرفع
    fixDeadCarries(db);
    // ودفعة «من التأمين» عُكس قيدها بعاكسٍ قُبل هنا ولم تُلغَ: تُلغى بعاكسها وتُرفع (قبل حساب المسدَّد)
    cancelReversedDepositRent(db, touched);
    // وإلغاءٌ حمله ضمّ استعادةٍ وصار عاكسه موثَّقاً هنا: يعود سببه سبب التعديل ويُرفع (سببٌ لا مبلغ، فلا يمسّ المسدَّد)
    unkeepDocumentedDepositRent(db);
    recomputeInstallments(db, touched.has(ALL_INSTALLMENTS) ? undefined : [...touched]);
    if (out.applied) reopenReversedMatches(db);
  });
  out.waiting = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox`)!.n);
  // قيدٌ وصل ومستنده لا يصل (حذفته استعادة على جهاز آخر) يبقى ويُعلَّم للمراجعة (orphans.ts) ·
  // بعد اكتمال الوارد لا قبله، فالقيد يسبق مستنده في ترتيب التطبيق
  // جهاز العضو يحمل جزءاً من الدفتر بصلاحيته · فلا يُعلَّم ما غاب مصدره عنه يتيماً
  if ((out.applied || out.rejected) && !out.waiting && !getSyncState(db, 'membership')) markOrphans(db, 'وصل بالمزامنة');
}

/**
 * سطر كشفٍ مطابَق بحركة قيدٍ عُكس (وصل عكسه من جهازٍ آخر، أو أصلحه هذا الجهاز) يعود مفتوحاً، ويرفعه جهاز المالك (المدقق الخارجي C٢-٢:
 * المحصِّل بلا صلاحية البنوك يلغي الدفعة فلا يُقبل تصحيح السطر منه، وجهاز المالك كان يُبقيه مطابَقاً بتحصيلٍ أُلغي)
 */
function reopenReversedMatches(db: DB): void {
  const ids = db.all<{ id: string }>(
    `SELECT l.id FROM bank_statement_lines l JOIN bank_tx t ON t.id = l.bank_tx_id JOIN journal_entries e ON e.no = t.journal_no
     WHERE l.status = 'matched' AND l.deleted_at IS NULL AND e.reversed_by IS NOT NULL`).map((r) => r.id);
  for (const id of ids) {
    db.run(`UPDATE bank_statement_lines SET status = 'open', bank_tx_id = NULL, matched_at = NULL WHERE id = ?`, [id]);
    enqueueStmtFix(db, id);
  }
}

/** التطبيق كله في نداءٍ واحد · للاختبارات والأدوات */
export function applyInbox(db: DB, deviceId: string): ApplyResult {
  const out: ApplyResult = { applied: 0, conflicts: 0, rejected: 0, waiting: 0 };
  for (const _ of applySteps(db, deviceId, out, 300)) { /* حتى النهاية */ }
  return out;
}

/** يفسح للواجهة بين صفحتين · مهلة صفرية تسمح للرسم واللمس */
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * التطبيق بصفحات صغيرة يفسح للواجهة بينها (أعطال ٢٠٢٦-١٠-٠٥) · onStep بعد كل صفحة بعدد ما طُبّق ومجموعه،
 * فيظهر التقدم وتتحدث الشاشات تدريجياً.
 */
export async function applyInboxAsync(
  db: DB, deviceId: string, onStep?: (done: number, total: number) => void, pause: () => Promise<void> = yieldToUi,
): Promise<ApplyResult> {
  const out: ApplyResult = { applied: 0, conflicts: 0, rejected: 0, waiting: 0 };
  const total = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox`)!.n);
  for (const done of applySteps(db, deviceId, out, 60)) {
    onStep?.(done, total);
    await pause();
  }
  return out;
}

/* ═══════════ اعتماد نسخة مستعادة واستبدال السحابة بها ═══════════ */

/**
 * ما في السحابة: آخر حالة لكل مستند · يُقرأ مرة والمزامنة متوقفة، قبل أن يُكتب شيء.
 * منه تُؤخذ القيود المرحّلة التي ليست في النسخة لتُضمّ إليها (keepPosted.ts)، ومنه خطة الاستبدال.
 * المستند كاملاً لما يحتاجه الضمّ (القيود ومستندات الدفع وحركات البنك وسجل العمليات) · وغيره بمفتاحه.
 */
export interface CloudSnapshot {
  /** آخر مؤشر في السحابة · المزامنة بعد الاعتماد تبدأ منه فلا تسحب ما استُبدل */
  cursor: Cursor | null;
  docs: RemoteDoc[];
}

/**
 * الجداول التي يُحفظ مستندها كاملاً في اللقطة · ما يُضمّ مع القيد المرحّل · ومنها الحسابات: حسابٌ أُضيف بعد النسخة يُحمل صفّه مع
 * قيده، وإلا رفض مفتاح الحساب سطره (المراجعة ١٢ · R12-BAK-1) · والدليل صغير فلا يثقل اللقطة · وصفوف التسوية: بها يُعرف أن دفعة
 * «من التأمين» سُدّدت بالتسوية التي في النسخة (R12-BAK-2)
 */
export const SNAPSHOT_FULL = new Set(['journal_entries', 'contract_payments', 'payment_lines', 'payment_allocations', 'bank_tx', 'audit_log',
  'contract_installments', 'tenants', 'accounts', 'deposit_settlements']);

const PLAN_PAGE = 500;

/**
 * minEpoch: عهد المسح الحالي في السحابة · ما كُتب في عهدٍ أقدم لا يُقرأ كما لا يُسحب (المتحقق المستقل، الجولة ٣٥ (ج١): الاستعادة
 * كانت تضمّ قيداً من عهدٍ ممسوح)
 */
export async function readCloud(remote: RemoteStore, onProgress?: (msg: string) => void, minEpoch = 0): Promise<CloudSnapshot> {
  let cursor: Cursor | null = null;
  // الصفحات مرتبة بوقت الخادم فالأحدث يغلب
  const last = new Map<string, RemoteDoc>();
  for (;;) {
    onProgress?.('جاري قراءة ما في السحابة' + (last.size ? ' · ' + last.size : ''));
    const { docs, next, more } = await remote.pull(cursor, PLAN_PAGE);
    for (const d of docs) {
      if (minEpoch > 0 && (d.ep ?? 0) < minEpoch) continue;
      last.set(d.id, SNAPSHOT_FULL.has(d.t) ? d : { id: d.id, t: d.t, k: d.k, u: d.u, dev: d.dev, del: d.del, d: null });
    }
    if (next) cursor = next;
    if (!(more ?? docs.length >= PLAN_PAGE)) break;
  }
  return { cursor, docs: [...last.values()] };
}

/**
 * ما في السحابة مقابل القاعدة · `tombstones` صفوفٌ في السحابة ليست في القاعدة فتُحذف منها بشاهد حذف ·
 * و`immutable` ما لا تحذفه قواعد الأمان أصلاً: سطور سجل العمليات تُضمّ (إضافةٌ لا تغيّر رقماً)،
 * والقيود المرحّلة تُضمّ إلى القاعدة قبل الاعتماد مع مستنداتها (keepPosted.ts) فلا يبقى منها شيء هنا.
 */
export interface CloudReplacePlan {
  cursor: Cursor | null;
  /** مستندات السحابة الحية · للعرض */
  cloudRows: number;
  tombstones: { t: string; k: string }[];
  immutable: { entries: number; audit: number };
  /** القيود المرحّلة في السحابة وليست في القاعدة · حزامٌ عند الاعتماد */
  posted: string[];
  /** سطور سجل العمليات في السحابة وليست في القاعدة · تُضمّ إليها عند الاعتماد */
  absorb: RemoteDoc[];
}

/** حزام: قيد مرحّل في السحابة لم يُضمّ إلى القاعدة قبل الاعتماد · لا يقع في مسار التطبيق */
export class CloudReplaceBlockedError extends Error {
  constructor(public entries: number) {
    super(`في السحابة ${entries} قيد مرحّل ليس في بيانات هذا الجهاز · القيد المرحّل لا يُحذف، `
      + 'فيُضمّ قبل الاعتماد · أعد الاستعادة أو الاعتماد ليُضمّ');
    this.name = 'CloudReplaceBlockedError';
  }
}

/** صف السحابة موجود في القاعدة المحلية؟ · بمفتاحه الأساسي */
function existsLocally(db: DB, t: string, k: string): boolean {
  if (!syncTable(t)) return true; // جدول خارج المزامنة · لا يُمسّ
  return !!db.get(`SELECT 1 FROM "${t}" WHERE ${pkWhere(t)}`, pkParams(t, k));
}

export function planFromSnapshot(db: DB, snap: CloudSnapshot): CloudReplacePlan {
  let cloudRows = 0;
  const tombstones: { t: string; k: string }[] = [];
  const immutable = { entries: 0, audit: 0 };
  const posted: string[] = [];
  const absorb: RemoteDoc[] = [];
  for (const d of snap.docs) {
    if (d.del) continue;
    cloudRows++;
    if (existsLocally(db, d.t, d.k)) continue;
    if (d.t === 'audit_log') { immutable.audit++; absorb.push(d); }
    else if (d.t === 'journal_entries' && d.d?.status === 'مرحّل') { immutable.entries++; posted.push(d.k); }
    else tombstones.push({ t: d.t, k: d.k });
  }
  return { cursor: snap.cursor, cloudRows, tombstones, immutable, posted, absorb };
}

export async function planCloudReplace(
  db: DB, remote: RemoteStore, onProgress?: (msg: string) => void, minEpoch = 0
): Promise<CloudReplacePlan> {
  return planFromSnapshot(db, await readCloud(remote, onProgress, minEpoch));
}

/**
 * القاعدة المستعادة هي الحقيقة لهذا الحساب: كل صف فيها يدخل الطابور بوقت الآن فيغلب ما في
 * السحابة، وما في السحابة وليس فيها يُحذف بشاهد حذف، والمؤشر إلى آخر ما قُرئ فلا يعود الوارد
 * القديم فوقها. لا كتابة إلى السحابة هنا · الرفع في دورة المزامنة التالية بعد الاعتماد.
 */
export function adoptAsCloudTruth(db: DB, uid: string, plan: CloudReplacePlan, epoch?: number): { queued: number } {
  // حزام: القيود المرحّلة في السحابة تُضمّ قبل هذه الخطوة (keepPosted.ts) · فما بقي منها خارج القاعدة يمنع
  const missing = plan.posted.filter((k) => !existsLocally(db, 'journal_entries', k)).length;
  if (missing > 0) throw new CloudReplaceBlockedError(missing);
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
    // وما ضُمّ منه ويُبنى عليه حكم المراجعة (علامةٌ، وحفظ مستندٍ أعاد ترحيل قيوده، وسطر اعتمادٍ سابق) كُتب في خطٍّ لم تَعُد إليه
    // البيانات: يُسمّى في سطرٍ واحد فلا يعمل هنا، والاستعادة حكمت من جديد على ما بعد النسخة (المراجع المعاكس الرابع على R12-BAK-2) ·
    // قبل رفع ما في القاعدة فيُرفع معه
    recordForeignReview(db, foreignReviewRows(plan.absorb));
    db.run(`DELETE FROM sync_inbox`);
    db.run(`DELETE FROM sync_outbox`);
    setSyncState(db, 'uid', uid);
    // آخر ما قُرئ لا موضعه الآمن: الاستبدال يغلب ما قبله في السحابة فلا يعود (البند ٢ للدورات لا للاعتماد)
    setSyncState(db, 'cursor', plan.cursor ? JSON.stringify({ ...plan.cursor, safe: undefined }) : null);
    setSyncState(db, 'joining', null);
    setSyncState(db, 'restored_unadopted', null);
    // عهد المسح الحالي في السحابة يُسجَّل مع الاعتماد ذرياً (قاعدة المالك ٢٠٢٦-١٠-٠٥) · فلا يُفرَّغ الجهاز بعدها
    if (epoch !== undefined) { setSyncState(db, 'wipe_epoch', String(epoch)); setSyncState(db, 'epoch_pending', null); }
    // كل شيء يُرفع برموز الرؤية الحالية
    setSyncState(db, 'acl_version', String(ACL_VERSION));
    for (const t of syncedNow(db)) {
      db.run(
        `INSERT INTO sync_outbox (tbl, pk, op, changed_at)
         SELECT '${t.name}', ${t.pk(t.name)}, 'upsert', ? FROM "${t.name}" WHERE true`, [at]);
    }
    // ما ضُمّ بعد قراءة الخطة (دفعةٌ حُملت مع قيدها) لا يُحذف من السحابة
    for (const x of plan.tombstones.filter((y) => !existsLocally(db, y.t, y.k))) {
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
/** مفتاح عقارات المستأجر المشترك كما في السحابة (sync/acl.ts يقرؤه) */
export const TENANT_PIDS = 'tenant_pids:';
/**
 * دفعة العضو صغيرة: قواعده تقرأ لكل صفٍّ مستند أبيه (المراجعة #18)، وللطلب الواحد عشرون قراءة تتقاسمها صفوف الدفعة ·
 * وحدّ الألف تعبير لكل مستند (ثبت على المحاكي) · وما زاد يُرفض فتُقسم الدفعة نصفين
 */
const MEMBER_PUSH_BATCH = 8;

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
  /** يُستدعى أثناء تطبيق الوارد (كل بضع ثوان) فتتحدث الشاشات بما وصل */
  onApplied?: () => void;
  /** للاختبار: الإفساح بين صفحات التطبيق */
  pause?: () => Promise<void>;
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

  // إسقاطات الأعضاء التي رفضها جهاز المالك قبل إصلاح السحب ليست بيانات ناقصة · تُرفع من سجل المرفوض
  db.run(`DELETE FROM sync_rejects WHERE tbl LIKE '%~pub'`);
  requeueForAcl(db);

  // ٠) كتل أرقام المستندات قبل أي كتابة · ما بقي منه أقل من نصفه يُملأ، فيعمل الجهاز بعدها بلا اتصال (numbering.ts)
  if (remote.reserveBlocks) {
    const req = blockRequests(db);
    if (req.length) {
      try {
        const got = await retrying(() => remote.reserveBlocks!(req));
        db.transaction(() => { for (const b of got) addBlock(db, b.series, b.lo, b.hi); });
        setSyncState(db, 'blocks_error', null);
      } catch (e) {
        // العضو في منشأةٍ بلا عدّاد يتابع المزامنة بلا أرقام جديدة حتى يوجد العدّاد (قرار المالك 2026-10-15 «١٦») · والعابر يُرمى كما كان
        if (!remote.memberMode || isTransientRemoteError(e)) throw e;
        setSyncState(db, 'blocks_error', (e instanceof Error ? e.message : String(e)).slice(0, 200));
      }
    }
  }

  // ١) السحب إلى الصندوق الوارد · المؤشر يُحفظ بعد حفظ كل صفحة
  let pulled = 0;
  const saved = getSyncState(db, 'cursor');
  let cursor: Cursor | null = saved ? (JSON.parse(saved) as Cursor) : null;
  for (;;) {
    onProgress?.('جاري سحب التغييرات' + (pulled ? ' · ' + pulled : ''));
    let page: PullPage;
    try { page = await retrying(() => remote.pull(cursor, PULL_PAGE)); }
    catch (e) { if (isTransientRemoteError(e)) giveUp(0, outboxCount(db)); throw e; }
    const { docs, next, more } = page!;
    // الوارد بعهد مسحٍ أقدم من عهد هذا الجهاز يُترك (المراجعة الخارجية ٧ · النتيجة ٢٣): جهازٌ قرأ العهد قبل المسح ودفع بعده · فلا
    // يرجع ما مُسح إلى أي جهاز · والمالك ترفض القواعد صفّه أصلاً
    const ep = Number(getSyncState(db, 'wipe_epoch') ?? 0);
    const fresh = ep > 0 ? docs.filter((d) => (d.ep ?? 0) >= ep) : docs;
    if (fresh.length) {
      stageInbox(db, fresh);
      pulled += fresh.length;
    }
    // التقليب داخل الدورة بالمؤشر، والمحفوظ موضعه الآمن (المراجعة الشاملة · البند ٢): ما قبل وقت القراءة بنافذة الأمان ·
    // فمستندٌ تأخر التزامه عن وقته يُسحب في الدورة التالية ولا يُتخطى
    if (next) {
      cursor = next;
      const keep = remote.durableCursor ? remote.durableCursor(next) : next;
      setSyncState(db, 'cursor', keep ? JSON.stringify(keep) : null);
    }
    if (!(more ?? docs.length >= PULL_PAGE)) break;
  }

  // ٢) التطبيق بصفحات يفسح للواجهة بينها، والتقدم ظاهر، والشاشات تتحدث تدريجياً · ثم ينتهي الانضمام
  onProgress?.('جاري تطبيق الوارد');
  let lastShown = 0;
  const a = await applyInboxAsync(db, deviceId, (done, total) => {
    onProgress?.('جاري تطبيق الوارد · ' + done + ' من ' + total);
    const now = Date.now();
    if (opts.onApplied && now - lastShown > 2500) { lastShown = now; opts.onApplied(); }
  }, opts.pause);
  if (getSyncState(db, 'joining') === '1') setSyncState(db, 'joining', null);

  // ٣) الدفع · على دفعات بتقدّم ظاهر «ن من م»، والدفعة تصغر عند الانشغال
  let pushed = 0;
  const total = outboxCount(db);
  let size = remote.memberMode ? MEMBER_PUSH_BATCH : PUSH_BATCH;
  if (remote.memberMode) prepareMemberUpload(db);
  let failures = 0;
  for (;;) {
    const batch = pendingOutbox(db, size);
    if (!batch.length) break;
    onProgress?.('جاري رفع التغييرات · ' + pushed + ' من ' + total);
    // المنشأة: حقول الرؤية والكتابة وإسقاط المبالغ تُضاف هنا (sync/acl.ts)
    const docs = batch.map((r) => {
      const d = buildDoc(db, r.tbl, r.pk, r.op, r.changed_at, deviceId);
      return remote.annotate ? remote.annotate(db, d) : d;
    });
    // العضو: ما لا قسم يجيزه له لا يُرسل أصلاً · يُعامل كالمرفوض
    const results0: Array<WriteResult | null> = docs.map((d) => (remote.memberMode && !d.op ? { ok: false, code: 'PERMISSION_DENIED', message: 'لا قسم يجيزه' } : null));
    let results: WriteResult[];
    let commitIso: string | null = null;
    try {
      const sendIdx = results0.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
      const sent = sendIdx.length ? await remote.write(sendIdx.map((i) => docs[i])) : [];
      const sample = remote.clockSample?.();
      recordClockSample(db, sample);
      // وقت الالتزام في الخادم لما رُفع (المتحقق المستقل على 299bdd5): وقت الجهاز وحده قد يسبق الخادم (ساعةٌ مقدَّمة قبل أول
      // عيّنة) فيُعدّ تعديل غيره الأحدث «أقدم» ويُرجعه الجهاز إلى نسخته
      commitIso = sample && Number.isFinite(sample.serverMs) ? new Date(sample.serverMs).toISOString() : null;
      results = results0.map((x) => x ?? { ok: false });
      sendIdx.forEach((i, j) => { results[i] = sent[j]; });
      failures = 0;
    } catch (e) {
      // انقطاع الاتصال وما ليس عابراً · الطابور كما هو ويُستأنف عند عودته
      if (!isTransientRemoteError(e)) throw e;
      if (failures >= maxRetries) giveUp(pushed, total);
      // الدفعة تُبنى من جديد أصغر · وتُنتظر مهلة تتضاعف
      size = Math.max(Math.min(MIN_PUSH_BATCH, size), Math.floor(size / 2));
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
        // العضو: المرفوض لصلاحيته لا تفيده الإعادة · يخرج من الطابور ويُسجَّل
        const memberDenied = remote.memberMode && res.code === 'PERMISSION_DENIED';
        // وتقرير العطل المرفوض (حدّ يومه، أو قواعدُ لم تُنشر بعد) يخرج من الطابور بلا سطرٍ في المرفوض: تشخيصٌ لا عملٌ للمستخدم
        // وتقرير العطل وسطر الفشل المرافق له لا يُعدّان «مرفوضاً» للعضو: كتبهما حوار الفشل لا هو (المدقق الخارجي H٨)
        const failureRow = docs[i].t === 'audit_log' && (docs[i].d?.entity_type === CRASH_ENTITY
          || String(docs[i].d?.entity_type ?? '').startsWith(FAILURE_ENTITY_PREFIX));
        // ورتبةٌ أخذها جهازٌ آخر للحساب نفسه تُعاد بالتالية (H٢)
        if (memberDenied && docs[i].t === 'audit_log' && docs[i].d?.entity_type === CRASH_ENTITY) retryCrashRank(db, docs[i].d as Record<string, unknown>);
        if (memberDenied && !failureRow) {
          db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`,
            [docs[i].id, r.tbl, r.pk, 'خارج صلاحيتك · بقي على هذا الجهاز ولم يُرفع', JSON.stringify({ ...docs[i], companions: undefined }), nowIso()]);
        }
        // رفض القيد المرحّل لأن نسخته في السحابة نهائية يُسجَّل للمالك فلا يتباين جهازه صامتاً (المراجعة الخارجية ٧ · النتيجة ٢١) ·
        // وسطر السجل المرفوض لا يُسجَّل (يقع في مسارات سليمة · المتحقق المستقل، الجولة ٣٠ على ٤٠٠ بذرة)
        const finalDenied = !memberDenied && immutableDenied(docs[i], res.code);
        // والقيد الذي عرف الجهاز رقمه في السحابة (القيد نفسه هناك برقمٍ آخر) ليس مرفوضاً: نسخة السحابة تصله (Z٢-٨)
        const knownInCloud = r.tbl === 'journal_entries' && typeof docs[i].d?.no === 'string'
          && Object.keys(noAliases(db)).includes(String(docs[i].d!.no));
        if (finalDenied && r.tbl === 'journal_entries' && !knownInCloud) {
          db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`,
            // i18n-exempt: سبب الرفض المخزَّن
            [docs[i].id, r.tbl, r.pk, FINAL_IN_CLOUD, JSON.stringify({ ...docs[i], companions: undefined }), nowIso()]);
        }
        // الرفض الدائم لصفٍّ بعينه يخرج من الطابور إلى سجل المرفوض (البند ١٥)
        const permanent = !res.ok && !memberDenied && !finalDenied && PERMANENT_PUSH_CODES.has(res.code ?? '');
        if (permanent) {
          db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`,
            [docs[i].id, r.tbl, r.pk, (PERMANENT_PUSH_REASON + ' · ' + (res.code ?? '') + ' ' + (res.message ?? '')).slice(0, 300),
              // بلا محتواه: يُعاد من الصف نفسه، والمستند الكبير لا يُخزَّن مرة ثانية
              JSON.stringify({ id: docs[i].id, t: docs[i].t, k: docs[i].k, u: docs[i].u, del: docs[i].del }), nowIso()]);
        }
        if (res.ok || memberDenied || finalDenied || permanent) {
          // لا يُحذف إن تغيّر الصف أثناء الرفع · يبقى للدفعة التالية بوقته الجديد
          db.run(`DELETE FROM sync_outbox WHERE tbl = ? AND pk = ? AND changed_at = ?`, [r.tbl, r.pk, r.changed_at]);
          if (r.tbl === 'bank_statement_lines') markStmtFix(db, r.pk, false);
          if (res.ok) {
            pushed++;
            // بوقت الالتزام في الخادم إن عُرف، ولا يتجاوز وقت المستند · وبلا وقت الخادم لا يُحفظ (الوارد يغلب كما كان)
            if (commitIso) noteRowTime(db, r.tbl, r.pk, isoCmp(docs[i].u, commitIso) < 0 ? docs[i].u : commitIso);
            if (OPENING_TABLES.has(r.tbl) && docs[i].d && !docs[i].del) noteSeenOpening(db, r.tbl, r.pk, docs[i].d!.opening_halalas);
            // والمحضر المقفل: أول ما بلغ قفله السحابة من هذا الجهاز، وهو مُقفله إن لم يعرفه قبلُ (E-1/R11-1 وR11-3)
            if (r.tbl === 'handovers' && !docs[i].del && Number(docs[i].d?.locked) === 1) {
              noteLockSeen(db, r.pk, commitIso && isoCmp(commitIso, docs[i].u) < 0 ? commitIso : docs[i].u, true, false);
            }
          }
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

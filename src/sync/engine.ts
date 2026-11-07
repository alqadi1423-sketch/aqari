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
import { isSafeBlobName } from '../files/store';
import { mirrorIssue } from '../domain/accounting/mirror';
import { nextJournalNo } from '../domain/accounting/post';
import { nextPurchaseNo } from '../domain/purchases';
import { postedAccum } from '../domain/assets/depreciation';
import { t as tr } from '../i18n';
import type { DB, SqlValue } from '../db/adapter';
import { SYNC_TABLES, SYNC_RANK, LATER_SYNC_TABLES, syncTable } from '../db/syncTables';
import { logAudit } from '../domain/audit';
import { moneyColumns, semanticIssues, type SemanticScope } from '../domain/backup/semantic';
import { DISCOUNT_ENTRY_SRC } from '../domain/contracts/installments';
import { recomputeInstallments, installmentsOfPayment } from '../domain/contracts/paid';
import { paidFromDeposit } from '../domain/contracts/cancelPayment';
import { blockRequests, addBlock } from '../domain/numbering';
import { markOrphans } from '../domain/accounting/orphans';
import { rentEntryIssue, allocationIssue, CREDIT_METHOD, type RentPaymentSrc, entryDimsIssue } from '../domain/accounting/derive';
import { filingRecordedAt } from '../domain/vatFilings';
import { TS_DEDUCTIBLE } from '../domain/purchases';
import { walletCashBalance, bankBalance } from '../domain/accounting/ledger';
import { CASH_DEPOSIT_SOURCE, CASH_WITHDRAW_SOURCE, TRANSFER_OUT_SOURCE, TRANSFER_IN_SOURCE } from '../domain/cashOps';
import { CRASH_ENTITY, FAILURE_ENTITY_PREFIX, retryCrashRank } from '../domain/crashReport';
import { memberSourceIssue, deductibleIssue, DERIVED_SOURCES, type SourceReader, type SrcLine } from '../domain/accounting/deriveSources';
import { RENT_REVENUE_GROUP, RENT_REVENUE_SQL } from '../domain/accounting/rentSplit';
import type { Cursor, PullPage, RemoteDoc, RemoteStore, RowData, SyncReport, WriteResult } from './types';
import { isoCmp, isoNorm } from './isoTime';
import { redactForReport } from '../domain/redact';

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
    throw new Error(tr('mirror.revRejected', { why: tr('mirror.extra', { lng: 'ar' }), lng: 'ar' }));
  }
  guessLink(db, doc.k);
  const revs = db.all<{ id: string }>(
    `SELECT id FROM journal_entries WHERE src_type = ? AND src_id = ? AND status = 'مرحّل'`, [src, srcId]).length; // i18n-exempt: حالة القيد المخزّنة
  if (revs > originals.length) { awaitPending(true); throw new Error(tr('mirror.revRejected', { why: tr('mirror.extra', { lng: 'ar' }), lng: 'ar' })); }
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
  const exists = (id: string) => !!db.get(`SELECT 1 FROM journal_entries WHERE id = ?`, [id])
    || !!db.get(`SELECT 1 FROM sync_inbox WHERE tbl = 'journal_entries' AND pk = ? AND del = 0`, [id]);
  return originals.filter((o) => {
    if (mirrorIssue(db, o, revId) !== '') return false;
    const by = db.get<{ r: string | null }>(`SELECT reversed_by AS r FROM journal_entries WHERE id = ?`, [o])!.r;
    // وربطٌ بعاكسٍ لا وجود له هنا ولا في الوارد لا يحجز الأصل (المدقق الخارجي M١٠: عضوٌ ربط قيد المالك بعاكسٍ وهمي فرُفض عكس المالك
    // نفسه على جهازه الثاني)
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

/** قيد التحصيل ودفعته: الفترة المقدَّمة، والتخصيص، ورصيد المستأجر الدائن، ثم السطور من الدفعة · يرمي بالسبب أو بالانتظار */
function rentCheckAgainst(db: DB, e: { srcId: string; date: string; lines: Array<{ account: string; debit: number; credit: number }> },
  pay: RentPaymentSrc, ts: string | undefined): void {
  const no = (why: string) => new Error(tr('derive.rejected', { why, lng: 'ar' }));
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
  const filed = filingRecordedAt(db, date);
  if (filed && (!doc.ts || isoCmp(doc.ts, filed) > 0)) throw no(tr('vat.filedEntry', { lng: 'ar' }));
  const why = memberSourceIssue(db, sourceReader(db), {
    id: doc.k, src_type: src, src_id: (doc.d!.src_id as string | null) ?? null, no: (doc.d!.no as string | null) ?? null, date,
    reversed_by: (doc.d!.reversed_by as string | null) ?? null, lines: (doc.lines ?? []) as SrcLine[],
  });
  if (why === 'await') throw new AwaitOriginal(tr('deriveSrc.noDoc', { lng: 'ar' }));
  if (why) throw no(why);
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

interface BankTxState { bank: string; amount: number; no: string; source: string; live: boolean }

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
  const old = db.get<{ b: string; a: number; n: string | null; s: string | null; del: string | null }>(
    `SELECT bank_id AS b, amount_halalas AS a, journal_no AS n, source AS s, deleted_at AS del FROM bank_tx WHERE id = ?`, [doc.k]);
  const was: BankTxState | null = old
    ? { bank: String(old.b ?? ''), amount: Number(old.a) || 0, no: String(old.n ?? ''), source: String(old.s ?? ''), live: old.del == null } : null;
  const now: BankTxState | null = row
    // والحذف قيمةٌ غير فارغة كما يعدّها الرصيد والسلة (deleted_at IS NOT NULL) · فالنص الفارغ حذف (المدقق الخارجي I٣: كان الحارس
    // يعدّه حيّاً فيمرّره «تعديلاً لا يمسّ شيئاً»، والرصيد يعدّه محذوفاً)
    ? { bank: String(row.bank_id ?? ''), amount: Number(row.amount_halalas) || 0, no: String(row.journal_no ?? ''), source: String(row.source ?? ''), live: row.deleted_at == null }
    : null;
  // تعديلٌ لا يمسّ البنك ولا المبلغ ولا القيد ولا المصدر ولا الحذف (البيان أو المطابقة) يمرّ
  if (was && now && was.bank === now.bank && was.amount === now.amount && was.no === now.no && was.source === now.source && was.live === now.live) return;
  const wasLive = was?.live ? was : null;
  const nowLive = now?.live ? now : null;
  // ما في السلة يبقى فيها: لا أثر له في رصيد
  if (!wasLive && !nowLive) return;
  const entryOf = (no: string) => (no ? db.get<{ id: string }>(`SELECT id FROM journal_entries WHERE no = ?`, [no]) : undefined);
  if (wasLive?.no && entryOf(wasLive.no)) {
    // حركة قيدٍ قائم: البيان والمصدر وحدهما
    if (!nowLive || nowLive.no !== wasLive.no || nowLive.bank !== wasLive.bank || nowLive.amount !== wasLive.amount) {
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
 * صفوف التحصيل على جهاز المالك (المتحقق المستقل، الجولة ٣٥ (أ٢ وأ٣ وأ٥)): الدفعة وسطورها وتخصيصها لا تتغير مبالغها ولا روابطها
 * بعد إنشائها أياً كان كاتبها (الإلغاء بـ cancelled_at، والتطبيق لا يعدّلها) · ودفعة العضو الجديدة: قيدٌ واحد لها، وقيدها
 * المرحّل يُعاد اشتقاقه منها · وسطورها وتخصيصها لا يتجاوزان المقبوض ولا المتبقي على أقساط عقدها
 */
const FROZEN_COLS: Record<string, string[]> = {
  contract_payments: ['contract_id', 'installment_id', 'date', 'gross_halalas', 'discount_halalas', 'net_halalas'],
  payment_lines: ['payment_id', 'method', 'bank_id', 'amount_halalas'],
  payment_allocations: ['payment_id', 'installment_id', 'amount_halalas'],
};
function collectionRowCheck(db: DB, doc: RemoteDoc, row: RowData): void {
  const frozen = FROZEN_COLS[doc.t];
  if (!frozen || getSyncState(db, 'membership')) return;
  const no = (why: string) => new Error(tr('derive.rejected', { why, lng: 'ar' }));
  const cur = db.get<Record<string, unknown>>(`SELECT * FROM "${doc.t}" WHERE id = ?`, [doc.k]);
  if (cur) {
    if (frozen.some((c) => c in row && String(cur[c] ?? '') !== String(row[c] ?? ''))) throw no(tr('derive.frozen', { lng: 'ar' }));
    // وقيد الدفعة لا يُستبدل بغيره (فكّه عند حذف قيده من السلة يبقى)
    if (doc.t === 'contract_payments' && row.journal_entry_id && cur.journal_entry_id && row.journal_entry_id !== cur.journal_entry_id) {
      throw no(tr('derive.frozen', { lng: 'ar' }));
    }
    // وإلغاء دفعةٍ لها قيد بعاكسٍ لقيدها وحده (المتحقق المستقل، الجولة ٣٧ (ر٥): كان الإلغاء بتعديلٍ وحده فيبقى قيدها لدفعةٍ ملغاة)
    if (doc.t === 'contract_payments' && row.cancelled_at && !cur.cancelled_at && cur.journal_entry_id) {
      // ودفعة العربون لا يلغيها عضو (المراجعة الشاملة · البند ٢٧ · المتحقق المستقل: جهاز العضو بنسخة قديمة يلغيها فيعود مبلغها
      // عالقاً في 2450) · وإلغاء المالك من جهازه الآخر يُقبل كما كتبه، فلا تفترق أجهزته، ورصيده العالق يُحمّر فحص عربون الحجوزات
      if (byMember(db, doc, false) && paidFromDeposit(db, doc.k)) throw no(tr('payment.cancelFromDeposit', { lng: 'ar' }));
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
    if (pay.method_label === CREDIT_METHOD || sum + (Number(row.amount_halalas) || 0) > (Number(pay.net_halalas) || 0)) throw no(tr('derive.method', { lng: 'ar' }));
    return;
  }
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

type ApplyOutcome = 'applied' | 'skipped' | 'conflict-local' | 'conflict-remote' | 'retry' | 'rejected';

function reject(db: DB, doc: RemoteDoc, reason: string): void {
  // المستند نفسه يُسحب ثانيةً في نافذة الأمان (البند ٢) · فرفضه بالسبب نفسه لا يتكرر في السجل ولا في سجل العمليات (التحقق المستقل)
  const payload = JSON.stringify(doc);
  if (db.get(`SELECT 1 FROM sync_rejects WHERE doc = ? AND reason = ? AND payload = ?`, [doc.id, reason, payload])) return;
  db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`,
    [doc.id, doc.t, doc.k, reason, payload, nowIso()]);
  // سبب الرفض كاملاً في sync_rejects على الجهاز، وفي سجل العمليات المزامَن محجوباً كنص العطل (المراجعة الشاملة · البند ١٧ ونظيره)
  try { logAudit(db, 'المزامنة', 'update', 'رفض وارد', `${doc.t} · ${doc.k} · ${redactForReport(reason)}`.slice(0, 300)); } catch { /* السجل لا يعطّل */ }
}

function applyOne(
  db: DB, doc: RemoteDoc, deviceId: string, cache: Map<string, Set<string>>, money: Map<string, string[]>, joining: boolean,
): ApplyOutcome {
  const t = syncTable(doc.t);
  if (!t) { reject(db, doc, 'جدول خارج المزامنة'); return 'rejected'; }
  // صدى ما كتبه هذا الجهاز · بمحتواه لا بمعرّف الجهاز وحده: العضو يكتب «dev» فينتحل الجهاز (مراجعة التثبيت #56)
  if (doc.dev === deviceId && isEcho(db, doc, deviceId)) return 'skipped';
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

  // القيد نفسه برقمٍ آخر في السحابة (استعادةٌ على جهازين بمعرّفٍ حتمي · المتحقق المستقل على bea2251): رقم المرحّل لا يتغير، فرقمه
  // في السحابة اسمٌ لرقمه هنا تُترجَم به حركات البنك المربوطة برقم القيد · ويُعرف قبل التعارض فمسار التعارض لا يفوته
  if (doc.t === 'journal_entries' && doc.d && typeof doc.d.no === 'string') {
    const here = db.get<{ no: string }>(`SELECT no FROM journal_entries WHERE id = ? AND status = 'مرحّل'`, [doc.k]); // i18n-exempt: حالة القيد المخزّنة
    if (here && here.no !== doc.d.no) noteJournalNoAlias(db, doc.d.no, here.no);
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
  let conflict: 'conflict-remote' | null = null;
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
    const localWins = !joining && (order > 0 || (order === 0 && deviceId > doc.dev));
    if (localWins) {
      logAudit(db, 'المزامنة', 'update', 'تعارض مزامنة', `${doc.t} · ${doc.k} · غلب تعديل هذا الجهاز (${mine}) على الوارد (${doc.u})`);
      return 'conflict-local';
    }
    conflict = 'conflict-remote';
  }
  // الوقت الوارد لا يتجاوز وقت كتابته في الخادم (#56)
  const theirs0 = incomingAt(doc);
  // ولا طابور: الوارد أقدم مما عرفه الجهاز للصف (رفعه أو طبّقه) لا يكتب فوقه، ويُرفع ما عنده فيتفق الأجهزة (المراجعة الخارجية ٧ ·
  // النتيجة ٨: دورة جهازٍ سحبت قبل تعديل غيره ودفعت بعده فكان الأقدم يغلب بلا أثر) · وأول دورةٍ للجهاز ما في الحساب يغلب
  if (!pending && !joining && !t.appendOnly) {
    const seen = db.get<{ u: string }>(`SELECT u FROM sync_rowtime WHERE tbl = ? AND pk = ?`, [doc.t, doc.k])?.u;
    if (seen && isoCmp(theirs0, seen) < 0) {
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

  // والرصيد الافتتاحي للبنك يضعه المالك وحده (المدقق الخارجي I١ · القاعدة ٩٩): مالٌ بلا قيد، فعضوٌ يرفعه ثم يسحبه نقداً كان يُدخل
  // المحفظة ما لا وجود له · فتعديل العضو له يُرفض ونسخة المالك تُعاد إلى السحابة، وبنكه الجديد بافتتاحيٍّ صفر
  // والعضو كاتب هذه النسخة بمسار قسمه (op) لا منشئ الصف: تعديل المالك لبنكٍ أنشأه عضو يحمل «by» العضو (المدقق الخارجي K٤: كان جهاز المالك
  // الثاني يرفض افتتاحي المالك نفسه فيتأرجح في السحابة)
  let bankOpeningZeroed = false;
  // وكذلك الرصيد الافتتاحي لحسابات الدليل (المدقق الخارجي M٧: افتتاحي 1100 من عضوٍ كان يُدخل المحفظة نقداً بلا قيد)
  if ((doc.t === 'banks' || doc.t === 'accounts') && !doc.del && !getSyncState(db, 'membership') && byMember(db, doc, false)) {
    const cur = db.get<{ o: number }>(`SELECT opening_halalas AS o FROM "${doc.t}" WHERE ${doc.t === 'accounts' ? 'code' : 'id'} = ?`, [doc.k]);
    const o = Number((doc.d as Record<string, unknown> | undefined)?.opening_halalas) || 0;
    if (cur && o !== (Number(cur.o) || 0)) {
      enqueue(db, doc.t, doc.k, 'upsert');
      reject(db, doc, tr('sync.bankOpeningOwner', { lng: 'ar' }));
      return 'rejected';
    }
    // وبنك العضو الجديد يُطبَّق بافتتاحيٍّ صفر وتُعاد نسخته كذلك، فلا تعلق حركاته (K٥: بنكٌ أُنشئ برصيدٍ قبل الترقية كان يُرفض كله)
    if (!cur && o !== 0) {
      doc.d = { ...(doc.d as Record<string, unknown>), opening_halalas: 0 };
      bankOpeningZeroed = true;
    }
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
        const fresh = doc.t === 'contracts' && !db.get(`SELECT 1 FROM contracts WHERE id = ?`, [doc.k]);
        upsertRow(db, doc.t, row, cols(doc.t));
        if (doc.t === 'contracts') keepUnknownOriginalEnd(db, doc.k, row, fresh);
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
          } catch { /* المخزَّن كما هو */ }
        }
        const issues = semanticIssues(db, scope, money);
        if (issues.length) throw new Error('الوارد مرفوض · ' + issues.join(' · '));
      }
      if (pending) db.run(`DELETE FROM sync_outbox WHERE tbl = ? AND pk = ?`, [doc.t, doc.k]);
      if (conflict) {
        logAudit(db, 'المزامنة', 'update', 'تعارض مزامنة', joining
          ? `${doc.t} · ${doc.k} · غلب ما في الحساب على نسخة هذا الجهاز عند انضمامه`
          : `${doc.t} · ${doc.k} · غلب الوارد (${doc.u}) على تعديل هذا الجهاز (${pending!.changed_at})`);
      }
    });
    noteRowTime(db, doc.t, doc.k, theirs0);
    if (bankOpeningZeroed) enqueue(db, doc.t, doc.k, 'upsert');
    return conflict ?? 'applied';
  } catch (e) {
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
  const money = moneyColumns(db); // مرة لكل تطبيق لا لكل صف
  const joining = getSyncState(db, 'joining') === '1';
  const touched = new Set<string>();
  /** ما له رفضُ انتظار (يملؤه restageArrivedParents في كل مرور) · فلا يُبحث في سجل المرفوض لكل صفٍّ يُطبَّق */
  const waitRejected = new Set<string>();
  /** معاملةٌ والوارد لا يرتدّ صداه إلى الطابور، ودفعةٌ سُجّلت على جهاز آخر لا يرفضها فحص «المتبقي» المحلي */
  const quiet = (fn: () => void) => db.transaction(() => {
    const wasOn = captureOn(db);
    setCapture(db, false);
    setApplying(db, true);
    try { fn(); } finally { setApplying(db, false); setCapture(db, wasOn); }
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
    recomputeInstallments(db, touched.has(ALL_INSTALLMENTS) ? undefined : [...touched]);
  });
  out.waiting = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_inbox`)!.n);
  // قيدٌ وصل ومستنده لا يصل (حذفته استعادة على جهاز آخر) يبقى ويُعلَّم للمراجعة (orphans.ts) ·
  // بعد اكتمال الوارد لا قبله، فالقيد يسبق مستنده في ترتيب التطبيق
  // جهاز العضو يحمل جزءاً من الدفتر بصلاحيته · فلا يُعلَّم ما غاب مصدره عنه يتيماً
  if ((out.applied || out.rejected) && !out.waiting && !getSyncState(db, 'membership')) markOrphans(db, 'وصل بالمزامنة');
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

/** الجداول التي يُحفظ مستندها كاملاً في اللقطة · ما يُضمّ مع القيد المرحّل */
export const SNAPSHOT_FULL = new Set(['journal_entries', 'contract_payments', 'payment_lines', 'payment_allocations', 'bank_tx', 'audit_log',
  'contract_installments', 'tenants']);

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
        if (finalDenied && r.tbl === 'journal_entries') {
          db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES (?,?,?,?,?,?)`,
            // i18n-exempt: سبب الرفض المخزَّن
            [docs[i].id, r.tbl, r.pk, 'نهائي في السحابة · نسخة هذا الجهاز تختلف عنها ولم تُرفع', JSON.stringify({ ...docs[i], companions: undefined }), nowIso()]);
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
          if (res.ok) {
            pushed++;
            // بوقت الالتزام في الخادم إن عُرف، ولا يتجاوز وقت المستند · وبلا وقت الخادم لا يُحفظ (الوارد يغلب كما كان)
            if (commitIso) noteRowTime(db, r.tbl, r.pk, isoCmp(docs[i].u, commitIso) < 0 ? docs[i].u : commitIso);
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

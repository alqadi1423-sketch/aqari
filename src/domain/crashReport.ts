/**
 * تقارير الأعطال إلى المالك (التوجيه الرابع ٤ · ٤ · قرار المالك 2026-11-07 «نعم توصلني»: تقارير أعطال الأعضاء تصل المالك بعد الحجب).
 *
 * العطل على أي جهازٍ في المنشأة صفٌّ في سجل العمليات بنوعٍ لا يقرؤه إلا المالك (OWNER_ONLY_AUDIT)، فيصله بالمزامنة نفسها بلا قناةٍ
 * جديدة · فيه: الموضع، ونوع الخطأ، وأثره محجوباً بـ redactForReport (لا اسم ولا رقم ولا مبلغ)، ورقم الإصدار، والمنصة.
 * والعضو يرفعه بمسار «العضو عن نفسه» (SELF_OP) وقاعدة السحابة memberCrashReport تحرسه: معرّفه «crash-<الكاتب>-<اليوم>-<الرتبة>»
 * برتبةٍ دون عشرين فلا يتجاوز عشرين في اليوم لكل كاتب، وحمولته دون حدّها · والجهاز يقف عند الحدّ نفسه قبلها فلا يرفع ما يُرفض.
 * دالةٌ خالصة إلا كتابة الصف (لا وحدات الجهاز)، فالمنصة تُمرَّر.
 */
import type { DB } from '../db/adapter';
import { redactForReport } from './redact';
import { auditActor, auditWriter, AUDIT_WRITER_SQL } from './audit';
import { APP_VERSION_LABEL } from '../version';

/** نوع الصف في سجل العمليات · قيمةٌ مخزّنة تقرؤها القواعد وقائمة الأقسام */
export const CRASH_ENTITY = 'تقرير عطل'; // i18n-exempt: قيمة مخزّنة
/** وحدة الصف في سجل العمليات */
export const CRASH_MODULE = 'تقارير الأعطال'; // i18n-exempt: قيمة مخزّنة
/** في اليوم لكل كاتب · تفرضه القاعدة برتبة المعرّف */
export const CRASH_DAILY_LIMIT = 20;
/** طول الحمولة (after_json) · دون حدّ القاعدة ٤٠٠٠ بهامشٍ لعدّ الحروف */
export const CRASH_BODY_MAX = 3800;
const WHERE_MAX = 120;

/**
 * يوم التقرير بتوقيت الخادم (UTC) كما تقرؤه القاعدة: yyyymmdd · عمداً لا باليوم المحلي (حارس localDates): القاعدة تقارنه بساعة
 * الخادم، ولا يُعرض للمستخدم يوماً
 */
export function crashDay(at: Date): string {
  const iso = at.toISOString();
  return iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10);
}

export interface CrashBody {
  /** رقم الإصدار والبناء */
  v: string;
  /** المنصة */
  p: string;
  /** نوع الخطأ */
  k: string;
  /** الأثر محجوباً */
  s: string;
}

/** حمولة التقرير دون حدّها: الأثر يُقصّ من آخره (أوله رسالة الخطأ وأقرب المواضع، وهي أنفعه) */
export function crashReportBody(e: unknown, platform: string): CrashBody {
  const stack = e instanceof Error ? (e.stack ?? (e.name + ': ' + e.message)) : String(e);
  const body: CrashBody = {
    v: APP_VERSION_LABEL, p: String(platform).slice(0, 20),
    k: (e instanceof Error ? e.name : typeof e).slice(0, 60), s: redactForReport(stack),
  };
  let over = JSON.stringify(body).length - CRASH_BODY_MAX;
  while (over > 0) {
    body.s = body.s.slice(0, Math.max(0, body.s.length - over - 16));
    over = JSON.stringify(body).length - CRASH_BODY_MAX;
  }
  return body;
}

/** الموضع نصٌّ من الكود، وقد يُبنى بقيمةٍ من المستخدم · فما بين «» والأرقام تُحجب، وطوله محدود */
const whereLabel = (where: string): string =>
  String(where ?? '').replace(/«[^»]*»/g, '«…»').replace(/[\d٠-٩]+/g, '#').slice(0, WHERE_MAX);

const syncValue = (db: DB, k: string): string | null => {
  try { return db.get<{ v: string | null }>(`SELECT v FROM sync_state WHERE k = ?`, [k])?.v ?? null; } catch { return null; }
};

/** كاتب المعرّف: حسابه إن دخل (والقاعدة تطابقه بحساب الطلب)، وإلا هوية الجهاز */
function writerKey(db: DB): string {
  const uid = syncValue(db, 'uid');
  if (uid) return uid;
  try {
    return db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'device_id'`)?.value || 'local';
  } catch { return 'local'; }
}

/**
 * يكتب التقرير صفاً في سجل العمليات · false إن بلغ الكاتب حدّ يومه أو تعذّرت الكتابة · ولا يرمي أبداً، فهو في مسار خطأٍ أصلاً
 */
export function recordCrashReport(db: DB, args: { where: string; e: unknown; platform: string; at?: Date }): boolean {
  try {
    const at = args.at ?? new Date();
    const prefix = `crash-${writerKey(db)}-${crashDay(at)}-`;
    const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE id LIKE ? ESCAPE '\\'`,
      [prefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%'])?.n ?? 0;
    if (n >= CRASH_DAILY_LIMIT) return false;
    db.run(
      `INSERT INTO audit_log (id, ts, user_name, module, action_type, entity_type, entity_name, before_json, after_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [prefix + n, at.toISOString().slice(0, 19), auditActor(db), CRASH_MODULE, 'update', CRASH_ENTITY, whereLabel(args.where),
        null, JSON.stringify(crashReportBody(args.e, args.platform))],
    );
    return true;
  } catch {
    return false;
  }
}

export interface CrashReportView {
  id: string; ts: string; who: string; where: string; version: string; platform: string; kind: string; stack: string;
}

/** تقارير الأعطال في آخر أيامٍ عددها days · الأحدث أولاً · لشاشة المالك */
export function crashReports(db: DB, days = 30, now: Date = new Date()): CrashReportView[] {
  const since = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 19);
  // والكاتب بمعرّفه (row_by الذي تفرضه القاعدة) لا بالاسم المكتوب في الصف (المدقق الخارجي F٣) · كسجل العمليات
  const owner = syncValue(db, 'org');
  return db.all<{ id: string; ts: string; user_name: string; entity_name: string; after_json: string | null; writer_uid: string | null; writer_name: string | null }>(
    `SELECT audit_log.id, audit_log.ts, audit_log.user_name, audit_log.entity_name, audit_log.after_json, rb.uid AS writer_uid, cp.name AS writer_name
     FROM audit_log ${AUDIT_WRITER_SQL}
     WHERE audit_log.entity_type = ? AND audit_log.ts >= ? ORDER BY audit_log.ts DESC, audit_log.id DESC LIMIT 200`,
    [CRASH_ENTITY, since],
  ).map((r) => {
    let b: Partial<CrashBody> = {};
    try { b = JSON.parse(r.after_json ?? '{}') as Partial<CrashBody>; } catch { b = {}; }
    return {
      id: r.id, ts: r.ts, who: auditWriter(r, owner).name, where: r.entity_name,
      version: String(b.v ?? ''), platform: String(b.p ?? ''), kind: String(b.k ?? ''), stack: String(b.s ?? ''),
    };
  });
}

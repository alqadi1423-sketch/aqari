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
import ar from '../i18n/locales/ar.json';

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

/** كلمات التطبيق العربية (من ملف ترجمته) · وكلمة الفشل التي تبدأ بها عناوين الحوار */
let appWords: Set<string> | null = null;
function knownWords(): Set<string> {
  if (appWords) return appWords;
  const words = new Set<string>(['تعذّر', 'تعذر', 'فشل']); // i18n-exempt: مطلع عناوين حوار الفشل
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { for (const w of v.split(/[^\u0620-\u065F\u066E\u066F\u0670-\u06D3\u06D5\u06EE\u06EF\u06FA-\u06FF]+/)) if (w) words.add(w); }
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(ar);
  return (appWords = words);
}

/**
 * الموضع نصٌّ من الكود، وقد يُبنى بقيمةٍ من المستخدم (المدقق الخارجي H٣: اسم الملف المرفوع، وفيه اسم المستأجر ورقمه، كان يصل المالك) ·
 * فما بين «» وكل رقمٍ بأي كتابة وكل كلمةٍ لاتينية أو بكتابةٍ أخرى تُحجب، والكلمة العربية تبقى إن كانت من كلمات التطبيق وحدها، وطوله محدود
 */
/** بادئة سطر الفشل في سجل العمليات (failureDialog) · وجهاز المالك يُسقط المرفوض منها عند الرفع كتقرير العطل (المدقق الخارجي H٨) */
export const FAILURE_ENTITY_PREFIX = 'فشل '; // i18n-exempt: نوع سطر الفشل المخزَّن
/** موضع الفشل محجوباً كموضع تقرير العطل · لسطر الفشل في سجل العمليات، ويقرؤه أعضاء المنشأة (H٣) */
export const failureWhere = (where: string): string => whereLabel(where);
const whereLabel = (where: string): string => {
  const known = knownWords();
  return String(where ?? '')
    .replace(/«[^»]*»/g, '«…»')
    .replace(/[\d٠-٩۰-۹]+/g, '#')
    .replace(/[^\s\u0600-\u06FF«»#…·:،.()\-]+/g, '…')
    // وحروف الكتابة العربية الممتدة (الفارسية والأردية: پ چ ژ ک گ ی ہ ھ …) من الكلمة نفسها (المدقق الخارجي J١٢: كانت تعبر وتقطعها)
    .replace(/[\u0620-\u065F\u066E\u066F\u0670-\u06D3\u06D5\u06EE\u06EF\u06FA-\u06FF]+/g, (w) => (known.has(w) ? w : '…'))
    .replace(/…(?:[\s.\-]*…)+/g, '…')
    // ولا يبقى بعد الكلمات الثلاث الأولى شيء: العنوان من الكود في أوله، وما بعده قد يكون اسماً كلماته من كلمات التطبيق نفسها
    // (المدقق الخارجي L٧: «باسم الشهري» يعبر كاملاً) · والأثر في الكود يحمل الموضع
    .replace(/^((?:\S+\s+){2}\S+)\s+\S[\s\S]*$/, '$1 …')
    .slice(0, WHERE_MAX);
};

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

/**
 * تقرير عطلٍ رفضته السحابة لعضو: قد تكون رتبته أخذها جهازٌ آخر للحساب نفسه في اليوم نفسه (المدقق الخارجي H٢: صفوف التقرير للمالك
 * وحده فلا يعرف الجهاز الثاني ما أخذه الأول) · فيُكتب من جديد بالرتبة التالية على هذا الجهاز ما دام دون حدّ اليوم، والقاعدة تحدّ
 * الحساب بعشرين في اليوم أياً كان جهازه · false إن لم يُعَد
 */
export function retryCrashRank(db: DB, row: Record<string, unknown> | undefined, at?: Date): boolean {
  try {
    const id = String(row?.id ?? '');
    const m = /^(crash-.+-\d{8}-)(\d+)$/.exec(id);
    if (!m || !row) return false;
    const prefix = m[1];
    // والرفض الذي لا تغيّره الرتبة لا يُعاد (المدقق الخارجي J١١: يومٌ خارج نافذة القاعدة لجهازٍ عاد بعد أيامٍ بلا اتصال كان يصير عشرين
    // صفاً كلها مرفوضة) · فالإعادة ليومٍ في نافذتها وحده (crashDayOk: بعد ثمانية أيامٍ مضت وقبل غد)، بهامش يومٍ لساعة الجهاز
    const day = /-(\d{8})-$/.exec(prefix)?.[1] ?? '';
    const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)));
    const nowMs = (at ?? new Date()).getTime();
    if (!Number.isFinite(t) || t <= nowMs - 7 * 86400000 || t > nowMs) return false;
    const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE id LIKE ? ESCAPE '\\'`,
      [prefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%'])?.n ?? 0;
    if (n >= CRASH_DAILY_LIMIT) return false;
    db.run(
      `INSERT INTO audit_log (id, ts, user_name, module, action_type, entity_type, entity_name, before_json, after_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [prefix + n, String(row.ts ?? ''), String(row.user_name ?? ''), CRASH_MODULE, 'update', CRASH_ENTITY, String(row.entity_name ?? ''), null,
        row.after_json == null ? null : String(row.after_json)],
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

/**
 * «نسيت الرمز» في قفل التطبيق (المراجعة الشاملة · البند ٥ · قرار المالك 2026-10-15 «٢»: التحقق بقوقل ثم رمزٌ جديد) · منطقٌ خالص:
 *  - تأكيد الحساب دخولٌ جديد بعد خروجٍ من قوقل: رمز هوية Firebase الناتج يشهد برقم الحساب وبأنه صدر عند الدخول لا بتجديد
 *    (iat قريب من auth_time، وكلاهما بساعة الخادم). وهو لا يشهد بإدخال كلمة مرور قوقل: قوقل على الجهاز يعطي رمز الحساب المضاف
 *    إليه بلا كلمة مرور · فلا يمنع من يحمل الجهاز وحسابه عليه، وما يمنعه: إعادة الضبط الصامتة، وحسابٌ آخر، وتكرارها، وألا تُرى.
 *  - ثلاث إعادات ضبطٍ في ٢٤ ساعة بساعة الخادم (iat) · لا يُحسب إلا ما بلغ الدخول وصحّ (المتحقق المستقل: فشل الشبكة وغياب الحساب
 *    وانحراف الساعة كانت تستهلك المحاولات فيُحبس المالك يوماً) · وقبل النافذة تقديرٌ بساعتي الجهاز يُخفي الزر، والخادم يحسم بعد الدخول.
 *  - إعادة الضبط سطرٌ في سجل العمليات يُزامَن، وتنبيهٌ عند الفتح التالي حتى يُقرّ به.
 */
import type { DB } from '../db/adapter';
import { logAudit } from './audit';
import { dfmt, toLocalISODate } from './dates';
import { SELF_AUDIT_ENTITY, SELF_AUDIT_MODULE } from './access/opWrites';

export const RESET_LIMIT = 3;
export const RESET_WINDOW_MS = 24 * 3_600_000;
/** أقصى ما بين الدخول (auth_time) وإصدار الرمز (iat) بساعة الخادم: أبعد منه رمزٌ مجدَّد لا دخول */
export const AUTH_FRESH_MS = 5 * 60_000;
/** ما يُحفظ من إعادات الضبط: الحدّ وما قبله */
const KEEP = RESET_LIMIT * 2;

/* ═══ رمز JWT: الحمولة بلا Buffer ولا atob (غير مضمونين على Hermes) ═══ */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64urlBytes(s: string): number[] | null {
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of s.replace(/=+$/, '')) {
    const v = B64.indexOf(ch === '+' ? '-' : ch === '/' ? '_' : ch);
    if (v < 0) return null;
    buf = ((buf << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return out;
}
function utf8(b: number[]): string {
  let s = '';
  for (let i = 0; i < b.length;) {
    const c = b[i++];
    const more = c < 0x80 ? 0 : c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : 1;
    let cp = more === 0 ? c : c & (0x3f >> more);
    for (let k = 0; k < more; k++) cp = (cp << 6) | ((b[i++] ?? 0) & 0x3f);
    s += String.fromCodePoint(cp);
  }
  return s;
}

/** حمولة رمز JWT · null إن لم يكن رمزاً · التوقيع لا يُفحص هنا (الرمز من ردّ Firebase نفسه عبر HTTPS) */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  const bytes = b64urlBytes(parts[1]);
  if (!bytes) return null;
  try {
    const v = JSON.parse(utf8(bytes)) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

export type ProofCheck = { ok: true; serverMs: number } | { ok: false; why: 'bad' | 'uid' | 'provider' | 'stale' };

/**
 * رمز هوية Firebase من دخولٍ جديد بقوقل للحساب المحفوظ · serverMs وقت إصداره بساعة الخادم (iat) ·
 * auth_time يبقى على وقت الدخول في كل تجديد، فصدورُ الرمز بعد الدخول بأكثر من المهلة رمزٌ مجدَّد لا دخول ·
 * ولا تُقارن ساعة الجهاز (المتحقق المستقل: كانت ترفض المالك إن انحرفت دقائق، والرمز من ردّ signInWithIdp الآن فلا يكون قديماً)
 */
export function checkAccountProof(idToken: string, uid: string): ProofCheck {
  const c = jwtClaims(idToken);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v * 1000 : null);
  const at = num(c?.auth_time), iat = num(c?.iat);
  if (!c || at === null || iat === null) return { ok: false, why: 'bad' };
  if ((c.user_id ?? c.sub) !== uid) return { ok: false, why: 'uid' };
  if ((c.firebase as { sign_in_provider?: unknown } | undefined)?.sign_in_provider !== 'google.com') return { ok: false, why: 'provider' };
  if (iat < at || iat - at > AUTH_FRESH_MS) return { ok: false, why: 'stale' };
  return { ok: true, serverMs: iat };
}

/* ═══ حدّ إعادة الضبط ═══ */

/** الآن بساعتي الجهاز · trusted: الرتيبة الأصلية حاضرة (منذ الإقلاع وتعدّ النوم · services/appLockService.ts) */
export interface ClockNow { wall: number; mono: number; trusted: boolean }
/** إعادة ضبطٍ تمّت · n تسلسلها على الجهاز · server وقت رمز هويتها بساعة الخادم · وساعتا الجهاز عندها */
export interface ResetAttempt extends ClockNow { n: number; server: number }
/**
 * سجلّ إعادة الضبط على الجهاز · notice: تسلسل آخر إعادة ضبطٍ (noticeAt وقتها بساعة الخادم) · seen: ما أُقرّ بتنبيهه ·
 * audited: ما كُتب سطره في سجل العمليات
 */
export interface ResetLog { attempts: ResetAttempt[]; notice: number; noticeAt: number; seen: number; audited: number }

export const emptyResetLog = (): ResetLog => ({ attempts: [], notice: 0, noticeAt: 0, seen: 0, audited: 0 });

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** السجل كما حُفظ · null إن تعذّر فهمه (لا يُعامل فارغاً: الحدّ لا يسقط بالشك) */
export function parseResetLog(raw: string | null): ResetLog | null {
  if (raw === null) return emptyResetLog();
  let v: Partial<ResetLog> | null;
  try { v = JSON.parse(raw) as Partial<ResetLog>; } catch { return null; }
  if (!v || typeof v !== 'object' || !Array.isArray(v.attempts)) return null;
  const attempts = v.attempts.filter((a): a is ResetAttempt => !!a && finite(a.n) && finite(a.wall) && finite(a.mono) && finite(a.server))
    .map((a) => ({ n: a.n, wall: a.wall, mono: a.mono, trusted: a.trusted === true, server: a.server }));
  const n = (x: unknown) => (finite(x) ? x : 0);
  return { attempts, notice: n(v.notice), noticeAt: n(v.noticeAt), seen: n(v.seen), audited: n(v.audited) };
}

/** نسختا السجل (المخزن الآمن والملف) تُدمجان: مسح إحداهما لا يُسقط ما في الأخرى */
export function mergeResetLogs(a: ResetLog, b: ResetLog): ResetLog {
  const byN = new Map<number, ResetAttempt>();
  for (const x of [...a.attempts, ...b.attempts]) if (!byN.has(x.n)) byN.set(x.n, x);
  const attempts = [...byN.values()].sort((x, y) => x.n - y.n).slice(-KEEP);
  const last = a.notice >= b.notice ? a : b;
  return { attempts, notice: last.notice, noticeAt: last.noticeAt, seen: Math.max(a.seen, b.seen), audited: Math.max(a.audited, b.audited) };
}

/**
 * كم مضى على لحظةٍ بساعتي الجهاز · في التشغيل نفسه الرتيبة وحدها (لا يغيّرها المستخدم) · والتشغيل نفسه أن الرتيبة لم
 * تتراجع وأن الإقلاع (ساعة الجهاز ناقص الرتيبة) قبل تلك اللحظة: المتحقق المستقل · الرتيبة بعد إعادة التشغيل قد تتجاوز قيمتها
 * القديمة فكانت تُطرح قيمتان من تشغيلين فيُحجب المالك من جديد بلا محاولة · وبعد إعادة التشغيل ساعة الجهاز وما مضى منذ الإقلاع
 * حدٌّ أدنى · وبلا رتيبة موثوقة ساعة الجهاز، والمُرجَعة إلى ما قبلها حديثة · وتقديم الساعة بأكثر مما مضى من التشغيل عند تلك
 * اللحظة يشبه إعادة التشغيل فيُظهر الزر، وساعة الخادم بعد الدخول ترفض (serverWaitMs)
 */
export function attemptAge(a: ClockNow, now: ClockNow): number {
  const w = now.wall - a.wall;
  if (a.trusted && now.trusted) {
    const sameBoot = now.mono >= a.mono && now.wall - now.mono <= a.wall;
    return sameBoot ? now.mono - a.mono : Math.max(w, now.mono);
  }
  return Math.max(0, w);
}

/** كم بقي حتى تجوز إعادة ضبطٍ أخرى بأعمار ما سبق (٠ إن جازت) */
function waitFrom(ages: number[]): number {
  const recent = ages.map((x) => Math.max(0, x)).filter((x) => x < RESET_WINDOW_MS).sort((x, y) => y - x);
  if (recent.length < RESET_LIMIT) return 0;
  return Math.max(1, RESET_WINDOW_MS - recent[recent.length - RESET_LIMIT]);
}

/**
 * قبل نافذة قوقل: تقديرٌ بساعتي الجهاز يُخفي الزر · عمر آخر إعادة ضبطٍ بساعتي الجهاز، وما قبلها بفارق ساعة الخادم عنها
 * (فلا تُقارن ساعة الجهاز بين تشغيلين إلا مرة)
 */
export function resetWaitMs(log: ResetLog, now: ClockNow): number {
  if (log.attempts.length < RESET_LIMIT) return 0;
  const latest = log.attempts.reduce((x, y) => (y.server > x.server ? y : x));
  const base = attemptAge(latest, now);
  return waitFrom(log.attempts.map((a) => base + (latest.server - a.server)));
}

/** بعد الدخول: بساعة الخادم في رمز الهوية وحدها (لا تغيّرها ساعة الجهاز ولا إعادة تشغيله) · ٠ إن جازت */
export function serverWaitMs(log: ResetLog, serverMs: number): number {
  return waitFrom(log.attempts.map((a) => serverMs - a.server));
}

/** إعادة ضبطٍ تمّت تُحفظ قبل أن تُعطى · وتنبيهها بساعة الخادم (ساعة الجهاز تُغيَّر) */
export function recordReset(log: ResetLog, now: ClockNow, serverMs: number): ResetLog {
  const n = log.attempts.reduce((m, a) => Math.max(m, a.n), Math.max(log.notice, log.seen, log.audited)) + 1;
  return { ...log, attempts: [...log.attempts, { n, ...now, server: serverMs }].slice(-KEEP), notice: n, noticeAt: serverMs };
}

export const noticePending = (log: ResetLog): { at: number } | null => (log.notice > log.seen ? { at: log.noticeAt } : null);
export const ackNotice = (log: ResetLog): ResetLog => ({ ...log, seen: log.notice });
export const auditPending = (log: ResetLog): boolean => log.notice > log.audited;
export const markAudited = (log: ResetLog, n: number): ResetLog => ({ ...log, audited: Math.max(log.audited, n) });

/** وقت التنبيه بتوقيت الجهاز وبصيغة التطبيق: dd/mm/yyyy HH:MM (dfmt · كآخر مزامنة في الإعدادات) */
export function resetWhen(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${dfmt(toLocalISODate(d))} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * سطر إعادة الضبط في سجل العمليات (يُزامَن) · العضو يكتبه بنوع «بيانات عضو» الذي تجيزه القواعد لكل عضو بلا قسمٍ مُجاز
 * (rulesGen: memberSelfAudit) فيبلغ المالك · والهوية لا تُكتب
 */
export function logLockReset(db: DB, atMs: number): void {
  let member = false;
  try { member = !!db.get<{ v: string | null }>(`SELECT v FROM sync_state WHERE k = 'membership'`)?.v; } catch { member = false; }
  const what = 'قفل التطبيق · أُعيد ضبط رمزه بتأكيد حساب قوقل'; // i18n-exempt: سطر سجل العمليات المخزَّن
  const at = { الوقت: resetWhen(atMs) };
  if (member) logAudit(db, SELF_AUDIT_MODULE, 'update', SELF_AUDIT_ENTITY, what, null, at);
  else logAudit(db, 'قفل التطبيق', 'update', 'رمز القفل', what, null, at); // i18n-exempt: سطر سجل العمليات المخزَّن
}

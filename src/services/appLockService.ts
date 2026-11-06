/**
 * قفل التطبيق على الجهاز (#51 · المنطق في domain/appLock.ts): إعداده في المخزن الآمن، وعلامةٌ في ملفات التطبيق تقول إنه
 * مفعّل فلا يسقط بصمت إن تعذّرت قراءة المخزن (كعلامة كلمة مرور النسخ، «ثالثاً أ ٩») · وقفل الجهاز بـexpo-local-authentication
 */
import { NativeModules } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { File, Paths } from 'expo-file-system';
import { deviceCipher } from './cipher';
import { hashPin, pinMatches, parseLockConfig, waitLeft, type LockConfig, type LockDelay } from '../domain/appLock';
import {
  emptyResetLog, parseResetLog, mergeResetLogs, resetWaitMs, serverWaitMs, recordReset, noticePending, ackNotice, auditPending, markAudited,
  type ResetLog, type ClockNow } from '../domain/lockReset';
import type { AccountProof } from '../cloud/session';
import { t } from '../i18n';

const KEY = 'aqari_app_lock';
const flagFile = () => new File(Paths.document, 'app-lock.flag');
// تعذّر فحص العلامة يُعدّ «مفعّل»: لا يسقط القفل بالشك (المتحقق المستقل · كعلامة كلمة مرور النسخ)
const flagged = (): boolean => { try { return flagFile().exists; } catch { return true; } };
function setFlag(on: boolean): void {
  const f = flagFile();
  if (on) { if (!f.exists) f.write('1'); } else if (f.exists) f.delete();
}

/** بلا علامة لا قفل (قراءةٌ متزامنة · فلا يتأخر أول رسم لمن لم يفعّله) */
export const lockMaybeOn = (): boolean => flagged();

export async function loadLock(): Promise<LockConfig> {
  let raw: string | null = null;
  try { raw = await SecureStore.getItemAsync(KEY); } catch { raw = null; }
  return parseLockConfig(raw, flagged());
}

// بوابة القفل تحفظ آخر إعداد لتقرر عند العودة من الخلفية فوراً (ui/LockGate.tsx) · فيُبلَّغ كل حفظ
const listeners = new Set<(c: LockConfig) => void>();
export function onLockChange(f: (c: LockConfig) => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

async function save(c: LockConfig): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(c));
  setFlag(c.on);
  listeners.forEach((f) => f(c));
}

/** للجهاز قفلٌ (بصمة أو وجه أو رمز الجهاز) يُفتح به التطبيق */
export async function deviceLockAvailable(): Promise<boolean> {
  // SECRET رمز الجهاز أو نمطه وحده، وما فوقه بصمة أو وجه · NONE لا قفل للجهاز
  try { return (await LocalAuthentication.getEnrolledLevelAsync()) !== LocalAuthentication.SecurityLevel.NONE; } catch { return false; }
}

/**
 * نافذة البصمة ونافذة قوقل ومنتقي الملفات والكاميرا والمشاركة تُخرج التطبيق إلى الخلفية · لا يُحسب ذلك خروجاً فيُقفل عند العودة
 * القصيرة (domain/appLock.ts: decideReturn) · والنافذة التي لا يعود وعدها أبداً (منتقٍ أُعيد إنشاء شاشته تحت ضغط الذاكرة) لا تُعدّ
 * مفتوحةً بعد PROMPT_MAX_MS (المتحقق المستقل، الجولة السابعة: كانت تبقى مفتوحةً بقية التشغيل فتصير «فوراً» مهلةً دقيقة)
 */
export const PROMPT_MAX_MS = 10 * 60_000;
const prompts = new Map<number, number>();
let promptSeq = 0;
let promptEndedAt = -Infinity;
export function promptActive(): boolean {
  const now = monoNow();
  for (const at of prompts.values()) if (now - at < PROMPT_MAX_MS) return true;
  return now - promptEndedAt < 1500;
}
export async function whilePrompting<R>(fn: () => Promise<R>): Promise<R> {
  const id = ++promptSeq;
  prompts.set(id, monoNow());
  try { return await fn(); } finally { prompts.delete(id); promptEndedAt = monoNow(); }
}

/** طلب قفل الجهاز · true إن فُتح */
export const askDevice = (): Promise<boolean> => whilePrompting(askDeviceNow);
async function askDeviceNow(): Promise<boolean> {
  try {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: t('lock.prompt'), cancelLabel: t('lock.cancel'), disableDeviceFallback: false,
    });
    return r.success;
  } catch { return false; }
}

export async function enableDeviceLock(delay: LockDelay): Promise<void> {
  await save({ on: true, method: 'device', delay });
}

export async function enablePinLock(pin: string, delay: LockDelay): Promise<void> {
  await save({ on: true, method: 'pin', delay, pin: await hashPin(deviceCipher, pin), fails: 0, failAt: 0 });
}

export async function setLockDelay(delay: LockDelay): Promise<void> {
  const c = await loadLock();
  if (c.on) await save({ ...c, delay });
}

export async function disableLock(): Promise<void> {
  try { await SecureStore.deleteItemAsync(KEY); } finally { setFlag(false); }
  listeners.forEach((f) => f(parseLockConfig(null, false)));
}

/**
 * الساعة الرتيبة (لا يغيّرها المستخدم) · على أندرويد منذ إقلاع الجهاز وتعدّ نومه (AqariClock.kt · المتحقق المستقل، الجولة
 * السادسة: performance.now تقف أثناء النوم) · وحيث لا تكون فـperformance.now، وإلا ساعة الجهاز فلا يدوم الانتظار أبداً
 */
const clock = (NativeModules.AqariClock as { elapsedRealtime(): number } | undefined) ?? null;
function nativeMs(): number | null {
  try { const v = clock?.elapsedRealtime(); return typeof v === 'number' && Number.isFinite(v) ? v : null; } catch { return null; }
}
export function monoNow(): number {
  const v = nativeMs();
  if (v !== null) return v;
  const p = globalThis.performance?.now?.();
  return typeof p === 'number' && Number.isFinite(p) ? p : Date.now();
}
/** الساعة الأصلية حاضرةٌ تعمل · وإلا فالعودة من الخلفية تُقفل أياً كانت المهلة (يُرى العطل ولا يُفتح به القفل) */
export const clockTrusted = (): boolean => nativeMs() !== null;
// وقت آخر خطأ بالساعة الرتيبة في هذا التشغيل · وبعد إعادة التشغيل يُحسب الانتظار من بدئه (domain/appLock.ts: waitLeft)
let lastFailMono: number | null = null;
const startMono = monoNow();

/** محاولة رمز · 'ok' أو 'wrong' أو انتظارٌ بالمللي ثانية */
export async function tryPin(pin: string): Promise<'ok' | 'wrong' | number> {
  const c = await loadLock();
  if (c.method !== 'pin' || !c.pin) return 'wrong';
  const wait = waitLeft(c.fails ?? 0, lastFailMono ?? startMono, monoNow());
  if (wait > 0) return wait;
  if (await pinMatches(deviceCipher, pin, c.pin)) {
    lastFailMono = null;
    await save({ ...c, fails: 0, failAt: 0 });
    return 'ok';
  }
  lastFailMono = monoNow();
  await save({ ...c, fails: (c.fails ?? 0) + 1, failAt: Date.now() });
  return 'wrong';
}

/* ═══ «نسيت الرمز» (المراجعة الشاملة · البند ٥ · المنطق في domain/lockReset.ts) ═══ */

// سجلّ إعادة الضبط بنسختين: المخزن الآمن وملفٌ في ملفات التطبيق (لا في الذاكرة المؤقتة) · لا يمسّه إيقاف القفل ولا تغيير الرمز
// ولا إعادة التشغيل، ومسح إحدى النسختين لا يُسقطه · وتعذّر قراءتهما معاً يحجب ولا يفتح
const RESET_KEY = 'aqari_lock_resets';
const resetFile = () => new File(Paths.document, 'app-lock-resets.json');
const clockNow = (): ClockNow => ({ wall: Date.now(), mono: monoNow(), trusted: clockTrusted() });

async function readResetLog(): Promise<ResetLog> {
  // undefined: لا نسخة · null: نسخةٌ تعذّرت قراءتها أو فهمها
  let a: ResetLog | null | undefined, b: ResetLog | null | undefined;
  try { const raw = await SecureStore.getItemAsync(RESET_KEY); a = raw === null ? undefined : parseResetLog(raw); } catch { a = null; }
  try { const f = resetFile(); b = f.exists ? parseResetLog(f.textSync()) : undefined; } catch { b = null; }
  if (a && b) return mergeResetLogs(a, b);
  if (a || b) return (a || b)!;
  if (a === undefined && b === undefined) return emptyResetLog();
  throw new Error('reset log unreadable');
}
async function writeResetLog(log: ResetLog): Promise<void> {
  const raw = JSON.stringify(log);
  let ok = false;
  try { await SecureStore.setItemAsync(RESET_KEY, raw); ok = true; } catch { /* يبقى الملف */ }
  try { resetFile().write(raw); ok = true; } catch { /* يبقى المخزن الآمن */ }
  if (!ok) throw new Error('reset log unwritable');
}

/** للبوابة عند كل فتح بلا قراءةٍ غير متزامنة لمن لم يُعِد ضبطاً قط */
export const resetLogPresent = (): boolean => { try { return resetFile().exists; } catch { return true; } };

export interface ResetStatus { waitMs: number | null; notice: { at: number } | null }
/** waitMs: كم بقي حتى تجوز إعادة ضبط (٠ إن جازت · null: تعذّرت قراءة السجل، لا «بعد ٢٤ ساعة») · notice: إعادة ضبطٍ لم يُقرّ بتنبيهها */
export async function resetStatus(): Promise<ResetStatus> {
  try {
    const log = await readResetLog();
    return { waitMs: resetWaitMs(log, clockNow()), notice: noticePending(log) };
  } catch { return { waitMs: null, notice: null }; }
}

export type Recovery = { ok: true } | { ok: false; why: 'limit' | 'device' | 'store' | Extract<AccountProof, { ok: false }>['why']; waitMs?: number };

async function flushAudit(log: ResetLog, audit: (atMs: number) => void): Promise<void> {
  if (!auditPending(log)) return;
  const n = log.notice;
  try { audit(log.noticeAt); } catch { return; }
  try { await writeResetLog(markAudited(await readResetLog(), n)); } catch { /* يُعاد عند الفتح التالي فيتكرر السطر وحده */ }
}

/**
 * إعادة ضبط الرمز بتأكيد الحساب · prove دخولٌ جديد بقوقل (services/cloud.ts: confirmSameAccount) · audit يكتب سطر سجل العمليات
 * (تعذّره يُعاد عند الفتح التالي) · الحدّ قبل النافذة بساعتي الجهاز وبعد الدخول بساعة الخادم · وللجهاز قفلٌ أُضيف بعد اختيار
 * الرمز: يُطلب قبل قوقل · ok: يُختار رمزٌ جديد · ولا يُحسب إلا ما بلغ الدخول وصحّ، ويُحفظ قبل أن يُعطى (المتحقق المستقل: المحاولة
 * كانت تُحفظ قبل النافذة فيُحبس المالك يوماً بثلاث نقرات بلا شبكة أو بعد الخروج، وحفظها قبل النافذة لا يحمي شيئاً: النجاح لا
 * يُعطى إلا بعد حفظه) · ورفض الخادم يعطي كم بقي بساعته فيختفي الزر
 */
export async function recoverByAccount(prove: () => Promise<AccountProof>, audit: (atMs: number) => void): Promise<Recovery> {
  let log: ResetLog;
  try { log = await readResetLog(); } catch { return { ok: false, why: 'store' }; }
  const wait = resetWaitMs(log, clockNow());
  if (wait > 0) return { ok: false, why: 'limit', waitMs: wait };
  if ((await deviceLockAvailable()) && !(await askDevice())) return { ok: false, why: 'device' };
  let proof: AccountProof;
  try { proof = await prove(); } catch { proof = { ok: false, why: 'error' }; }
  if (!proof.ok) return { ok: false, why: proof.why };
  // يُقرأ من جديد بعد النافذة: ما كُتب أثناءها لا يُمحى
  try { log = await readResetLog(); } catch { return { ok: false, why: 'store' }; }
  const serverWait = serverWaitMs(log, proof.serverMs);
  if (serverWait > 0) return { ok: false, why: 'limit', waitMs: serverWait };
  const next = recordReset(log, clockNow(), proof.serverMs);
  try { await writeResetLog(next); } catch { return { ok: false, why: 'store' }; }
  await flushAudit(next, audit);
  return { ok: true };
}

/** سطر سجل العمليات الذي تعذّر عند إعادة الضبط يُكتب عند الفتح التالي */
export async function flushResetAudit(audit: (atMs: number) => void): Promise<void> {
  let log: ResetLog;
  try { log = await readResetLog(); } catch { return; }
  await flushAudit(log, audit);
}

/** أُقرّ بتنبيه إعادة الضبط */
export async function ackResetNotice(): Promise<void> {
  await writeResetLog(ackNotice(await readResetLog()));
}

/**
 * ما يجري عند فتح البوابة (ui/LockGate.tsx) · recovered: الفتح التالي يلي إعادة الضبط نفسها فلا يُنبَّه فيه · opened: سطر السجل
 * المتعذّر يُكتب، وتنبيه إعادة ضبطٍ لم يُقرّ بها يُعرض بـshow (مرةً حتى يُقرّ به: ack)
 */
export function resetNotices(audit: (atMs: number) => void) {
  let skip = false;
  let shown = false;
  return {
    recovered(): void { skip = true; },
    async opened(show: (atMs: number, ack: () => Promise<void>) => void): Promise<void> {
      if (skip) { skip = false; return; }
      if (shown || (!lockMaybeOn() && !resetLogPresent())) return;
      await flushResetAudit(audit).catch(() => undefined);
      const st = await resetStatus();
      if (!st.notice || shown) return;
      shown = true;
      show(st.notice.at, async () => { shown = false; await ackResetNotice().catch(() => undefined); });
    },
  };
}

/**
 * قفل التطبيق (#51 · قرار المالك 2026-10-07: «أ. قفل اختياري بالبصمة أو برمز الآن، والتشفير لاحقاً») · منطقٌ بلا خدمات الجهاز:
 *  - الطريقة: قفل الجهاز (البصمة أو الوجه، أو رمز الجهاز بديلاً) إن كان للجهاز قفل · وإلا رمزٌ للتطبيق من ٤ إلى ٨ أرقام.
 *  - متى يُقفل: عند كل تشغيل، وعند العودة من الخلفية بعد المهلة التي يختارها (فوراً، أو دقيقة، أو خمس دقائق).
 *  - الرمز لا يُحفظ: ملحٌ عشوائي وPBKDF2 كنسخ الاحتياط، والمقارنة بزمنٍ ثابت · والمحاولات الخاطئة تُبطئ ما بعدها.
 *  - القفل يحجب الواجهة وحدها · وتشفير القاعدة مرحلةٌ لاحقة بقرار المالك.
 */
import type { CipherProvider } from './backup/encryption';

export type LockMethod = 'device' | 'pin';
export const LOCK_DELAYS = [0, 60, 300] as const;
export type LockDelay = (typeof LOCK_DELAYS)[number];

export interface PinHash { salt: string; hash: string; iterations: number }
export interface LockConfig { on: boolean; method: LockMethod; delay: LockDelay; pin?: PinHash; fails?: number; failAt?: number }

export const PIN_ITERATIONS = 200_000;
export const pinShapeOk = (pin: string): boolean => /^[0-9]{4,8}$/.test(pin);

// ست عشري: بلا Buffer (غير موجود على Hermes)
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

export async function hashPin(c: CipherProvider, pin: string, iterations = PIN_ITERATIONS): Promise<PinHash> {
  const salt = await c.random(16);
  return { salt: hex(salt), hash: hex(await c.pbkdf2(pin, salt, iterations)), iterations };
}

export async function pinMatches(c: CipherProvider, pin: string, h: PinHash): Promise<boolean> {
  const got = await c.pbkdf2(pin, unhex(h.salt), h.iterations);
  const want = unhex(h.hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

/** مهلة الانتظار بعد المحاولات الخاطئة · خمسٌ بلا انتظار، ثم ٣٠ ثانية تتضاعف حتى ساعة */
export function lockoutMs(fails: number): number {
  if (fails < 5) return 0;
  return Math.min(30_000 * 2 ** (fails - 5), 3_600_000);
}
/**
 * كم بقي من الانتظار الآن (٠ إن جازت المحاولة) · بساعةٍ رتيبة منذ آخر خطأ في هذا التشغيل، أو منذ بدء التشغيل إن لم يكن
 * (المتحقق المستقل: ساعة الجهاز المقدَّمة كانت تُنهي الانتظار) · فإغلاق التطبيق يعيد الانتظار كاملاً ولا يقصّره
 */
export function waitLeft(fails: number, sinceMono: number, nowMono: number): number {
  const ms = lockoutMs(fails);
  return ms ? Math.max(0, ms - Math.max(0, nowMono - sinceMono)) : 0;
}

/** العودة من نافذة البصمة أو قوقل خلال هذه المدة لا تُعدّ خروجاً (بالساعتين معاً) */
export const PROMPT_GRACE_MS = 60_000;

/** خروجٌ إلى الخلفية · بساعة الجهاز وبالساعة الرتيبة · prompting: خرج والنافذة مفتوحة */
export interface Away { wall: number; mono: number; prompting: boolean }

/**
 * قرار العودة من الخلفية بلا انتظار (المتحقق المستقل: القرار كان بعد قراءةٍ غير متزامنة فيظهر المحتوى لحظة) ·
 * cfg null والقفل مُعلَّم: يُقفل · والخروج أثناء نافذة البصمة أو قوقل يُعفى إن قصُر وحده (كان يُلغي القفل كله)
 */
export function decideReturn(cfg: Pick<LockConfig, 'on' | 'delay'> | null, flagged: boolean, away: Away | null, wallNow: number, monoNow: number): boolean {
  if (!away) return false;
  if (!cfg) return flagged;
  const w = wallNow - away.wall, m = monoNow - away.mono;
  if (away.prompting && w >= 0 && w < PROMPT_GRACE_MS && m < PROMPT_GRACE_MS) return false;
  return lockOnReturn(cfg, w, m);
}

/**
 * هل يُقفل عند العودة من الخلفية · المدة بساعة الجهاز وبالساعة الرتيبة معاً: أيهما بلغ المهلة أقفل، وساعةٌ أُرجعت إلى الوراء
 * تُقفل (المتحقق المستقل: الفرق السالب كان يمنع القفل) · والرتيبة قد لا تعدّ نوم الجهاز فلا يُعتمد عليها وحدها
 */
export function lockOnReturn(cfg: Pick<LockConfig, 'on' | 'delay'>, awayWallMs: number | null, awayMonoMs: number | null): boolean {
  if (!cfg.on || awayWallMs === null) return false;
  const d = cfg.delay * 1000;
  return awayWallMs < 0 || awayWallMs >= d || (awayMonoMs ?? 0) >= d;
}

/** إعداد القفل كما حُفظ · وما لا يُفهم يعامَل «مفعّلاً بقفل الجهاز» إن كان مُعلَّماً بأنه مفعّل (لا يسقط القفل بصمت) */
export function parseLockConfig(raw: string | null, flagged: boolean): LockConfig {
  const off: LockConfig = { on: false, method: 'device', delay: 0 };
  let c: Partial<LockConfig> | null = null;
  try { c = raw ? (JSON.parse(raw) as Partial<LockConfig>) : null; } catch { c = null; }
  if (!c || typeof c.on !== 'boolean') return flagged ? { on: true, method: 'device', delay: 0 } : off;
  const method: LockMethod = c.method === 'pin' && c.pin ? 'pin' : 'device';
  const delay = (LOCK_DELAYS as readonly number[]).includes(Number(c.delay)) ? (Number(c.delay) as LockDelay) : 0;
  return { on: c.on, method, delay, ...(method === 'pin' ? { pin: c.pin } : {}), fails: Number(c.fails ?? 0) || 0, failAt: Number(c.failAt ?? 0) || 0 };
}

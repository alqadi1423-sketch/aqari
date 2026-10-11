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
/** كم بقي من الانتظار الآن (٠ إن جازت المحاولة) */
export function waitLeft(cfg: Pick<LockConfig, 'fails' | 'failAt'>, now: number): number {
  const ms = lockoutMs(cfg.fails ?? 0);
  return ms && cfg.failAt ? Math.max(0, cfg.failAt + ms - now) : 0;
}

/** هل يُقفل عند العودة من الخلفية · backgroundAt وقت الخروج إليها */
export function lockOnReturn(cfg: Pick<LockConfig, 'on' | 'delay'>, backgroundAt: number | null, now: number): boolean {
  if (!cfg.on || backgroundAt === null) return false;
  return now - backgroundAt >= cfg.delay * 1000;
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

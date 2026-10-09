/**
 * تشفير النسخة الاحتياطية بكلمة مرور اختيارية (قرار المالك ٢٠٢٦-١٠-٠٣) · بخوارزميات قياسية مفتوحة لا اختراع فيها:
 *  - المفتاح: PBKDF2-HMAC-SHA256 بملح عشوائي ١٦ بايت و٦٠٠٬٠٠٠ دورة (توصية OWASP) · ٣٢ بايت.
 *  - التشفير: AES-256-GCM بقطع من ١ ميغا · لكل قطعة رقم عشوائي ٨ بايت يتبعه رقمها، وتحمل بياناتُها
 *    الموثَّقة الترويسةَ ورقمَ القطعة وعلامةَ الأخيرة · فلا تُبدَّل قطعة ولا تُحذف ولا يُبتر الملف دون كشف.
 *
 * الشكل (البايتات بترتيب الشبكة):
 *   0..7   «AQBKENC1»
 *   8      نوع اشتقاق المفتاح: 1 = PBKDF2-HMAC-SHA256
 *   9..12  عدد الدورات
 *   13..28 الملح
 *   29..36 بادئة الرقم العشوائي
 *   37..40 حجم القطعة
 *   41..   القطع: نصٌّ مشفّر ثم وسم ١٦ بايت · كل قطعة بحجمها إلا الأخيرة (قد تكون فارغة)
 * فأي أداة قياسية تفكّ النسخة بكلمة مرورها ومعرفة هذا الشكل. وكلمة المرور المنسية لا تُستعاد: لا مفتاح خلفي.
 */
export const ENC_MAGIC = 'AQBKENC1';
export const KDF_PBKDF2_SHA256 = 1;
export const DEFAULT_ITERATIONS = 600_000;
/** أقصى دورات يقبلها الفكّ من رأس الملف (مراجعة التثبيت #49: كانت حتى ٥٠ مليوناً يتجمد بها الجهاز) */
export const MAX_ITERATIONS = 2_000_000;
const HEADER = 41;
const TAG = 16;
const CHUNK = 1 << 20;

/** الأوّليات القياسية · في الاختبار من node:crypto وعلى الجهاز من مكوّنات النظام */
export interface CipherProvider {
  random(n: number): Uint8Array | Promise<Uint8Array>;
  /** PBKDF2-HMAC-SHA256 بكلمة المرور مرمَّزة UTF-8 · ٣٢ بايت */
  pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array>;
  /** AES-256-GCM · النص المشفّر يتبعه وسم ١٦ بايت */
  seal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  /** يرمي إن لم يطابق الوسم */
  open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
}

export class PasswordRequiredError extends Error {
  constructor() { super('النسخة مشفّرة بكلمة مرور'); this.name = 'PasswordRequiredError'; }
}
export class WrongPasswordError extends Error {
  constructor() { super('كلمة المرور غير صحيحة، أو الملف عُدّل بعد تشفيره'); this.name = 'WrongPasswordError'; }
}

const enc = new TextEncoder();

export function isEncryptedArchive(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER + TAG) return false;
  for (let i = 0; i < ENC_MAGIC.length; i++) if (bytes[i] !== ENC_MAGIC.charCodeAt(i)) return false;
  return true;
}

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const readU32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function chunkParams(header: Uint8Array, prefix: Uint8Array, i: number, last: boolean) {
  return { nonce: concat([prefix, u32(i)]), aad: concat([header, u32(i), new Uint8Array([last ? 1 : 0])]) };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function encryptArchive(
  plain: Uint8Array, password: string, p: CipherProvider,
  opts: { iterations?: number; chunk?: number; onProgress?: (msg: string) => void } = {},
): Promise<Uint8Array> {
  return (await encryptArchiveWithKey(plain, password, p, opts)).sealed;
}

/** مع المفتاح المشتق · ليُتحقق من الملف بفكّه دون اشتقاقٍ ثانٍ (الاشتقاق مقصودٌ بطؤه) */
export async function encryptArchiveWithKey(
  plain: Uint8Array, password: string, p: CipherProvider,
  opts: { iterations?: number; chunk?: number; onProgress?: (msg: string) => void } = {},
): Promise<{ sealed: Uint8Array; key: Uint8Array }> {
  if (!password) throw new Error('كلمة المرور فارغة');
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const chunk = opts.chunk ?? CHUNK;
  const salt = await p.random(16);
  const prefix = await p.random(8);
  const header = concat([enc.encode(ENC_MAGIC), new Uint8Array([KDF_PBKDF2_SHA256]), u32(iterations), salt, prefix, u32(chunk)]);
  opts.onProgress?.('جاري تجهيز مفتاح التشفير');
  const key = await p.pbkdf2(password, salt, iterations);
  const full = Math.floor(plain.length / chunk);
  const parts: Uint8Array[] = [header];
  for (let i = 0; i <= full; i++) {
    const last = i === full;
    const { nonce, aad } = chunkParams(header, prefix, i, last);
    parts.push(await p.seal(key, nonce, plain.subarray(i * chunk, last ? plain.length : (i + 1) * chunk), aad));
    if (i % 4 === 3) { opts.onProgress?.(`جاري التشفير · ${i + 1} من ${full + 1}`); await tick(); }
  }
  return { sealed: concat(parts), key };
}

export async function decryptArchive(
  bytes: Uint8Array, password: string, p: CipherProvider, onProgress?: (msg: string) => void,
  /** مفتاحٌ اشتُقّ لهذا الملف نفسه (encryptArchiveWithKey) · يُغني عن الاشتقاق */
  knownKey?: Uint8Array,
): Promise<Uint8Array> {
  if (!isEncryptedArchive(bytes)) throw new Error('الملف ليس نسخة مشفّرة');
  if (bytes[8] !== KDF_PBKDF2_SHA256) throw new Error('نسخة مشفّرة بإصدار أحدث من التطبيق');
  const header = bytes.subarray(0, HEADER);
  const iterations = readU32(bytes, 9);
  const salt = bytes.slice(13, 29);
  const prefix = bytes.slice(29, 37);
  const chunk = readU32(bytes, 37);
  if (!iterations || iterations > MAX_ITERATIONS || !chunk || chunk > 64 << 20) throw new WrongPasswordError();
  if (!knownKey) onProgress?.('جاري تجهيز مفتاح فكّ التشفير');
  const key = knownKey ?? await p.pbkdf2(password, salt, iterations);
  const parts: Uint8Array[] = [];
  let at = HEADER;
  let i = 0;
  for (;;) {
    const rest = bytes.length - at;
    const last = rest < chunk + TAG;
    if (rest < TAG) throw new WrongPasswordError(); // مبتور
    const size = last ? rest : chunk + TAG;
    const { nonce, aad } = chunkParams(header, prefix, i, last);
    try {
      parts.push(await p.open(key, nonce, bytes.subarray(at, at + size), aad));
    } catch {
      throw new WrongPasswordError();
    }
    at += size;
    i++;
    if (last) break;
    if (i % 4 === 0) { onProgress?.('جاري فكّ التشفير'); await tick(); }
  }
  return concat(parts);
}

/**
 * أدوات التشفير لخادم الهوية (ق٠-٦) · WebCrypto القياسية وحدها (crypto.getRandomValues وcrypto.subtle)، فتعمل كما هي على Node
 * وعلى Cloudflare Workers · بلا Buffer ولا وحدات Node.
 */

/** أبجدية كروكفورد (بلا I وL وO وU) · نفسها في مفتاح الاسترداد على الجهاز (src/domain/backup/recoveryKey.ts) */
export const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** رمزٌ من n محرفاً كروكفورد · كل محرفٍ ٥ بتات من بايتٍ عشوائي (٢٥٦ قابلة للقسمة على ٣٢ فلا انحياز) */
export function randomCode(n: number, random: (k: number) => Uint8Array = randomBytes): string {
  const b = random(n);
  let s = '';
  for (let i = 0; i < n; i++) s += crockford[b[i] & 31];
  return s;
}

/** ما كتبه المستخدم بلا مسافات وشرطات، بحروفٍ كبيرة، وO صفراً وI وL واحداً، والأرقام الهندية لاتينية (كمفتاح الاسترداد) */
export function normalizeCode(input: string): string {
  return String(input ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toUpperCase()
    .replace(/[\s\-_.·]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export const isCode = (s: string, n: number): boolean => s.length === n && [...s].every((c) => crockford.includes(c));

const enc = new TextEncoder();
const dec = new TextDecoder();
const HEX = '0123456789abcdef';

export function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += HEX[x >> 4] + HEX[x & 15];
  return s;
}

export async function sha256Hex(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(s))));
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64url(b: Uint8Array): string {
  let s = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < b.length) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8);
    s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '');
  }
  return s;
}

export function unb64url(s: string): Uint8Array<ArrayBuffer> | null {
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    buf = ((buf << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(enc.encode(s));
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

/** مقارنةٌ بزمنٍ ثابت لنصّين (بصمتين بطولٍ واحد عادةً) */
export function sameText(a: string, b: string): boolean {
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

/**
 * توقيع HMAC-SHA256 (أجزاء من الملّي ثانية فيسع حدّ ١٠ م.ث للنداء على Workers) · الرمز «v1.<الحمولة>.<التوقيع>» والحمولة JSON ·
 * والتحقق بـsubtle.verify (زمنٌ ثابت)
 */
export interface Signer {
  sign(payload: Record<string, unknown>): Promise<string>;
  verify(token: string): Promise<Record<string, unknown> | null>;
}

export function hmacSigner(key: Uint8Array): Signer {
  const k = crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return {
    async sign(payload) {
      const body = 'v1.' + b64url(utf8(JSON.stringify(payload)));
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await k, utf8(body)));
      return body + '.' + b64url(sig);
    },
    async verify(token) {
      const parts = String(token ?? '').split('.');
      if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return null;
      const sig = unb64url(parts[2]);
      const raw = unb64url(parts[1]);
      if (!sig || !raw || sig.length !== 32) return null;
      if (!(await crypto.subtle.verify('HMAC', await k, sig, utf8(parts[0] + '.' + parts[1])))) return null;
      try {
        const v = JSON.parse(fromUtf8(raw)) as unknown;
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      } catch { return null; }
    },
  };
}

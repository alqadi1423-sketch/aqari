/**
 * أوّليات التشفير على الجهاز · من مكوّنات النظام لا من شيفرة مكتوبة هنا:
 *  - AES-256-GCM من expo-crypto (Cipher في أندرويد · CryptoKit في iOS).
 *  - PBKDF2-HMAC-SHA256 من javax.crypto عبر AqariCrypto (Mac أصلي، أسرع بكثير من JS على Hermes) ·
 *    وإن غاب المكوّن الأصلي فمن @noble/hashes (مكتبة مفتوحة مدقّقة) بالنتيجة نفسها حرفاً.
 */
import { NativeModules } from 'react-native';
import { getRandomBytes, AESEncryptionKey, AESSealedData, aesEncryptAsync, aesDecryptAsync } from 'expo-crypto';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import type { CipherProvider } from '../domain/backup/encryption';

interface AqariCryptoNative {
  pbkdf2Sha256(password: string, saltB64: string, iterations: number): Promise<string>;
}
const native = (NativeModules.AqariCrypto as AqariCryptoNative | undefined) ?? null;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return s;
}
function fromB64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export const deviceCipher: CipherProvider = {
  random: (n) => getRandomBytes(n),
  pbkdf2: async (password, salt, iterations) => {
    if (native) return fromB64(await native.pbkdf2Sha256(password, toB64(salt), iterations));
    return pbkdf2Async(sha256, new TextEncoder().encode(password), salt, { c: iterations, dkLen: 32, asyncTick: 20 });
  },
  seal: async (key, nonce, plain, aad) => {
    const k = await AESEncryptionKey.import(key);
    const sealed = await aesEncryptAsync(plain, k, { nonce: { bytes: nonce }, additionalData: aad, tagLength: 16 });
    return sealed.ciphertext({ includeTag: true });
  },
  open: async (key, nonce, sealed, aad) => {
    const k = await AESEncryptionKey.import(key);
    return aesDecryptAsync(AESSealedData.fromParts(nonce, sealed, 16), k, { additionalData: aad });
  },
};

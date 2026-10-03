/** أوّليات التشفير من node:crypto · للاختبارات وأدوات الحاسوب · المرجع القياسي الذي يطابقه الجهاز */
import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto';
import type { CipherProvider } from '../domain/backup/encryption';

export const nodeCipher: CipherProvider = {
  random: (n) => new Uint8Array(randomBytes(n)),
  pbkdf2: (password, salt, iterations) => new Promise((res, rej) =>
    pbkdf2(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256', (e, k) => (e ? rej(e) : res(new Uint8Array(k))))),
  seal: async (key, nonce, plain, aad) => {
    const c = createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return new Uint8Array(Buffer.concat([ct, c.getAuthTag()]));
  },
  open: async (key, nonce, sealed, aad) => {
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(aad);
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return new Uint8Array(Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]));
  },
};

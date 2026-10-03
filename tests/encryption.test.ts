/**
 * تشفير النسخة بكلمة مرور (encryption.ts) · خوارزميات قياسية ونتيجة واحدة على كل مزوّد · بيانات مصطنعة.
 */
import { createHmac } from 'node:crypto';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { nodeCipher } from '@/files/nodeCipher';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { encryptArchive, decryptArchive, isEncryptedArchive, WrongPasswordError, PasswordRequiredError } from '@/domain/backup/encryption';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { addProperty } from './helpers/fixtures';
import { createBackup } from '@/domain/backup/create';
import { sealBackupFile } from '@/domain/backup/seal';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';

const FAST = { iterations: 1000 };
const bytes = (n: number, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

test('تشفير ثم فكّ يعيد الملف كما هو · بأحجام حول حدّ القطعة', async () => {
  for (const n of [0, 1, 100, 1024, 1024 * 3, 1024 * 3 + 5]) {
    const plain = bytes(n);
    const c = await encryptArchive(plain, 'كلمة سر تجريبية', nodeCipher, { ...FAST, chunk: 1024 });
    expect(isEncryptedArchive(c)).toBe(true);
    if (n >= 64) expect(Buffer.from(c).includes(Buffer.from(plain.subarray(0, 64)))).toBe(false);
    expect(Buffer.from(await decryptArchive(c, 'كلمة سر تجريبية', nodeCipher)).equals(Buffer.from(plain))).toBe(true);
  }
});

test('كلمة مرور خاطئة · بايت معدَّل · ملف مبتور · قطعتان مبدَّلتان: كلها تُرفض', async () => {
  const plain = bytes(5000);
  const c = await encryptArchive(plain, 'pass-1', nodeCipher, { ...FAST, chunk: 1024 });
  await expect(decryptArchive(c, 'pass-2', nodeCipher)).rejects.toBeInstanceOf(WrongPasswordError);
  const flipped = c.slice(); flipped[200] ^= 1;
  await expect(decryptArchive(flipped, 'pass-1', nodeCipher)).rejects.toBeInstanceOf(WrongPasswordError);
  await expect(decryptArchive(c.slice(0, c.length - 10), 'pass-1', nodeCipher)).rejects.toBeInstanceOf(WrongPasswordError);
  // بتر عند حدّ قطعة: حذف القطعة الأخيرة كلها
  await expect(decryptArchive(c.slice(0, 41 + 4 * (1024 + 16)), 'pass-1', nodeCipher)).rejects.toBeInstanceOf(WrongPasswordError);
  const swapped = c.slice();
  swapped.set(c.subarray(41, 41 + 1040), 41 + 1040);
  swapped.set(c.subarray(41 + 1040, 41 + 2080), 41);
  await expect(decryptArchive(swapped, 'pass-1', nodeCipher)).rejects.toBeInstanceOf(WrongPasswordError);
});

test('تشفيران للملف نفسه بكلمة واحدة لا يتشابهان · ملح ورقم عشوائيان', async () => {
  const plain = bytes(300);
  const a = await encryptArchive(plain, 'x', nodeCipher, FAST);
  const b = await encryptArchive(plain, 'x', nodeCipher, FAST);
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  expect(isEncryptedArchive(bytes(100))).toBe(false);
});

test('PBKDF2 بكلمة مرور عربية: node:crypto و@noble/hashes وخوارزمية RFC 8018 (كما في AqariCrypto.kt) نتيجة واحدة', async () => {
  const pw = 'عقاري ١٢٣ مفتاح';
  const salt = bytes(16, 3);
  const c = 2000;
  const viaNode = await nodeCipher.pbkdf2(pw, salt, c);
  const viaNoble = pbkdf2(sha256, new TextEncoder().encode(pw), salt, { c, dkLen: 32 });
  // ما يفعله الملف الأصلي حرفاً: HMAC بمفتاح UTF-8 · U1 = HMAC(S || 00000001) ثم Ui = HMAC(Ui-1) وXOR
  const key = Buffer.from(pw, 'utf8');
  let u = createHmac('sha256', key).update(Buffer.concat([Buffer.from(salt), Buffer.from([0, 0, 0, 1])])).digest();
  const t = Buffer.from(u);
  for (let i = 1; i < c; i++) {
    u = createHmac('sha256', key).update(u).digest();
    for (let j = 0; j < t.length; j++) t[j] ^= u[j];
  }
  expect(Buffer.from(viaNoble).equals(Buffer.from(viaNode))).toBe(true);
  expect(t.equals(Buffer.from(viaNode))).toBe(true);
});

describe('النسخة المشفّرة في مسار الاستعادة', () => {
  let dir: string;
  beforeEach(() => { dir = tempDir('aq-enc-'); });
  afterEach(() => rmrf(dir));

  test('كلمة خاطئة يُعاد السؤال · الصحيحة تُكمل · والإلغاء لا يمسّ شيئاً · وبلا سؤال تُطلب', async () => {
    const env = makeBackupEnv(dir);
    addProperty(env.db, { name: 'عقار تجريبي مشفّر' });
    const file = path.join(dir, 'enc.aqbk');
    await createBackup(env, file);
    await sealBackupFile(env, file, 'كلمة-١', undefined, 1000);
    const raw = new Uint8Array(fs.readFileSync(file));
    expect(isEncryptedArchive(raw)).toBe(true);
    expect(Buffer.from(raw).includes(Buffer.from('عقار تجريبي مشفّر'))).toBe(false);

    await expect(prepareRestore(env, file)).rejects.toBeInstanceOf(PasswordRequiredError);
    await expect(prepareRestore(env, file, undefined, { password: async () => null })).rejects.toBeInstanceOf(PasswordRequiredError);
    const asked: boolean[] = [];
    const answers = ['خطأ', 'كلمة-١'];
    const plan = await prepareRestore(env, file, undefined, { password: async (wrong: boolean) => { asked.push(wrong); return answers.shift()!; } });
    expect(asked).toEqual([false, true]);
    expect(plan.incoming.properties).toBe(1);
    const res = await commitRestore(env, plan);
    expect(res.db.get(`SELECT name FROM properties`)).toEqual({ name: 'عقار تجريبي مشفّر' });
    env.closeLive();
  });
});

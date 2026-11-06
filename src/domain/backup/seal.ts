/**
 * تشفير نسخةٍ اكتمل إنشاؤها وتحقّقها (createBackup) بكلمة مرور · في مكانها على القرص.
 * ولا يُسلَّم ملفٌ مشفّر قبل أن يُفكّ ويطابق ما شُفّر بصمةً: تشفيرٌ لا يُفكّ نسخةٌ ضائعة.
 */
import type { BackupEnv } from './types';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { encryptArchiveWithKey, forEachPlainChunk } from './encryption';

export async function sealBackupFile(
  env: BackupEnv, path: string, password: string, onProgress?: (msg: string) => void, iterations?: number,
): Promise<void> {
  if (!env.cipher) throw new Error('مكوّن التشفير غير متاح على هذا الجهاز · لم تُشفَّر النسخة');
  if (!env.hasher) throw new Error('وحدة التجزئة غير متاحة');
  let plain: Uint8Array | null = env.fs.read(path);
  const before = await env.hasher(plain);
  const enc = await encryptArchiveWithKey(plain, password, env.cipher, { onProgress, iterations });
  plain = null;
  let sealed: Uint8Array | null = enc.sealed;
  onProgress?.('جاري التحقق من النسخة المشفّرة');
  // فكّ كل قطعة وتجزئتها تدريجاً (المراجعة الشاملة · البند ٢١): لا يُحمل الأصل المفكوك كاملاً فوق النسخة المشفّرة
  const h = sha256.create();
  await forEachPlainChunk(sealed, password, env.cipher, (c) => { h.update(c); }, undefined, enc.key);
  if (bytesToHex(h.digest()) !== before) throw new Error('النسخة المشفّرة لا تُفكّ إلى الأصل · لم تُسلَّم');
  const sealedHash = await env.hasher(sealed);
  env.fs.write(path, sealed);
  sealed = null;
  // ما على القرص هو ما شُفّر وتُحقّق منه
  if ((await env.hasher(env.fs.read(path))) !== sealedHash) throw new Error('تعذّرت كتابة النسخة المشفّرة كاملة');
}

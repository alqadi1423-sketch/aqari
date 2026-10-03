/**
 * تشفير نسخةٍ اكتمل إنشاؤها وتحقّقها (createBackup) بكلمة مرور · في مكانها على القرص.
 * ولا يُسلَّم ملفٌ مشفّر قبل أن يُفكّ ويطابق ما شُفّر بصمةً: تشفيرٌ لا يُفكّ نسخةٌ ضائعة.
 */
import type { BackupEnv } from './types';
import { encryptArchiveWithKey, decryptArchive } from './encryption';

export async function sealBackupFile(
  env: BackupEnv, path: string, password: string, onProgress?: (msg: string) => void, iterations?: number,
): Promise<void> {
  if (!env.cipher) throw new Error('مكوّن التشفير غير متاح على هذا الجهاز · لم تُشفَّر النسخة');
  if (!env.hasher) throw new Error('وحدة التجزئة غير متاحة');
  let plain: Uint8Array | null = env.fs.read(path);
  const before = await env.hasher(plain);
  const { sealed, key } = await encryptArchiveWithKey(plain, password, env.cipher, { onProgress, iterations });
  plain = null;
  onProgress?.('جاري التحقق من النسخة المشفّرة');
  const back = await decryptArchive(sealed, password, env.cipher, undefined, key);
  if ((await env.hasher(back)) !== before) throw new Error('النسخة المشفّرة لا تُفكّ إلى الأصل · لم تُسلَّم');
  env.fs.write(path, sealed);
  // ما على القرص هو ما شُفّر وتُحقّق منه
  if ((await env.hasher(env.fs.read(path))) !== (await env.hasher(sealed))) throw new Error('تعذّرت كتابة النسخة المشفّرة كاملة');
}

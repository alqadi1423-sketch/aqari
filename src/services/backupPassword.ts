/**
 * سرّ النسخ الاحتياطية (التوجيه الرابع ٤ · ٣ · قرار المالك 2026-11-07 «تشفير النسخ الاحتياطي إجبارياً مع مفتاح استرداد يظهر مرة»):
 * مفتاح الاسترداد (domain/backup/recoveryKey.ts) يولّده الجهاز ويُعرض مرة، ويُحفظ في مخزن النظام الآمن (Keystore) على هذا الجهاز وحده
 * بعد أن يكتب المستخدم آخر مجموعةٍ منه · فتُشفَّر به كل نسخةٍ تُصدَّر أو تُرفع إلى Drive بلا سؤال، ولا نسخة تخرج بلا تشفير.
 * وكلمة المرور القديمة (قبل المفتاح) تبقى سرّاً تُختم به النسخ حتى يُنشأ المفتاح، وتبقى النسخ القديمة تُفتح بها · لا يُرفع السرّ ولا
 * يُزامَن ولا يُكتب في نسخة، ونسيانه لا يُعوَّض: لا مفتاح خلفي.
 * ومعه علامةٌ في ملفات التطبيق تقول إنه وُضع (ونوعه)، فلا تخرج نسخةٌ إن تعذّرت قراءته (domain/backup/passwordGate.ts)
 */
import * as SecureStore from 'expo-secure-store';
import { File, Paths } from 'expo-file-system';
import { getRandomBytes } from 'expo-crypto';
import { passwordState, secretForSealing, type PasswordStore } from '../domain/backup/passwordGate';
import { generateRecoveryKey, isValidRecoveryKey, sealingSecretOf } from '../domain/backup/recoveryKey';
import { t } from '../i18n';

const KEY = 'aqari_backup_password';
/** محتوى العلامة: «key» لمفتاح الاسترداد، وغيره لكلمة مرورٍ قبله */
const KIND_KEY = 'key';

const flagFile = () => new File(Paths.document, 'backup-password.flag');
const store: PasswordStore = {
  get: async () => (await SecureStore.getItemAsync(KEY)) || null,
  // تعذّر فحص العلامة يُعدّ «وُضعت»: لا تخرج نسخةٌ بلا تشفير بالشك (المتحقق المستقل)
  flagged: () => { try { return flagFile().exists; } catch { return true; } },
  setFlag: (on) => {
    const f = flagFile();
    if (on) { if (!f.exists) f.write('1'); } else if (f.exists) f.delete();
  },
};

const flagIsKey = (): boolean => { try { const f = flagFile(); return f.exists && f.textSync().trim() === KIND_KEY; } catch { return false; } };

/** السرّ المحفوظ: لتجربته أولاً عند استعادة نسخةٍ مشفّرة */
export async function getBackupPassword(): Promise<string | null> {
  try { return (await SecureStore.getItemAsync(KEY)) || null; } catch { return null; }
}

/** مفتاح استرداد محفوظ، أو كلمة مرورٍ قديمة، أو لا شيء، أو وُضع وتعذّرت قراءته */
export type SecretKind = 'key' | 'password' | 'off' | 'lost';

export async function backupSecretKind(): Promise<SecretKind> {
  const st = await passwordState(store);
  if (st !== 'on') return st;
  return flagIsKey() ? 'key' : 'password';
}

/** للتصدير والرفع: السرّ دائماً · ترمي إن لم يُنشأ المفتاح (RecoveryKeyRequiredError) أو تعذّرت قراءته */
export const backupSecretForSealing = (): Promise<string> => secretForSealing(store);

/** مفتاحٌ جديد من مولّد النظام · يُعرض ولا يُحفظ حتى يؤكَّد بـ saveRecoveryKey */
export const newRecoveryKey = (): string => generateRecoveryKey((n) => getRandomBytes(n));

/** حفظ المفتاح بعد تأكيده · يحلّ محل كلمة المرور القديمة أو المفتاح السابق للنسخ القادمة، والسابقة تبقى بسرّها */
export async function saveRecoveryKey(key: string): Promise<void> {
  if (!isValidRecoveryKey(key)) throw new Error(t('backup.key.invalid'));
  await SecureStore.setItemAsync(KEY, sealingSecretOf(key));
  const f = flagFile();
  if (f.exists) f.delete();
  f.write(KIND_KEY);
}

/** تفريغ الجهاز كاملاً وحده (deviceReset.ts): يُمحى السرّ وعلامته مع بيانات الجهاز · ولا زرّ في الواجهة يزيله، فالتشفير إجباري */
export async function clearBackupSecretForReset(): Promise<void> {
  try { await SecureStore.deleteItemAsync(KEY); } finally { store.setFlag(false); }
}

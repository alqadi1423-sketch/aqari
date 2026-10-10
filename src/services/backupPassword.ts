/**
 * كلمة مرور النسخ الاحتياطية · اختيارية · تُحفظ في مخزن النظام الآمن (Keystore) على هذا الجهاز وحده،
 * فتُشفَّر بها كل نسخة تُصدَّر أو تُرفع إلى Drive بلا سؤال كل مرة. لا تُرفع ولا تُزامَن ولا تُكتب في نسخة.
 * ونسيانها لا يُعوَّض: لا مفتاح خلفي، فالنسخة المشفّرة بها لا تُفتح بغيرها.
 * ومعها علامةٌ في ملفات التطبيق تقول إنها وُضعت، فلا تخرج نسخةٌ بلا تشفير إن تعذّرت قراءتها (domain/backup/passwordGate.ts)
 */
import * as SecureStore from 'expo-secure-store';
import { File, Paths } from 'expo-file-system';
import { passwordForSealing, passwordState, type PasswordStore, type PasswordState } from '../domain/backup/passwordGate';

const KEY = 'aqari_backup_password';
export const MIN_PASSWORD = 8;

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

export async function getBackupPassword(): Promise<string | null> {
  try { return (await SecureStore.getItemAsync(KEY)) || null; } catch { return null; }
}

/** مفعّلة، أو غير مفعّلة، أو وُضعت وتعذّرت قراءتها */
export const backupPasswordState = (): Promise<PasswordState> => passwordState(store);

/** للتصدير والرفع: ترمي إن وُضعت كلمةٌ تعذّرت قراءتها ولا تعيد null عندها */
export const backupPasswordForSealing = (): Promise<string | null> => passwordForSealing(store);

export async function setBackupPassword(pw: string): Promise<void> {
  if (pw.length < MIN_PASSWORD) throw new Error('كلمة المرور ' + MIN_PASSWORD + ' أحرف على الأقل');
  await SecureStore.setItemAsync(KEY, pw);
  store.setFlag(true);
}

export async function clearBackupPassword(): Promise<void> {
  try { await SecureStore.deleteItemAsync(KEY); } finally { store.setFlag(false); }
}

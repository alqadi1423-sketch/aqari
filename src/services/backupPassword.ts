/**
 * كلمة مرور النسخ الاحتياطية · اختيارية · تُحفظ في مخزن النظام الآمن (Keystore) على هذا الجهاز وحده،
 * فتُشفَّر بها كل نسخة تُصدَّر أو تُرفع إلى Drive بلا سؤال كل مرة. لا تُرفع ولا تُزامَن ولا تُكتب في نسخة.
 * ونسيانها لا يُعوَّض: لا مفتاح خلفي، فالنسخة المشفّرة بها لا تُفتح بغيرها.
 */
import * as SecureStore from 'expo-secure-store';

const KEY = 'aqari_backup_password';
export const MIN_PASSWORD = 8;

export async function getBackupPassword(): Promise<string | null> {
  try { return (await SecureStore.getItemAsync(KEY)) || null; } catch { return null; }
}

export async function setBackupPassword(pw: string): Promise<void> {
  if (pw.length < MIN_PASSWORD) throw new Error('كلمة المرور ' + MIN_PASSWORD + ' أحرف على الأقل');
  await SecureStore.setItemAsync(KEY, pw);
}

export async function clearBackupPassword(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

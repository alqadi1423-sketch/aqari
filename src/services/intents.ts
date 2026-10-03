/**
 * الشاشتان الداخليتان بقصد صريح (android/app/src/main/java/com/aqari/app/AqariIntents.kt) ·
 * لا روابط: الشاشتان غير مكشوفتين، وأندرويد ١٤ لا يوصل إليهما قصد Linking الضمني.
 */
import { NativeModules, Platform } from 'react-native';

interface AqariIntentsNative {
  pinWidget(kind: string): Promise<boolean>;
  saveErrorLog(name: string): Promise<boolean>;
}

const native = (): AqariIntentsNative | null =>
  Platform.OS === 'android' ? ((NativeModules.AqariIntents as AqariIntentsNative | undefined) ?? null) : null;

/** طلب تثبيت ودجت على الشاشة · strip أو panel أو actions */
export async function pinWidget(kind: 'strip' | 'panel' | 'actions'): Promise<void> {
  const n = native();
  if (!n) throw new Error('unsupported');
  await n.pinWidget(kind);
}

/** نقل ملف الخطأ المؤقت إلى التنزيلات · الاسم يُفحص في الشاشة الأصلية قبل القراءة */
export async function saveErrorLogNative(name: string): Promise<void> {
  const n = native();
  if (!n) throw new Error('unsupported');
  await n.saveErrorLog(name);
}

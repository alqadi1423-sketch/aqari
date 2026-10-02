/**
 * إعداد الربط بقوقل · يُقرأ من متغيرات البيئة وقت البناء (أو EAS Secrets) لا من الكود.
 * EXPO_PUBLIC_* تُضمَّن في الحزمة عند بنائها، وغيابها يعني بناءً بلا ربط: التطبيق يعمل كاملاً
 * والإعدادات تقول إن الربط غير مهيّأ ولا تعرض زرّاً لا يعمل.
 *
 * ليست أسراراً بالمعنى الدقيق (مفتاح Firebase للويب يعرّف المشروع ولا يمنح صلاحية · الحماية
 * في قواعد الأمان)، لكنها تبقى خارج المستودع كسائر الإعدادات.
 */
export interface CloudConfig {
  apiKey: string;
  projectId: string;
  webClientId: string;
}

export function cloudConfig(): CloudConfig | null {
  const apiKey = process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? '';
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? '';
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';
  if (!apiKey || !projectId || !webClientId) return null;
  return { apiKey, projectId, webClientId };
}

/** نطاق Drive الوحيد: مجلد التطبيق المخفي · لا وصول لأي ملف آخر في Drive المستخدم */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

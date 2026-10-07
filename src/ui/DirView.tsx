/**
 * اتجاه الواجهة من اللغة فوراً بلا إعادة تشغيل · يلفّ جذر التطبيق وجذر كل نافذة (Modal) لأنها شجرة مستقلة.
 * لا يُضبط الاتجاه إلا حين تخالف اللغةُ اتجاهَ أندرويد الأصلي (بعد تغيير اللغة وقبل إعادة الفتح):
 * ضبطه صراحةً بالاتجاه نفسه قلب ترتيب الصفوف على الجهاز (فحص المحاكي ٢٠٢٦-١٠-٠٧)، فالموافق يُترك يرث.
 */
import React from 'react';
import { I18nManager, View, type StyleProp, type ViewStyle } from 'react-native';
import { useLang } from '../i18n';

export function DirView({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { rtl } = useLang();
  const differs = rtl !== I18nManager.isRTL;
  return <View style={[{ flex: 1 }, differs ? { direction: rtl ? 'rtl' : 'ltr' } : null, style]}>{children}</View>;
}

/** محاذاة النص للغة اليسارية · والعربية كما كانت (المحاذاة الطبيعية) */
export function useTextAlign(): { textAlign?: 'left'; writingDirection: 'rtl' | 'ltr' } {
  const { rtl } = useLang();
  return rtl ? { writingDirection: 'rtl' } : { textAlign: 'left', writingDirection: 'ltr' };
}

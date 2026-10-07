/**
 * اتجاه الواجهة من اللغة فوراً بلا إعادة تشغيل: الاتجاه في Yoga يسري على الشجرة تحته ·
 * يلفّ جذر التطبيق وجذر كل نافذة (Modal) لأنها شجرة مستقلة لا ترث.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useLang } from '../i18n';

export function DirView({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { rtl } = useLang();
  return <View style={[{ flex: 1, direction: rtl ? 'rtl' : 'ltr' }, style]}>{children}</View>;
}

/** محاذاة النص للغة اليسارية · والعربية كما كانت (المحاذاة الطبيعية) */
export function useTextAlign(): { textAlign?: 'left'; writingDirection: 'rtl' | 'ltr' } {
  const { rtl } = useLang();
  return rtl ? { writingDirection: 'rtl' } : { textAlign: 'left', writingDirection: 'ltr' };
}

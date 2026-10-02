/**
 * مكبّر الواجهة: يرسم المحتوى على لوح أعرض/أضيق ثم يحجّمه ليطابق الشاشة،
 * فيكبر أو يصغر كل شيء معاً · البطاقات والحشو والمسافات والأزرار والنصوص ·
 * بمعامل متصل ٧٠ إلى ١٥٠٪. حجم الخط معامل ضرب مستقل فوقه (useFs).
 */
import React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from './store';

/** ارتفاع شريط التبويبات قبل إضافة الحافة الآمنة · يستعمله الشريط وحشو المحتوى معاً */
export const TAB_BAR_BASE = 56;

/**
 * المساحة الآمنة داخل اللوح المُحجَّم: القيم الفيزيائية تُقسم على معامل التكبير
 * حتى تعادل بصرياً حجم أشرطة النظام مهما تغيّر المقياس.
 * كل عنصر يلامس حافة الشاشة يقرأ هذه القيم · لا أرقاماً ثابتة.
 */
export function useScaledInsets() {
  const insets = useSafeAreaInsets();
  const { uiScale } = useApp();
  return {
    top: insets.top / uiScale,
    bottom: insets.bottom / uiScale,
    left: insets.left / uiScale,
    right: insets.right / uiScale,
  };
}

export function UiScaleView({ children }: { children: React.ReactNode }) {
  const { uiScale } = useApp();
  const { width, height } = useWindowDimensions();
  if (Math.abs(uiScale - 1) < 0.005) return <View style={{ flex: 1 }}>{children}</View>;
  // اللوح يُثبَّت بحيث يكون مركزه = مركز الشاشة، فيملأ التحجيم (حول المركز)
  // الشاشة بالضبط بلا فيض ولا قصّ · لا اعتماد على transformOrigin ولا يتأثر بالاتجاه RTL
  const w = width / uiScale;
  const h = height / uiScale;
  return (
    <View style={{ flex: 1, overflow: 'hidden' }}>
      <View
        style={{
          position: 'absolute',
          left: (width - w) / 2,
          top: (height - h) / 2,
          width: w,
          height: h,
          transform: [{ scale: uiScale }],
        }}
      >
        {children}
      </View>
    </View>
  );
}

/**
 * القسم المطوي في صفحات الكيانات (المورد والمستأجر والوحدة والعقار والعداد
 * والحساب والبنك): القسم الفارغ لا يُعرض إطلاقاً، والمملوء يُعرض مطوياً برأس
 * يحمل عنوانه وعدده، ولا يُبنى محتواه إلا عند فتحه · وتقسيم الصفحات داخله.
 */
import React from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { T, Num } from './components';
import { Icon, type IconName } from './icons';
import { C } from './theme';
import { Pager, usePager } from './Pager';

/**
 * نطاق الصفحة المعروضة داخل القسم · تستعمله دالة المحتوى في استعلامها
 * (LIMIT/OFFSET) · وبلا تقسيم صفحات يكون النطاق كل العناصر.
 */
export interface SectionPage {
  /** رقم الصفحة الحالية · يبدأ من صفر */
  page: number;
  /** عدد عناصر الصفحة الواحدة */
  size: number;
  /** LIMIT للاستعلام */
  limit: number;
  /** OFFSET للاستعلام */
  offset: number;
}

export function CollapsibleSection({
  title, count, children, defaultOpen, icon, pageKey, onToggle,
}: {
  /** عنوان القسم كما يظهر في رأسه */
  title: string;
  /** عدد عناصر القسم · يُعرض بجانب العنوان، وإن كان صفراً لم يُعرض القسم إطلاقاً */
  count: number;
  /** المحتوى · دالة لا تُستدعى إلا بعد الفتح فلا يُحمَّل شيء قبله */
  children: (page: SectionPage) => React.ReactNode;
  /** يُفتح القسم مع أول رسمة · وافتراضه مغلق */
  defaultOpen?: boolean;
  /** أيقونة اختيارية قبل العنوان */
  icon?: IconName;
  /**
   * مفتاح تقسيم الصفحات · بوجوده يُقسَّم القسم صفحاتٍ ويظهر شريط التنقل أسفله
   * وتلتزم دالة المحتوى بالنطاق المعطى · وبغيابه يُعرض المحتوى كله بلا شريط.
   * والمفتاح يحفظ عدد عناصر الصفحة المختار لكل نوع قسم على حدة.
   */
  pageKey?: string;
  /** يُنادى عند كل فتح أو طيّ · للشاشة أن تقيس أو تؤجّل به */
  onToggle?: (open: boolean) => void;
}) {
  const [open, setOpen] = React.useState(!!defaultOpen);
  const pager = usePager(pageKey ?? '');
  const spin = React.useRef(new Animated.Value(defaultOpen ? 1 : 0)).current;

  React.useEffect(() => {
    Animated.timing(spin, {
      toValue: open ? 1 : 0, duration: 150, useNativeDriver: true,
    }).start();
  }, [open, spin]);

  const toggle = React.useCallback(() => {
    const next = !open;
    // الطيّ يُنهي المحتوى ويعيد القسم إلى صفحته الأولى · ففتحه القادم بدء جديد
    if (!next) pager.reset();
    setOpen(next);
    onToggle?.(next);
  }, [open, pager, onToggle]);

  // السهم: مطويّاً يشير إلى جهة البدء ومفتوحاً يشير إلى الأسفل
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '90deg'] });

  // القسم الفارغ لا يُعرض إطلاقاً · بعد الخطّافات كي لا يختلف ترتيبها
  if (!(count > 0)) return null;

  const slice: SectionPage = pageKey
    ? { page: pager.page, size: pager.size, limit: pager.limit, offset: pager.offset }
    : { page: 0, size: count, limit: count, offset: 0 };

  return (
    <View style={st.wrap}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [st.head, pressed && { backgroundColor: C.paper }]}
      >
        {icon ? <Icon name={icon} size={16} color={C.emerald} /> : null}
        <T size={13.5} bold color={C.ink}>{title}</T>
        <Num size={12.5} color={C.muted}>{count}</Num>
        <View style={{ flex: 1 }} />
        <Animated.View style={{ transform: [{ rotate }] }}>
          <Icon name="back" size={14} color={C.muted} />
        </Animated.View>
      </Pressable>
      {open ? (
        <View style={st.body}>
          {children(slice)}
          {pageKey ? <Pager pager={pager} total={count} /> : null}
        </View>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { borderBottomWidth: 1, borderBottomColor: C.line },
  // رأس القسم: هدف لمس كامل وملمس ضغط خفيف · والسهم عارٍ بلا إطار حوله
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48,
    paddingVertical: 12, paddingHorizontal: 2, borderRadius: 8,
  },
  body: { paddingBottom: 10 },
});

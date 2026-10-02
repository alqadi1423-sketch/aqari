/**
 * هيكل الشاشة الموحّد: عنوان + زر رجوع في كل شاشة + إجراءات + تمرير.
 * المساحة الآمنة مبدأ لا ترقيع: الرأس تحت شريط الحالة والنتوء (insets.top)،
 * والمحتوى لا يختفي خلف شريط التبويبات أو خط الإيماءة (ارتفاع الشريط أو insets.bottom).
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
import { C, FONT_BOLD, FONT_MED, TYPE } from './theme';
import { useFs } from './store';
import { useScaledInsets } from './UiScale';
import { BTN_SIZES } from './components';
import { Icon, type IconName } from './icons';

/**
 * تبويبات الجذر الخمسة كما تسمّيها شجرة المسارات · ما عداها شاشة فرعية
 * مدخلها «المزيد»، فهو مرجعها حين لا يكون تحتها مكدَّس تعود إليه.
 */
const ROOT_TABS = new Set(['(tabs)', 'index', 'properties', 'contracts', 'collect', 'more']);

/**
 * زر الرجوع الواحد في التطبيق كلّه: سهم مفرد رأسه إلى اليمين ونصّ «رجوع»،
 * بلا إطار ولا خلفية ولا دائرة ولا قوس ولا شكل ثانٍ فوقه.
 * كل عنصر يعيد المستخدم إلى ما قبله يستعمله · في رأس الشاشة أو داخل ورقة.
 */
export function BackButton({ onPress }: { onPress: () => void }) {
  const fs = useFs();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [st.back, pressed && { opacity: 0.5 }]}
      hitSlop={BTN_SIZES.icon.hitSlop}
      accessibilityRole="button"
      accessibilityLabel="رجوع"
    >
      <Icon name="arrowBack" size={fs(BTN_SIZES.icon.icon)} color={C.ink} />
      <Text style={{ fontFamily: FONT_MED, fontSize: fs(TYPE.body), color: C.ink }}>رجوع</Text>
    </Pressable>
  );
}

export function Screen({
  title, sub, actions, children, scroll = true, noBack, icon,
}: {
  title: string;
  sub?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  scroll?: boolean;
  /** تبويبات الجذر لا تعرض زر رجوع */
  noBack?: boolean;
  /** أيقونة SVG بجانب عنوان الشاشة */
  icon?: IconName;
}) {
  const router = useRouter();
  const navigation = useNavigation();
  const fs = useFs();
  const insets = useScaledInsets();
  // شاشات التبويبات: المتصفّح يضعها فوق الشريط بنفسه فلا حشو إضافي إطلاقاً
  // شاشات المكدس: تمتد حتى حافة الشاشة فتحتاج الحافة الآمنة السفلية وحدها
  const bottomPad = noBack ? 0 : insets.bottom;
  // الحواف الجانبية للشاشات المنحنية: الحشو الأفقي = الأكبر من 16 ومن الحافتين الآمنتين ·
  // الجهاز العادي يعطي صفراً فيبقى الهامش 16 متساوياً على الجانبين
  const padH = Math.max(16, insets.left, insets.right);
  /**
   * الرجوع: إن كان تحت الشاشة مكدَّس فإلى سابقتها دائماً.
   * وإن لم يكن (فُتحت برابط عميق aqari:// أو أُعيد تحميل التطبيق عليها
   * فبدأت وحدها في المكدَّس) فإلى فهرسها لا إلى الجذر: كل شاشة فرعية
   * مدخلها «المزيد» فإليه تعود، وتبويبات الجذر وحدها تعود إلى الرئيسية.
   * وتُقرأ حالة التنقل عند الضغط لا عند الرسم · فلا تُتخذ القرارات بحالة قديمة.
   */
  const goBack = () => {
    if (navigation.canGoBack()) { router.back(); return; }
    const st = navigation.getState?.();
    const current = st?.routes?.[st.index ?? 0]?.name ?? '';
    router.replace((ROOT_TABS.has(current) ? '/' : '/more') as never);
  };
  return (
    <View style={{ flex: 1, backgroundColor: C.paper, paddingTop: insets.top }}>
      <View style={[st.topbar, { paddingLeft: Math.max(14, insets.left), paddingRight: Math.max(14, insets.right) }]}>
        {!noBack && <BackButton onPress={goBack} />}
        {/* سطر واحد بارتفاع ثابت: أيقونة الشاشة واسمها */}
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {icon ? <Icon name={icon} size={20} color={C.emerald} /> : null}
          <Text numberOfLines={1} style={{ fontFamily: FONT_BOLD, fontSize: fs(TYPE.screenTitle), color: C.ink, textAlign: 'right', flexShrink: 1 }}>{title}</Text>
        </View>
        {actions}
      </View>
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: padH, paddingBottom: bottomPad }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, paddingHorizontal: padH, paddingBottom: bottomPad }}>{children}</View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  topbar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  // أيقونة عارية: لا إطار ولا خلفية · الأبعاد الدنيا مع hitSlop تكمل هدف لمس ٤٤ نقطة
  back: {
    minWidth: BTN_SIZES.icon.minWidth, minHeight: BTN_SIZES.icon.minHeight,
    flexDirection: 'row', gap: 5, alignItems: 'center', justifyContent: 'center',
  },
});

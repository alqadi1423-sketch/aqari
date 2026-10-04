import React from 'react';
import { Tabs } from 'expo-router';
import { C, FONT_MED } from '../../src/ui/theme';
import { Icon } from '../../src/ui/icons';
import { useScaledInsets, TAB_BAR_BASE } from '../../src/ui/UiScale';
import { useAccess } from '../../src/ui/access';
import { canView } from '../../src/domain/access/access';
import type { SectionKey } from '../../src/domain/access/sections';

/**
 * التنقّل السفلي الخمسة: الرئيسية · العقارات · العقود · التحصيل · المزيد.
 * الشريط يحترم المساحة الآمنة: ارتفاعه وحشوه السفلي من insets لا أرقام ثابتة،
 * فيبقى فوق أزرار النظام (◁ ○ □) وفوق خط الإيماءة على اختلاف الأجهزة.
 */
export default function TabsLayout() {
  const insets = useScaledInsets();
  // الشريط يُبنى من صلاحيات العضو · التبويب الذي قسمه «لا» لا يظهر (href: null)
  const access = useAccess();
  const hide = (sec: SectionKey) => (canView(access, sec) ? {} : { href: null });
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // القياس أثبت أن تجميد التبويب المغادَر يعيد بناء شجرته كاملة عند كل
        // عودة (وصول 3.5 ث للرئيسية) · إبقاؤها حية أرخص: الكتابة أندر من التنقل
        freezeOnBlur: false,
        tabBarActiveTintColor: C.emerald,
        tabBarInactiveTintColor: C.muted,
        tabBarStyle: {
          backgroundColor: '#fff',
          borderTopColor: C.line,
          height: TAB_BAR_BASE + insets.bottom,
          paddingBottom: insets.bottom,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontFamily: FONT_MED, fontSize: 10.5 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'الرئيسية', tabBarIcon: ({ color }) => <Icon name="home" size={21} color={String(color)} /> }}
      />
      <Tabs.Screen
        name="properties"
        options={{ title: 'العقارات', ...hide('props'), tabBarIcon: ({ color }) => <Icon name="building" size={21} color={String(color)} /> }}
      />
      <Tabs.Screen
        name="contracts"
        options={{ title: 'العقود', ...hide('contracts'), tabBarIcon: ({ color }) => <Icon name="contract" size={21} color={String(color)} /> }}
      />
      <Tabs.Screen
        name="collect"
        options={{ title: 'التحصيل', ...hide('collect'), tabBarIcon: ({ color }) => <Icon name="collect" size={21} color={String(color)} /> }}
      />
      <Tabs.Screen
        name="more"
        options={{ title: 'المزيد', tabBarIcon: ({ color }) => <Icon name="menu" size={21} color={String(color)} /> }}
      />
    </Tabs>
  );
}

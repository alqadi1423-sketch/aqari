import React, { useEffect } from 'react';
import { I18nManager, View, ActivityIndicator } from 'react-native';
import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts,
  IBMPlexSansArabic_400Regular,
  IBMPlexSansArabic_500Medium,
  IBMPlexSansArabic_700Bold,
} from '@expo-google-fonts/ibm-plex-sans-arabic';
import { AppStateProvider } from '../src/ui/store';
import { UiScaleView } from '../src/ui/UiScale';
import { ToastProvider } from '../src/ui/Toast';
import { DialogProvider } from '../src/ui/AppDialog';
import { C } from '../src/ui/theme';
import { rescheduleAllNotifications } from '../src/services/notifications';
import { appDb } from '../src/db/expoAdapter';
import { perfMarkNavRender, perfRouteChanged, perfTouch, perfTouchUp } from '../src/perf/perf';

// التطبيق عربي RTL بالكامل
try {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
} catch { /* على الويب لا يلزم */ }

// شبكة أمان أخيرة: أي خطأ أفلت من الالتقاط يُعرض رسالةً بدل أن يُغلق التطبيق
type GlobalErrorUtils = { getGlobalHandler(): (e: unknown, fatal?: boolean) => void; setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void };
const EU = (globalThis as { ErrorUtils?: GlobalErrorUtils }).ErrorUtils;
if (EU && !__DEV__) {
  const prev = EU.getGlobalHandler();
  EU.setGlobalHandler((e, fatal) => {
    try {
      const { reportFailure } = require('../src/ui/failureDialog') as typeof import('../src/ui/failureDialog');
      reportFailure({ title: 'حدث خطأ غير متوقع', where: 'خطأ عام', e }).catch(() => prev?.(e, fatal));
    } catch {
      prev?.(e, fatal);
    }
  });
}

/**
 * القياس المركزي: usePathname يعاد تصيير مشتركه عند كل تغيير مسار بحكم البناء،
 * فلا تعتمد الأداة على تركيب الشاشات (الحية غير المجمدة لا يعاد تركيبها فكانت
 * تغيب من التقرير) ولا على مستمع حاوية قد يسبق جاهزيتها
 */
function PerfPathTracker() {
  const pathname = usePathname();
  const prev = React.useRef(pathname);
  // جسد التصيير يلاحظ التغيير قبل الإيداع · فتُعلَّم بداية «التركيب»
  if (prev.current !== pathname) {
    prev.current = pathname;
    perfMarkNavRender();
  }
  useEffect(() => {
    const route = pathname === '/' ? 'index' : pathname.replace(/^\//, '');
    perfRouteChanged(route);
  }, [pathname]);
  return null;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    IBMPlexSansArabic_400Regular,
    IBMPlexSansArabic_500Medium,
    IBMPlexSansArabic_700Bold,
  });


  useEffect(() => {
    // إعادة جدولة التنبيهات (50 نداء جسر) مؤجلة بعيداً عن أول التنقلات ·
    // كنس السلة يتولاه مزوّد الحالة ضمن صيانة الإقلاع المؤجلة
    const t = setTimeout(() => {
      try {
        rescheduleAllNotifications(appDb()).catch(() => {});
      } catch { /* أول فتح قد يفشل على الويب */ }
    }, 6000);
    return () => clearTimeout(t);
  }, []);

  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: C.paper, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={C.emerald} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <AppStateProvider>
        <ToastProvider>
        <DialogProvider>
          <StatusBar style="dark" />
          <UiScaleView>
            {/* لحظة بدء كل لمسة تُلتقط هنا لقياس زمن الانتقال · لا تحجز اللمسة */}
            <View
              style={{ flex: 1 }}
              onStartShouldSetResponderCapture={() => { perfTouch(); return false; }}
              onTouchEnd={perfTouchUp}
            >
              <PerfPathTracker />
              {/* القياس أثبت أن إذابة الشاشة المجمدة أبطأ من إبقائها حية (وصول 3.5 ث) · التجميد أُطفئ */}
              <Stack screenOptions={{ headerShown: false, freezeOnBlur: false, contentStyle: { backgroundColor: C.paper } }} />
            </View>
          </UiScaleView>
        </DialogProvider>
        </ToastProvider>
      </AppStateProvider>
    </SafeAreaProvider>
  );
}

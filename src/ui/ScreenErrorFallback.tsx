/**
 * حاجز الشاشات (D-5) · يلفّ به expo-router كل شاشة عبر `unstable_settings.screenErrorBoundary` في
 * التخطيط الجذري، فعطلُ رسمٍ في شاشة يُعرض بطاقةً عربية مكانها والتطبيق حيٌّ حولها (التبويبات والحوارات
 * وحوار الخطأ العام)، لا صفحةً فارغة لا يُخرج منها إلا بإغلاق التطبيق.
 * قرار المالك 2026-08-23: «حدود خطأ حولها فلا يُغلق التطبيق مهما حدث».
 */
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { usePathname, useRouter, type ErrorBoundaryProps } from 'expo-router';
import { ErrorCard } from './ErrorBoundary';
import { useScaledInsets } from './UiScale';
import { C } from './theme';
import { useLang } from '../i18n';
import { appDb } from '../db/expoAdapter';
import { logAudit } from '../domain/audit';
import { failureAuditDetail } from '../domain/redact';

export function ScreenErrorFallback({ error, retry }: ErrorBoundaryProps): React.ReactElement {
  const { t } = useLang();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useScaledInsets();
  const where = t('crash.screen');

  // نص الخطأ محجوباً في سجل العمليات كحاجز الأقسام · والسجل لا يعطّل
  useEffect(() => {
    try {
      // i18n-exempt: فئة السجل وموضعه قيمٌ فنية يقرؤها سجل العمليات كما يكتبها حاجز الأقسام
      logAudit(appDb(), 'الأعطال', 'update', 'خطأ في ' + pathname, failureAuditDetail(error).slice(0, 300));
    } catch { /* السجل لا يعطّل */ }
  }, [error, pathname]);

  const goHome = () => {
    try {
      if (router.canDismiss()) router.dismissAll();
      router.navigate('/');
    } catch { /* التنقّل لم يجهز · يبقى «أعد المحاولة» */ }
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.paper, paddingTop: insets.top + 12 }}>
      <ErrorCard
        where={where}
        error={error}
        onRetry={() => { retry().catch(() => {}); }}
        // الرئيسية نفسها لا تُعرض فيها «الرئيسية» · زرٌّ لا يعمل لا يُعرض
        home={pathname !== '/' ? { label: t('crash.home'), onPress: goHome } : undefined}
      />
    </View>
  );
}

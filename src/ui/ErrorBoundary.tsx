/**
 * حاجز الأخطاء: أي استثناء داخل ما يلفّه يُعرض بطاقة عربية بدل إسقاط التطبيق،
 * ونصّه الكامل يُكتب في سجل العمليات ويُنسخ للمشاركة معي.
 */
import React from 'react';
import { View, Share, Pressable } from 'react-native';
import { T, BtnGhost, BtnPrimary, Row } from './components';
import { Icon } from './icons';
import { C } from './theme';
import { appDb } from '../db/expoAdapter';
import { logAudit } from '../domain/audit';
import { redactForReport, failureAuditDetail } from '../domain/redact';

interface Props {
  children: React.ReactNode;
  /** اسم الموضع · يُسجَّل مع نص الخطأ ليُعرف مصدره */
  where: string;
  onClose?: () => void;
}

interface State { error: Error | null }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      // نص الخطأ محجوباً لا خاماً (المراجعة الشاملة · البند ١٧): سجل العمليات يُزامَن، ونص الخطأ قد يحمل اسماً أو مبلغاً
      logAudit(appDb(), 'الأعطال', 'update', 'خطأ في ' + this.props.where,
        (failureAuditDetail(error) + ' ' + (info.componentStack ?? '')).slice(0, 300));
    } catch { /* السجل لا يعطّل */ }
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <ErrorCard where={this.props.where} error={this.state.error} onClose={this.props.onClose}
        onRetry={() => this.setState({ error: null })} />
    );
  }
}

/**
 * بطاقة الخطأ العربية · يرسمها حاجز الأقسام هنا، وحاجز الشاشات (ScreenErrorFallback) بزرّ «الرئيسية» معها (D-5)
 */
export function ErrorCard({ where, error, onRetry, onClose, home }: {
  where: string;
  error: Error;
  onRetry: () => void;
  onClose?: () => void;
  /** زرٌّ ثالث يخرج من الشاشة المعطوبة · لا يُمرَّر حيث لا يعمل */
  home?: { label: string; onPress: () => void };
}): React.ReactElement {
  // ما يُشارك خارج الجهاز محجوبةٌ بياناته كتقرير الخطأ نفسه
  const detail = redactForReport(error.name + ': ' + error.message);
  return (
    <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 16, margin: 12, borderWidth: 1, borderColor: C.line }}>
      <Row style={{ alignItems: 'center', marginBottom: 6 }}>
        <T size={13.5} bold color={C.rose} style={{ flex: 1 }}>تعذّر عرض {where}</T>
        {/* الإغلاق علامة ✕ عارية · لا زرّ نصّي مؤطَّر */}
        {onClose ? (
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="إغلاق"
            style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="x" size={16} color={C.charcoal} />
          </Pressable>
        ) : null}
      </Row>
      {/* لا طمأنة بلا فحص · حاجزُ الرسم لا يعلم ما جرى للبيانات فلا يدّعي */}
      <T size={12} color={C.muted} style={{ marginBottom: 10 }}>نص الخطأ سُجّل في سجل العمليات.</T>
      <Row>
        <View style={{ flex: 1 }}>
          <BtnGhost small title="نسخ تفاصيل الخطأ"
            onPress={() => { Share.share({ message: 'خطأ ' + where + ': ' + detail }).catch(() => {}); }} />
        </View>
        {home ? (
          <View style={{ flex: 1 }}>
            <BtnGhost small title={home.label} onPress={home.onPress} />
          </View>
        ) : null}
        <View style={{ flex: 1 }}>
          <BtnPrimary small title="أعد المحاولة" onPress={onRetry} />
        </View>
      </Row>
    </View>
  );
}

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
import { redactForReport } from '../domain/redact';

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
      logAudit(appDb(), 'الأعطال', 'update', 'خطأ في ' + this.props.where,
        (error.message + ' ' + (info.componentStack ?? '')).slice(0, 300));
    } catch { /* السجل لا يعطّل */ }
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    // ما يُشارك خارج الجهاز محجوبةٌ بياناته كتقرير الخطأ نفسه
    const detail = redactForReport(this.state.error.name + ': ' + this.state.error.message);
    return (
      <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: 16, margin: 12, borderWidth: 1, borderColor: C.line }}>
        <Row style={{ alignItems: 'center', marginBottom: 6 }}>
          <T size={13.5} bold color={C.rose} style={{ flex: 1 }}>تعذّر عرض {this.props.where}</T>
          {/* الإغلاق علامة ✕ عارية · لا زرّ نصّي مؤطَّر */}
          {this.props.onClose ? (
            <Pressable onPress={this.props.onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="إغلاق"
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
              onPress={() => { Share.share({ message: 'خطأ ' + this.props.where + ': ' + detail }).catch(() => {}); }} />
          </View>
          <View style={{ flex: 1 }}>
            <BtnPrimary small title="أعد المحاولة" onPress={() => this.setState({ error: null })} />
          </View>
        </Row>
      </View>
    );
  }
}

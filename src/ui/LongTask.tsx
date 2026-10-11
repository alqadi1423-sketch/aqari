/**
 * نافذة تقدّم العمليات الطويلة (توجيه المالك ٢٠٢٦-١٠-٠٧): النسبة، والحجم المنجز من الكلي، وزر إلغاء ·
 * وإن لم يتقدم شيءٌ دقيقةً كاملة ظهر ذلك مع «إعادة المحاولة».
 * الإلغاء وإعادة المحاولة يظهران حيث تكون العملية قابلة للقطع وحدها (الزر غير المسموح لا يظهر):
 * التنزيل والرفع وإنشاء النسخة وتجهيز الاستعادة · أما التبديل إلى النسخة والمسح فلا يُقطعان.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, View } from 'react-native';
import { DirView } from './DirView';
import { useAppLocked } from './lockState';
import { T, BtnGhost, BtnPrimary } from './components';
import { C, TYPE } from './theme';
import {
  cancelSource, progressView, progressLabel, progressLine, StallWatch, type CancelSignal, type ProgressInfo,
} from '../domain/progress';

interface TaskState {
  msg: string;
  info: ProgressInfo | null;
  cancellable: boolean;
  retryable: boolean;
  stalled: boolean;
  cancelling: boolean;
}

export interface LongTask {
  /**
   * نداء التقدّم كما كان (setProgress): نصٌّ يظهر النافذة ومقدارٌ اختياري، وnull يخفيها.
   * يوافق ProgressFn فيُمرَّر إلى المجال كما هو.
   */
  report: (msg: string | null, info?: ProgressInfo) => void;
  /** بدء محاولة قابلة للقطع · يعيد إشارة الإلغاء لتُمرَّر إلى العملية · onRetry يُظهر «إعادة المحاولة» */
  begin: (opts?: { cancellable?: boolean; onRetry?: () => void }) => CancelSignal;
  /** مرحلةٌ لا تُقطع (التبديل إلى النسخة مثلاً) · يختفي الإلغاء وتبقى النسبة */
  uncancellable: () => void;
  /** طُلبت إعادة المحاولة فأُلغيت المحاولة الجارية · يقرؤه مسار العملية مرة في معالجة الإلغاء */
  takeRetry: () => boolean;
  element: React.ReactElement | null;
}

export function useLongTask(): LongTask {
  const [st, setSt] = useState<TaskState | null>(null);
  // النافذة المنبثقة فوق غطاء القفل · تختفي ما دام مقفلاً (#51 · ui/lockState.ts)
  const appLocked = useAppLocked();
  const watch = useRef(new StallWatch());
  const ctl = useRef<{ cancel: () => void; onRetry?: () => void } | null>(null);
  const retryFlag = useRef(false);
  // صلاحية القطع للمحاولة الجارية · تُقرأ حين تظهر النافذة مع أول تقدّم
  const mode = useRef({ cancellable: false, retryable: false });

  const report = useCallback((msg: string | null, info?: ProgressInfo) => {
    if (msg === null) { setSt(null); ctl.current = null; mode.current = { cancellable: false, retryable: false }; return; }
    const moved = watch.current.tick(msg, info);
    setSt((p) => ({
      msg, info: info ?? null,
      cancellable: mode.current.cancellable, retryable: mode.current.retryable,
      stalled: moved ? false : (p?.stalled ?? false), cancelling: p?.cancelling ?? false,
    }));
  }, []);

  const begin = useCallback((opts: { cancellable?: boolean; onRetry?: () => void } = {}) => {
    const src = cancelSource();
    ctl.current = { cancel: src.cancel, onRetry: opts.onRetry };
    retryFlag.current = false;
    watch.current.reset();
    const cancellable = opts.cancellable ?? true;
    mode.current = { cancellable, retryable: cancellable && !!opts.onRetry };
    // النافذة تظهر مع أول تقدّم لا قبله · فلا تغطي منتقي الملف
    setSt((p) => (p ? { ...p, ...mode.current, stalled: false, cancelling: false } : p));
    return src.signal;
  }, []);

  const uncancellable = useCallback(() => {
    mode.current = { cancellable: false, retryable: false };
    setSt((p) => (p ? { ...p, cancellable: false, retryable: false } : p));
  }, []);

  const takeRetry = useCallback(() => {
    const r = retryFlag.current;
    retryFlag.current = false;
    return r;
  }, []);

  // دقيقة بلا تقدّم = توقّف ظاهر
  useEffect(() => {
    if (!st) return;
    const t = setInterval(() => {
      if (watch.current.stalled()) setSt((p) => (p && !p.stalled ? { ...p, stalled: true } : p));
    }, 2000);
    return () => clearInterval(t);
  }, [st !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = () => {
    ctl.current?.cancel();
    setSt((p) => (p ? { ...p, cancelling: true } : p));
  };
  const retry = () => {
    const c = ctl.current;
    if (!c?.onRetry) return;
    retryFlag.current = true;
    c.cancel();
    setSt((p) => (p ? { ...p, cancelling: true, msg: 'جاري إعادة المحاولة' } : p));
  };

  let element: React.ReactElement | null = null;
  if (st) {
    const v = progressView(st.msg, st.info);
    const fill: `${number}%` = v.pct !== null ? `${v.pct}%` : '100%';
    element = (
      <Modal visible={!appLocked} transparent animationType="fade">
        <DirView>
        <View style={{ flex: 1, backgroundColor: 'rgba(20,23,29,0.55)', alignItems: 'center', justifyContent: 'center', padding: 28 }}>
          <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 22, minWidth: 280, alignSelf: 'stretch', alignItems: 'center', gap: 10 }}>
            <View style={{ alignSelf: 'stretch', height: 8, borderRadius: 4, backgroundColor: C.paperLine, overflow: 'hidden' }}>
              <View style={{ height: 8, borderRadius: 4, backgroundColor: C.emerald, width: fill, opacity: v.pct !== null ? 1 : 0.3 }} />
            </View>
            <T size={TYPE.number} med center>{st.cancelling ? 'جاري الإلغاء' : progressLabel(st.msg)}</T>
            {v.pct !== null || v.amount ? (
              <T size={TYPE.body} color={C.muted} center>
                {progressLine(v)}
              </T>
            ) : null}
            {st.stalled && !st.cancelling ? (
              <T size={TYPE.body} color={C.rose} center>
                {st.cancellable ? 'لم تتقدم العملية منذ دقيقة' : 'لم تتقدم العملية منذ دقيقة · هذه المرحلة لا تُقطع، فانتظر اكتمالها'}
              </T>
            ) : null}
            {st.cancellable && !st.cancelling ? (
              <View style={{ flexDirection: 'row', gap: 8, alignSelf: 'stretch', marginTop: 4 }}>
                {st.stalled && st.retryable ? <View style={{ flex: 1 }}><BtnPrimary title="إعادة المحاولة" onPress={retry} /></View> : null}
                <View style={{ flex: 1 }}><BtnGhost title="إلغاء" onPress={cancel} /></View>
              </View>
            ) : null}
          </View>
        </View>
        </DirView>
      </Modal>
    );
  }

  return { report, begin, uncancellable, takeRetry, element };
}

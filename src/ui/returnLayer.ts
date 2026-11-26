/**
 * خطّاف الطبقة العائدة (D-4) · `leave(v)` قبل الانتقال إلى شاشة أخرى، فإذا عاد التركيز إلى هذه الشاشة
 * (زر الرجوع أو التبويب) استُدعي `restore(v)` مرةً واحدة فتُفتح الورقة كما كانت.
 */
import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { ReturnLayer } from './returnLayerStore';

export function useReturnLayer<T>(restore: (v: T) => void): (v: T) => void {
  const layer = useRef(new ReturnLayer<T>()).current;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  useFocusEffect(useCallback(() => {
    const v = layer.take();
    if (v !== null) restoreRef.current(v);
  }, [layer]));
  return useCallback((v: T) => layer.leave(v), [layer]);
}

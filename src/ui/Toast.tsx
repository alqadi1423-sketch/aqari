import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT_MED } from './theme';

const ToastCtx = createContext<(msg: string) => void>(() => {});

/** جسر أمري للخدمات خارج شجرة React · المزوّد يسجّل نفسه حين يُركَّب */
let imperativeToast: ((msg: string) => void) | null = null;
export function showToast(msg: string): void { imperativeToast?.(msg); }

export function ToastProvider({ children }: { children: React.ReactNode }) {
  // خارج شجرة التكبير · فوق شريط التبويبات وخط الإيماءة بقيم فيزيائية
  const insets = useSafeAreaInsets();
  const [msg, setMsg] = useState('');
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback(
    (m: string) => {
      setMsg(m);
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }).start();
      }, 2600);
    },
    [opacity]
  );
  useEffect(() => { imperativeToast = show; return () => { imperativeToast = null; }; }, [show]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <Animated.View pointerEvents="none" style={[st.toast, { opacity, bottom: insets.bottom + 90 }]}>
        <View style={st.dot} />
        <Text style={st.msg}>{msg}</Text>
      </Animated.View>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

const st = StyleSheet.create({
  toast: {
    position: 'absolute', alignSelf: 'center', backgroundColor: C.ink,
    paddingVertical: 12, paddingHorizontal: 20, borderRadius: 9, flexDirection: 'row',
    alignItems: 'center', gap: 9, maxWidth: '88%',
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.emerald },
  msg: { fontFamily: FONT_MED, color: '#fff', fontSize: 12.5, textAlign: 'right', flexShrink: 1 },
});

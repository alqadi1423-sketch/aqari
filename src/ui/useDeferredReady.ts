/**
 * «الانتقال لا ينتظر البيانات»: الشاشة تُفتح فوراً بهيكل تحميل،
 * والحساب الثقيل يجري بعد أول رسم · فزمن الضغطة إحساسه صفر.
 */
import { useEffect, useRef, useState } from 'react';

export function useDeferredReady(): boolean {
  const [ready, setReady] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    // إطاران بعد أول رسم · لا InteractionManager الذي قد يؤجل بلا سقف
    // بانتظار تفاعلات لا تخص هذه الشاشة (قيس تأجيله بالثواني)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (alive.current) setReady(true);
    }));
    return () => { alive.current = false; };
  }, []);
  return ready;
}

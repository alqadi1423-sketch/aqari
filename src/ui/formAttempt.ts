/**
 * محاولة الحفظ (قرار المالك 2026-10-07): الخانة الإلزامية لا تُظلَّل بالأحمر إلا بعد محاولة حفظ ناقصة،
 * ويزول الأحمر عند الكتابة فيها · وزر «حفظ» ظاهر دائماً.
 * الاستعمال: const f = useSaveAttempt(); … error={f.missing(name)} … onPress={() => f.attempt(ok, save)}
 */
import { useCallback, useState } from 'react';

export function useSaveAttempt() {
  const [tried, setTried] = useState(false);
  /** الخانة فارغة بعد محاولة حفظ · فتُظلَّل · والكتابة فيها تزيل الأحمر بلا خطوة أخرى */
  const missing = useCallback((v: string | null | undefined) => tried && !String(v ?? '').trim(), [tried]);
  /** يحفظ إن اكتملت الخانات · وإلا تُظلَّل الناقصة ولا يُحفظ شيء */
  const attempt = useCallback((complete: boolean, save: () => void) => {
    if (!complete) { setTried(true); return; }
    save();
  }, []);
  const reset = useCallback(() => setTried(false), []);
  return { tried, missing, attempt, reset };
}

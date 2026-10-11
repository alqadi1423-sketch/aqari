/**
 * حال قفل التطبيق للنوافذ المنبثقة (#51 · المتحقق المستقل): النافذة المنبثقة (Modal) نافذةٌ فوق غطاء القفل، فكانت تبقى ظاهرةً
 * وتعمل فوقه · فكل نافذةٍ منبثقة تختفي ما دام التطبيق مقفلاً · وتحت الغطاء المؤقت عند الخروج إلى الخلفية تبقى، لأن طيّها
 * على أندرويد يمحو ما فيها (المتحقق، الجولة السادسة)
 */
import { useEffect, useState } from 'react';

let locked = false;
const subs = new Set<() => void>();

export function setAppLocked(v: boolean): void {
  if (locked === v) return;
  locked = v;
  subs.forEach((f) => f());
}

export function useAppLocked(): boolean {
  const [v, setV] = useState(locked);
  useEffect(() => {
    const f = () => setV(locked);
    subs.add(f);
    f();
    return () => { subs.delete(f); };
  }, []);
  return v;
}

/**
 * «هل كتب المستخدم شيئاً في هذه الورقة؟» · سياقٌ تملكه الورقة ويُبلّغه كل حقل إدخال فيها.
 *
 * البند: كل عنصر يفتح شيئاً يغلقه الضغط ثانيةً، وشرطٌ لازم: إن أدخل المستخدم بيانات فلا يُغلق
 * بلا استئذانه. والورقة تُغلق من ثلاثة أبواب (الخلفية · علامة ✕ · زر الرجوع في أندرويد)
 * وستون ورقةً في التطبيق لا تحمل حارساً، فلا يُكتب الحارس ستين مرة بل مرةً هنا:
 * الحقول المشتركة تُعلّم الورقة عند أول تغيير، والورقة تستأذن قبل الإغلاق إن عُلّمت.
 * وحفظُ الورقة أو إلغاؤها بزرَيها لا يمرّ بهذا الباب، فلا استئذان على فعلٍ مقصود.
 */
import { createContext, useContext } from 'react';

export const SheetDirtyCtx = createContext<{ mark(): void } | null>(null);

/** يعيد دالةً تُعلّم الورقة الحاوية بأن فيها إدخالاً · وخارج أي ورقة لا تفعل شيئاً */
export function useMarkSheetDirty(): () => void {
  const ctx = useContext(SheetDirtyCtx);
  return ctx ? ctx.mark : noop;
}

const noop = (): void => {};

/**
 * هل تغيّر النموذج عمّا فُتح عليه؟ · مقارنة قيم (لا مراجع) تنزل في الكائنات والمصفوفات ·
 * فما كُتب ثم مُسح حتى عاد كما كان ليس إدخالاً، وتغيير اختيارٍ وحده إدخال (D-3).
 */
export function formChanged(base: unknown, now: unknown): boolean {
  if (Object.is(base, now)) return false;
  if (base === null || now === null || typeof base !== 'object' || typeof now !== 'object') {
    // الغائب والفارغ سواء في الحقول الاختيارية
    const blank = (v: unknown) => v === undefined || v === null || v === '';
    return !(blank(base) && blank(now));
  }
  if (Array.isArray(base) !== Array.isArray(now)) return true;
  const a = base as Record<string, unknown>;
  const b = now as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (formChanged(a[k], b[k])) return true;
  return false;
}

/**
 * هل يستأذن إغلاق الورقة بالإيماءة؟ · حكم صاحب النموذج (`dirty`) إن مرّره مقدَّمٌ على العلامة
 * الداخلية، لأن العلامة تُصفَّر كلما ظهرت الورقة والإدخال باقٍ عنده (العودة من المراجعة · D-3).
 */
export function sheetNeedsConfirm(dirty: boolean | undefined, marked: boolean): boolean {
  return dirty !== undefined ? dirty : marked;
}

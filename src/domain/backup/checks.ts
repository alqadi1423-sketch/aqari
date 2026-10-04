/**
 * الفحوص الواحدة للنسخ والاستعادة بالحكم نفسه (قرار المالك ٢٠٢٦-١٠-٠٤) · فلا تمرّ بيانات في أحدهما وتُرفض في الآخر:
 *  - تلفٌ يرفض الاثنين: مبلغ بالهللات ليس عدداً صحيحاً (لا ينتجه التطبيق). ومعه ما يرفضانه قبل هذا الفحص:
 *    ملف مفقود أو تالف، بصمة لا تطابق، قاعدة لا تجتاز integrity_check، اسم مرفق غير صالح.
 *  - فرقٌ محاسبي لا يمنع أحداً من حفظ بياناته ولا استعادتها: النسخة تُنشأ وتُوسم «فيها ملاحظات»
 *    بأسماء الفحوص وأرقامها، والاستعادة تمرّ وتعرضها، وتظهر في أداة مراجعة الدفتر.
 */
import type { DB } from '../../db/adapter';
import { semanticIssues, NON_INTEGER_ISSUE } from './semantic';
import { integrityChecks } from '../accounting/integrity';

export interface DataReview {
  /** تلف · يرفض النسخ والاستعادة */
  blocking: string[];
  /** فروق محاسبية · تُكتب في النسخة وتُعرض ولا تمنع */
  notes: string[];
}

export function reviewData(db: DB): DataReview {
  const sem = semanticIssues(db);
  const blocking = sem.filter((x) => x.startsWith(NON_INTEGER_ISSUE));
  const notes = [
    ...integrityChecks(db).filter((c) => !c.ok).map((c) => `«${c.name}» (${c.value})`),
    ...sem.filter((x) => !x.startsWith(NON_INTEGER_ISSUE)),
  ];
  return { blocking, notes };
}

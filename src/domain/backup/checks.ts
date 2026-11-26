/**
 * الفحوص الواحدة للنسخ والاستعادة بالحكم نفسه (قرار المالك ٢٠٢٦-١٠-٠٤) · فلا تمرّ بيانات في أحدهما وتُرفض في الآخر:
 *  - تلفٌ يرفض الاثنين: مبلغ بالهللات ليس عدداً صحيحاً (لا ينتجه التطبيق). ومعه ما يرفضانه قبل هذا الفحص:
 *    ملف مفقود أو تالف، بصمة لا تطابق، قاعدة لا تجتاز integrity_check، اسم مرفق غير صالح.
 *  - فرقٌ محاسبي لا يمنع أحداً من حفظ بياناته ولا استعادتها: النسخة تُنشأ وتُوسم «فيها ملاحظات»
 *    بأسماء الفحوص وأرقامها، والاستعادة تمرّ وتعرضها، وتظهر في أداة مراجعة الدفتر.
 *  - إلا القيد المرحّل غير المتوازن أو بلا سطور: يرفض الاستعادة كما يرفضه فحص المزامنة على الأجهزة الأخرى، فلا يُعتمد للسحابة دفترٌ
 *    ترفضه أجهزة الأعضاء (المراجعة الشاملة 2026-11-13 · C-12 · قرار المالك س١١ تطبيقاً لقرار 2026-10-02) · وإنشاء النسخة يبقى
 *    يمرّ بملاحظة (2026-10-04)، فالتطبيق لا يصنعه (المحفّزات تمنعه) ولا يأتي إلا من ملفٍ تالف أو مصنوع.
 */
import type { DB } from '../../db/adapter';
import { semanticIssues, NON_INTEGER_ISSUE, UNBALANCED_ISSUE, LINELESS_ISSUE } from './semantic';
import { integrityChecks } from '../accounting/integrity';

export interface DataReview {
  /** تلف · يرفض النسخ والاستعادة */
  blocking: string[];
  /** فروق محاسبية · تُكتب في النسخة وتُعرض ولا تمنع */
  notes: string[];
  /** قيدٌ مرحّل مختل · ملاحظةٌ في إنشاء النسخة، ويرفض الاستعادة (C-12) */
  restoreBlocking: string[];
}

export function reviewData(db: DB): DataReview {
  const sem = semanticIssues(db);
  const blocking = sem.filter((x) => x.startsWith(NON_INTEGER_ISSUE));
  const notes = [
    ...integrityChecks(db).filter((c) => !c.ok).map((c) => `«${c.name}» (${c.value})`),
    ...sem.filter((x) => !x.startsWith(NON_INTEGER_ISSUE)),
  ];
  const restoreBlocking = sem.filter((x) => x.startsWith(UNBALANCED_ISSUE) || x.startsWith(LINELESS_ISSUE));
  return { blocking, notes, restoreBlocking };
}

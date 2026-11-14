/**
 * قاعدةٌ كأنها من إصدارٍ قبل الترحيلة ٥١ (أبعاد سطر القيد المرحّل تُملأ مرةً ولا تُغيَّر): لاختباراتٍ تصنع حال القيود القديمة بلا
 * أبعاد أو بأبعادٍ كتبها إصدارٌ سابق · يُنزع المحفّز، ثم يعود بنصه نفسه من الترحيلة · بيانات مصطنعة.
 */
import { MIGRATION_51 } from '@/db/schema';
import type { DB } from '@/db/adapter';

export function asLegacyDims<T>(db: DB, fn: () => T): T {
  db.exec('DROP TRIGGER IF EXISTS trg_jl_dims_fill_only');
  try {
    return fn();
  } finally {
    db.exec(MIGRATION_51);
  }
}

/**
 * رمز ضريبة سطر الفاتورة (الهجرة ٣٩ · دراسة القائم 2026-10-09): خاضع S، صفري Z، معفى E · وحدةٌ بلا تبعيات فيقرؤها
 * الإقرار والفواتير معاً بلا دورة استيراد.
 */
import type { DB } from '../db/adapter';

export type TaxCode = 'S' | 'Z' | 'E';

/** رمز السطر: المخزَّن، وإلا من نسبته (القديم: فوق الصفر خاضع، وإلا معفى كما كان خياره «0٪ (معفى)») */
export const lineTaxCode = (code: string | null | undefined, pct: number): TaxCode =>
  code === 'S' || code === 'Z' || code === 'E' ? code : pct > 0 ? 'S' : 'E';

/** النسبة الأساسية لضريبة القيمة المضافة (٪) */
export const STANDARD_VAT_PCT = 15;

/** هل المنشأة مسجّلة في ضريبة القيمة المضافة (company.vat_enabled) */
export const vatRegistered = (db: DB): boolean =>
  !!Number(db.get<{ v: number }>(`SELECT vat_enabled AS v FROM company WHERE id = 1`)?.v ?? 0);

/**
 * مبلغٌ مقبوض شامل الضريبة بالنسبة الأساسية ← صافيه وضريبته بالهللة (المراجعة الشاملة ٨ · البند ١١):
 * الصافي = round(المبلغ × 100 ÷ 115) والضريبة الباقي، فيجتمعان إلى المقبوض بلا فرق تقريب.
 */
export function splitVatInclusive(grossHalalas: number): { net: number; tax: number } {
  const net = Math.round((grossHalalas * 100) / (100 + STANDARD_VAT_PCT));
  return { net, tax: grossHalalas - net };
}

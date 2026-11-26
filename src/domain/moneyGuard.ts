/**
 * فحص المبالغ المدخلة في العقد والتجديد والحجز وصفقة التقبيل (المراجعة الشاملة 2026-11-13 · A1-7).
 * كل مبلغٍ ماليٍّ عددٌ صحيحٌ بالهللات غير سالب · و«-» تقبله toHalalas ولوحة الأرقام، فكان التأمين −١٬٠٠٠ يُحفظ بلا قيد،
 * والتأمين الإضافي السالب في التجديد يعلق في 2400 · والرسالة جملةٌ كاملة تسمّي الحقل وقيمته (قرار المالك 2026-08-19).
 */
import { t } from '../i18n';
import { fmt } from './money';

/** الحقول المالية المفحوصة · مفتاح اسمها في ar.json/en.json (money.field…) */
export type MoneyField = 'Value' | 'Deposit' | 'Services' | 'Parking' | 'ExtraDeposit' | 'ReservationDeposit' | 'KeyMoney' | 'Commission';

export function moneyFieldLabel(field: MoneyField, lng?: 'ar' | 'en'): string {
  return t('money.field' + field, lng ? { lng } : undefined);
}

/** رسالة رفض المبلغ أو null · الغائب (undefined/null) مقبول: الحقل الاختياري يُعامل صفراً عند كاتبه */
export function moneyError(field: MoneyField, halalas: number | null | undefined): string | null {
  if (halalas == null) return null;
  if (typeof halalas !== 'number' || !Number.isInteger(halalas)) return t('money.notInteger', { field: moneyFieldLabel(field), value: String(halalas) });
  if (halalas < 0) return t('money.negative', { field: moneyFieldLabel(field), value: fmt(halalas) });
  return null;
}

/** أول رسالة رفض بين الحقول المعطاة بترتيبها، مع الحقل */
export function firstMoneyError(fields: Array<[MoneyField, number | null | undefined]>): { field: MoneyField; message: string } | null {
  for (const [field, v] of fields) {
    const message = moneyError(field, v);
    if (message) return { field, message };
  }
  return null;
}

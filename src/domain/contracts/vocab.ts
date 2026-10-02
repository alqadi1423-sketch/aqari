/**
 * مفردات العقد الموحّدة: قائمة واحدة يستوردها كل نموذج، فلا تفترق شاشة عن شاشة.
 * كانت «مفروشة جزئياً» في الإنشاء و«مؤثثة جزئياً» في التجديد فتنشقّ البيانات شقّين.
 */
import { CYCLE_MONTHS } from './installments';

export const FURNISHED_OPTIONS = ['غير مؤثثة', 'مؤثثة', 'مؤثثة جزئياً'] as const;

/** دوريات الدفع من خريطة الأشهر نفسها · دورية تُضاف للنطاق تظهر في كل الشاشات وحدها */
export const CYCLE_OPTIONS = Object.keys(CYCLE_MONTHS);

/**
 * حالة التأمين: أين يقبع المبلغ فعلاً · النص للمطبوعات وحدها واللون في التفاصيل والقوائم.
 * محتجز لدى إيجار (1260 أزرق) · لدينا (1100/1110 أخضر) · في محفظة إيجار (1265 ذهبي)
 * بعد تسوية بخصم بقي في المحفظة · وطرف آخر رمادي باسمه.
 */
export function depositState(
  holder?: string | null,
  holderName?: string | null,
  inWallet1265?: boolean
): { label: string; fg: string; bg: string } {
  // label للمطبوعات · وفي التفاصيل والقوائم اللون وحده بلا نص
  if (inWallet1265) return { label: 'في محفظة إيجار', fg: '#8A6D1C', bg: '#FBF0D3' };
  if (holder === 'منصة إيجار') return { label: 'لدى إيجار', fg: '#1D4ED8', bg: '#DBEAFE' };
  if (holder === 'طرف آخر') {
    const n = holderName?.trim() ? 'لدى ' + holderName.trim() : 'لدى طرف آخر';
    return { label: n, fg: '#5B6472', bg: '#EDEFF2' };
  }
  return { label: 'لدينا', fg: '#106B45', bg: '#DDF3E7' };
}

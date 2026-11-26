/**
 * مصدر القيد في الرئيسية («أحدث الحركات» وأوراق التفصيل) · المسار الذي يفتحه ضغط الصف · D-22.
 *
 * الرئيسية تسأل routeAllowed عن هذا المسار قبل أن تجعل الصف زراً: عضوٌ يرى الدفتر ولا يرى المشتريات كان يضغط قيد
 * شراءٍ فيرجعه حارس المسارات إلى الرئيسية بلا نتيجة. دالةٌ خالصة بلا React Native لتُختبر وحدها.
 */

const PURCHASE = new Set(['purchase', 'purchase_pay', 'vat_refund']);
const CONTRACT = new Set(['contract_deposit', 'deposit_refund', 'deposit_carry', 'deposit_deduct', 'deposit_deduct_move', 'deposit_rent', 'key_money']);
const CLAIM = new Set(['claim', 'claim_collect']);

/** rentContract: عقد دفعة الإيجار من معرّفها (استعلامٌ يمرّره المنادي) */
export function sourcePath(srcType: string | null, srcId: string | null, rentContract: (paymentId: string) => string | null): string {
  if (!srcType || !srcId) return '/journal';
  if (PURCHASE.has(srcType)) return `/purchases?detail=${srcId}`;
  if (srcType === 'invoice') return `/invoices?detail=${srcId}`;
  if (srcType === 'rent') {
    const c = rentContract(srcId);
    if (c) return `/contracts?detail=${c}`;
  }
  if (CONTRACT.has(srcType)) return `/contracts?detail=${srcId}`;
  if (CLAIM.has(srcType)) return `/claims?detail=${srcId}`;
  if (srcType === 'cash_op') return '/banks';
  return '/journal';
}

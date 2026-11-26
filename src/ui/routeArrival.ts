/**
 * الوصول إلى تبويبٍ بمعاملات (روابط الرئيسية وغيرها) · D-9.
 *
 * كل وصولٍ بمعاملات يبدأ بمسح المرشّحات ثم يطبّق ما جاء، فلا يبقى بحثٌ أو مدى تأخيرٍ من وصولٍ سابق تحت رقمٍ
 * يخص الجميع · والشاشة تستهلك المعامل بعد تطبيقه، فتعمل الضغطة الثانية على الرابط نفسه.
 * دوالّ خالصة بلا React Native لتُختبر وحدها.
 */

type Param = string | string[] | undefined;

/** معامل المسار نصاً · قد يصل مصفوفة */
export function paramStr(v: Param): string {
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

export interface CollectArrival { filter: string; q: string; fProp: string; fLate: string; fAmt: string }

/** شرائح أعمار الذمم في الرئيسية (AGING_BUCKETS) بمدى التأخير في مرشّح التحصيل */
const LATE_BY_BUCKET: Record<string, string> = { '1': '1-30', '2': '31-60', '3': '61-90', '4': '90+' };

/** حالة مرشّحات «التحصيل» بعد الوصول · null إن لم يأتِ معاملٌ منها */
export function collectArrival(p: { filter?: Param; bucket?: Param; q?: Param }): CollectArrival | null {
  const filter = paramStr(p.filter);
  const bucket = paramStr(p.bucket);
  const q = paramStr(p.q);
  if (!filter && !bucket && !q) return null;
  return { filter: filter || 'due', q, fProp: '', fLate: LATE_BY_BUCKET[bucket] ?? '', fAmt: '' };
}

export interface ContractsArrival { fStatus: string; fProp: string; fUnit: string; fPeriod: string; fCycle: string; q: string }

/** حالة مرشّحات «العقود» بعد وصولٍ بحالة · وفتح التفصيل وحده لا يمسّ القائمة (null) */
export function contractsArrival(p: { status?: Param; detail?: Param }): ContractsArrival | null {
  const status = paramStr(p.status);
  if (!status) return null;
  return { fStatus: status, fProp: '', fUnit: '', fPeriod: '', fCycle: '', q: '' };
}

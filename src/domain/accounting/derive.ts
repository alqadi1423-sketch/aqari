/**
 * إعادة اشتقاق سطور قيد العضو من مصدره · المرحلة الأولى: الدفعات والتحصيل (المراجعة الخارجية ٧ · النتيجة ١ · قرار المالك
 * 2026-10-15 «١»: «(ب) على مراحل، الدفعات والتحصيل أولاً») · جهاز المالك يحسب سطور قيد التحصيل من دفعته بالدوال التي رحّل بها
 * الجهاز الكاتب، ويقارنها بالسطور الواردة حساباً بحساب · ووصف السطر وأبعاده لا تُقارن هنا
 *  أشكال قيد «rent» ثلاثة: تحصيل قسط (مصدره القسط) · سداد من الرصيد الدائن (مصدره الدفعة) · تحصيل جماعي (مصدره
 *  العقد، بلا قسط، وفائضه رصيدٌ دائن 2410 بقدر ما لم يُخصَّص على الأقساط)
 */
import type { DB } from '../../db/adapter';
import { t } from '../../i18n';
import { rentCollectionLines, type EntryLine } from './post';
import { rentRevenueLines, RENT_REVENUE_GROUP } from './rentSplit';
import type { DiscountKind } from '../contracts/installments';

export interface RentPaymentSrc {
  id: string;
  contract_id: string;
  installment_id: string | null;
  date: string;
  net_halalas: number;
  discount_halalas: number;
  discount_kind: string | null;
}

export interface IncomingLines { srcId: string; date: string; lines: Array<{ account: string; debit: number; credit: number }> }

const CASH = '1100';
const TENANT_CREDIT = '2410';

/**
 * فرق التقريب وحده بين حسابات إيراد العقد (القاعدة ٩٩ وقرار المالك 2026-10-15: «هللتان على الأكثر لكل حساب، وما زاد يُرفض»):
 * ما زاد ينقل إيراداً بين معفى وخاضع فيغيّر الإقرار · والتوزيع من العقد ودفعاته (rentSplit) فلا يبعد بين جهازين إلا بهللة لكل
 * حساب، وبهللتين للإيجار الذي يأخذ الباقي · ومجموع الإيراد يُطابق بالضبط
 */
const SPLIT_SLACK = 2;

function byAccount(lines: Array<{ account: string; debit: number; credit: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.account, (m.get(l.account) ?? 0) + (Number(l.debit) || 0) - (Number(l.credit) || 0));
  for (const [k, v] of m) if (!v) m.delete(k);
  return m;
}

/** فرق السطور الواردة عن المشتقة · '' إن طابقت */
function linesIssue(got: Map<string, number>, want: Map<string, number>): string {
  let gotRev = 0;
  let wantRev = 0;
  for (const a of new Set([...got.keys(), ...want.keys()])) {
    const g = got.get(a) ?? 0;
    const w = want.get(a) ?? 0;
    if (RENT_REVENUE_GROUP.includes(a)) {
      gotRev += g;
      wantRev += w;
      if (Math.abs(g - w) > SPLIT_SLACK) return t('derive.account', { account: a, lng: 'ar' });
    } else if (g !== w) return t('derive.account', { account: a, lng: 'ar' });
  }
  return gotRev === wantRev ? '' : t('derive.revenue', { lng: 'ar' });
}

/**
 * سبب رفض قيد تحصيلٍ وارد من دفعته · '' إن طابقها · 'await' إن احتاج تخصيص التحصيل الجماعي ولم يصل بعد
 * allocated: مجموع تخصيص الدفعة على الأقساط (payment_allocations) إن وصل، وإلا null
 */
export function rentEntryIssue(db: DB, e: IncomingLines, pay: RentPaymentSrc, allocated: number | null): string {
  if (e.date !== pay.date) return t('derive.date', { lng: 'ar' });
  const net = Number(pay.net_halalas) || 0;
  const discount = Number(pay.discount_halalas) || 0;
  const cid = pay.contract_id;
  const got = byAccount(e.lines);
  const shapes: Array<() => EntryLine[] | 'await'> = [];
  // تحصيل قسط (postRentCollection) · وشاشة التحصيل لا تسجّل دفعةً بلا قسط، فالدفعة بلا قسطٍ تحصيلٌ جماعي يُطابق تخصيصه (وإلا
  // قُبل فائضه إيراداً بحجب تخصيصه)
  if (pay.installment_id && e.srcId === pay.installment_id) {
    shapes.push(() => rentCollectionLines(db, { contractId: cid, net, discount, discountKind: pay.discount_kind as DiscountKind | null }));
  }
  // سداد من الرصيد الدائن (applyTenantCredit)
  if (e.srcId === pay.id && !discount) {
    shapes.push(() => [{ account: TENANT_CREDIT, debit: net, credit: 0 }, ...rentRevenueLines(db, cid, net, '', 'credit')]);
  }
  // تحصيل جماعي (recordBulkRentPayment): الإيراد بالمخصَّص والفائض رصيدٌ دائن
  if (e.srcId === cid && !pay.installment_id && !discount) {
    shapes.push(() => {
      const hasRevenue = RENT_REVENUE_GROUP.some((a) => got.has(a));
      const alloc = allocated ?? (hasRevenue ? null : 0);
      if (alloc === null) return 'await';
      return [
        { account: CASH, debit: net, credit: 0 },
        ...(alloc > 0 ? rentRevenueLines(db, cid, alloc, '', 'credit') : []),
        ...(net - alloc > 0 ? [{ account: TENANT_CREDIT, debit: 0, credit: net - alloc }] : []),
      ];
    });
  }
  if (!shapes.length) return t('derive.source', { lng: 'ar' });
  let first = '';
  let waiting = false;
  for (const shape of shapes) {
    const want = shape();
    if (want === 'await') { waiting = true; continue; }
    const why = linesIssue(got, byAccount(want));
    if (!why) return '';
    first ||= why;
  }
  return waiting ? 'await' : first;
}

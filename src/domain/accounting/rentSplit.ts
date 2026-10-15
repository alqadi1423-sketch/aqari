/**
 * فصل إيراد العقد (قرار المالك ٢٠٢٦-١٠-٠٧): الأقساط تبقى مطابقة لجدول إيجار بالضبط، والإيراد في الدفتر يُقسم
 * بالنسبة: «إيرادات الإيجار» 4200، و«إيرادات الخدمات (غاز وكهرباء ومياه)» 4210، و«إيرادات المواقف» 4220.
 * قيمة العقد هي «كامل قيمة الإيجار» (قرار المالك ٢٠٢٦-١٠-٠٧)، ومبلغا الخدمات والمواقف فوقها (الهجرة ٣٢)، وإجمالي العقد
 * مجموع الثلاثة وهو مجموع الأقساط. النسبة من إجمالي العقد · والعقد بلا تفصيل يبقى كله إيجاراً.
 * كل مسارٍ يقيّد إيراد إيجار يمرّ من هنا: التحصيل، والتحصيل الجماعي، وتحويل العربون، والخصم بعد الاستحقاق،
 * وردّ الفائض وتحويله.
 */
import type { DB } from '../../db/adapter';
import { t } from '../../i18n';
import type { EntryLine } from './post';

export const RENT_REVENUE = '4200';
export const SERVICES_REVENUE = '4210';
export const PARKING_REVENUE = '4220';
/** حسابات إيراد العقد معاً · لمراجعة الدفتر التي تشتق المحصَّل منه */
export const RENT_REVENUE_GROUP = [RENT_REVENUE, SERVICES_REVENUE, PARKING_REVENUE];
export const RENT_REVENUE_SQL = RENT_REVENUE_GROUP.map((c) => `'${c}'`).join(', ');

const colsCache = new WeakMap<object, boolean>();
function hasSplitColumns(db: DB): boolean {
  const k = db as unknown as object;
  let v = colsCache.get(k);
  if (v === undefined) {
    v = db.all<{ name: string }>(`PRAGMA table_info(contracts)`).some((c) => c.name === 'services_halalas');
    if (v) colsCache.set(k, v);
  }
  return v;
}

/**
 * إيراد العقد المحصَّل من دفعاته غير الملغاة: التحصيل الجماعي بتخصيصه على الأقساط، وغيره بصافيه والخصم بعد الاستحقاق ·
 * null إن لم تكن أعمدته في القاعدة
 *  القاعدة ٩٩ وقرار المالك 2026-10-15: التوزيع من بيانات يراها الجهازان معاً (العقد والدفعة) · كان من سطور الدفتر بعُد
 *  العقد، وجهاز العضو يرى بعضها، فيختلف توزيعه عن جهاز المالك بأكثر من التقريب
 */
function paidRevenue(db: DB, contractId: string): number | null {
  const k = db as unknown as object;
  let has = payColsCache.get(k);
  if (has === undefined) {
    const cols = db.all<{ name: string }>(`PRAGMA table_info(contract_payments)`).map((c) => c.name);
    has = cols.includes('cancelled_at') && cols.includes('discount_kind')
      && !!db.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'payment_allocations'`);
    // النتيجة الإيجابية وحدها تُحفظ · فقاعدة تُرقّى وهي مفتوحة تُفحص من جديد
    if (has) payColsCache.set(k, has);
  }
  if (!has) return null;
  return Number(db.get<{ n: number }>(
    `SELECT COALESCE(SUM(COALESCE(
       (SELECT SUM(a.amount_halalas) FROM payment_allocations a WHERE a.payment_id = p.id),
       p.net_halalas + CASE WHEN p.discount_kind = '${AFTER_DUE}' THEN p.discount_halalas ELSE 0 END)), 0) AS n
     FROM contract_payments p WHERE p.contract_id = ? AND p.cancelled_at IS NULL`, [contractId])?.n ?? 0);
}
const payColsCache = new WeakMap<object, boolean>();
const AFTER_DUE = 'بعد الاستحقاق'; // i18n-exempt: نوع الخصم المخزَّن

/**
 * نصيب الخدمات والمواقف من مبلغٍ بنسبتهما من إجمالي العقد · والهللات الباقية على الإيجار.
 * التقريب تراكمي على مستوى العقد (المراجعة #10): نصيب كل حساب = نسبته من إيراد العقد المحصَّل بعد المبلغ، ناقص نسبته منه
 * قبله · فلا تتآكل هللات الخدمات والمواقف مع كثرة الدفعات · والعكس (side = 'debit') كذلك.
 * والمحصَّل من العقد ودفعاته (paidRevenue) لا من الدفتر: فيتفق جهازان على التوزيع إلا بهللةٍ لكل حساب مهما اختلف ما يريانه
 * من الدفتر أو من الدفعات (نصيب(ق + م) − نصيب(ق) لا يبعد عن نسبة م إلا بأقل من هللة)، فيُعاد اشتقاقه على جهاز المالك (derive.ts)
 */
export function rentSplit(db: DB, contractId: string | null | undefined, amount: number, side: 'credit' | 'debit' = 'credit'): { rent: number; services: number; parking: number } {
  if (!contractId || !amount || !hasSplitColumns(db)) return { rent: amount, services: 0, parking: 0 };
  const c = db.get<{ v: number; s: number; p: number }>(
    `SELECT value_halalas AS v, services_halalas AS s, parking_halalas AS p FROM contracts WHERE id = ?`, [contractId]);
  const v = Number(c?.v ?? 0);
  const s = Number(c?.s ?? 0);
  const p = Number(c?.p ?? 0);
  if (!v || (!s && !p) || s < 0 || p < 0) return { rent: amount, services: 0, parking: 0 };
  const total = v + s + p;
  const share = (cum: number, x: number) => (cum >= 0 ? Math.floor((cum * x) / total) : -Math.floor((-cum * x) / total));
  const before = paidRevenue(db, contractId) ?? 0;
  const after = before + (side === 'credit' ? amount : -amount);
  const dir = side === 'credit' ? 1 : -1;
  const clamp = (x: number) => Math.min(Math.max(0, x), amount);
  let services = clamp(dir * (share(after, s) - share(before, s)));
  let parking = clamp(dir * (share(after, p) - share(before, p)));
  if (services + parking > amount) parking = amount - services;
  return { rent: amount - services - parking, services, parking };
}

/** إجمالي العقد بعبارة SQL: الإيجار والخدمات والمواقف · ما يدفعه المستأجر ومجموع أقساطه · a بادئة الجدول إن وُجدت */
export function contractTotalSql(db: DB, a = ''): string {
  return hasSplitColumns(db) ? `(${a}value_halalas + ${a}services_halalas + ${a}parking_halalas)` : `${a}value_halalas`;
}

/** إجمالي العقد من صفه (SELECT *) · الإيجار والخدمات والمواقف */
export function contractTotalOf(c: { value_halalas: number; services_halalas?: number | null; parking_halalas?: number | null }): number {
  return Number(c.value_halalas || 0) + Number(c.services_halalas || 0) + Number(c.parking_halalas || 0);
}

/** سطور إيراد العقد لمبلغٍ في جهةٍ واحدة (دائن للإيراد، ومدين لعكسه) · وصف سطر الإيجار كما يمرّره المسار */
export function rentRevenueLines(db: DB, contractId: string | null | undefined, amount: number, descr: string, side: 'credit' | 'debit'): EntryLine[] {
  const sp = rentSplit(db, contractId, amount, side);
  const line = (account: string, value: number, d: string): EntryLine =>
    ({ account, descr: d, debit: side === 'debit' ? value : 0, credit: side === 'credit' ? value : 0 });
  return [
    line(RENT_REVENUE, sp.rent, descr),
    ...(sp.services ? [line(SERVICES_REVENUE, sp.services, t('lease.revServices', { lng: 'ar' }))] : []),
    ...(sp.parking ? [line(PARKING_REVENUE, sp.parking, t('lease.revParking', { lng: 'ar' }))] : []),
  ];
}

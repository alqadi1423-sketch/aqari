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

/** نصيب الخدمات والمواقف من مبلغٍ بنسبتهما في العقد · والهللات الباقية على الإيجار */
export function rentSplit(db: DB, contractId: string | null | undefined, amount: number): { rent: number; services: number; parking: number } {
  if (!contractId || !amount || !hasSplitColumns(db)) return { rent: amount, services: 0, parking: 0 };
  const c = db.get<{ v: number; s: number; p: number }>(
    `SELECT value_halalas AS v, services_halalas AS s, parking_halalas AS p FROM contracts WHERE id = ?`, [contractId]);
  const v = Number(c?.v ?? 0);
  const s = Number(c?.s ?? 0);
  const p = Number(c?.p ?? 0);
  if (!v || (!s && !p) || s < 0 || p < 0) return { rent: amount, services: 0, parking: 0 };
  const total = v + s + p;
  const services = Math.floor((amount * s) / total);
  const parking = Math.floor((amount * p) / total);
  return { rent: amount - services - parking, services, parking };
}

/** إجمالي العقد بعبارة SQL: الإيجار والخدمات والمواقف · ما يدفعه المستأجر ومجموع أقساطه · a بادئة الجدول إن وُجدت */
export function contractTotalSql(db: DB, a = ''): string {
  return hasSplitColumns(db) ? `(${a}value_halalas + ${a}services_halalas + ${a}parking_halalas)` : `${a}value_halalas`;
}

/** سطور إيراد العقد لمبلغٍ في جهةٍ واحدة (دائن للإيراد، ومدين لعكسه) · وصف سطر الإيجار كما يمرّره المسار */
export function rentRevenueLines(db: DB, contractId: string | null | undefined, amount: number, descr: string, side: 'credit' | 'debit'): EntryLine[] {
  const sp = rentSplit(db, contractId, amount);
  const line = (account: string, value: number, d: string): EntryLine =>
    ({ account, descr: d, debit: side === 'debit' ? value : 0, credit: side === 'credit' ? value : 0 });
  return [
    line(RENT_REVENUE, sp.rent, descr),
    ...(sp.services ? [line(SERVICES_REVENUE, sp.services, t('lease.revServices', { lng: 'ar' }))] : []),
    ...(sp.parking ? [line(PARKING_REVENUE, sp.parking, t('lease.revParking', { lng: 'ar' }))] : []),
  ];
}

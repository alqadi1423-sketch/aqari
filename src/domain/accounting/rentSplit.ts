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

/** إيراد العقد المرحَّل حتى الآن على كل حساب (من بُعد العقد في سطور القيود) · null إن لم يكن البُعد في القاعدة */
function postedRevenue(db: DB, contractId: string): { rent: number; services: number; parking: number } | null {
  const k = db as unknown as object;
  let has = lineDimCache.get(k);
  if (has === undefined) {
    has = db.all<{ name: string }>(`PRAGMA table_info(journal_lines)`).some((c) => c.name === 'contract_id');
    lineDimCache.set(k, has);
  }
  if (!has) return null;
  const rows = db.all<{ a: string; n: number }>(
    `SELECT l.account_code AS a, COALESCE(SUM(l.credit_halalas - l.debit_halalas),0) AS n
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.contract_id = ? AND e.status = '${POSTED_STATUS}' AND l.account_code IN (${RENT_REVENUE_SQL})
     GROUP BY l.account_code`, [contractId]);
  const of = (code: string) => Number(rows.find((r) => r.a === code)?.n ?? 0);
  return { rent: of(RENT_REVENUE), services: of(SERVICES_REVENUE), parking: of(PARKING_REVENUE) };
}
const lineDimCache = new WeakMap<object, boolean>();
const POSTED_STATUS = 'مرحّل'; // i18n-exempt: حالة القيد المخزّنة

/**
 * نصيب الخدمات والمواقف من مبلغٍ بنسبتهما من إجمالي العقد · والهللات الباقية على الإيجار.
 * التقريب تراكمي على مستوى العقد (المراجعة #10): نصيب كل حساب بعد الدفعة = نسبته من مجموع إيراد العقد
 * المرحَّل معها، ناقص ما رُحِّل عليه قبلها · فلا تتآكل هللات الخدمات والمواقف مع كثرة الدفعات،
 * والعكس (side = 'debit') يُعيد الحسابات إلى نسبتها كذلك.
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
  const prior = postedRevenue(db, contractId);
  if (!prior) {
    const services = Math.floor((amount * s) / total);
    const parking = Math.floor((amount * p) / total);
    return { rent: amount - services - parking, services, parking };
  }
  const share = (cum: number, x: number) => (cum >= 0 ? Math.floor((cum * x) / total) : -Math.floor((-cum * x) / total));
  const before = prior.rent + prior.services + prior.parking;
  const after = before + (side === 'credit' ? amount : -amount);
  const dir = side === 'credit' ? 1 : -1;
  const clamp = (x: number) => Math.min(Math.max(0, x), amount);
  let services = clamp(dir * (share(after, s) - prior.services));
  let parking = clamp(dir * (share(after, p) - prior.parking));
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

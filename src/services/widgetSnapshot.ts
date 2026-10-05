/**
 * لقطة الودجت · الجسر الوحيد بين التطبيق وشاشة الجوال.
 *
 * ودجت أندرويد عملية منفصلة لا تفتح قاعدة البيانات ولا تشغّل جافاسكربت،
 * فلا سبيل لها إلى أرقامك إلا ملفٌ يكتبه التطبيق وتقرؤه هي. وهذا الملف هو
 * `widget.json` في مجلد التطبيق الداخلي — يقرؤه الودجت لأنه من التطبيق نفسه
 * (المعرّف نفسه)، ولا يصل إليه تطبيق آخر ولا يظهر في أي مجلد عام.
 *
 * والنصوص تُكتب **جاهزةً منسَّقة** لا أرقاماً خاماً: التنسيق العربي والفواصل
 * والنِّسب كلها تخرج من دوال التطبيق نفسها، فلا يُعاد بناؤها في كوتلن
 * ولا تختلف الودجت عن الشاشة في فاصلة.
 *
 * والودجت تتبع صلاحية الأقسام (توجيه المالك ٢٠٢٦-١٠-٠٥): عضوٌ بلا قسم التحصيل لا تُكتب له مبالغه في الملف
 * أصلاً، وبلا البنوك والنقد لا رصيد نقد، وأزرار الاختصار لما لا يفتحه لا تظهر.
 */
import type { DB } from '../db/adapter';
import { allInstallments, collectKpis, occupancySummary } from '../domain/stats';
import { cashOnHand } from '../domain/accounting/ledger';
import { today } from '../domain/dates';
import { fmt } from '../domain/money';
import { canView, canAdd, type Access } from '../domain/access/access';
import { readAccess } from './access';

/** ما تقرؤه الودجت · حقولها نصوص جاهزة للعرض إلا العدّادات والنِّسب */
export interface WidgetSnapshot {
  /** لحظة الكتابة · لتُعرف اللقطة البائتة */
  at: string;
  /** يوم اللقطة · الودجت تُعيد الحساب إن تغيّر اليوم */
  day: string;
  lateCount: number;
  lateSum: string;
  dueThisMonth: string;
  paidThisMonth: string;
  monthPct: number;
  occupancyPct: number;
  occupiedUnits: number;
  totalUnits: number;
  cash: string;
  /** لا بيانات بعد · الودجت تعرض سطر ترحيب لا أصفاراً */
  empty: boolean;
  /** صلاحيته لا تشمل التحصيل · فلا مبالغ ولا أعداد تحصيل، وسطرٌ يقول ذلك */
  noCollect: boolean;
  /** أزرار الاختصار الظاهرة · ما لا يفتحه لا يظهر */
  can: { collect: boolean; invoices: boolean; claims: boolean };
}

const EMPTY: Omit<WidgetSnapshot, 'at' | 'day' | 'noCollect' | 'can'> = {
  lateCount: 0, lateSum: '0.00', dueThisMonth: '0.00', paidThisMonth: '0.00',
  monthPct: 0, occupancyPct: 0, occupiedUnits: 0, totalUnits: 0, cash: '0.00', empty: true,
};

/** بناء اللقطة من القاعدة · دالّة خالصة تُختبر بلا ملفات ولا جهاز */
export function buildWidgetSnapshot(db: DB, T: string = today(), access: Access = readAccess(db)): WidgetSnapshot {
  const at = new Date().toISOString();
  const collect = canView(access, 'collect');
  const can = { collect: canAdd(access, 'collect'), invoices: canView(access, 'invoices'), claims: canView(access, 'claims') };
  const units = Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM units WHERE deleted_at IS NULL`)?.n ?? 0);
  if (!units) return { at, day: T, ...EMPTY, noCollect: !collect, can };

  const k = collect ? collectKpis(allInstallments(db, T), T) : null;
  const props = canView(access, 'props');
  const occ = props ? occupancySummary(db, T.slice(0, 8) + '01', T, T) : null;
  return {
    at,
    day: T,
    lateCount: k ? k.lateCount : 0,
    lateSum: k ? fmt(k.lateSum) : '',
    dueThisMonth: k ? fmt(k.dueThisMonth) : '',
    paidThisMonth: k ? fmt(k.paidThisMonth) : '',
    monthPct: k && k.dueThisMonth > 0 ? Math.round((k.paidThisMonth / k.dueThisMonth) * 100) : 0,
    occupancyPct: occ ? occ.now.pct : 0,
    occupiedUnits: occ ? occ.now.occupied : 0,
    totalUnits: occ ? occ.now.total : 0,
    cash: canView(access, 'banks') ? fmt(cashOnHand(db)) : '',
    empty: false,
    noCollect: !collect,
    can,
  };
}

/** اسم الملف الذي يقرؤه الودجت · متّفق عليه بين هذا الملف وكوتلن */
export const WIDGET_FILE = 'widget.json';

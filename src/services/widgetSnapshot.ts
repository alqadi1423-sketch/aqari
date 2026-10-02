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
 */
import type { DB } from '../db/adapter';
import { allInstallments, collectKpis, occupancySummary } from '../domain/stats';
import { cashOnHand } from '../domain/accounting/ledger';
import { today } from '../domain/dates';
import { fmt } from '../domain/money';

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
}

const EMPTY: Omit<WidgetSnapshot, 'at' | 'day'> = {
  lateCount: 0, lateSum: '0.00', dueThisMonth: '0.00', paidThisMonth: '0.00',
  monthPct: 0, occupancyPct: 0, occupiedUnits: 0, totalUnits: 0, cash: '0.00', empty: true,
};

/** بناء اللقطة من القاعدة · دالّة خالصة تُختبر بلا ملفات ولا جهاز */
export function buildWidgetSnapshot(db: DB, T: string = today()): WidgetSnapshot {
  const at = new Date().toISOString();
  const units = Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM units WHERE deleted_at IS NULL`)?.n ?? 0);
  if (!units) return { at, day: T, ...EMPTY };

  const insts = allInstallments(db, T);
  const k = collectKpis(insts, T);
  const occ = occupancySummary(db, T.slice(0, 8) + '01', T, T);
  return {
    at,
    day: T,
    lateCount: k.lateCount,
    lateSum: fmt(k.lateSum),
    dueThisMonth: fmt(k.dueThisMonth),
    paidThisMonth: fmt(k.paidThisMonth),
    monthPct: k.dueThisMonth > 0 ? Math.round((k.paidThisMonth / k.dueThisMonth) * 100) : 0,
    occupancyPct: occ.now.pct,
    occupiedUnits: occ.now.occupied,
    totalUnits: occ.now.total,
    cash: fmt(cashOnHand(db)),
    empty: false,
  };
}

/** اسم الملف الذي يقرؤه الودجت · متّفق عليه بين هذا الملف وكوتلن */
export const WIDGET_FILE = 'widget.json';

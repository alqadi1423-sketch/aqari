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
 *
 * وتتبع قفل التطبيق (المراجعة الشاملة · البند ٢٣، الخيار أ): القفل يحجب الواجهة والودجت على الشاشة الرئيسية بلا قفل،
 * فحين يكون مفعّلاً لا يُكتب في الملف مبلغٌ ولا نسبة تحصيل ولا نقد، والأعداد وحدها (المتأخر والوحدات) مع `locked`.
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
  /** قفل التطبيق مفعّل · فلا مبلغ ولا نسبة تحصيل ولا نقد، والودجت تعرض الأعداد وحدها */
  locked: boolean;
}

/** ما يُعرف به حال القفل · من خارج القاعدة (services/appLockService: lockMaybeOn) فيُمرَّر */
export interface SnapshotOpts { locked?: boolean }

const EMPTY: Omit<WidgetSnapshot, 'at' | 'day' | 'noCollect' | 'can' | 'locked'> = {
  lateCount: 0, lateSum: '0.00', dueThisMonth: '0.00', paidThisMonth: '0.00',
  monthPct: 0, occupancyPct: 0, occupiedUnits: 0, totalUnits: 0, cash: '0.00', empty: true,
};

/** بناء اللقطة من القاعدة · دالّة خالصة تُختبر بلا ملفات ولا جهاز */
export function buildWidgetSnapshot(db: DB, T: string = today(), access: Access = readAccess(db), opts: SnapshotOpts = {}): WidgetSnapshot {
  const at = new Date().toISOString();
  const locked = opts.locked === true;
  const collect = canView(access, 'collect');
  const can = { collect: canAdd(access, 'collect'), invoices: canView(access, 'invoices'), claims: canView(access, 'claims') };
  const units = Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM units WHERE deleted_at IS NULL`)?.n ?? 0);
  if (!units) return { at, day: T, ...EMPTY, noCollect: !collect, can, locked };

  const k = collect ? collectKpis(allInstallments(db, T), T) : null;
  // المبالغ والنسبة تُكتب والقفل مطفأ · والقفل يُبقي العدد وحده (k.lateCount)
  const money = k && !locked ? k : null;
  const props = canView(access, 'props');
  const occ = props ? occupancySummary(db, T.slice(0, 8) + '01', T, T) : null;
  return {
    at,
    day: T,
    lateCount: k ? k.lateCount : 0,
    lateSum: money ? fmt(money.lateSum) : '',
    dueThisMonth: money ? fmt(money.dueThisMonth) : '',
    paidThisMonth: money ? fmt(money.paidThisMonth) : '',
    monthPct: money && money.dueThisMonth > 0 ? Math.round((money.paidThisMonth / money.dueThisMonth) * 100) : 0,
    occupancyPct: occ ? occ.now.pct : 0,
    occupiedUnits: occ ? occ.now.occupied : 0,
    totalUnits: occ ? occ.now.total : 0,
    cash: canView(access, 'banks') && !locked ? fmt(cashOnHand(db)) : '',
    empty: false,
    noCollect: !collect,
    can,
    locked,
  };
}

/** اسم الملف الذي يقرؤه الودجت · متّفق عليه بين هذا الملف وكوتلن */
export const WIDGET_FILE = 'widget.json';

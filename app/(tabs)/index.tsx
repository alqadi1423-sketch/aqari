/**
 * الرئيسية · التنبيهات أولاً ثم مؤشرات مضغوطة كل رقم فيها يُفتح على مكوِّناته،
 * ورسم ستة أشهر بأعمدة متجاورة (إيراد أخضر · مصروف أحمر) تنتهي بنهاية الفترة،
 * وأساس احتسابه مفتاح أعلى بطاقته: استحقاق (الافتراض) أو نقدي.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '../../src/ui/Screen';
import { Card, CardTitle, Chip, ChipGroup, T, Num, Money, BarRow, EmptyState, Row, Badge, Divider } from '../../src/ui/components';
import { BarChart } from '../../src/ui/BarChart';
import { DateField } from '../../src/ui/DateField';
import { Sheet } from '../../src/ui/Sheet';
import { Skeleton } from '../../src/ui/Skeleton';
import { useDeferredReady } from '../../src/ui/useDeferredReady';
import { perfNow, perfProbe } from '../../src/perf/perf';
import { useAccess } from '../../src/ui/access';
import { canView } from '../../src/domain/access/access';
import type { SectionKey } from '../../src/domain/access/sections';
import { useApp } from '../../src/ui/store';
import { C, TYPE } from '../../src/ui/theme';
import { periodRevenueExpense, cashOnHand, monthlyRevenueExpense } from '../../src/domain/accounting/ledger';
import {
  periodRevenueExpenseAccrual, monthlyRevenueExpenseAccrual, BASIS_ACCRUAL, BASIS_CASH, type Basis,
} from '../../src/domain/accrual';
import {
  allInstallments, agingBuckets, AGING_BUCKETS, expenseSplit, portfolioStats, reservedUnitsCount,
} from '../../src/domain/stats';
import { today, toLocalISODate, dfmt, daysBetween, ARABIC_MONTHS_SHORT } from '../../src/domain/dates';
import { fmt } from '../../src/domain/money';
import { computeReminders } from '../../src/domain/reminders';

type Range = 'month' | 'quarter' | 'year' | 'all' | 'custom';

/** أعمدة الرسم في الرئيسية · ستة أشهر لا تتغيّر بتغيّر الفترة */
const MONTHS_ON_HOME = 6;

function rangeDates(r: Range, customFrom: string, customTo: string): { from: string | null; to: string } {
  const now = new Date();
  const TT = today();
  if (r === 'quarter') { const q = Math.floor(now.getMonth() / 3); return { from: toLocalISODate(new Date(now.getFullYear(), q * 3, 1)), to: TT }; }
  if (r === 'year') return { from: toLocalISODate(new Date(now.getFullYear(), 0, 1)), to: TT };
  if (r === 'all') return { from: null, to: TT };
  if (r === 'custom') return { from: customFrom || null, to: customTo || TT };
  return { from: toLocalISODate(new Date(now.getFullYear(), now.getMonth(), 1)), to: TT };
}

/** مؤشر مضغوط يقبل الضغط · الرقم المجمّع بابه مكوِّناته */
function MiniKpi({ label, value, danger, onPress }: { label: string; value: string; danger?: boolean; onPress?: () => void }) {
  // القيمة الغائبة تُسقط المؤشّر بعنوانه · الصفر قيمة
  if (value === '' || value === 'لا يوجد') return null;
  const body = (
    <>
      <T size={TYPE.caption} color={C.muted}>{label}</T>
      <Num size={TYPE.number} bold color={danger ? C.rose : C.ink}>{value}</Num>
    </>
  );
  const box = { borderWidth: 1, borderColor: C.line, borderRadius: 9, paddingVertical: 8, paddingHorizontal: 6, alignItems: 'center' as const, flex: 1 };
  return onPress
    ? <Pressable onPress={onPress} style={({ pressed }) => [box, pressed && { backgroundColor: C.paper }]}>{body}</Pressable>
    : <View style={box}>{body}</View>;
}

/**
 * مسبار قياس أقسام الرئيسية: يركّب الأقسام قسماً كل إطارين ويسجّل زمن كل قسم،
 * ثم يقيس إعادة التصيير الكاملة ثلاثاً · يُفعَّل في بناء تحقق فقط ولا يشحن مفعّلاً.
 */
const PROBE = false;

/**
 * قفل إعادة التصيير: يتخطى React الشجرة الملفوفة ما دامت deps كما هي ·
 * قيس أن إعادة تصيير الرئيسية كاملةً بلا تغيير بيانات تكلف 150 حتى 220 م.ث،
 * وبهذا القفل تصير مصالحة سطحية لا تلمس الأقسام.
 */
const Static = React.memo(
  ({ children }: { deps: unknown[]; children: React.ReactElement }) => children,
  (a, b) => a.deps.length === b.deps.length && a.deps.every((v, i) => Object.is(v, b.deps[i]))
);

export default function Dashboard() {
  const { db, version } = useApp();
  const router = useRouter();
  const ready = useDeferredReady();
  const [range, setRange] = useState<Range>('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  // أساس احتساب الإيراد والمصروف · الاستحقاق هو الافتراض ولا يظهر مفتاحه إلا هنا
  const [basis, setBasis] = useState<Basis>(BASIS_ACCRUAL);
  const [stage, setStage] = useState(PROBE ? 0 : 99);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!PROBE || !ready) return;
    const labels = ['التنبيهات', 'المؤشرات', 'الرسم البياني', 'توزيع المصروفات', 'أعمار الذمم', 'بقية الشاشة'];
    let s = 0;
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      const t0 = perfNow();
      setStage(s + 1);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (cancelled) return;
        perfProbe('رئيسية · ' + labels[s], perfNow() - t0);
        s += 1;
        if (s < labels.length) { step(); return; }
        let k = 0;
        const rr = () => {
          if (cancelled) return;
          const r0 = perfNow();
          setTick((x) => x + 1);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (cancelled) return;
            perfProbe('رئيسية · إعادة تصيير كاملة ' + (k + 1), perfNow() - r0);
            k += 1;
            if (k < 3) rr();
          }));
        };
        rr();
      }));
    };
    // بعد انقضاء صيانة الإقلاع المؤجلة كلها · وإلا اختلطت أطر المسبار بها
    const t = setTimeout(step, 10000);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  // ورقتا التفصيل: قيود النوع (إيراد/مصروف) وفواتير فئة مصروفات
  const [drill, setDrill] = useState<'إيراد' | 'مصروف' | null>(null);
  const [catDrill, setCatDrill] = useState<string | null>(null);
  const [monthDrill, setMonthDrill] = useState<{ key: string; label: string } | null>(null);
  const T0 = today();
  // الرئيسية تُبنى من صلاحيات العضو · البطاقة التي قسمها «لا» لا تظهر
  const access = useAccess();
  const sees = (k: SectionKey) => canView(access, k);

  const data = useMemo(() => {
    const { from, to } = rangeDates(range, customFrom, customTo);
    if (!ready) {
      return {
        from, to, revenue: 0, expense: 0, cash: 0, banksCount: 0,
        late: [] as ReturnType<typeof allInstallments>, soonContracts: [] as Array<{ id: string; end: string }>,
        openClaims: [] as Array<{ id: string }>,
        months: [] as Array<{ label: string; key: string; revenue: number; expense: number }>,
        split: [] as Array<[string, number]>, aging: [0, 0, 0, 0, 0],
        pf: { total: 0, occupied: 0, vacant: 0, occupancyPct: 0, income: 0, cancelledValue: 0, cancelledCount: 0 },
        reserved: 0, vacant: 0, totalDue: 0, totalPaid: 0, overdue: 0,
        moves: [] as Array<{ id: string; no: string; date: string; memo: string; d: number; src_type: string | null; src_id: string | null }>,
        topDueArr: [] as Array<[string, number]>,
        recentInvoices: [] as Array<{ id: string; customer_name: string; no: string; issue: string; status: string; total_halalas: number }>,
      };
    }
    const accrual = basis === BASIS_ACCRUAL;
    const { revenue, expense } = accrual
      ? periodRevenueExpenseAccrual(db, from, to)
      : periodRevenueExpense(db, from, to);
    const cash = cashOnHand(db);
    const banksCount = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM banks WHERE deleted_at IS NULL`)!.n;

    // التنبيهات
    const insts = allInstallments(db, T0);
    const late = insts.filter((x) => x.remaining > 0 && x.daysLate > 0 && x.status !== 'ملغية');
    const soonContracts = db
      .all<{ id: string; end: string }>(
        `SELECT id, end FROM contracts
         WHERE status NOT IN ('مسودة','ملغى') AND deleted_at IS NULL AND end IS NOT NULL`
      )
      .filter((c) => {
        const d = daysBetween(c.end, T0);
        return d >= 0 && d <= 60;
      });
    const openClaims = db.all<{ id: string }>(
      `SELECT id FROM claims WHERE status = 'مفتوحة' AND deleted_at IS NULL`
    );

    // الاتجاه الشهري · ستة أشهر في الرئيسية دائماً تنتهي بنهاية الفترة المختارة
    // (شهر واحد لا يصنع اتجاهاً · والاثنا عشر مكانها التقارير) · باستعلام واحد
    const toDate = to ? new Date(to + 'T00:00:00') : new Date();
    const monthsBack = MONTHS_ON_HOME;
    const firstMonth = new Date(toDate.getFullYear(), toDate.getMonth() - (monthsBack - 1), 1);
    const fromKey = toLocalISODate(firstMonth).slice(0, 7);
    const toKey = toLocalISODate(toDate).slice(0, 7);
    const byMonth = accrual
      ? monthlyRevenueExpenseAccrual(db, fromKey, toKey)
      : monthlyRevenueExpense(db, fromKey, toKey);
    const months: Array<{ label: string; key: string; revenue: number; expense: number }> = [];
    for (let i = monthsBack - 1; i >= 0; i--) {
      const d = new Date(toDate.getFullYear(), toDate.getMonth() - i, 1);
      const key = toLocalISODate(d).slice(0, 7);
      const m = byMonth.get(key) ?? { revenue: 0, expense: 0 };
      months.push({ label: ARABIC_MONTHS_SHORT[d.getMonth()], key, revenue: m.revenue, expense: m.expense });
    }

    const split = expenseSplit(db, from, to);
    const aging = agingBuckets(insts);
    const pf = portfolioStats(db, T0);
    const reserved = reservedUnitsCount(db, T0);
    const vacant = Math.max(0, pf.total - pf.occupied - reserved);
    const totalDue = insts.reduce((s, x) => s + x.amount, 0);
    const totalPaid = insts.reduce((s, x) => s + x.paid, 0);
    const overdue = late.reduce((s, x) => s + x.remaining, 0);

    const moves = db.all<{ id: string; no: string; date: string; memo: string; d: number; src_type: string | null; src_id: string | null }>(
      `SELECT e.id, e.no, e.date, e.memo, COALESCE(SUM(l.debit_halalas),0) AS d, e.src_type, e.src_id
       FROM journal_entries e LEFT JOIN journal_lines l ON l.entry_id = e.id
       WHERE e.status='مرحّل' AND e.deleted_at IS NULL
       GROUP BY e.id ORDER BY e.created_at DESC LIMIT 6`
    );
    const topDue = new Map<string, number>();
    for (const x of insts) {
      if (x.remaining > 0 && x.status !== 'ملغية' && x.contractStatus !== 'ملغى')
        topDue.set(x.tenant, (topDue.get(x.tenant) || 0) + x.remaining);
    }
    const topDueArr = [...topDue.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const recentInvoices = db.all<{ id: string; customer_name: string; no: string; issue: string; status: string; total_halalas: number }>(
      `SELECT id, customer_name, no, issue, status, total_halalas FROM invoices
       WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 4`
    );
    return {
      from, to, revenue, expense, cash, banksCount: Number(banksCount),
      late, soonContracts, openClaims, months, split, aging,
      pf, reserved, vacant, totalDue, totalPaid, overdue, moves, topDueArr, recentInvoices,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, range, customFrom, customTo, ready, basis]);

  // قيود النوع خلال الفترة · كل سطر يفتح مستنده
  const drillRows = useMemo(() => {
    if (!drill) return [];
    const conds = [`e.status = 'مرحّل'`, `e.deleted_at IS NULL`, `a.type = ?`];
    const params: string[] = [drill];
    if (data.from) { conds.push(`e.date >= ?`); params.push(data.from); }
    conds.push(`e.date <= ?`); params.push(data.to);
    return db.all<{ id: string; no: string; date: string; memo: string; amount: number; src_type: string | null; src_id: string | null; account: string }>(
      `SELECT e.id, e.no, e.date, e.memo, a.name AS account, e.src_type, e.src_id,
              CASE WHEN a.type = 'إيراد' THEN l.credit_halalas - l.debit_halalas
                   ELSE l.debit_halalas - l.credit_halalas END AS amount
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.code = l.account_code
       WHERE ${conds.join(' AND ')} AND amount != 0
       ORDER BY e.date DESC LIMIT 200`, params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, drill, data.from, data.to]);

  const catRows = useMemo(() => {
    if (!catDrill) return [];
    const conds = [`deleted_at IS NULL`, `COALESCE(NULLIF(TRIM(category),''),'غير مصنَّف') = ?`];
    const params: string[] = [catDrill];
    if (data.from) { conds.push(`date >= ?`); params.push(data.from); }
    conds.push(`date <= ?`); params.push(data.to);
    return db.all<{ id: string; no: string; supplier_name: string; date: string; total_halalas: number }>(
      `SELECT id, no, supplier_name, date, total_halalas FROM purchases
       WHERE ${conds.join(' AND ')} ORDER BY date DESC LIMIT 200`, params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, catDrill, data.from, data.to]);

  // كل قيد يفتح ما ولّده
  const openSource = useCallback((srcType: string | null, srcId: string | null) => {
    if (!srcType || !srcId) { router.push('/journal'); return; }
    if (['purchase', 'purchase_pay', 'vat_refund'].includes(srcType)) { router.push(`/purchases?detail=${srcId}`); return; }
    if (srcType === 'invoice') { router.push(`/invoices?detail=${srcId}`); return; }
    if (srcType === 'rent') {
      const c = db.get<{ contract_id: string }>(`SELECT contract_id FROM contract_payments WHERE id = ?`, [srcId]);
      if (c) { router.push(`/contracts?detail=${c.contract_id}`); return; }
    }
    if (['contract_deposit', 'deposit_refund', 'deposit_carry', 'deposit_deduct', 'deposit_deduct_move', 'key_money'].includes(srcType)) {
      router.push(`/contracts?detail=${srcId}`); return;
    }
    if (['claim', 'claim_collect'].includes(srcType)) { router.push(`/claims?detail=${srcId}`); return; }
    if (srcType === 'cash_op') { router.push('/banks'); return; }
    router.push('/journal');
  }, [db, router]);

  const net = data.revenue - data.expense;
  const maxAging = Math.max(1, ...data.aging);
  const splitTotal = data.split.reduce((s, [, v]) => s + v, 0);
  const statusMap: Record<string, string> = { 'مدفوعة': 'paid', 'مستحقة': 'due', 'متأخرة': 'overdue', 'مسودة': 'draft' };

  return (
    <Screen title="الرئيسية" noBack>
      <ChipGroup
        options={[['month', 'هذا الشهر'], ['quarter', 'هذا الربع'], ['year', 'هذه السنة'], ['all', 'كل الفترات'], ['custom', 'مخصصة']]}
        value={range}
        onChange={setRange}
      />
      {range === 'custom' && (
        <Row style={{ marginTop: 8 }}>
          <View style={{ flex: 1 }}><DateField label="من" value={customFrom} onChange={setCustomFrom} /></View>
          <View style={{ flex: 1 }}><DateField label="إلى" value={customTo} onChange={setCustomTo} /></View>
        </Row>
      )}

      {!ready ? <View style={{ marginTop: 10 }}><Skeleton rows={7} /></View> : (
      <>
      {/* التنبيهات أولاً · كلٌّ يفتح المعنيّين به تحديداً */}
      {stage >= 1 ? <Static deps={[data]}><View style={{ marginTop: 10 }}>
        {sees('contracts') && data.soonContracts.length > 0 && (
          <Pressable onPress={() => router.push(`/contracts?status=${encodeURIComponent('ينتهي قريباً')}`)} style={alertStyle(C.goldSoft)}>
            <T size={12.5} color="#8A6C25">{data.soonContracts.length} عقداً ينتهي خلال 60 يوماً</T>
            <T size={12} bold color={C.emerald}>عرض</T>
          </Pressable>
        )}
        {sees('collect') && data.late.length > 0 && (
          <Pressable onPress={() => router.push('/collect?filter=late')} style={alertStyle('#FBEBE9')}>
            <T size={12.5} color={C.rose}>{data.late.length} دفعة متأخرة · {fmt(data.overdue)}</T>
            <T size={12} bold color={C.emerald}>عرض</T>
          </Pressable>
        )}
        {sees('contracts') ? <RemindersCard /> : null}
        {sees('claims') && data.openClaims.length > 0 && (
          <Pressable onPress={() => router.push('/claims')} style={alertStyle('#FBEBE9')}>
            <T size={12.5} color={C.rose}>{data.openClaims.length} مطالبة مفتوحة</T>
            <T size={12} bold color={C.emerald}>عرض</T>
          </Pressable>
        )}
      </View></Static> : null}

      {/* المؤشرات في صف مضغوط · كل رقم يُفتح */}
      {stage >= 2 && sees('reports') ? <Static deps={[data]}><>
      <Row style={{ marginTop: 4 }}>
        <MiniKpi label="الإيرادات" value={fmt(data.revenue)} onPress={() => setDrill('إيراد')} />
        <MiniKpi label="المصروفات" value={fmt(data.expense)} danger={data.expense > 0} onPress={() => setDrill('مصروف')} />
      </Row>
      <Row style={{ marginTop: 6 }}>
        <MiniKpi label="صافي الربح" value={fmt(net)} danger={net < 0} onPress={() => router.push('/reports')} />
        {sees('banks') ? <MiniKpi label={`النقد في ${data.banksCount} حسابات`} value={fmt(data.cash)} onPress={() => router.push('/banks')} /> : null}
      </Row>
      </></Static> : null}

      {/* الإيرادات مقابل المصروفات · أعمدة متجاورة، ومفتاح الأساس أعلى البطاقة */}
      {stage >= 3 && sees('reports') ? <Static deps={[data, basis]}><Card style={{ marginTop: 10 }}>
        {/* المفتاح صف واحد لا ينكسر · ChipGroup يلتف داخل حيز العنوان الضيق */}
        <CardTitle action={
          <Row gap={6} style={{ flexWrap: 'nowrap' }}>
            <Chip label="استحقاق" active={basis === BASIS_ACCRUAL} onPress={() => setBasis(BASIS_ACCRUAL)} />
            <Chip label="نقدي" active={basis === BASIS_CASH} onPress={() => setBasis(BASIS_CASH)} />
          </Row>
        }>
          الإيرادات مقابل المصروفات
        </CardTitle>
        {data.months.some((m) => m.revenue > 0 || m.expense > 0) ? (
          <BarChart months={data.months} onMonthPress={(m) => setMonthDrill({ key: m.key, label: m.label })} />
        ) : (
          <EmptyState>لا توجد قيود مرحّلة بعد لعرض الاتجاه · رحّل قيداً من «القيود اليومية» ليظهر هنا</EmptyState>
        )}
      </Card></Static> : null}

      {/* توزيع المصروفات · كل فئة تفتح فواتيرها */}
      {stage >= 4 && sees('reports') ? <Static deps={[data]}><Card>
        <CardTitle>توزيع المصروفات</CardTitle>
        {data.split.length ? data.split.map(([k, v]) => (
          <BarRow key={k} label={k} value={fmt(v)} pct={splitTotal ? (v / splitTotal) * 100 : 0}
            onPress={() => setCatDrill(k)} />
        )) : <EmptyState>لا بيانات في هذه الفترة</EmptyState>}
      </Card></Static> : null}

      {/* أعمار الذمم · كل شريحة تفتح أقساطها في التحصيل */}
      {stage >= 5 && sees('collect') ? <Static deps={[data]}><Card>
        <CardTitle>أعمار الذمم المدينة</CardTitle>
        {AGING_BUCKETS.map((b, k) => (
          <BarRow key={b[0]} label={b[0]} value={fmt(data.aging[k])} pct={(data.aging[k] / maxAging) * 100}
            color={k >= 3 ? C.rose : k >= 1 ? C.gold : '#D8D5CC'}
            onPress={() => router.push(k === 0 ? '/collect?filter=soon' : `/collect?filter=late&bucket=${k}`)} />
        ))}
        <Pressable onPress={() => router.push('/collect?filter=due')}>
          <Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
            <T size={12}>الإجمالي المستحق</T>
            <Money halalas={data.aging.reduce((a, x) => a + x, 0)} size={12} bold />
          </Row>
        </Pressable>
      </Card></Static> : null}

      {stage >= 6 ? <Static deps={[data]}><>
      {/* العقارات · الأعداد تفتح قوائمها */}
      {sees('props') ? <Card>
        <CardTitle action={<Pressable onPress={() => router.push('/properties')}><T size={12} bold color={C.emerald}>عرض الكل</T></Pressable>}>
          العقارات
        </CardTitle>
        <Row style={{ flexWrap: 'wrap', marginBottom: 10 }}>
          <MiniKpi label="معدل الإشغال" value={data.pf.total ? data.pf.occupancyPct + '%' : ''} onPress={() => router.push('/units')} />
          <MiniKpi label="وحدات مشغولة" value={`${data.pf.occupied} من ${data.pf.total}`} onPress={() => router.push('/units?occ=rented')} />
          {sees('collect') ? <MiniKpi label="نسبة التحصيل" value={(data.totalDue ? Math.round((data.totalPaid / data.totalDue) * 100) : 0) + '%'} onPress={() => router.push('/collect?filter=month')} /> : null}
          {sees('collect') ? <MiniKpi label="المتأخرات" value={fmt(data.overdue)} danger={data.overdue > 0} onPress={() => router.push('/collect?filter=late')} /> : null}
        </Row>
        <BarRow label="مشغولة" value={String(data.pf.occupied)} pct={data.pf.total ? (data.pf.occupied / data.pf.total) * 100 : 0} color={C.emerald}
          onPress={() => router.push('/units?occ=rented')} />
        <BarRow label="شاغرة" value={String(data.vacant)} pct={data.pf.total ? (data.vacant / data.pf.total) * 100 : 0} color={C.rose}
          onPress={() => router.push('/units?occ=vacant')} />
        <BarRow label="محجوزة" value={String(data.reserved)} pct={data.pf.total ? (data.reserved / data.pf.total) * 100 : 0} color={C.gold}
          onPress={() => router.push('/units')} />
      </Card> : null}

      {/* أحدث الحركات · كل قيد يفتح مستنده */}
      {sees('ledger') ? <Card>
        <CardTitle action={<Pressable onPress={() => router.push('/journal')}><T size={12} bold color={C.emerald}>عرض الكل</T></Pressable>}>
          أحدث الحركات
        </CardTitle>
        {data.moves.length ? data.moves.map((m) => (
          <Pressable key={m.no} onPress={() => openSource(m.src_type, m.src_id)}>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <View style={{ flex: 1 }}>
                <T size={12} med>{m.memo || m.no}</T>
                <Num size={10.5} color={C.muted}>{dfmt(m.date)}</Num>
              </View>
              <Money halalas={Number(m.d)} size={12} bold />
            </Row>
          </Pressable>
        )) : <EmptyState>لا حركات بعد</EmptyState>}
      </Card> : null}

      {/* أكبر الأرصدة المستحقة · الاسم يفتح دفعاته في التحصيل */}
      {sees('collect') ? <Card>
        <CardTitle action={<Pressable onPress={() => router.push('/collect')}><T size={12} bold color={C.emerald}>عرض الكل</T></Pressable>}>
          أكبر الأرصدة المستحقة
        </CardTitle>
        {data.topDueArr.length ? data.topDueArr.map(([name, v]) => (
          <Pressable key={name} onPress={() => router.push(`/collect?q=${encodeURIComponent(name)}`)}>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 6 }}>
              <T size={12.5}>{name}</T>
              <Money halalas={v} size={12.5} bold color={C.rose} />
            </Row>
          </Pressable>
        )) : <EmptyState>لا مستحقات</EmptyState>}
      </Card> : null}

      {/* أحدث الفواتير · كل صف يفتح فاتورته */}
      {sees('invoices') ? <Card>
        <CardTitle action={<Pressable onPress={() => router.push('/invoices')}><T size={12} bold color={C.emerald}>عرض الكل</T></Pressable>}>
          أحدث الفواتير
        </CardTitle>
        {data.recentInvoices.length ? data.recentInvoices.map((v) => (
          <Pressable key={v.id} onPress={() => router.push(`/invoices?detail=${v.id}`)}>
            <View style={{ paddingVertical: 8 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T size={13} bold>{v.customer_name}</T>
                <Badge kind={statusMap[v.status] || 'draft'} label={v.status} />
              </Row>
              <Row style={{ justifyContent: 'space-between', marginTop: 3 }}>
                <Num size={11} color={C.muted}>{v.no} · {dfmt(v.issue)}</Num>
                <Money halalas={Number(v.total_halalas)} size={12.5} bold />
              </Row>
              <Divider />
            </View>
          </Pressable>
        )) : <EmptyState>لا توجد فواتير بعد</EmptyState>}
      </Card> : null}
      </></Static> : null}
      </>
      )}

      {/* قيود النوع خلال الفترة · كل سطر يفتح مستنده */}
      {drill && (
        <Sheet visible onClose={() => setDrill(null)} tall
          title={(drill === 'إيراد' ? 'إيرادات الفترة' : 'مصروفات الفترة') + ' (' + drillRows.length + ')'}>
          {drillRows.length ? drillRows.map((r, i) => (
            <Pressable key={r.id + ':' + i} onPress={() => { setDrill(null); openSource(r.src_type, r.src_id); }}>
              <View style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T size={12.5} style={{ flex: 1 }}>{r.memo || r.no}</T>
                  <Money halalas={Number(r.amount)} size={12.5} bold color={drill === 'إيراد' ? C.emerald : C.rose} />
                </Row>
                <Num size={10.5} color={C.muted}>{r.account} · {dfmt(r.date)} · {r.no}</Num>
              </View>
            </Pressable>
          )) : <EmptyState>لا قيود في هذه الفترة</EmptyState>}
          <View style={{ height: 10 }} />
        </Sheet>
      )}

      {/* فواتير فئة مصروفات خلال الفترة */}
      {monthDrill && (
        <Sheet visible onClose={() => setMonthDrill(null)} tall title={'حركة شهر ' + monthDrill.label}>
          {db.all<{ id: string; no: string; date: string; memo: string; d: number; c2: number; src_type: string | null; src_id: string | null }>(
            `SELECT e.id, e.no, e.date, e.memo, COALESCE(SUM(l.debit_halalas),0) AS d, COALESCE(SUM(l.credit_halalas),0) AS c2, e.src_type, e.src_id
             FROM journal_entries e LEFT JOIN journal_lines l ON l.entry_id = e.id
             WHERE e.status='مرحّل' AND e.deleted_at IS NULL AND substr(e.date,1,7) = ?
             GROUP BY e.id ORDER BY e.date`, [monthDrill.key]
          ).map((e) => (
            <Pressable key={e.id} onPress={() => { setMonthDrill(null); openSource(e.src_type, e.src_id); }}>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
                <View style={{ flex: 1 }}>
                  {e.memo ? <T size={12} med>{e.memo}</T> : null}
                  <Num size={10.5} color={C.muted}>{e.no} · {dfmt(e.date)}</Num>
                </View>
                <Money halalas={Number(e.d)} size={12} bold />
              </Row>
            </Pressable>
          ))}
          <View style={{ height: 10 }} />
        </Sheet>
      )}
      {catDrill && (
        <Sheet visible onClose={() => setCatDrill(null)} tall title={'فواتير ' + catDrill + ' (' + catRows.length + ')'}>
          {catRows.length ? catRows.map((p) => (
            <Pressable key={p.id} onPress={() => { setCatDrill(null); router.push(`/purchases?detail=${p.id}`); }}>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
                <View style={{ flex: 1 }}>
                  <T size={12.5} bold>{p.supplier_name}</T>
                  <Num size={10.5} color={C.muted}>{p.no} · {dfmt(p.date)}</Num>
                </View>
                <Money halalas={Number(p.total_halalas)} size={12.5} bold />
              </Row>
            </Pressable>
          )) : <EmptyState>لا فواتير في هذه الفئة خلال الفترة</EmptyState>}
          <View style={{ height: 10 }} />
        </Sheet>
      )}
    </Screen>
  );
}

/**
 * بطاقة «تنبيهات» تحت شريط المتأخرات (اعتمدها المالك ٢٠٢٦-١٠-٠٤): عددها وأقرب ثلاثة ·
 * انتهاء عقد · انتهاء مستند · دفعة تقترب · و«عرض الكل» في لوحة سفلية. المتأخرات لا تتكرر هنا، شريطها فوقها.
 * ولا تظهر البطاقة بلا تنبيه.
 */
function RemindersCard() {
  const { db, version } = useApp();
  const [all, setAll] = useState(false);
  const items = useMemo(
    () => computeReminders(db).filter((r) => r.kind !== 'دفعة متأخرة').sort((a, b) => a.days - b.days),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  if (!items.length) return null;
  const line = (r: (typeof items)[number], i: number) => (
    <Row key={i} style={{ justifyContent: 'space-between', paddingVertical: 4, gap: 10 }}>
      <T size={12.5} style={{ flexShrink: 1 }}>{r.kind} · {r.subject}</T>
      {/* تذكير العقد يحمل مدته في نصّه · فلا تتكرر */}
      {r.kind !== 'عقد يقارب الانتهاء' ? (
        <T size={12} bold color={C.muted}>{r.days === 0 ? 'اليوم' : 'بعد ' + r.days + ' يوماً'}</T>
      ) : null}
    </Row>
  );
  return (
    <View style={{ backgroundColor: C.goldSoft, borderRadius: 10, padding: 11, marginBottom: 8 }}>
      <Row style={{ justifyContent: 'space-between', marginBottom: 4 }}>
        <T size={12.5} bold color="#8A6C25">تنبيهات · {items.length}</T>
        {items.length > 3 ? (
          <Pressable onPress={() => setAll(true)}><T size={12} bold color={C.emerald}>عرض الكل</T></Pressable>
        ) : null}
      </Row>
      {items.slice(0, 3).map(line)}
      <Sheet visible={all} onClose={() => setAll(false)} title={'التنبيهات · ' + items.length} tall>
        {items.map(line)}
      </Sheet>
    </View>
  );
}

const alertStyle = (bg: string) => ({
  flexDirection: 'row' as const,
  justifyContent: 'space-between' as const,
  alignItems: 'center' as const,
  gap: 10,
  borderRadius: 9,
  paddingVertical: 9,
  paddingHorizontal: 12,
  marginBottom: 8,
  backgroundColor: bg,
});

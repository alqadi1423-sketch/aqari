/**
 * التقارير · قسمان: القوائم المالية (الدخل/الميزانية/التدفقات)،
 * والتقارير المفصلة (وحدة/عقار/مورد/الفواتير) بمدة قابلة للتحديد
 * وتصدير PDF وإكسل من كل تقرير.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, ActivityIndicator, ScrollView, Pressable } from 'react-native';
import { perfScreenShown } from '../src/perf/perf';
import { Screen } from '../src/ui/Screen';
import { Card, CardTitle, T, Num, EmptyState, Row, ChipGroup, BtnGhost, BtnPrimary, SetRow, SearchBox } from '../src/ui/components';
import { Icon } from '../src/ui/icons';
import { Sheet } from '../src/ui/Sheet';
import { useDeferredReady } from '../src/ui/useDeferredReady';
import { Skeleton } from '../src/ui/Skeleton';
import { DateField } from '../src/ui/DateField';
import { useApp, useFs } from '../src/ui/store';
import { EntrySheet, srcTypeLabel } from '../src/ui/EntrySheet';
import { useToast } from '../src/ui/Toast';
import { C } from '../src/ui/theme';
import { allAccounts, accountMovement, allAccountMovements, accountPeriodChange, trialBalance } from '../src/domain/accounting/ledger';
import { vatReturnData } from '../src/domain/vatReturn';
import { dataYears, dataQuarters, defaultPeriod, quarterRange, QUARTER_AR } from '../src/domain/periods';
import { useRouter } from 'expo-router';
import { today, toLocalISODate, dfmt } from '../src/domain/dates';
import { fmt } from '../src/domain/money';
import {
  exportUnitsReport, exportPropertiesReport, exportSuppliersReport, exportInvoicesReport,
  exportVatReturn, exportTrialBalance, exportFinancialStatement,
  type ExportKind,
} from '../src/services/reportExport';
import type { IconName } from '../src/ui/icons';
import { reportFailure } from '../src/ui/failureDialog';

type Range = 'month' | 'quarter' | 'year' | 'all' | 'custom';
type Tab = 'income' | 'balance' | 'cash' | 'equity' | 'trial';
type DetailKind = 'unit' | 'property' | 'supplier' | 'invoices';

const DETAIL_REPORTS: Array<{ kind: DetailKind; title: string; icon: IconName }> = [
  { kind: 'unit', title: 'تقرير وحدات', icon: 'home' },
  { kind: 'property', title: 'تقرير عقارات', icon: 'building' },
  { kind: 'supplier', title: 'تقرير موردين', icon: 'supplier' },
  { kind: 'invoices', title: 'تقرير الفواتير', icon: 'invoice' },
];

function prevDayOf(date: string): string {
  const d = new Date(date + 'T00:00:00');
  return toLocalISODate(new Date(d.getTime() - 86400000));
}

export default function Reports() {
  const { db, version } = useApp();
  const router = useRouter();
  const toast = useToast();
  const [finYear, setFinYear] = useState<number | 'all' | 'custom' | null>(null);
  const [finQ, setFinQ] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [tab, setTab] = useState<Tab>('income');
  const ready = useDeferredReady();
  const fs = useFs();
  // أعرضة أعمدة الجداول · تكبر مع مقياس الخط فلا تُقصّ كلمة ولا يُبتر رقم
  const COL_ACC = Math.round(fs(132));
  const COL_NUM = Math.round(fs(74));
  const NAME_MIN = Math.round(fs(96));
  // تبديل تبويب داخل الشاشة انتقالٌ يُقاس أيضاً (كفتح ميزان المراجعة)
  const tabFirst = useRef(true);
  useEffect(() => {
    if (tabFirst.current) { tabFirst.current = false; return; }
    const names: Record<Tab, string> = {
      income: 'قائمة الدخل', balance: 'المركز المالي', cash: 'التدفقات النقدية',
      equity: 'حقوق الملكية', trial: 'ميزان المراجعة',
    };
    requestAnimationFrame(() => requestAnimationFrame(() => perfScreenShown('التقارير · ' + names[tab])));
  }, [tab]);

  // السنوات والأرباع من تواريخ المستندات وحدها · سنة بلا بيانات لا تُعرض
  const years = useMemo(() => (ready ? dataYears(db) : []), [db, version, ready]);
  const finQuarters = useMemo(() => (typeof finYear === 'number' ? dataQuarters(db, finYear) : []),
    [db, version, finYear]);
  useEffect(() => {
    // عند الفتح: السنة والربع الحاليان إن كان فيهما بيانات وإلا آخر فترة فيها بيانات
    if (finYear !== null) return;
    const d = defaultPeriod(db, today());
    if (d) { setFinYear(d.year); setFinQ(d.q); } else setFinYear('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finYear, version]);
  useEffect(() => {
    // سنة أو ربع اختفت مستنداته يختفي اختياره معه
    if (typeof finYear === 'number' && !years.some((y) => y.year === finYear)) { setFinYear(null); return; }
    if (typeof finYear === 'number' && finQ !== 0 && !finQuarters.some((x) => x.q === finQ)) setFinQ(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [years, finQuarters, finYear, finQ]);

  const { from, to } = useMemo(() => {
    const T = today();
    if (finYear === null || finYear === 'all') return { from: null as string | null, to: T };
    if (finYear === 'custom') return { from: customFrom || null, to: customTo || T };
    if (finQ !== 0) { const r = quarterRange(finYear, finQ); return { from: r.from as string | null, to: r.to }; }
    return { from: (finYear + '-01-01') as string | null, to: finYear + '-12-31' };
  }, [finYear, finQ, customFrom, customTo]);

  // الفترة السابقة المساوية طولاً · للمقارنة في كل قائمة
  const prev = useMemo(() => {
    if (!from) return { from: null as string | null, to: null as string | null };
    const f = new Date(from + 'T00:00:00');
    const t = new Date(to + 'T00:00:00');
    const days = Math.max(1, Math.round((t.getTime() - f.getTime()) / 86400000) + 1);
    const pTo = new Date(f.getTime() - 86400000);
    const pFrom = new Date(pTo.getTime() - (days - 1) * 86400000);
    return { from: toLocalISODate(pFrom), to: toLocalISODate(pTo) };
  }, [from, to]);

  const data = useMemo(() => {
    const accounts = ready ? allAccounts(db) : [];
    const rev = accounts.filter((a) => a.type === 'إيراد');
    const exp = accounts.filter((a) => a.type === 'مصروف');
    const asset = accounts.filter((a) => a.type === 'أصل');
    const liab = accounts.filter((a) => a.type === 'خصم');
    const eq = accounts.filter((a) => a.type === 'حقوق ملكية');
    // حركات الفترتين وأرصدة التاريخين بأربعة استعلامات تجميعية · لا استعلام لكل حساب
    const curMap = ready ? allAccountMovements(db, from, to) : new Map<string, { debit: number; credit: number }>();
    const prevMap = ready && prev.from ? allAccountMovements(db, prev.from, prev.to) : new Map<string, { debit: number; credit: number }>();
    const ZERO = { debit: 0, credit: 0 };
    const mv = (code: string, f = from, t: string | null = to) =>
      (f === from && t === to) ? (curMap.get(code) ?? ZERO) : accountMovement(db, code, f, t);
    const pv = (code: string) => (prevMap.get(code) ?? ZERO);
    const revRows = rev.map((a) => ({ code: a.code, name: a.name, v: mv(a.code).credit - mv(a.code).debit, p: pv(a.code).credit - pv(a.code).debit }));
    const expRows = exp.map((a) => ({ code: a.code, name: a.name, v: mv(a.code).debit - mv(a.code).credit, p: pv(a.code).debit - pv(a.code).credit }));
    const totalRev = revRows.reduce((s2, r) => s2 + r.v, 0);
    const totalExp = expRows.reduce((s2, r) => s2 + r.v, 0);
    const prevRev = revRows.reduce((s2, r) => s2 + r.p, 0);
    const prevExp = expRows.reduce((s2, r) => s2 + r.p, 0);
    // المركز: كما في نهاية المدة، والمقارنة كما في نهاية المدة السابقة
    const balToMap = allAccountMovements(db, null, to);
    const balPrevMap = prev.to ? allAccountMovements(db, null, prev.to) : new Map<string, { debit: number; credit: number }>();
    const balFrom = (map: Map<string, { debit: number; credit: number }>, a: { code: string; type: string; opening_halalas: number }) => {
      const m = map.get(a.code) ?? { debit: 0, credit: 0 };
      const net = m.debit - m.credit;
      const oriented = ['أصل', 'مصروف'].includes(a.type) ? net : -net;
      return oriented + Number(a.opening_halalas || 0);
    };
    const balAt = (a: { code: string; type: string; opening_halalas: number }, at: string | null) =>
      at === to ? balFrom(balToMap, a) : at === prev.to ? balFrom(balPrevMap, a) : balFrom(allAccountMovements(db, null, at), a);
    const assetRows = asset.map((a) => ({ code: a.code, name: a.name, v: balAt(a, to), p: prev.to ? balAt(a, prev.to) : 0 }));
    const liabRows = liab.map((a) => ({ code: a.code, name: a.name, v: balAt(a, to), p: prev.to ? balAt(a, prev.to) : 0 }));
    const eqRows = eq.map((a) => ({ code: a.code, name: a.name, v: balAt(a, to), p: prev.to ? balAt(a, prev.to) : 0 }));
    const sumA = assetRows.reduce((s2, r) => s2 + r.v, 0);
    const sumL = liabRows.reduce((s2, r) => s2 + r.v, 0);
    const sumE = eqRows.reduce((s2, r) => s2 + r.v, 0);
    const arChange = accountPeriodChange(db, '1200', from, to);
    const apChange = accountPeriodChange(db, '2100', from, to);
    const faChange = accountPeriodChange(db, '1400', from, to);
    const net = totalRev - totalExp;
    const prevNet = prevRev - prevExp;
    const opCash = net - arChange + apChange;
    const prevOpCash = prevNet - (prev.from ? accountPeriodChange(db, '1200', prev.from, prev.to) : 0)
      + (prev.from ? accountPeriodChange(db, '2100', prev.from, prev.to) : 0);
    // حقوق الملكية: أولها + إضافات المالك - مسحوباته + صافي الربح = آخرها
    const capIn = mv('3100').credit;
    const capOut = mv('3100').debit;
    const eqOpen = eq.reduce((s2, a) => s2 + (from ? balAt(a, prevDayOf(from)) : 0), 0);
    const equity = { open: eqOpen, capIn, capOut, net, close: eqOpen + capIn - capOut + net };
    const prevEquity = prev.from ? {
      capIn: pv('3100').credit, capOut: pv('3100').debit, net: prevNet,
    } : { capIn: 0, capOut: 0, net: 0 };
    // ميزان المراجعة
    const trial = trialBalance(db, from, to);
    const trialD = trial.reduce((s2, r) => s2 + r.debitHalalas, 0);
    const trialC = trial.reduce((s2, r) => s2 + r.creditHalalas, 0);
    const hasEntries = !!db.get(`SELECT id FROM journal_entries WHERE status='مرحّل' AND deleted_at IS NULL LIMIT 1`);
    return {
      revRows, expRows, totalRev, totalExp, prevRev, prevExp, prevNet,
      assetRows, liabRows, eqRows, sumA, sumL, sumE,
      arChange, apChange, faChange, net, opCash, prevOpCash,
      equity, prevEquity, trial, trialD, trialC, hasEntries,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, from, to, prev.from, prev.to, ready]);

  const toLabel = dfmt(to);
  const arDigits = (n: number | string) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
  const periodLabel = typeof finYear === 'number'
    ? (finQ !== 0 ? `سنة ${arDigits(finYear)} · الربع ${QUARTER_AR[finQ as 1 | 2 | 3 | 4]}` : `سنة ${arDigits(finYear)} كاملة`)
    : from ? `عن الفترة من ${dfmt(from)} إلى ${toLabel}` : `حتى ${toLabel}`;

  const line = (name: string, v: number, indent = true, bold = false, color?: string, prevV?: number, accountCode?: string) => {
    const body = (
      <Row key={name} style={{ justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
        {/* اسم البند لا يضيق دون حدّ · فلا تنزل كلمته حرفاً تحت حرف */}
        <T size={bold ? 13 : 12.5} bold={bold} numberOfLines={2}
          style={[indent ? { paddingStart: 16 } : undefined, { flex: 1, flexShrink: 1, minWidth: NAME_MIN }]} color={color ?? C.charcoal}>{name}</T>
        {prevV !== undefined ? <Num size={11} color={C.muted} style={{ marginStart: 8, flexShrink: 0 }}>{fmt(prevV)}</Num> : null}
        <Num size={bold ? 13 : 12.5} bold={bold} color={color ?? C.ink} style={{ flexShrink: 0, marginStart: 8, textAlign: 'left' }}>{fmt(v)}</Num>
      </Row>
    );
    return accountCode ? (
      <Pressable key={name} onPress={() => setStmtAccount({ code: accountCode, name })}>{body}</Pressable>
    ) : body;
  };
  const compareHead = (
    <Row style={{ justifyContent: 'flex-end', marginBottom: 4 }}>
      <T size={10.5} color={C.muted}>الفترة السابقة</T>
      <T size={10.5} color={C.muted} style={{ minWidth: 92, textAlign: 'left' }}>الحالية</T>
    </Row>
  );

  // التقارير المفصلة: النوع + الجهة + المدة، ثم PDF أو إكسل
  const [detailKind, setDetailKind] = useState<DetailKind | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [entityQ, setEntityQ] = useState('');
  const [dRange, setDRange] = useState<Range>('month');
  const [dFrom, setDFrom] = useState('');
  const [dTo, setDTo] = useState('');
  const [exporting, setExporting] = useState(false);
  const [stmtAccount, setStmtAccount] = useState<{ code: string; name: string } | null>(null);
  const [stmtEntry, setStmtEntry] = useState<string | null>(null);
  const [vatOpen, setVatOpen] = useState(false);
  const [vatYear, setVatYear] = useState<number | null>(null);
  const [vatQ, setVatQ] = useState<1 | 2 | 3 | 4>(1);
  const vatQuarters = useMemo(() => (vatYear != null ? dataQuarters(db, vatYear) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, vatYear]);
  useEffect(() => {
    // عند فتح الإقرار: الفترة الحالية إن كان فيها بيانات وإلا آخر فترة فيها بيانات
    if (!vatOpen || vatYear != null) return;
    const d = defaultPeriod(db, today());
    if (d) { setVatYear(d.year); setVatQ(d.q); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vatOpen, vatYear, version]);
  useEffect(() => {
    // ربع بلا مستندات لا يبقى مختاراً
    if (vatYear != null && vatQuarters.length && !vatQuarters.some((x) => x.q === vatQ))
      setVatQ(vatQuarters[vatQuarters.length - 1].q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vatQuarters, vatQ, vatYear]);
  const [vatApproved, setVatApproved] = useState(false);
  const [vatDrill, setVatDrill] = useState<'deductible' | 'excluded' | null>(null);
  const vatPreview = useMemo(() => (vatOpen && vatYear != null ? vatReturnData(db, vatYear, vatQ) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, vatOpen, vatYear, vatQ]);
  const runVat = async (kind: 'pdf' | 'xlsx' | 'docx') => {
    if (vatYear == null) return;
    setExporting(true);
    try { await exportVatReturn(db, vatYear, vatQ, kind, vatApproved); }
    catch (e) { reportFailure({ title: 'تعذّر التصدير', e }); }
    finally { setExporting(false); }
  };

  const detailPeriod = useMemo(() => {
    const now = new Date();
    const T = today();
    if (dRange === 'quarter') { const qq = Math.floor(now.getMonth() / 3); return { from: toLocalISODate(new Date(now.getFullYear(), qq * 3, 1)) as string | null, to: T }; }
    if (dRange === 'year') return { from: toLocalISODate(new Date(now.getFullYear(), 0, 1)) as string | null, to: T };
    if (dRange === 'all') return { from: null as string | null, to: T };
    if (dRange === 'custom') return { from: (dFrom || null) as string | null, to: dTo || T };
    return { from: toLocalISODate(new Date(now.getFullYear(), now.getMonth(), 1)) as string | null, to: T };
  }, [dRange, dFrom, dTo]);

  const detailEntities = useMemo(() => {
    if (detailKind === 'unit') {
      return db.all<{ id: string; unit_no: string; property_id: string }>(
        `SELECT id, unit_no, property_id FROM units WHERE deleted_at IS NULL ORDER BY COALESCE(unit_no_key, unit_no), unit_no`
      ).map((u) => ({
        value: u.id,
        label: [db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [u.property_id])?.name, u.unit_no].filter(Boolean).join(' · '),
      }));
    }
    if (detailKind === 'property') {
      return db.all<{ id: string; name: string }>(`SELECT id, name FROM properties WHERE deleted_at IS NULL ORDER BY name`)
        .map((p) => ({ value: p.id, label: p.name }));
    }
    if (detailKind === 'supplier') {
      // التقارير تشمل المؤرشف · الأرشفة تُخفي من قوائم الإدخال لا من الذاكرة المحاسبية
      return db.all<{ id: string; name: string }>(`SELECT id, name FROM suppliers WHERE deleted_at IS NULL ORDER BY name`)
        .map((s) => ({ value: s.id, label: s.name }));
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, detailKind]);

  // شريط تصدير واحد للقائمة المعروضة أياً كان تبويبها · ميزان المراجعة له مصدِّره الخاص
  const runStatementExport = (kind: ExportKind) =>
    (tab === 'trial'
      ? exportTrialBalance(db, from, to, kind)
      : exportFinancialStatement(db, tab, from, to, kind)
    ).catch(() => toast('تعذّر التصدير'));

  const runDetailExport = async (kind: ExportKind) => {
    if (!detailKind) return;
    if (detailKind !== 'invoices' && !selectedIds.length) { toast('اختر جهة واحدة على الأقل'); return; }
    setExporting(true);
    try {
      const { from: f2, to: t2 } = detailPeriod;
      if (detailKind === 'unit') await exportUnitsReport(db, selectedIds, f2, t2, kind);
      else if (detailKind === 'property') await exportPropertiesReport(db, selectedIds, f2, t2, kind);
      else if (detailKind === 'supplier') await exportSuppliersReport(db, selectedIds, f2, t2, kind);
      else await exportInvoicesReport(db, f2, t2, kind);
    } catch (e) {
      reportFailure({ title: 'تعذّر التصدير', e });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Screen title="التقارير" icon="chart">
      {!ready ? <Skeleton rows={8} /> : <>

      {/* ١ · التقارير المفصلة */}
      <Card>
        <CardTitle>تقارير مفصلة</CardTitle>
        <SetRow icon="shield" title="الإقرار الضريبي" onPress={() => setVatOpen(true)} />
        {DETAIL_REPORTS.map((r) => (
          <SetRow key={r.kind} icon={r.icon} title={r.title}
            onPress={() => { setDetailKind(r.kind); setSelectedIds([]); setEntityQ(''); }} />
        ))}
      </Card>

      {/* ٢ · القوائم المالية */}
      <T size={14} bold color={C.ink} style={{ marginTop: 4, marginBottom: 8 }}>القوائم المالية</T>
      {years.length ? (
        <>
          <T size={11.5} color={C.muted} style={{ marginBottom: 4 }}>السنة</T>
          <ChipGroup
            options={[...years.map((y) => [y.year, arDigits(y.year)] as [number | 'all' | 'custom', string]), ['all', 'كل الفترات'], ['custom', 'مخصصة']]}
            value={finYear ?? 'all'}
            onChange={(v) => { setFinYear(v); setFinQ(0); }} />
          {typeof finYear === 'number' && finQuarters.length ? (
            <View style={{ marginTop: 8 }}>
              <T size={11.5} color={C.muted} style={{ marginBottom: 4 }}>الربع</T>
              <ChipGroup
                options={[[0, 'كاملة'], ...finQuarters.map((x) => [x.q, QUARTER_AR[x.q] + ' (' + x.count + ')'] as [number, string])]}
                value={finQ} onChange={(v) => setFinQ(v as 0 | 1 | 2 | 3 | 4)} />
            </View>
          ) : null}
        </>
      ) : (
        <EmptyState>لا توجد مستندات بعد. سجّل فاتورة لتظهر فترتها هنا.</EmptyState>
      )}
      {finYear === 'custom' && (
        <Row style={{ marginTop: 8 }}>
          <View style={{ flex: 1 }}><DateField label="من" value={customFrom} onChange={setCustomFrom} /></View>
          <View style={{ flex: 1 }}><DateField label="إلى" value={customTo} onChange={setCustomTo} /></View>
        </Row>
      )}
      <View style={{ marginVertical: 8 }}>
        <T size={11.5} color={C.muted} style={{ marginBottom: 4 }}>نوع القائمة</T>
        <ChipGroup
          options={[['income', 'قائمة الدخل'], ['balance', 'المركز المالي'], ['cash', 'التدفقات النقدية'], ['equity', 'حقوق الملكية'], ['trial', 'ميزان المراجعة']]}
          value={tab} onChange={setTab} />
      </View>

      {tab === 'income' && (
        <Card>
          <T size={14} bold color={C.ink} style={{ marginBottom: 6 }}>قائمة الدخل · {periodLabel}</T>
          {compareHead}
          {line('الإيرادات', NaN as never, false, true) && null}
          <T size={13} bold style={{ marginBottom: 4 }}>الإيرادات</T>
          {data.revRows.map((r) => line(r.name, r.v, true, false, undefined, r.p, r.code))}
          {line('إجمالي الإيرادات', data.totalRev, false, true, undefined, data.prevRev)}
          <T size={13} bold style={{ marginVertical: 4 }}>المصروفات</T>
          {data.expRows.map((r) => line(r.name, r.v, true, false, undefined, r.p, r.code))}
          {line('إجمالي المصروفات', data.totalExp, false, true, undefined, data.prevExp)}
          {line('صافي الربح', data.net, false, true, C.emerald, data.prevNet)}
          {!data.hasEntries ? <T size={11} color={C.muted} style={{ marginTop: 8 }}>لا توجد قيود مرحّلة</T> : null}
        </Card>
      )}
      {tab === 'balance' && (
        <Card>
          <T size={14} bold color={C.ink} style={{ marginBottom: 6 }}>المركز المالي · كما في {toLabel}</T>
          {compareHead}
          <T size={13} bold style={{ marginBottom: 4 }}>الأصول</T>
          {data.assetRows.map((r) => line(r.name, r.v, true, false, undefined, r.p, r.code))}
          {line('إجمالي الأصول', data.sumA, false, true)}
          <T size={13} bold style={{ marginVertical: 4 }}>الخصوم</T>
          {data.liabRows.map((r) => line(r.name, r.v, true, false, undefined, r.p, r.code))}
          <T size={13} bold style={{ marginVertical: 4 }}>حقوق الملكية</T>
          {data.eqRows.map((r) => line(r.name, r.v, true, false, undefined, r.p, r.code))}
          {line('إجمالي الخصوم وحقوق الملكية', data.sumL + data.sumE, false, true)}
          <T size={11.5} color={Math.abs(data.sumA - (data.sumL + data.sumE)) > 1 ? C.rose : C.emerald} style={{ marginTop: 8 }}>
            {Math.abs(data.sumA - (data.sumL + data.sumE)) > 1
              ? 'الميزانية غير متوازنة · تحقق من القيود المرحّلة'
              : 'الأصول = الخصوم + حقوق الملكية'}
          </T>
        </Card>
      )}
      {tab === 'cash' && (
        <Card>
          <T size={14} bold color={C.ink} style={{ marginBottom: 4 }}>قائمة التدفقات النقدية · {periodLabel}</T>
          {line('صافي الربح', data.net, false)}
          {line('التغير في الذمم المدينة', -data.arChange, false)}
          {line('التغير في الذمم الدائنة', data.apChange, false)}
          {line('صافي التدفق من الأنشطة التشغيلية', data.opCash, false, true, undefined, data.prevOpCash)}
          {line('شراء/بيع أصول ثابتة', -data.faChange, false)}
          {line('صافي التغير في النقدية', data.opCash - data.faChange, false, true, C.emerald)}
        </Card>
      )}

      {tab === 'equity' && (
        <Card>
          <T size={14} bold color={C.ink} style={{ marginBottom: 6 }}>التغيّرات في حقوق الملكية · {periodLabel}</T>
          {compareHead}
          {line('حقوق الملكية أول المدة', data.equity.open, false)}
          {line('إضافات المالك', data.equity.capIn, false, false, undefined, data.prevEquity.capIn)}
          {line('مسحوبات المالك', -data.equity.capOut, false, false, undefined, -data.prevEquity.capOut)}
          {line('صافي ربح المدة', data.equity.net, false, false, undefined, data.prevEquity.net)}
          {line('حقوق الملكية آخر المدة', data.equity.close, false, true, C.emerald)}
        </Card>
      )}
      {tab === 'trial' && (
        <Card>
          <T size={14} bold color={C.ink} style={{ marginBottom: 8 }}>ميزان المراجعة · {periodLabel}</T>
          {/*
            جدول بأعرضة ثابتة داخل تمرير أفقي: عمود الحساب واسع يسع رمزه سطراً
            واسمه تحته بخط أصغر، والأعمدة الرقمية تُمرَّر إن ضاقت الشاشة ·
            فلا تنزل كلمة حرفاً تحت حرف ولا يُقصّ رقم.
          */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ minWidth: '100%' }}
          >
            <View>
              <Row style={{ paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <T size={10.5} bold color={C.muted} numberOfLines={1} style={{ width: COL_ACC }}>الحساب</T>
                <Num size={10.5} color={C.muted} style={{ width: COL_NUM, textAlign: 'left' }}>أول المدة</Num>
                <Num size={10.5} color={C.muted} style={{ width: COL_NUM, textAlign: 'left' }}>مدين</Num>
                <Num size={10.5} color={C.muted} style={{ width: COL_NUM, textAlign: 'left' }}>دائن</Num>
                <Num size={10.5} color={C.muted} style={{ width: COL_NUM, textAlign: 'left' }}>آخر المدة</Num>
              </Row>
              {data.trial.map((r) => (
                <Pressable key={r.code} onPress={() => setStmtAccount({ code: r.code, name: r.name })}>
                  <Row style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.paperLine, alignItems: 'flex-start' }}>
                    <View style={{ width: COL_ACC }}>
                      <Num size={11.5}>{r.code}</Num>
                      <T size={10} color={C.muted} numberOfLines={2}>{r.name}</T>
                    </View>
                    <Num size={11} style={{ width: COL_NUM, textAlign: 'left' }}>{fmt(r.openingHalalas)}</Num>
                    <Num size={11} style={{ width: COL_NUM, textAlign: 'left' }}>{fmt(r.debitHalalas)}</Num>
                    <Num size={11} style={{ width: COL_NUM, textAlign: 'left' }}>{fmt(r.creditHalalas)}</Num>
                    <Num size={11} bold style={{ width: COL_NUM, textAlign: 'left' }}>{fmt(r.closingHalalas)}</Num>
                  </Row>
                </Pressable>
              ))}
              <Row style={{ paddingVertical: 8, marginTop: 4, borderTopWidth: 2, borderTopColor: C.ink }}>
                <T size={12} bold numberOfLines={2} style={{ width: COL_ACC }} color={data.trialD === data.trialC ? C.emerald : C.rose}>
                  {data.trialD === data.trialC ? 'المدين = الدائن' : 'غير متوازن · تحقق من القيود'}
                </T>
                <View style={{ width: COL_NUM }} />
                <Num size={11.5} bold style={{ width: COL_NUM, textAlign: 'left' }} color={data.trialD === data.trialC ? C.ink : C.rose}>{fmt(data.trialD)}</Num>
                <Num size={11.5} bold style={{ width: COL_NUM, textAlign: 'left' }} color={data.trialD === data.trialC ? C.ink : C.rose}>{fmt(data.trialC)}</Num>
                <View style={{ width: COL_NUM }} />
              </Row>
            </View>
          </ScrollView>
        </Card>
      )}

      {/* شريط التصدير الوحيد · يصدّر القائمة المعروضة أعلاه بالصيغ الثلاث */}
      <Row style={{ justifyContent: 'flex-end', marginBottom: 8 }} gap={8}>
        <BtnGhost small title="إكسل" onPress={() => runStatementExport('xlsx')} />
        <BtnGhost small title="وورد" onPress={() => runStatementExport('docx')} />
        <BtnGhost small icon="print" title="PDF" onPress={() => runStatementExport('pdf')} />
      </Row>

      {/* كشف حركة حساب · من ضغط صف في الميزان · وكل سطر يفتح ورقة تفاصيل قيده */}
      {stmtAccount && (
        <Sheet visible onClose={() => setStmtAccount(null)} title={stmtAccount.code + ' · ' + stmtAccount.name} tall>
          {(() => {
            const lines2 = db.all<{
              entry_id: string; date: string; memo: string; src_type: string | null;
              debit_halalas: number; credit_halalas: number;
            }>(
              `SELECT e.id AS entry_id, e.date, e.memo, e.src_type, l.debit_halalas, l.credit_halalas
               FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
               WHERE l.account_code = ? AND e.status = 'مرحّل' AND e.deleted_at IS NULL
                 ${from ? "AND e.date >= '" + from + "'" : ''} AND e.date <= '${to}'
               ORDER BY e.date, e.created_at`, [stmtAccount.code]);
            let run = 0;
            return lines2.length ? lines2.map((l, i) => {
              run += Number(l.debit_halalas) - Number(l.credit_halalas);
              return (
                <Pressable key={i} onPress={() => setStmtEntry(l.entry_id)}>
                  <View style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <T size={12} numberOfLines={2} style={{ flex: 1, minWidth: NAME_MIN }}>{l.memo}</T>
                      <Num size={11.5} bold color={Number(l.debit_halalas) ? C.emerald : C.rose}>
                        {Number(l.debit_halalas) ? fmt(Number(l.debit_halalas)) : fmt(Number(l.credit_halalas))}
                      </Num>
                    </Row>
                    <Row style={{ justifyContent: 'space-between', marginTop: 2 }}>
                      <Num size={10.5} color={C.muted}>{dfmt(l.date)}</Num>
                      <Num size={10.5} color={C.muted}>الجاري: {fmt(run)}</Num>
                    </Row>
                    <T size={10} color={C.muted} numberOfLines={1} style={{ marginTop: 2 }}>{srcTypeLabel(l.src_type)}</T>
                  </View>
                </Pressable>
              );
            }) : <EmptyState>لا حركة على الحساب خلال المدة</EmptyState>;
          })()}
          <View style={{ height: 10 }} />
        </Sheet>
      )}

      {/* ورقة تفاصيل القيد · فوق كشف الحساب · وفتح المستند المصدر يغلقهما معاً */}
      {stmtEntry ? (
        <EntrySheet entryId={stmtEntry} onClose={() => setStmtEntry(null)} onLeave={() => setStmtAccount(null)} />
      ) : null}

      {/* الإقرار الضريبي · بترقيم الهيئة والمستبعدة في سطر رقابة */}
      {vatOpen && (
        <Sheet visible onClose={() => setVatOpen(false)} title="الإقرار الضريبي"
          footer={
            <>
              <View style={{ flex: 1 }}><BtnGhost small title="إكسل" disabled={exporting} onPress={() => runVat('xlsx')} /></View>
              <View style={{ flex: 1 }}><BtnGhost small title="وورد" disabled={exporting} onPress={() => runVat('docx')} /></View>
              <View style={{ flex: 1 }}><BtnPrimary small icon="print" title="PDF" loading={exporting} onPress={() => runVat('pdf')} /></View>
            </>
          }>
          {!years.length ? (
            <EmptyState>لا توجد مستندات بعد. سجّل فاتورة لتظهر فترتها هنا.</EmptyState>
          ) : (
            <>
              <T size={11.5} color={C.muted} style={{ marginBottom: 5 }}>السنة</T>
              <ChipGroup options={years.map((y) => [y.year, arDigits(y.year)] as [number, string])}
                value={vatYear ?? years[0].year} onChange={setVatYear} />
              <T size={11.5} color={C.muted} style={{ marginVertical: 5 }}>الربع</T>
              <ChipGroup options={vatQuarters.map((x) => [x.q, QUARTER_AR[x.q] + ' (' + x.count + ')'] as [1 | 2 | 3 | 4, string])}
                value={vatQ} onChange={setVatQ} />
            </>
          )}
          {vatPreview ? (
            <View style={{ marginVertical: 8 }}>
              <Pressable onPress={() => setVatDrill('deductible')}
                style={{ backgroundColor: C.paper, borderRadius: 8, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: C.line }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T size={12} bold numberOfLines={2} style={{ flex: 1, minWidth: NAME_MIN }}>البند ٧ · القابلة للخصم ({vatPreview.schedules.deductiblePurchases.length})</T>
                  <Num size={12} bold color={C.emerald}>{fmt(vatPreview.items.find((i) => i.no === '7')!.taxHalalas)}</Num>
                </Row>
              </Pressable>
              <Pressable onPress={() => setVatDrill('excluded')}
                style={{ backgroundColor: C.paper, borderRadius: 8, padding: 10, borderWidth: 1, borderColor: C.line }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T size={12} bold color={C.rose} numberOfLines={2} style={{ flex: 1, minWidth: NAME_MIN }}>غير القابلة للخصم · خارج البند ٧ ({vatPreview.excluded.count})</T>
                  <Num size={12} bold color={C.rose}>{fmt(vatPreview.excluded.amountHalalas)}</Num>
                </Row>
              </Pressable>
            </View>
          ) : null}
          <T size={11.5} color={C.muted} style={{ marginVertical: 5 }}>علامة «مسودة» المائية</T>
          <ChipGroup options={[[0, 'مسودة'], [1, 'معتمد · بلا علامة']]} value={vatApproved ? 1 : 0} onChange={(v) => setVatApproved(!!v)} />
          <View style={{ height: 8 }} />
        </Sheet>
      )}

      {/* الفواتير التي كوّنت المبلغ · من ضغط رقم في الإقرار */}
      {vatDrill && vatPreview && (
        <Sheet visible onClose={() => setVatDrill(null)} tall
          title={vatDrill === 'deductible' ? 'فواتير البند ٧ · القابلة للخصم' : 'غير القابلة للخصم · خارج البند ٧'}>
          {(vatDrill === 'deductible' ? vatPreview.schedules.deductiblePurchases : vatPreview.schedules.excludedPurchases).map((r) => (
            <Pressable key={r.id}
              onPress={() => { setVatDrill(null); setVatOpen(false); router.push(`/purchases?detail=${r.id}`); }}>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
                <View style={{ flex: 1, minWidth: NAME_MIN }}>
                  <T size={12.5} bold numberOfLines={2}>{r.supplier}</T>
                  <Num size={11} color={C.muted}>{r.no} · {dfmt(r.date)}{'reason' in r && r.reason ? ' · ' + r.reason : ''}</Num>
                </View>
                <Num size={12.5} bold>{fmt(r.total)}</Num>
              </Row>
            </Pressable>
          ))}
          {!(vatDrill === 'deductible' ? vatPreview.schedules.deductiblePurchases : vatPreview.schedules.excludedPurchases).length
            ? <EmptyState>لا فواتير في هذه الفئة خلال الربع</EmptyState> : null}
          <View style={{ height: 10 }} />
        </Sheet>
      )}

      {/* نافذة التقرير المفصل: جهات متعددة + المدة ثم PDF أو وورد أو إكسل */}
      {detailKind && (() => {
        const needle = entityQ.trim().toLowerCase();
        const visible = needle
          ? detailEntities.filter((e) => e.label.toLowerCase().includes(needle))
          : detailEntities;
        const toggle = (id: string) => setSelectedIds((cur) =>
          cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
        return (
          <Sheet visible onClose={() => setDetailKind(null)} tall
            title={DETAIL_REPORTS.find((r) => r.kind === detailKind)!.title}
            footer={
              <>
                <View style={{ flex: 1 }}>
                  <BtnGhost small icon="export" title="إكسل" disabled={exporting} onPress={() => runDetailExport('xlsx')} />
                </View>
                <View style={{ flex: 1 }}>
                  <BtnGhost small icon="clipboard" title="وورد" disabled={exporting} onPress={() => runDetailExport('docx')} />
                </View>
                <View style={{ flex: 1 }}>
                  <BtnPrimary small icon="print" title="PDF" loading={exporting} onPress={() => runDetailExport('pdf')} />
                </View>
              </>
            }>
            {detailKind !== 'invoices' && (
              <>
                <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <T size={12.5} bold>الجهات ({selectedIds.length} من {detailEntities.length})</T>
                  <Row gap={10}>
                    <BtnGhost small title="اختر الكل"
                      onPress={() => setSelectedIds(detailEntities.map((e) => e.value))} />
                    <BtnGhost small title="امسح" onPress={() => setSelectedIds([])} />
                  </Row>
                </Row>
                {detailEntities.length > 6 ? (
                  <View style={{ marginBottom: 6 }}><SearchBox value={entityQ} onChange={setEntityQ} /></View>
                ) : null}
                <View style={{ maxHeight: 250, borderWidth: 1, borderColor: C.line, borderRadius: 9, marginBottom: 10 }}>
                  <ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false}>
                    {visible.length ? visible.map((e) => {
                      const on = selectedIds.includes(e.value);
                      return (
                        <Pressable key={e.value} onPress={() => toggle(e.value)}
                          style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
                          <View style={{
                            width: 20, height: 20, borderRadius: 5, borderWidth: 2,
                            borderColor: on ? C.emerald : C.line, backgroundColor: on ? C.emerald : '#fff',
                            alignItems: 'center', justifyContent: 'center',
                          }}>
                            {on ? <Icon name="check" size={13} color="#fff" /> : null}
                          </View>
                          <T size={12.5} numberOfLines={2} style={{ flex: 1 }}>{e.label}</T>
                        </Pressable>
                      );
                    }) : <EmptyState>لا نتائج مطابقة</EmptyState>}
                  </ScrollView>
                </View>
              </>
            )}
            <T size={11.5} color={C.muted} style={{ marginBottom: 5 }}>مدة التقرير</T>
            <ChipGroup
              options={[['month', 'هذا الشهر'], ['quarter', 'هذا الربع'], ['year', 'هذه السنة'], ['all', 'كل الفترات'], ['custom', 'مخصصة']]}
              value={dRange} onChange={setDRange} />
            {dRange === 'custom' && (
              <Row style={{ marginTop: 8 }}>
                <View style={{ flex: 1 }}><DateField label="من" value={dFrom} onChange={setDFrom} /></View>
                <View style={{ flex: 1 }}><DateField label="إلى" value={dTo} onChange={setDTo} /></View>
              </Row>
            )}
            {exporting ? (
              <Row gap={8} style={{ marginTop: 10, alignItems: 'center' }}>
                <ActivityIndicator color={C.emerald} />
                <T size={12} color={C.muted}>جاري تجهيز التقرير…</T>
              </Row>
            ) : null}
            <View style={{ height: 8 }} />
          </Sheet>
        );
      })()}
      </>}
    </Screen>
  );
}

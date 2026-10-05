/**
 * التحصيل · مبنية على الدفعة لا على الشخص: أربعة مؤشرات، تصفية عبر ورقة سفلية
 * ورقاقات للمفعَّل منها، بطاقات الدفعات بعدد أيام التأخير وزر تحصيل يفتح السداد
 * على القسط نفسه، آخر التحصيلات.
 */
import React, { useMemo, useState, useEffect } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { View, Pressable, Linking, FlatList } from 'react-native';
import { Screen } from '../../src/ui/Screen';
import {
  Card, CardTitle, ChipGroup, KpiCard, T, Num, Money, EmptyState, Row, Badge,
  SearchBox, BtnPrimary, BtnGhost, Field,
} from '../../src/ui/components';
import { Sheet, SelectField, PickerSheet } from '../../src/ui/Sheet';
import { NeedsTemplate } from '../../src/ui/NeedsTemplate';
import { useDialog } from '../../src/ui/AppDialog';
import { usePager, Pager } from '../../src/ui/Pager';
import { useDeferredReady } from '../../src/ui/useDeferredReady';
import { Skeleton } from '../../src/ui/Skeleton';
import { DateField } from '../../src/ui/DateField';
import { ActionMenuButton } from '../../src/ui/ActionMenu';
import { usePerm } from '../../src/ui/access';
import { useApp } from '../../src/ui/store';
import { attachPicked, pickFile, type PickedFile } from '../../src/ui/attach';
import { useToast } from '../../src/ui/Toast';
import { C } from '../../src/ui/theme';
import { FilterBar, FilterSheet, useFilterSheet, type ActiveChip } from '../../src/ui/FilterSheet';
import {
  allInstallments, filterInstallments, collectKpis,
  type CollectFilter, type InstallmentView,
} from '../../src/domain/stats';
import { recordRentPayment, paymentForInstallment, type RentPaymentLine, type PayMethod } from '../../src/domain/contracts/service';
import { DISCOUNT_AFTER_DUE, DISCOUNT_REDUCES_INSTALLMENT, type DiscountKind } from '../../src/domain/contracts/installments';
import { today, dfmt, periodLabel } from '../../src/domain/dates';
import { fmt, toHalalas } from '../../src/domain/money';
import { dialPhone } from '../../src/domain/phone';
import { rescheduleAllNotifications } from '../../src/services/notifications';
import { printReceipt } from '../../src/services/print';
import { reportFailure } from '../../src/ui/failureDialog';

const FILTERS: Array<[CollectFilter, string]> = [
  ['due', 'غير مسدَّدة'], ['late', 'متأخرة'], ['month', 'هذا الشهر'],
  ['soon', 'قادمة'], ['paid', 'مسدَّدة'], ['all', 'الكل'],
];
const LATE_OPTIONS: Array<[string, string]> = [
  ['', 'الكل'], ['1-30', 'من 1 إلى 30'], ['31-60', 'من 31 إلى 60'], ['61-90', 'من 61 إلى 90'], ['90+', 'فوق 90'],
];
const AMT_OPTIONS: Array<[string, string]> = [
  ['', 'الكل'], ['lt1000', 'حتى 1000'], ['1000-5000', 'من 1000 إلى 5000'], ['gt5000', 'فوق 5000'],
];

interface PayLine { method: PayMethod; bankId: string; amount: string }

type RowItem = ReturnType<typeof filterInstallments>[number];

/**
 * بطاقة القسط: بطاقة القسط القابل للتحصيل هي زر سداده، وغيرُه بطاقة عرض لا تُضغط ·
 * التواصل وسند القبض في ⋮ أعلى البطاقة يساراً · مكوّن بذاكرة.
 */
const InstCard = React.memo(function InstCard({ x, onPay, onWa, onSms, onReceipt, canPay }: {
  x: RowItem;
  /** «التحصيل: إدخال» فأعلى · بلاه البطاقة عرضٌ لا يُضغط ولا تواصل منها */
  canPay: boolean;
  onPay: (x: RowItem) => void;
  onWa: (x: RowItem) => void;
  onSms: (x: RowItem) => void;
  onReceipt: (x: RowItem) => void;
}) {
  // متأخرات العقد الملغى تُحصَّل (المراجعة ٤.٩) · والقسط الملغى معه لا
  const payable = canPay && x.remaining > 0 && x.status !== 'ملغية';
  /**
   * ميزان الحالة: الاتصال يصح ما دام هناك جوال · والمطالبة برسالة لا تصح
   * لقسط مسدَّد أو ملغى (نصّها يحمل المتبقي) · وسند القبض لا يُعرض لقسط لم يُدفع منه شيء.
   */
  const menu = [
    ...(x.phone && canPay ? [
      { icon: 'phone' as const, label: 'اتصال', onPress: () => Linking.openURL('tel:' + (dialPhone(x.phone) ?? x.phone)) },
    ] : []),
    ...(x.phone && payable ? [
      { icon: 'chat' as const, label: 'واتساب', onPress: () => onWa(x) },
      { icon: 'message' as const, label: 'رسالة', onPress: () => onSms(x) },
    ] : []),
    ...(x.paid > 0 ? [{ icon: 'print' as const, label: 'سند القبض', onPress: () => onReceipt(x) }] : []),
  ];
  // القسط الذي لا يقبل تحصيلاً لا تُفتح بطاقته على نافذة السداد · فلا تكون البطاقة زراً
  const body = (
    <Card style={{ paddingVertical: 10 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T size={13} bold style={{ flex: 1 }}>{x.tenant}</T>
        <Row gap={6}>
          <Badge kind={x.cls === 'late' ? 'overdue' : x.cls === 'paid' ? 'paid' : x.cls === 'mut' ? 'draft' : 'due'} label={x.displayStatus} />
          {menu.length ? <ActionMenuButton title={x.tenant} actions={menu} /> : null}
        </Row>
      </Row>
      <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
        {x.unitNo || (x.contractStatus !== 'مسودة' && x.contractNo)
          ? <T size={11.5} color={C.muted}>{[x.unitNo ? 'وحدة ' + x.unitNo : '', x.contractStatus !== 'مسودة' && x.contractNo ? 'عقد ' + x.contractNo : ''].filter(Boolean).join(' · ')}</T>
          : null}
        <Row gap={6}>
          {x.agreedDate ? <Badge kind="due" label="موعد متفق عليه" /> : null}
          <Num size={11.5} color={x.agreedDate ? '#1D4ED8' : C.muted}>{dfmt(x.effectiveDue)}</Num>
        </Row>
      </Row>
      <Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
        <Row gap={12}>
          <View><T size={10} color={C.muted}>المبلغ</T><Money halalas={x.amount} size={12} /></View>
          <View><T size={10} color={C.muted}>المسدَّد</T><Money halalas={x.paid} size={12} /></View>
          <View><T size={10} color={C.muted}>المتبقي</T><Money halalas={x.remaining} size={12} bold color={x.remaining > 0 ? C.rose : C.emerald} /></View>
        </Row>
      </Row>
    </Card>
  );
  if (!payable) return body;
  return <Pressable onPress={() => onPay(x)}>{body}</Pressable>;
});


export default function Collect() {
  const { db, version, bump } = useApp();
  const perm = usePerm('collect');
  const toast = useToast();
  const dialog = useDialog();
  const [filter, setFilter] = useState<CollectFilter>('due');
  const [q, setQ] = useState('');
  // مرشِّحات تُجمع: الحالة · العقار · مدى التأخير · المبلغ
  const [fProp, setFProp] = useState('');
  const [fLate, setFLate] = useState('');
  const [fAmt, setFAmt] = useState('');
  const [paidSheet, setPaidSheet] = useState(false);
  const ready = useDeferredReady();
  const pager = usePager('collect');
  const fsheet = useFilterSheet();
  const clearFilters = () => { setFilter('due'); setFProp(''); setFLate(''); setFAmt(''); setQ(''); };

  // نافذة السداد
  const [paying, setPaying] = useState<InstallmentView | null>(null);
  const [payRef, setPayRef] = useState('');
  const [payFile, setPayFile] = useState<PickedFile | null>(null);
  // القدوم من جدول العقد: نفس نافذة السداد لا نافذة ثانية
  const params = useLocalSearchParams<{ pay?: string; filter?: string; bucket?: string; q?: string }>();
  useEffect(() => {
    if (params.pay && perm.add) {
      const x = base.all.find((r) => r.installmentId === String(params.pay));
      if (x) openPayment(x);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.pay]);
  useEffect(() => {
    if (params.filter) setFilter(String(params.filter) as CollectFilter);
    if (params.q) setQ(String(params.q));
    if (params.bucket) {
      const b = Number(params.bucket);
      setFLate(b === 1 ? '1-30' : b === 2 ? '31-60' : b === 3 ? '61-90' : b === 4 ? '90+' : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.filter, params.bucket, params.q]);
  const [payDate, setPayDate] = useState(today());
  const [payPeriod, setPayPeriod] = useState('');
  const [payLines, setPayLines] = useState<PayLine[]>([]);
  const [discount, setDiscount] = useState('');
  // نوع الخصم يختاره المستخدم ولا يُفترض · والمبلغ المقبوض يتبع الخصم ما لم يعدّله المستخدم بيده
  const [discountKind, setDiscountKind] = useState<DiscountKind | ''>('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [payNotes, setPayNotes] = useState('');

  const T_ = today();
  // الأساس الثقيل يُحسب عند تغيّر البيانات فقط · لا عند كل ضغطة بحث أو مرشِّح · ومؤجل عن أول رسم
  const base = useMemo(() => {
    if (!ready) {
      return {
        all: [] as ReturnType<typeof allInstallments>,
        kpis: { dueThisMonth: 0, paidThisMonth: 0, lateSum: 0, lateCount: 0, collectionPct: 0 },
        recent: [] as Array<{ id: string; date: string; period: string; net_halalas: number; tenant_name: string }>,
        props: [] as Array<{ id: string; name: string }>,
        unitProp: new Map<string, string>(),
      };
    }
    const all = allInstallments(db, T_);
    const kpis = collectKpis(all, T_);
    const recent = db.all<{ id: string; date: string; period: string; net_halalas: number; tenant_name: string }>(
      `SELECT p.id, p.date, p.period, p.net_halalas, c.tenant_name
       FROM contract_payments p JOIN contracts c ON c.id = p.contract_id AND c.deleted_at IS NULL
       WHERE p.cancelled_at IS NULL
       ORDER BY p.date DESC, p.created_at DESC LIMIT 8`
    );
    const props = db.all<{ id: string; name: string }>(
      `SELECT id, name FROM properties WHERE deleted_at IS NULL ORDER BY name`);
    const unitProp = new Map(
      db.all<{ id: string; property_id: string }>(`SELECT id, property_id FROM units`)
        .map((u) => [u.id, u.property_id]));
    return { all, kpis, recent, props, unitProp };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready]);

  const data = useMemo(() => {
    let rows = filterInstallments(base.all, filter, T_);
    // العدد قبل المرشِّحات المجموعة · سطر «8 من 24» يقيس عليه
    const statusTotal = rows.length;
    const needle = q.trim().toLowerCase();
    if (needle) {
      rows = rows.filter((x) =>
        [x.tenant, x.unitNo, x.contractNo ?? '', x.dueDate].some((v) => v && String(v).toLowerCase().includes(needle))
      );
    }
    // المرشِّحات تُجمع: العقار ثم مدى التأخير ثم المبلغ
    if (fProp) rows = rows.filter((x) => base.unitProp.get(x.unitId) === fProp);
    if (fLate) {
      rows = rows.filter((x) => {
        const d = x.daysLate;
        if (fLate === '1-30') return d >= 1 && d <= 30;
        if (fLate === '31-60') return d >= 31 && d <= 60;
        if (fLate === '61-90') return d >= 61 && d <= 90;
        return d > 90;
      });
    }
    if (fAmt) {
      rows = rows.filter((x) => {
        const v = x.amount / 100;
        if (fAmt === 'lt1000') return v <= 1000;
        if (fAmt === '1000-5000') return v > 1000 && v <= 5000;
        return v > 5000;
      });
    }
    const totalRows = rows.length;
    // القسط مشتق الحساب (المتبقي والتأخر) فالتقسيم بعد الاشتقاق · العرض صفحة واحدة دوماً
    const paged = rows.slice(pager.offset, pager.offset + pager.limit);
    return { ...base, rows: paged, totalRows, statusTotal };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, filter, q, fProp, fLate, fAmt, pager.offset, pager.limit]);

  useEffect(() => { pager.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filter, fProp, fLate, fAmt]);

  // مدفوعات الشهر الحالي · يفتحها مؤشر «محصَّل هذا الشهر»
  const monthPayments = useMemo(() => {
    if (!paidSheet) return [];
    const mo = T_.slice(0, 7);
    return db.all<{ id: string; date: string; net_halalas: number; tenant_name: string; contract_id: string; period: string }>(
      `SELECT p.id, p.date, p.net_halalas, p.period, c.tenant_name, c.id AS contract_id
       FROM contract_payments p JOIN contracts c ON c.id = p.contract_id AND c.deleted_at IS NULL
       WHERE substr(p.date, 1, 7) = ? AND p.cancelled_at IS NULL
       ORDER BY p.date DESC`, [mo]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, paidSheet]);

  const openPayment = React.useCallback((x: InstallmentView) => {
    setPaying(x);
    setPayDate(T_);
    setPayPeriod(periodLabel(x.dueDate));
    const firstBank = db.get<{ id: string }>(`SELECT id FROM banks WHERE deleted_at IS NULL AND archived = 0 LIMIT 1`);
    setPayLines([{ method: firstBank ? 'bank' : 'cash', bankId: firstBank?.id ?? '', amount: fmt(x.remaining).replace(/,/g, '') }]);
    setDiscount('');
    setDiscountKind('');
    setAmountTouched(false);
    setPayNotes('');
    setPayRef('');
    setPayFile(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, T_]);

  /** التسجيل الفعلي بعد التأكيد · منطق الترحيل كما هو */
  const doRecordPayment = () => {
    try {
      const lines: RentPaymentLine[] = payLines
        .map((l) => ({ method: l.method, bankId: l.bankId || undefined, amountHalalas: toHalalas(l.amount) }))
        .filter((l) => l.amountHalalas > 0);
      const notes = (payRef.trim() ? 'مرجع: ' + payRef.trim() + (payNotes.trim() ? ' · ' : '') : '') + payNotes.trim();
      if (!paying) return;
      const paymentId = recordRentPayment(db, paying.contractId, {
          installmentId: paying.installmentId,
          period: payPeriod.trim(),
          date: payDate,
          lines,
          discountHalalas: toHalalas(discount),
          discountKind: toHalalas(discount) > 0 && discountKind ? discountKind : null,
          notes,
        });
      if (payFile) {
        attachPicked(db, payFile, 'payment', paymentId, 'receipt')
          .catch((e) => reportFailure({ title: 'تعذّر إرفاق الإيصال', e }));
      }
      setPaying(null);
      bump();
      rescheduleAllNotifications(db).catch(() => {});
      toast('تم تسجيل السداد وتحديث حالة الدفعة بنجاح');
      // سند القبض · نسخة المستأجر أو المكتب أو كلاهما
      dialog({
        title: 'سند القبض',
        body: 'أي نسخة تُصدر؟',
        tone: 'normal',
        actions: [
          { label: 'بلا سند', variant: 'ghost' },
          { label: 'نسخة المستأجر', variant: 'primary', onPress: () => { printReceipt(db, paymentId, 'tenant').catch(() => {}); } },
          { label: 'نسخة المكتب', variant: 'primary', onPress: () => { printReceipt(db, paymentId, 'office').catch(() => {}); } },
          { label: 'كلاهما', variant: 'primary', onPress: () => { printReceipt(db, paymentId, 'both').catch(() => {}); } },
        ],
      });
    } catch (e) { reportFailure({ title: 'تعذّر التسجيل', e }); }
  };

  // القفل قبل التسجيل: حوار ملخص واضح ثم «تأكيد التسجيل» أو «رجوع»
  const confirmPay = () => {
    if (!paying) return;
    const method = payLines.filter((l) => toHalalas(l.amount) > 0).map((l) => {
      const label = l.method === 'cash' ? 'نقداً' : l.method === 'bank' ? 'تحويل بنكي' : l.method === 'cheque' ? 'شيك' : 'بطاقة';
      const bankName = l.method !== 'cash' ? banks.find((b) => b.id === l.bankId)?.name ?? '' : '';
      return label + (bankName ? ' (' + bankName + ')' : '');
    }).join(' + ');
    const received = payLines.reduce((s, l) => s + toHalalas(l.amount), 0);
    const d = toHalalas(discount);
    // ما غاب من البنود غاب بعنوانه · لا «لا يوجد»
    dialog({
      title: 'تأكيد تسجيل الدفعة',
      body: [
        'المستأجر: ' + paying.tenant,
        'القسط: ' + (payPeriod.trim() || periodLabel(paying.dueDate)),
        'المقبوض: ' + fmt(received) + ' ريال',
        d > 0 ? 'الخصم: ' + fmt(d) + ' ريال · ' + (discountKind === DISCOUNT_AFTER_DUE ? 'خصم بعد الاستحقاق' : 'تنزيل من قيمة القسط') : '',
        d > 0 ? 'يغطي من القسط: ' + fmt(received + d) + ' ريال' : '',
        d > 0 && discountKind === DISCOUNT_REDUCES_INSTALLMENT ? 'تنبيه: تخفيض القسط يخالف قيمة العقد الموثّقة في منصة إيجار' : '',
        method ? 'طريقة الدفع: ' + method : '',
        'التاريخ: ' + dfmt(payDate),
      ].filter(Boolean).join('\n'),
      actions: [
        { label: 'رجوع', variant: 'ghost' },
        { label: 'تأكيد التسجيل', variant: 'primary', onPress: doRecordPayment },
      ],
    });
  };

  const banks = db.all<{ id: string; name: string }>(`SELECT id, name FROM banks WHERE deleted_at IS NULL AND archived = 0 ORDER BY created_at`);

  /**
   * التسجيل لا يقبل بلا مبلغ، ولا بطريقة غير نقدية بلا حساب يستقر فيه المبلغ ·
   * فما دام لا يصح التسجيل لا يُعرض زره أصلاً.
   */
  // طرق السداد بالمقبوض فعلاً والخصم فوقه · ولا يتجاوز المقبوضُ مع الخصم المتبقيَ على القسط،
  // ولا خصم بلا نوع · كما تشترط الخدمة والقاعدة
  const payReceived = payLines.reduce((s, l) => s + Math.max(0, toHalalas(l.amount)), 0);
  const payDiscount = toHalalas(discount);
  const payOver = !!paying && (payReceived + Math.max(0, payDiscount) > paying.remaining || payDiscount < 0);
  const payNeedsKind = payDiscount > 0 && !discountKind;
  const payReady = payLines.some((l) => toHalalas(l.amount) > 0)
    && payLines.every((l) => toHalalas(l.amount) <= 0 || l.method === 'cash' || !!l.bankId)
    && !payOver && !payNeedsKind;
  // الخصم يُنزل المقبوض المقترح ما دام المستخدم لم يعدّله بيده · فيبقى المقبوض مع الخصم هو المتبقي
  const onDiscountChange = (v: string) => {
    setDiscount(v);
    if (!amountTouched && paying && payLines.length === 1) {
      const left = Math.max(0, paying.remaining - Math.max(0, toHalalas(v)));
      setPayLines((p) => p.map((x) => ({ ...x, amount: fmt(left).replace(/,/g, '') })));
    }
  };

  // كل نص يُرسل قالبٌ من الإعدادات · لا نص مكتوباً في الكود
  const [waFor, setWaFor] = useState<{ x: (typeof data.rows)[number]; via: 'wa' | 'sms' } | null>(null);
  // مراسلة مستأجر: قوالب المستأجرين والعامة فقط · لا قوالب الموردين ولا الموظفين
  const scripts = useMemo(() =>
    db.all<{ id: string; title: string; body: string }>(
      `SELECT id, title, body FROM message_scripts
       WHERE deleted_at IS NULL AND audience IN ('مستأجرون','عام') ORDER BY title`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const fillScript = (body: string, x: (typeof data.rows)[number]) => body
    .replace(/\{الاسم\}/g, x.tenant)
    .replace(/\{المبلغ\}/g, fmt(x.remaining) + ' ريال')
    .replace(/\{التاريخ\}/g, dfmt(x.dueDate))
    .replace(/\{تاريخ الاستحقاق\}/g, dfmt(x.effectiveDue ?? x.dueDate))
    .replace(/\{الوحدة\}/g, x.unitNo || '');
  const openChannel = (x: (typeof data.rows)[number], via: 'wa' | 'sms', text: string) => {
    if (via === 'wa') {
      Linking.openURL('https://wa.me/' + (dialPhone(x.phone) ?? '+966' + x.phone.replace(/^0/, '')).replace('+', '')
        + '?text=' + encodeURIComponent(text));
    } else {
      Linking.openURL('sms:' + x.phone + '?body=' + encodeURIComponent(text));
    }
  };

  // رأس القائمة: المؤشرات والبحث وشريط التصفية · يتمرر مع القائمة الافتراضية
  const header = (
    <View>
      <Row style={{ flexWrap: 'wrap' }}>
        <KpiCard label="مستحق هذا الشهر" value={<Money halalas={data.kpis.dueThisMonth} size={15} bold />}
          onPress={() => { setFilter('month'); setFLate(''); setFAmt(''); }} />
        <KpiCard label="محصَّل هذا الشهر" tone="pos" value={<Money halalas={data.kpis.paidThisMonth} size={15} bold />}
          onPress={() => setPaidSheet(true)} />
      </Row>
      <Row style={{ marginTop: 8, flexWrap: 'wrap' }}>
        <KpiCard label="متأخر" tone="neg" value={<Money halalas={data.kpis.lateSum} size={15} bold />} sub={data.kpis.lateCount + ' دفعة'}
          onPress={() => { setFilter('late'); setFLate(''); }} />
        <KpiCard label="نسبة التحصيل" value={data.kpis.collectionPct + '%'}
          onPress={() => setFilter('month')} />
      </Row>
      <View style={{ height: 10 }} />
      <FilterBar
        search={<SearchBox value={q} onChange={setQ} />}
        total={data.statusTotal}
        filtered={data.totalRows}
        itemName="دفعة"
        chips={([
          filter !== 'due' ? { key: 'st', label: FILTERS.find((f) => f[0] === filter)?.[1] ?? filter, onClear: () => setFilter('due') } : null,
          fProp ? { key: 'pr', label: data.props.find((pr) => pr.id === fProp)?.name ?? 'عقار', onClear: () => setFProp('') } : null,
          fLate ? { key: 'la', label: 'تأخير ' + (LATE_OPTIONS.find((o) => o[0] === fLate)?.[1] ?? fLate) + ' يوماً', onClear: () => setFLate('') } : null,
          fAmt ? { key: 'am', label: 'المبلغ ' + (AMT_OPTIONS.find((o) => o[0] === fAmt)?.[1] ?? fAmt), onClear: () => setFAmt('') } : null,
        ].filter(Boolean)) as ActiveChip[]}
        onOpen={fsheet.show}
        onClearAll={clearFilters}
        resultCount={data.totalRows}
      />
    </View>
  );

  // معالجات مثبتة كي لا تكسر ذاكرة البطاقات
  const onWaCb = React.useCallback((x: RowItem) => setWaFor({ x, via: 'wa' }), []);
  const onSmsCb = React.useCallback((x: RowItem) => setWaFor({ x, via: 'sms' }), []);
  const onReceiptCb = React.useCallback((x: RowItem) => {
    const pid = paymentForInstallment(db, x.installmentId);
    if (!pid) { toast('لا يوجد سند لهذا القسط'); return; }
    dialog({
      title: 'سند القبض',
      body: 'أي نسخة تُصدر؟',
      tone: 'normal',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        { label: 'نسخة المستأجر', variant: 'primary', onPress: () => { printReceipt(db, pid, 'tenant').catch(() => {}); } },
        { label: 'كلاهما', variant: 'primary', onPress: () => { printReceipt(db, pid, 'both').catch(() => {}); } },
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, dialog]);
  const renderInst = React.useCallback(({ item: x }: { item: RowItem }) => (
    <InstCard x={x} onPay={openPayment} onWa={onWaCb} onSms={onSmsCb} onReceipt={onReceiptCb} canPay={perm.add} />
  ), [openPayment, onWaCb, onSmsCb, onReceiptCb, perm.add]);

  // ذيل القائمة: تقسيم الصفحات ثم آخر التحصيلات
  const footer = (
    <View>
      <Pager pager={pager} total={data.totalRows} />
      <Card>
        <CardTitle>آخر التحصيلات</CardTitle>
        {data.recent.length ? data.recent.map((r) => (
          <Row key={r.id} style={{ justifyContent: 'space-between', paddingVertical: 6 }}>
            <T size={12}>{dfmt(r.date)} · {r.tenant_name}{r.period ? ' · ' + r.period : ''}</T>
            <Money halalas={Number(r.net_halalas)} size={12} bold />
          </Row>
        )) : <EmptyState>لا تحصيلات بعد</EmptyState>}
      </Card>
    </View>
  );

  return (
    <Screen title="التحصيل" noBack scroll={false}>
      {!ready ? <View style={{ paddingTop: 10 }}><Skeleton rows={7} /></View> : (
      <FlatList
        data={data.rows}
        keyExtractor={(x) => x.installmentId}
        renderItem={renderInst}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={<Card><EmptyState>{q.trim() || filter !== 'due' ? 'لا دفعات مطابقة' : 'لا مستحقات · كل الدفعات محصَّلة'}</EmptyState></Card>}
        initialNumToRender={6}
        maxToRenderPerBatch={10}
        windowSize={5}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      />
      )}

      <FilterSheet open={fsheet.open} onClose={fsheet.hide} onClearAll={clearFilters} resultCount={data.totalRows}>
        <T size={11.5} color={C.muted} style={{ marginBottom: 5 }}>الحالة</T>
        <ChipGroup options={FILTERS} value={filter} onChange={setFilter} />
        <View style={{ marginTop: 8 }}>
          <SelectField label="العقار" value={fProp}
            options={[{ value: '', label: 'كل العقارات' }, ...data.props.map((pr) => ({ value: pr.id, label: pr.name }))]}
            onPick={setFProp} />
        </View>
        <T size={11.5} color={C.muted} style={{ marginBottom: 5 }}>مدى التأخير بالأيام</T>
        <ChipGroup options={LATE_OPTIONS} value={fLate} onChange={setFLate} />
        <T size={11.5} color={C.muted} style={{ marginVertical: 5 }}>المبلغ بالريال</T>
        <ChipGroup options={AMT_OPTIONS} value={fAmt} onChange={setFAmt} />
      </FilterSheet>

      {/* مدفوعات الشهر · يفتحها مؤشر «محصَّل هذا الشهر» وكل صف يفتح عقده أو سنده */}
      {paidSheet && (
        <Sheet visible onClose={() => setPaidSheet(false)} tall
          title={'مدفوعات الشهر (' + monthPayments.length + ')'}>
          {monthPayments.length ? monthPayments.map((mp) => (
            <View key={mp.id} style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T size={12.5} bold style={{ flex: 1 }}>{mp.tenant_name}</T>
                <Money halalas={Number(mp.net_halalas)} size={12.5} bold color={C.emerald} />
              </Row>
              <Row style={{ justifyContent: 'space-between', marginTop: 3 }}>
                <Num size={11} color={C.muted}>{dfmt(mp.date)}{mp.period ? ' · ' + mp.period : ''}</Num>
                <Row gap={6}>
                  <BtnGhost small icon="print" title="سند القبض"
                    onPress={() => printReceipt(db, mp.id, 'tenant').catch(() => toast('تعذّرت الطباعة'))} />
                </Row>
              </Row>
            </View>
          )) : <EmptyState>لا مدفوعات هذا الشهر بعد</EmptyState>}
          <View style={{ height: 10 }} />
        </Sheet>
      )}

      {/* اختيار نص رسالة الواتساب: التذكير التلقائي أو قالب جاهز (رموزه تتعبأ بالبيانات) */}
      {/* لا قالب للمستأجرين: السبب ورابط إنشائه مكان قائمةٍ فارغة (لا قوالب مزروعة) */}
      {waFor && !scripts.length && (
        <Sheet visible onClose={() => setWaFor(null)} title="اختر نص الرسالة">
          <NeedsTemplate reason="لا قالب رسالة للمستأجرين بعد · نص الرسالة قالبٌ تكتبه برموزٍ تتعبأ من بيانات القسط"
            linkLabel="أنشئ قالب رسالة" route="/scripts" onNavigate={() => setWaFor(null)} />
        </Sheet>
      )}
      {waFor && scripts.length > 0 && (
        <PickerSheet
          visible
          onClose={() => setWaFor(null)}
          title="اختر نص الرسالة"
          options={scripts.map((s) => ({ value: s.id, label: s.title, sub: fillScript(s.body, waFor.x).slice(0, 70) + '…' }))}
          onPick={(v) => {
            const tpl = scripts.find((s2) => s2.id === v);
            if (tpl) openChannel(waFor.x, waFor.via, fillScript(tpl.body, waFor.x));
            setWaFor(null);
          }}
        />
      )}

      {/* نافذة تسجيل دفعة إيجار · السداد المتعدد */}
      <Sheet
        visible={!!paying}
        onClose={() => setPaying(null)}
        title="تسجيل دفعة إيجار"
        tall
        footer={
          <>
            {payReady ? (
              <View style={{ flex: 1 }}><BtnPrimary title="تأكيد التحصيل" onPress={confirmPay} /></View>
            ) : null}
          </>
        }
      >
        <Field label="الفترة/الدفعة المستحقة" value={payPeriod} onChange={setPayPeriod} />
        <DateField label="تاريخ الدفعة" value={payDate} onChange={setPayDate} />
        <T size={11.5} color={C.muted} style={{ marginBottom: 6 }}>طرق السداد</T>
        {payLines.map((l, i) => (
          <View key={i} style={{ borderWidth: 1, borderColor: C.line, borderRadius: 9, padding: 9, marginBottom: 8 }}>
            <SelectField
              label="الطريقة"
              value={l.method}
              options={[
                { value: 'cash', icon: 'cash', label: 'نقداً' },
                { value: 'bank', icon: 'bank', label: 'تحويل بنكي' },
                { value: 'cheque', icon: 'invoice', label: 'شيك' },
                { value: 'card', icon: 'card', label: 'بطاقة (مدى/ائتمانية)' },
              ]}
              onPick={(v) => setPayLines((p) => p.map((x, xi) => (xi === i ? { ...x, method: v } : x)))}
            />
            {l.method !== 'cash' && (
              <SelectField
                label="الحساب"
                value={l.bankId}
                options={banks.map((b) => ({ value: b.id, label: b.name }))}
                onPick={(v) => setPayLines((p) => p.map((x, xi) => (xi === i ? { ...x, bankId: v } : x)))}
                placeholder="أضف حساباً بنكياً أولاً"
                emptyText="أضف حساباً بنكياً أولاً من شاشة البنوك"
              />
            )}
            <Field label="المبلغ المقبوض" value={l.amount} keyboard="numeric" ltr
              onChange={(v) => { setAmountTouched(true); setPayLines((p) => p.map((x, xi) => (xi === i ? { ...x, amount: v } : x))); }} />
            {payLines.length > 1 && (
              <BtnGhost small danger icon="cancel" title="حذف هذه الطريقة"
                onPress={() => setPayLines((p) => p.filter((_, xi) => xi !== i))} />
            )}
          </View>
        ))}
        <BtnGhost small title="+ إضافة طريقة سداد أخرى (دفع بأكثر من طريقة)"
          onPress={() => setPayLines((p) => [...p, { method: 'cash', bankId: '', amount: '' }])} />
        <View style={{ height: 10 }} />
        <Field label="الخصم" value={discount} onChange={onDiscountChange} keyboard="numeric" ltr />
        {payDiscount > 0 ? (
          <>
            <SelectField<DiscountKind>
              label="نوع الخصم"
              value={discountKind || null}
              placeholder="اختر نوع الخصم"
              error={payNeedsKind}
              options={[
                { value: DISCOUNT_AFTER_DUE, label: 'خصم بعد الاستحقاق',
                  sub: 'القسط يبقى بقيمته · الإيراد بقيمة ما غطّته الدفعة كاملاً · والخصم مصروف في الخصومات الممنوحة' },
                { value: DISCOUNT_REDUCES_INSTALLMENT, label: 'تنزيل من قيمة القسط',
                  sub: 'القسط نفسه يُخفَّض بالخصم · الإيراد بالمقبوض وحده · ولا يُسجَّل خصم' },
              ]}
              onPick={setDiscountKind}
            />
            {discountKind === DISCOUNT_AFTER_DUE ? (
              <T size={11.5} color={C.muted} style={{ marginTop: -6, marginBottom: 10 }}>
                القسط يبقى بقيمته · يُسجَّل الإيراد بقيمة ما غطّته الدفعة كاملاً، والخصم مصروفاً في حساب الخصومات الممنوحة
              </T>
            ) : null}
            {discountKind === DISCOUNT_REDUCES_INSTALLMENT ? (
              <View style={{ marginTop: -6, marginBottom: 10 }}>
                <T size={11.5} color={C.muted}>
                  تُخفَّض قيمة القسط نفسه بمبلغ الخصم · يُسجَّل الإيراد بالمقبوض وحده ولا يُسجَّل خصم
                </T>
                <T size={11.5} color={C.rose} style={{ marginTop: 4 }}>
                  تنبيه: تخفيض القسط يخالف قيمة العقد الموثّقة في منصة إيجار
                </T>
              </View>
            ) : null}
          </>
        ) : null}
        <Field label="مرجع الحوالة أو الشيك" value={payRef} onChange={setPayRef} ltr />
        <View style={{ marginBottom: 10 }}>
          <BtnGhost small icon="attach" title={payFile ? payFile.name : 'إرفاق صورة الإيصال'}
            onPress={async () => { const f = await pickFile(); if (f) setPayFile(f); }} />
        </View>
        <View style={{ backgroundColor: C.paper, borderRadius: 8, padding: 11, marginBottom: 10 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={13} bold>المقبوض فعلاً:</T>
            <Num size={13} bold>{fmt(payReceived)}</Num>
          </Row>
          {payDiscount > 0 ? (
            <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
              <T size={12} color={C.muted}>يغطي من القسط مع الخصم:</T>
              <Num size={12}>{fmt(payReceived + payDiscount)}</Num>
            </Row>
          ) : null}
          {/* سبب غياب زر التحصيل حين يتجاوز المدخل المتبقي · فلا يُترك المستخدم بلا تفسير */}
          {payOver && paying ? (
            <T size={11.5} color={C.rose} style={{ marginTop: 6 }}>
              {payDiscount < 0
                ? 'الخصم لا يكون سالباً'
                : 'المقبوض مع الخصم يتجاوز المتبقي على القسط (' + fmt(paying.remaining) + ')'}
            </T>
          ) : null}
          {payNeedsKind && !payOver ? (
            <T size={11.5} color={C.rose} style={{ marginTop: 6 }}>اختر نوع الخصم ليظهر زر التحصيل</T>
          ) : null}
        </View>
        <Field label="ملاحظات" value={payNotes} onChange={setPayNotes} />
      </Sheet>
    </Screen>
  );
}

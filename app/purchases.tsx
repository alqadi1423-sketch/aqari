/** فواتير الشراء · التسجيل بالفئات وبنود التأسيس والعدادات، والسداد والتراجع */
import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { CashShortNote } from '../src/ui/CashGate';
import { cashShortfall } from '../src/domain/cashGuard';
import { useLocalSearchParams } from 'expo-router';
import { View, Pressable, FlatList, type ListRenderItemInfo } from 'react-native';
import { Screen } from '../src/ui/Screen';
import {
  Card, T, Num, Money, EmptyState, Row, Badge, SearchBox, BtnPrimary, BtnGhost, BtnIcon, Field, ChipGroup,
  KV,
} from '../src/ui/components';
import { Sheet, SelectField } from '../src/ui/Sheet';
import { DateField } from '../src/ui/DateField';
import { ActionMenuButton } from '../src/ui/ActionMenu';
import { usePager, Pager } from '../src/ui/Pager';
import { useDialog } from '../src/ui/AppDialog';
import { FilterBar, FilterSheet, useFilterSheet, type ActiveChip } from '../src/ui/FilterSheet';
import { useDeferredReady } from '../src/ui/useDeferredReady';
import { Skeleton } from '../src/ui/Skeleton';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { C, TYPE } from '../src/ui/theme';
import { Icon } from '../src/ui/icons';
import {
  savePurchase, payPurchaseSplit, unmarkPurchasePaid, deletePurchase, purchaseTax, priorPaymentCashOut,
  TAX_STATUSES, EXCLUDE_REASONS, TS_DEDUCTIBLE, TS_EXCLUDED, TS_EXEMPT, TS_ZERO, taxPeriodOf, markVatFiled, markVatRefunded, markVatRejected,
  type PurchasePayMethod, type TaxStatus,
} from '../src/domain/purchases';
import { today as todayFn } from '../src/domain/dates';
import { metersForPurchase } from '../src/domain/meters';
import { today, dfmt, daysBetween, toLocalISODate } from '../src/domain/dates';
import { fmt, toHalalas } from '../src/domain/money';
import { attachPicked, pickFile } from '../src/ui/attach';
import { FileViewer, type ViewerFile } from '../src/ui/FileViewer';
import { AttachStrip } from '../src/ui/AttachStrip';
import { reportFailure } from '../src/ui/failureDialog';
import { usePerm } from '../src/ui/access';

import { CostCenterField } from '../src/ui/CostCenters';
import { PurchaseLinesSection, loadLineDrafts } from '../src/ui/PurchaseLines';
import { toLineInput, emptyLine, type LineDraft } from '../src/ui/AssetSheets';
import { GENERAL_COST_CENTER, withCostCenter } from '../src/domain/accounting/dimensions';
const CATEGORIES = ['كهرباء', 'مياه', 'اتصالات وإنترنت', 'إيجار', 'رواتب', 'تكلفة مبيعات', 'مصروفات تأسيس', 'مصروفات أخرى'];
const INCORP_ITEMS = ['رسوم حكومية', 'ديكور وتجهيزات', 'معدات', 'تسويق افتتاحي', 'استشارات'];

interface PurchaseRow {
  id: string; no: string; supplier_name: string; date: string; due: string; category: string;
  subtotal_halalas: number; tax_halalas: number; total_halalas: number; exempt: number;
  exclude_from_vat: number; paid: number; tax_status?: string; refund_status?: string;
  /** أللفاتورة مستند أصلي مرفق؟ · صفر أو واحد · به يُقرَّر عرض زر «الفاتورة الأصلية» */
  att_n: number;
}

const EMPTY_ROWS: PurchaseRow[] = [];

const TAX_CHIPS: Array<[string, string]> = [['', 'الكل'], ...TAX_STATUSES.map((s): [string, string] => [s, s])];
const PAID_CHIPS: Array<[string, string]> = [['', 'الكل'], ['paid', 'مسدَّدة'], ['unpaid', 'غير مسدَّدة']];
const PERIOD_CHIPS: Array<[string, string]> = [['month', 'هذا الشهر'], ['quarter', 'هذا الربع'], ['year', 'هذه السنة'], ['', 'الكل']];

/** حدود الفترة الحالية [من، إلى] بتواريخ ISO محلية */
function periodBounds(kind: string): [string, string] {
  const now = new Date();
  const y = now.getFullYear();
  if (kind === 'month') {
    const m = now.getMonth();
    return [toLocalISODate(new Date(y, m, 1)), toLocalISODate(new Date(y, m + 1, 0))];
  }
  if (kind === 'quarter') {
    const qs = Math.floor(now.getMonth() / 3) * 3;
    return [toLocalISODate(new Date(y, qs, 1)), toLocalISODate(new Date(y, qs + 3, 0))];
  }
  return [y + '-01-01', y + '-12-31'];
}

function statusBadge(p: { paid: number; due: string }) {
  if (Number(p.paid)) return <Badge kind="paid" label="مسدَّدة" />;
  if (!p.due) return <Badge kind="draft" label="بلا تاريخ استحقاق" />;
  const days = daysBetween(p.due, today());
  if (days < 0) return <Badge kind="overdue" label="متأخرة" />;
  if (days <= 7) return <Badge kind="due" label={`تستحق خلال ${days} يوم`} />;
  return <Badge kind="due" label="مستحقة" />;
}

/** بطاقة فاتورة شراء واحدة · خارج الشاشة وبذاكرة كي لا تُعاد رسوم القائمة كلها ·
 * الضغط على البطاقة يفتح ورقة العرض الشاملة · السداد المسدَّد لا يُعدَّل بل يُتراجع عنه */
const PurchaseCard = React.memo(function PurchaseCard({
  id, no, supplierName, date, due, category, subtotalHalalas, taxHalalas, totalHalalas,
  exempt, excludeFromVat, paid, taxStatus, refundStatus, hasOriginal, canManage,
  onDetail, onPay, onEdit, onUndoPay, onPrint, onDelete, onVatFiled, onVatRefunded, onVatRejected,
}: {
  id: string; no: string; supplierName: string; date: string; due: string; category: string;
  subtotalHalalas: number; taxHalalas: number; totalHalalas: number;
  exempt: number; excludeFromVat: number; paid: number; taxStatus: string;
  refundStatus: string; hasOriginal: boolean;
  /** «المشتريات والموردون: كامل» · السداد والتراجع والتعديل والحذف واسترداد الضريبة */
  canManage: boolean;
  onDetail: (id: string) => void;
  onPay: (id: string, totalHalalas: number) => void;
  onEdit: (id: string) => void;
  onUndoPay: (id: string) => void;
  onPrint: (id: string, no: string) => void;
  onDelete: (id: string) => void;
  onVatFiled: (id: string) => void;
  onVatRefunded: (id: string) => void;
  onVatRejected: (id: string) => void;
}) {
  // الضريبة إذا استُردت أو رُفضت فقد انتهت قصتها · لا يُعرض لها فعل استرداد بعدها
  const vatSettled = refundStatus.startsWith('مسترَد') || refundStatus === 'مرفوض';
  const vatActions = canManage && taxStatus === TS_DEDUCTIBLE && !vatSettled ? [
    ...(refundStatus.startsWith('مُقدَّم') ? [] : [
      { icon: 'reload' as const, label: 'الضريبة: مُقدَّمة في الإقرار', onPress: () => onVatFiled(id) },
    ]),
    { icon: 'cash' as const, label: 'الضريبة: مسترَدة نقداً اليوم', onPress: () => onVatRefunded(id) },
    { icon: 'cancel' as const, label: 'الضريبة: مرفوضة (تصير تكلفة)', onPress: () => onVatRejected(id) },
  ] : [];
  return (
    <Pressable onPress={() => onDetail(id)}>
      <Card style={{ paddingVertical: 10 }}>
        {/* زر ⋮ أعلى البطاقة يساراً بمحاذاة العنوان · والمسدَّدة لا «سداد» لها ولا «تعديل»
            (يبقى «التراجع عن السداد») · وبلا مستند أصلي مرفق لا يُعرض زر «الفاتورة الأصلية» */}
        <Row style={{ justifyContent: 'space-between' }}>
          <T size={TYPE.sectionTitle} bold style={{ flex: 1 }}>{supplierName}</T>
          <Row gap={8}>
            {statusBadge({ paid, due })}
            <ActionMenuButton title={no} actions={[
              { icon: 'eye', label: 'عرض التفاصيل', onPress: () => onDetail(id) },
              canManage && !paid ? { icon: 'card', label: 'تسديد الفاتورة', onPress: () => onPay(id, totalHalalas) } : null,
              canManage && paid ? { icon: 'undo', label: 'التراجع عن السداد', onPress: () => onUndoPay(id) } : null,
              paid || !canManage ? null : { icon: 'edit' as const, label: 'تعديل', onPress: () => onEdit(id) },
              hasOriginal ? { icon: 'print' as const, label: 'الفاتورة الأصلية', onPress: () => onPrint(id, no) } : null,
              ...vatActions,
              canManage ? {
                icon: 'trash', label: 'حذف', danger: true,
                onPress: () => onDelete(id),
              } : null,
            ]} />
          </Row>
        </Row>
        <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
          <Num size={TYPE.caption} color={C.muted}>{no} · {dfmt(date)}</Num>
          {category || excludeFromVat
            ? <T size={TYPE.caption} color={C.muted}>{[category, excludeFromVat ? 'غير قابلة للخصم' : ''].filter(Boolean).join(' · ')}</T>
            : null}
        </Row>
        <Row gap={12} style={{ marginTop: 6 }}>
          <View><T size={TYPE.caption} color={C.muted}>قبل الضريبة</T><Money halalas={subtotalHalalas} size={TYPE.body} /></View>
          <View><T size={TYPE.caption} color={C.muted}>الضريبة</T>
            {exempt ? <T size={TYPE.body}>معفاة</T> : <Money halalas={taxHalalas} size={TYPE.body} />}
          </View>
          <View><T size={TYPE.caption} color={C.muted}>الإجمالي</T><Money halalas={totalHalalas} size={TYPE.body} bold /></View>
        </Row>
      </Card>
    </Pressable>
  );
});

export default function Purchases() {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const ready = useDeferredReady();
  const perm = usePerm('purchases');
  const [q, setQ] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [payFor, setPayFor] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<string | null>(null);

  // المرشِّحات · تُدمج كلها في WHERE واحد
  const fsheet = useFilterSheet();
  const [fSupplier, setFSupplier] = useState('');
  const [fCategory, setFCategory] = useState('');
  const [fTax, setFTax] = useState('');
  const [fPaid, setFPaid] = useState('');
  const [fPeriod, setFPeriod] = useState('');
  const [fProperty, setFProperty] = useState('');
  const pager = usePager('purchases');

  // حقول النموذج
  const [supplier, setSupplier] = useState('');
  const [date, setDate] = useState(today());
  const [due, setDue] = useState('');
  const [category, setCategory] = useState('');
  const [incorpItem, setIncorpItem] = useState('');
  const [amortize, setAmortize] = useState(false);
  const [amortizeMonths, setAmortizeMonths] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [unitSel, setUnitSel] = useState('');
  const [meterId, setMeterId] = useState('');
  const [meterReading, setMeterReading] = useState('');
  const [subtotal, setSubtotal] = useState('');
  const [taxStr, setTaxStr] = useState('');
  const [totalStr, setTotalStr] = useState('');
  // ما أدخله المستخدم يُحفظ كما هو · المحسوب وحده يتحرك
  const [touched, setTouched] = useState({ base: false, tax: false, total: false });
  // المعيار الوحيد: هل الفاتورة باسم المنشأة وبرقمها الضريبي؟ الافتراض «مستبعدة»
  const [taxStatus, setTaxStatus] = useState<TaxStatus>(TS_EXCLUDED);
  const [excludeReason, setExcludeReason] = useState(EXCLUDE_REASONS[0]);
  const [excludeOther, setExcludeOther] = useState('');
  const [vatFixOpen, setVatFixOpen] = useState(false);
  const [vatFixValue, setVatFixValue] = useState('');
  const [confirmOurs, setConfirmOurs] = useState(false);
  const exempt = taxStatus === TS_EXEMPT || taxStatus === TS_ZERO;
  const [pendingFile, setPendingFile] = useState<{ uri: string; name: string; mime: string } | null>(null);

  // نافذة السداد
  const [payLines, setPayLines] = useState<Array<{ method: PurchasePayMethod; bankId: string; amount: string }>>([]);
  const [payDate, setPayDate] = useState(today());

  // شرط WHERE الواحد: البحث والمرشِّحات كلها في SQL
  const filter = useMemo(() => {
    const where: string[] = ['deleted_at IS NULL'];
    const args: Array<string | number> = [];
    const needle = q.trim();
    if (needle) {
      where.push(`(no LIKE '%'||?||'%' OR supplier_name LIKE '%'||?||'%')`);
      args.push(needle, needle);
    }
    if (fSupplier) { where.push('supplier_name = ?'); args.push(fSupplier); }
    if (fCategory) { where.push('TRIM(category) = ?'); args.push(fCategory); }
    if (fTax) {
      where.push(`(CASE WHEN COALESCE(tax_status, '') != '' THEN tax_status WHEN exempt = 1 THEN ? ELSE ? END) = ?`);
      args.push(TS_EXEMPT, TS_EXCLUDED, fTax);
    }
    if (fPaid) { where.push('paid = ?'); args.push(fPaid === 'paid' ? 1 : 0); }
    if (fPeriod) {
      const [from, to] = periodBounds(fPeriod);
      where.push('date >= ? AND date <= ?');
      args.push(from, to);
    }
    // مشتريات العقار: المرتبطة به مباشرة أو عبر وحداته أو عبر عداداته (عدادات العقار أو عدادات وحداته)
    if (fProperty) {
      where.push(`(property_id = ?
        OR unit_id IN (SELECT id FROM units WHERE property_id = ?)
        OR meter_id IN (SELECT id FROM meters
          WHERE (owner_type = 'property' AND owner_id = ?)
             OR (owner_type = 'unit' AND owner_id IN (SELECT id FROM units WHERE property_id = ?))))`);
      args.push(fProperty, fProperty, fProperty, fProperty);
    }
    return { sql: where.join(' AND '), args };
  }, [q, fSupplier, fCategory, fTax, fPaid, fPeriod, fProperty]);

  // أي تغيير في البحث أو المرشِّحات يعيد للصفحة الأولى
  useEffect(() => {
    pager.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, fSupplier, fCategory, fTax, fPaid, fPeriod, fProperty]);

  const total = useMemo(() => {
    if (!ready) return 0;
    return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM purchases WHERE ` + filter.sql, filter.args)?.n ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready, filter]);

  // العدد الكلي قبل البحث والمرشِّحات · لسطر «24 من 60»
  const totalAll = useMemo(() => {
    if (!ready) return 0;
    return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM purchases WHERE deleted_at IS NULL`)?.n ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready]);

  const rows = useMemo(() => {
    if (!ready) return EMPTY_ROWS;
    return db.all<PurchaseRow>(
      `SELECT p.*, EXISTS(SELECT 1 FROM attachments
         WHERE entity_type = 'purchase' AND entity_id = p.id AND deleted_at IS NULL) AS att_n
       FROM purchases p WHERE ` + filter.sql + ` ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`,
      [...filter.args, pager.limit, pager.offset]
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready, filter, pager.limit, pager.offset]);

  const suppliers = useMemo(
    () => db.all<{ id: string; name: string; vat: string; default_category: string; default_amount_halalas: number | null; utility_type: string }>(
      `SELECT id, name, vat, default_category, default_amount_halalas, utility_type FROM suppliers WHERE archived = 0 AND deleted_at IS NULL ORDER BY name`
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]
  );
  const properties = useMemo(
    () => db.all<{ id: string; name: string }>(`SELECT id, name FROM properties WHERE deleted_at IS NULL AND archived = 0 ORDER BY name`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]
  );
  // اسم عقار المرشِّح · يُقرأ من القاعدة مباشرة ليشمل المؤرشف القادم عبر الرابط
  const fPropertyName = useMemo(
    () => (fProperty ? db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [fProperty])?.name ?? '' : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, fProperty]
  );
  const units = useMemo(
    () => (propertyId
      ? db.all<{ id: string; unit_no: string }>(`SELECT id, unit_no FROM units WHERE property_id = ? AND deleted_at IS NULL AND archived = 0 ORDER BY COALESCE(unit_no_key, unit_no), unit_no`, [propertyId])
      : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, propertyId]
  );
  const banks = useMemo(
    () => db.all<{ id: string; name: string }>(`SELECT id, name FROM banks WHERE deleted_at IS NULL AND archived = 0 ORDER BY created_at`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]
  );
  // الفئات: الأساسية + كل فئة استعملها المستخدم من قبل · فئته لا تُنسى ولا تُعاد كتابتها
  const categoryOptions = React.useMemo(() => {
    const used = db.all<{ c: string }>(
      `SELECT DISTINCT TRIM(category) AS c FROM purchases
       WHERE deleted_at IS NULL AND TRIM(category) != '' ORDER BY c`
    ).map((r) => r.c);
    return [...CATEGORIES, ...used.filter((c) => !CATEGORIES.includes(c))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version]);

  const selectedSupplier = suppliers.find((s) => s.name === supplier.trim());
  const supplierMetersList = useMemo(
    () => (selectedSupplier?.utility_type ? metersForPurchase(db, selectedSupplier.id, propertyId || null) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, selectedSupplier, propertyId]
  );
  const prevReading = useMemo(
    () => (meterId
      ? db.get<{ reading: number | null }>(
          `SELECT reading FROM meter_readings WHERE meter_id = ? AND reading IS NOT NULL ORDER BY date DESC LIMIT 1`,
          [meterId]
        )?.reading ?? null
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, meterId]
  );

  const deriveAmounts = (patch: Partial<{ base: string; tax: string; total: string }>, mark: 'base' | 'tax' | 'total') => {
    const t = { ...touched, [mark]: true };
    let b = patch.base !== undefined ? patch.base : subtotal;
    let x = patch.tax !== undefined ? patch.tax : taxStr;
    let g = patch.total !== undefined ? patch.total : totalStr;
    const bh = toHalalas(b), xh = toHalalas(x), gh = toHalalas(g);
    if (t.base && !t.tax && !t.total) {
      const sx = exempt ? 0 : purchaseTax(bh, exempt);
      x = fmt(sx).replace(/,/g, ''); g = fmt(bh + sx).replace(/,/g, '');
    } else if (t.total && !t.base && !t.tax) {
      const sb = exempt ? gh : Math.round(gh / 1.15);
      b = fmt(sb).replace(/,/g, ''); x = fmt(gh - sb).replace(/,/g, '');
    } else if (t.base && t.total && !t.tax) {
      x = fmt(gh - bh).replace(/,/g, '');
    } else if (t.base && t.tax && !t.total) {
      g = fmt(bh + xh).replace(/,/g, '');
    } else if (t.tax && t.total && !t.base) {
      b = fmt(gh - xh).replace(/,/g, '');
    }
    setSubtotal(b); setTaxStr(x); setTotalStr(g); setTouched(t);
  };

  // بنود الفاتورة (الهجرة ٢٩) · اختيارية
  const [lines, setLines] = useState<LineDraft[]>([]);
  const openNew = () => {
    if (!suppliers.length) { toast('أضف مورداً أولاً'); return; }
    setEditingId(null);
    setSupplier(suppliers[0].name); setDate(today()); setDue(''); setCategory(''); setIncorpItem('');
    setAmortize(false); setAmortizeMonths(''); setPropertyId(''); setUnitSel('');
    setMeterId(''); setMeterReading(''); setSubtotal(''); setTaxStr(''); setTotalStr('');
    setTouched({ base: false, tax: false, total: false });
    setTaxStatus(TS_EXCLUDED); setExcludeReason(EXCLUDE_REASONS[0]); setExcludeOther(''); setConfirmOurs(false);
    setPendingFile(null);
    setLines([]);
    setFormOpen(true);
  };
  const openEdit = useCallback((id: string) => {
    const p = db.get<{
      supplier_name: string; date: string; due: string; category: string; incorp_item: string;
      amortize: number; amortize_months: number | null; exempt: number; exclude_from_vat: number;
      tax_status: string; exclude_reason: string; supplier_vatno: string;
      unit_id: string | null; property_id: string | null; subtotal_halalas: number;
    }>(`SELECT * FROM purchases WHERE id = ?`, [id]);
    if (!p) return;
    setEditingId(id);
    setSupplier(p.supplier_name); setDate(p.date); setDue(p.due); setCategory(p.category);
    setIncorpItem(p.incorp_item); setAmortize(!!Number(p.amortize));
    setAmortizeMonths(p.amortize_months != null ? String(p.amortize_months) : '');
    const u = p.unit_id ? db.get<{ property_id: string }>(`SELECT property_id FROM units WHERE id = ?`, [p.unit_id]) : undefined;
    setPropertyId(p.property_id ?? u?.property_id ?? '');
    setUnitSel(p.unit_id ? 'U:' + p.unit_id : p.property_id ? 'P:' + p.property_id : '');
    setMeterId(''); setMeterReading('');
    setSubtotal(fmt(Number(p.subtotal_halalas)).replace(/,/g, ''));
    setTaxStr(fmt(Number((p as unknown as { tax_halalas: number }).tax_halalas)).replace(/,/g, ''));
    setTotalStr(fmt(Number((p as unknown as { total_halalas: number }).total_halalas)).replace(/,/g, ''));
    setTouched({ base: true, tax: true, total: true }); // أرقام مستند محفوظة
    const ts = (p.tax_status as TaxStatus) || (Number(p.exempt) ? TS_EXEMPT : TS_EXCLUDED);
    setTaxStatus(ts);
    setConfirmOurs(ts === TS_DEDUCTIBLE);
    if (EXCLUDE_REASONS.includes(p.exclude_reason)) { setExcludeReason(p.exclude_reason); setExcludeOther(''); }
    else { setExcludeReason('أخرى'); setExcludeOther(p.exclude_reason || ''); }
    setLines(loadLineDrafts(db, id));
    setFormOpen(true);
  }, [db]);

  // القدوم من الدفتر أو تقرير: ?detail=<id> يفتح ورقة عرض المستند مباشرة والرجوع يعيد من حيث أتيت
  const params = useLocalSearchParams<{ detail?: string; property?: string; newNote?: string; newProperty?: string }>();
  useEffect(() => {
    if (params.detail) setDetailFor(String(params.detail));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.detail]);
  // القدوم من المحادثة (الدفعة ٥): ?newNote=&newProperty= يفتح فاتورة جديدة ببندٍ وصفه نص الرسالة وعقارها ·
  // والمبالغ يُدخلها المستخدم، والحفظ بمسار الخدمة وصلاحيتها كما هما
  useEffect(() => {
    if (params.newNote === undefined && params.newProperty === undefined) return;
    if (!perm.add || !suppliers.length) return;
    openNew();
    if (params.newNote) setLines([{ ...emptyLine(), descr: String(params.newNote).slice(0, 200) }]);
    if (params.newProperty && properties.some((p) => p.id === String(params.newProperty))) {
      setPropertyId(String(params.newProperty)); setUnitSel('P:' + String(params.newProperty));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.newNote, params.newProperty]);
  // القدوم من شاشة العقار: ?property=<id> يفعّل مرشِّح العقار (المرتبط مباشرة أو عبر وحداته أو عداداته)
  useEffect(() => {
    if (params.property) setFProperty(String(params.property));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.property]);

  const [cc, setCc] = useState(GENERAL_COST_CENTER);
  const [payCc, setPayCc] = useState(GENERAL_COST_CENTER);
  const doSave = (...a: Parameters<typeof doSaveIn>) => withCostCenter(cc, () => doSaveIn(...a));
  const doSaveIn = (baseH: number, taxH2: number, totalH2: number, roundingDiff: number) => {
    try {
      const savedId = savePurchase(db, {
        supplier: supplier.trim(), date, due, category: category.trim(),
        incorpItem: category.trim() === 'مصروفات تأسيس' ? incorpItem.trim() : '',
        amortize: category.trim() === 'مصروفات تأسيس' && amortize,
        amortizeMonths: amortize && amortizeMonths.trim() ? parseInt(amortizeMonths, 10) : null,
        exempt, excludeFromVat: taxStatus === TS_EXCLUDED,
        taxStatus,
        excludeReason: taxStatus === TS_EXCLUDED ? (excludeReason === 'أخرى' ? excludeOther.trim() : excludeReason) : '',
        unitId: unitSel.startsWith('U:') ? unitSel.slice(2) : null,
        propertyId: unitSel.startsWith('P:') ? unitSel.slice(2) : propertyId || null,
        subtotalHalalas: baseH,
        taxHalalas: taxH2, totalHalalas: totalH2, roundingDiffHalalas: roundingDiff,
        meterId: meterId || null,
        meterReading: meterReading.trim() ? parseFloat(meterReading) : null,
        lines: lines.length ? lines.map(toLineInput) : undefined,
      }, editingId ?? undefined);
      if (pendingFile) {
        attachPicked(db, pendingFile, 'purchase', savedId, 'purchase').catch((e) => reportFailure({ title: 'تعذّر رفع الملف', e }));
      }
      setFormOpen(false); bump();
      toast(editingId ? 'تم تحديث الفاتورة وإعادة ترحيلها محاسبياً' : 'تم تسجيل الفاتورة وترحيلها محاسبياً');
    } catch (e) {
      reportFailure({ title: 'تعذّر الحفظ', e });
    }
  };

  // فاتورة الشراء الأصلية = المستند المرفق من المتجر يُعرض داخل التطبيق، لا نسخة يولّدها
  const [viewOrig, setViewOrig] = useState<{ files: ViewerFile[]; index: number } | null>(null);
  const printOriginal = useCallback((id: string, no: string) => {
    // لا يصل هنا إلا ما له مستند مرفق · الخالية منه لا يُعرض لها الزر أصلاً
    const atts = db.all<{ id: string; sha256: string; ext: string; original_name: string; display_name: string; mime: string; created_at: string; size_bytes: number }>(
      `SELECT a.id, a.sha256, b.ext, a.original_name, a.display_name, a.mime, a.created_at, b.size_bytes
       FROM attachments a JOIN blobs b ON b.sha256 = a.sha256
       WHERE a.entity_type = 'purchase' AND a.entity_id = ? AND a.deleted_at IS NULL
       ORDER BY a.created_at DESC`, [id]);
    if (!atts.length) return;
    setViewOrig({
      index: 0,
      files: atts.map((a): ViewerFile => ({
        attId: a.id, sha256: a.sha256, ext: a.ext,
        name: a.display_name || a.original_name || 'فاتورة ' + no,
        mime: a.mime, sizeBytes: Number(a.size_bytes), createdAt: a.created_at,
        cat: 'purchase', linked: 'فاتورة شراء ' + no,
      })),
    });
  }, [db]);

  // معالجات بطاقة الصف · مثبَّتة كي لا تُبطل ذاكرة PurchaseCard
  const openPay = useCallback((id: string, totalHalalas: number) => {
    setPayFor(id);
    setPayLines([{ method: banks.length ? 'bank' : 'cash', bankId: banks[0]?.id ?? '', amount: fmt(totalHalalas).replace(/,/g, '') }]);
    setPayDate(today());
  }, [banks]);
  const undoPay = useCallback((id: string) => {
    dialog({
      title: 'التراجع عن السداد',
      body: 'سيُعكَس أثره المحاسبي بالكامل.',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        { label: 'تأكيد', variant: 'primary', onPress: () => { unmarkPurchasePaid(db, id); bump(); toast('تم التراجع عن السداد'); } },
      ],
    });
  }, [db, bump, toast, dialog]);
  const doDelete = useCallback((id: string) => {
    dialog({
      title: 'حذف الفاتورة',
      body: 'حذف هذه الفاتورة؟ سيُعكَس أثرها المحاسبي إن وُجد.',
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        { label: 'حذف', variant: 'danger', onPress: () => { deletePurchase(db, id); bump(); toast('تم الحذف · يمكن استعادته من الإعدادات'); } },
      ],
    });
  }, [db, bump, toast, dialog]);
  const vatFiled = useCallback((id: string) => {
    try { markVatFiled(db, id); bump(); toast('حُدّثت حالة الاسترداد'); }
    catch (e) { reportFailure({ title: 'تعذّر تحديث حالة الاسترداد', e }); }
  }, [db, bump, toast, dialog]);
  const vatRefunded = useCallback((id: string) => {
    try { markVatRefunded(db, id, todayFn()); bump(); toast('سُجّل الاسترداد وأُقفل 1270'); }
    catch (e) { reportFailure({ title: 'تعذّر تسجيل الاسترداد', e }); }
  }, [db, bump, toast, dialog]);
  const vatRejected = useCallback((id: string) => {
    try { markVatRejected(db, id, todayFn()); bump(); toast('حُمّلت الضريبة على المصروف'); }
    catch (e) { reportFailure({ title: 'تعذّر تسجيل الرفض', e }); }
  }, [db, bump, toast, dialog]);

  // مرفقات الفاتورة قيد التعديل · بها يُقرَّر عرض زر إرفاق الأصل من عدمه
  const editingAttCount = useMemo(() => (editingId ? Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attachments WHERE entity_type = 'purchase' AND entity_id = ? AND deleted_at IS NULL`,
    [editingId])?.n ?? 0) : 0),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, version, editingId]);

  const clearFilters = useCallback(() => {
    setQ(''); setFSupplier(''); setFCategory(''); setFTax(''); setFPaid(''); setFPeriod(''); setFProperty('');
  }, []);

  // رقاقة واحدة لكل مرشِّح مفعَّل · تسميتها باسم القيمة
  const activeChips = useMemo(() => {
    const chips: ActiveChip[] = [];
    if (fSupplier) chips.push({ key: 'supplier', label: 'مورد ' + fSupplier, onClear: () => setFSupplier('') });
    if (fCategory) chips.push({ key: 'category', label: 'فئة ' + fCategory, onClear: () => setFCategory('') });
    if (fTax) chips.push({ key: 'tax', label: fTax, onClear: () => setFTax('') });
    if (fPaid) chips.push({ key: 'paid', label: fPaid === 'paid' ? 'مسدَّدة' : 'غير مسدَّدة', onClear: () => setFPaid('') });
    if (fPeriod) chips.push({ key: 'period', label: PERIOD_CHIPS.find(([v]) => v === fPeriod)?.[1] ?? fPeriod, onClear: () => setFPeriod('') });
    if (fProperty) chips.push({ key: 'property', label: 'عقار ' + (fPropertyName || 'محدَّد'), onClear: () => setFProperty('') });
    return chips;
  }, [fSupplier, fCategory, fTax, fPaid, fPeriod, fProperty, fPropertyName]);

  const openDetail = useCallback((id: string) => setDetailFor(id), []);

  const keyExtractor = useCallback((item: PurchaseRow) => item.id, []);
  const renderItem = useCallback(({ item }: ListRenderItemInfo<PurchaseRow>) => (
    <PurchaseCard
      id={item.id} no={item.no} supplierName={item.supplier_name} date={item.date} due={item.due}
      category={item.category} subtotalHalalas={Number(item.subtotal_halalas)} taxHalalas={Number(item.tax_halalas)}
      totalHalalas={Number(item.total_halalas)} exempt={Number(item.exempt)} excludeFromVat={Number(item.exclude_from_vat)}
      paid={Number(item.paid)} taxStatus={item.tax_status ?? ''} refundStatus={item.refund_status ?? ''}
      hasOriginal={!!Number(item.att_n)} canManage={perm.manage}
      onDetail={openDetail} onPay={openPay} onEdit={openEdit} onUndoPay={undoPay} onPrint={printOriginal} onDelete={doDelete}
      onVatFiled={vatFiled} onVatRefunded={vatRefunded} onVatRejected={vatRejected}
    />
  ), [openDetail, openPay, openEdit, undoPay, printOriginal, doDelete, vatFiled, vatRefunded, vatRejected, perm.manage]);

  // نافذة القرار عند عدم التوازن · Alert في أندرويد يعرض ثلاثة أزرار فقط فيُسقط الرابع
  const [imbalance, setImbalance] = useState<{ bh: number; xh: number; gh: number } | null>(null);

  const save = () => {
    if (taxStatus === TS_DEDUCTIBLE) {
      if (!(selectedSupplier?.vat ?? '').trim()) {
        dialog({
          title: 'المورد بلا رقم ضريبي',
          body: '«' + supplier.trim() + '» بلا رقم ضريبي في بطاقته · والرقم شرط نظامي للخصم.',
          actions: [
            { label: 'تراجع', variant: 'ghost' },
            // تعديل بطاقة المورد · لصاحب «كامل» وحده
            ...(perm.manage ? [{ label: 'أضِفه الآن', variant: 'primary' as const, onPress: () => { setVatFixValue(''); setVatFixOpen(true); } }] : []),
          ],
        });
        return;
      }
      if (!confirmOurs) {
        dialog({
          title: 'تأكيد مطلوب',
          body: 'أكّد أن الفاتورة صادرة باسم المنشأة وبرقمها الضريبي · وإلا فأبقِها «' + TS_EXCLUDED + '»',
          actions: [{ label: 'حسناً', variant: 'ghost' }],
        });
        return;
      }
    }
    const bh = toHalalas(subtotal);
    const xh = exempt ? 0 : toHalalas(taxStr);
    const gh = toHalalas(totalStr) || bh + xh;
    if (gh - bh - xh === 0) { doSave(bh, xh, gh, 0); return; }
    setImbalance({ bh, xh, gh });
  };

  const listHeader = (
    <FilterBar chips={activeChips} onOpen={fsheet.show} onClearAll={clearFilters}
      resultCount={total} total={totalAll} filtered={total} itemName="فاتورة"
      search={<SearchBox value={q} onChange={setQ} />} />
  );

  return (
    <Screen title="فواتير الشراء" icon="wrench" scroll={false}
      /* لا مورد فلا فاتورة شراء تُسجَّل · الزر لا يُعرض بدل أن يُعرض ويرفض */
      actions={suppliers.length && perm.add ? <BtnPrimary small title="+ تسجيل فاتورة شراء" onPress={openNew} /> : undefined}>
      {!ready ? <Skeleton /> : (
        <FlatList
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          ListHeaderComponent={listHeader}
          ListFooterComponent={<Pager pager={pager} total={total} />}
          ListEmptyComponent={<Card><EmptyState>{totalAll === 0
            ? (!perm.add ? 'لا توجد فواتير شراء مسجَّلة' : suppliers.length
              ? 'لا توجد فواتير شراء مسجَّلة · اضغط «+ تسجيل فاتورة شراء»'
              : 'لا فواتير شراء · أضف مورداً أولاً فالفاتورة تُسجَّل على مورد')
            : 'لا نتائج مطابقة · عدّل البحث أو اضغط «مسح الكل»'}</EmptyState></Card>}
          initialNumToRender={5}
          maxToRenderPerBatch={8}
          windowSize={5}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
        />
      )}

      {/* ورقة التصفية · المرشِّحات الستة */}
      <FilterSheet open={fsheet.open} onClose={fsheet.hide} onClearAll={clearFilters} resultCount={total}>
        <SelectField label="المورد" value={fSupplier}
          options={[{ value: '', label: 'كل المورّدين' }, ...suppliers.map((s) => ({ value: s.name, label: s.name }))]}
          onPick={setFSupplier} />
        <SelectField label="العقار" value={fProperty}
          options={[
            { value: '', label: 'كل العقارات' },
            ...properties.map((p) => ({ value: p.id, label: p.name })),
            ...(fProperty && !properties.some((p) => p.id === fProperty)
              ? [{ value: fProperty, label: fPropertyName || 'عقار محدَّد' }] : []),
          ]}
          onPick={setFProperty} />
        <SelectField label="الفئة" value={fCategory}
          options={[{ value: '', label: 'كل الفئات' }, ...categoryOptions.map((c) => ({ value: c, label: c }))]}
          onPick={setFCategory} />
        <T size={11.5} color={C.muted} style={{ marginBottom: 5 }}>الوضع الضريبي</T>
        <View style={{ marginBottom: 10 }}>
          <ChipGroup options={TAX_CHIPS} value={fTax} onChange={setFTax} />
        </View>
        <T size={11.5} color={C.muted} style={{ marginBottom: 5 }}>السداد</T>
        <View style={{ marginBottom: 10 }}>
          <ChipGroup options={PAID_CHIPS} value={fPaid} onChange={setFPaid} />
        </View>
        <T size={11.5} color={C.muted} style={{ marginBottom: 5 }}>الفترة</T>
        <ChipGroup options={PERIOD_CHIPS} value={fPeriod} onChange={setFPeriod} />
      </FilterSheet>

      {/* نافذة التسجيل */}
      <Sheet visible={formOpen} onClose={() => setFormOpen(false)}
        title={editingId ? 'تعديل فاتورة الشراء' : 'تسجيل فاتورة شراء / التزام'} tall
        footer={
          <>
            <View style={{ flex: 1 }}><BtnPrimary title={editingId ? 'حفظ التعديل' : 'تسجيل الفاتورة'} onPress={save} /></View>
          </>
        }>
        <SelectField label="المورد / الجهة" value={selectedSupplier?.id ?? ''}
          display={supplier || undefined}
          options={suppliers.map((s) => ({ value: s.id, label: s.name, sub: s.utility_type ? 'مورد ' + s.utility_type : undefined }))}
          onPick={(id) => {
            const s = suppliers.find((x) => x.id === id);
            if (!s) return;
            setSupplier(s.name);
            if (s.default_category && !category) setCategory(s.default_category);
            if (s.default_amount_halalas && !subtotal) deriveAmounts({ base: fmt(Number(s.default_amount_halalas)).replace(/,/g, '') }, 'base');
            setMeterId('');
          }} />
        <Row>
          <View style={{ flex: 1 }}><DateField label="تاريخ الفاتورة" value={date} onChange={setDate} /></View>
          <View style={{ flex: 1 }}><DateField label="تاريخ الاستحقاق" value={due} onChange={setDue} /></View>
        </Row>
        <CostCenterField value={cc} onChange={setCc} />
        <Field label="الفئة" value={category} onChange={setCategory} />
        <PurchaseLinesSection lines={lines} onChange={setLines} baseHalalas={toHalalas(subtotal)} />
        <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
          {categoryOptions.map((c) => <BtnGhost key={c} small title={c} onPress={() => setCategory(c)} />)}
        </Row>
        {category.trim() === 'مصروفات تأسيس' && (
          <>
            <Field label="البند الفرعي" value={incorpItem} onChange={setIncorpItem} />
            <CheckRow checked={amortize} onToggle={() => setAmortize((v) => !v)}
              label="استهلاك على فترة زمنية بدل احتسابه دفعة واحدة" />
            {amortize && <Field label="عدد أشهر الاستهلاك" value={amortizeMonths} onChange={setAmortizeMonths} keyboard="numeric" ltr />}
          </>
        )}
        <SelectField label="العقار المرتبط" value={propertyId}
          options={[{ value: '', label: 'بدون ربط' }, ...properties.map((p) => ({ value: p.id, label: p.name }))]}
          onPick={(v) => { setPropertyId(v); setUnitSel(v ? 'P:' + v : ''); setMeterId(''); }} />
        {propertyId ? (
          <SelectField label="تحديد الوحدة أو العقار بالكامل" value={unitSel}
            options={[
              { value: 'P:' + propertyId, icon: 'building', label: 'العقار بالكامل' },
              ...units.map((u) => ({ value: 'U:' + u.id, label: 'وحدة رقم ' + u.unit_no })),
            ]}
            onPick={setUnitSel} />
        ) : null}
        {selectedSupplier?.utility_type ? (
          <>
            <SelectField label="العداد المرتبط" value={meterId}
              options={[{ value: '', label: 'بدون ربط بعداد' },
                ...supplierMetersList.map((m) => ({ value: m.id, label: m.label + ' · ' + m.number }))]}
              onPick={setMeterId} />
            {!supplierMetersList.length ? (
              <T size={10.5} color={C.muted} style={{ marginBottom: 8 }}>
                لا عدادات مرتبطة بـ{supplier} · اربطها من نافذة الوحدة أو العقار
              </T>
            ) : null}
            {meterId ? (
              <Row>
                <View style={{ flex: 1 }}><Field label="القراءة الحالية" value={meterReading} onChange={setMeterReading} keyboard="numeric" ltr /></View>
                <View style={{ flex: 1 }}>
                  <Field label="القراءة السابقة" value={prevReading != null ? String(prevReading) : ''} disabled ltr />
                </View>
              </Row>
            ) : null}
          </>
        ) : null}
        {/* الفاتورة الأصلية مستند واحد لا أكثر · فما أُرفق أصله لا يُعرض معه زر إرفاق أصل آخر */}
        {editingAttCount ? (
          <AttachStrip section="purchases" entityType="purchase" entityId={editingId!} kind="purchase"
            linked={'فاتورة شراء ' + (supplier.trim() || '')} title="الفاتورة الأصلية المرفقة" hideAdd />
        ) : (
          <View style={{ marginBottom: 10 }}>
            <BtnGhost small icon="attach" title={pendingFile ? pendingFile.name : 'إرفاق صورة أو ملف الفاتورة الأصلية من المتجر'}
              onPress={async () => { const f = await pickFile(); if (f) setPendingFile(f); }} />
          </View>
        )}
        <Field label="المبلغ قبل الضريبة (كما في الفاتورة)" value={subtotal}
          onChange={(v) => deriveAmounts({ base: v }, 'base')} keyboard="numeric" ltr />
        <Row>
          <View style={{ flex: 1 }}>
            <Field label="الضريبة (كما في الفاتورة)" value={exempt ? '0' : taxStr}
              onChange={(v) => deriveAmounts({ tax: v }, 'tax')} keyboard="numeric" ltr disabled={exempt} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="الإجمالي (كما في الفاتورة)" value={totalStr}
              onChange={(v) => deriveAmounts({ total: v }, 'total')} keyboard="numeric" ltr />
          </View>
        </Row>
        <SelectField label="الوضع الضريبي" value={taxStatus}
          options={TAX_STATUSES.map((v) => ({ value: v, label: v }))}
          onPick={(v) => {
            setTaxStatus(v);
            if (v === TS_EXEMPT || v === TS_ZERO) { setTaxStr('0'); setTotalStr(subtotal); }
            if (v !== TS_DEDUCTIBLE) setConfirmOurs(false);
          }} />
        {taxStatus === TS_DEDUCTIBLE ? (
          <>
            {(selectedSupplier?.vat ?? '').trim() ? (
              <View style={{ backgroundColor: C.emeraldSoft, borderRadius: 8, padding: 10, marginBottom: 10 }}>
                <T size={11.5} color={C.muted}>الرقم الضريبي للمورد (من بطاقته)</T>
                <Num size={13} bold>{selectedSupplier!.vat}</Num>
              </View>
            ) : (
              <View style={{ backgroundColor: C.roseSoft, borderRadius: 8, padding: 10, marginBottom: 10 }}>
                <T size={12} bold color={C.rose}>«{supplier.trim() || 'المورد'}» بلا رقم ضريبي · والرقم شرط نظامي للخصم</T>
                {perm.manage ? (
                  <View style={{ marginTop: 8 }}>
                    <BtnGhost small title="أضِفه الآن" onPress={() => { setVatFixValue(''); setVatFixOpen(true); }} />
                  </View>
                ) : null}
              </View>
            )}
            <CheckRow checked={confirmOurs} onToggle={() => setConfirmOurs((v) => !v)}
              label="أؤكّد أن الفاتورة صادرة باسم المنشأة وبرقمها الضريبي" />
          </>
        ) : null}
        {taxStatus === TS_EXCLUDED ? (
          <>
            <SelectField label="سبب الاستبعاد" value={excludeReason}
              options={[...EXCLUDE_REASONS, 'أخرى'].map((v) => ({ value: v, label: v }))}
              onPick={setExcludeReason} />
            {excludeReason === 'أخرى' ? (
              <Field label="سبب آخر" value={excludeOther} onChange={setExcludeOther} />
            ) : null}
          </>
        ) : null}
        <Num size={11.5} color={C.muted} style={{ marginBottom: 8 }}>الفترة الضريبية: {taxPeriodOf(date)}</Num>
        {(() => {
          const bh = toHalalas(subtotal), xh = exempt ? 0 : toHalalas(taxStr), gh = toHalalas(totalStr);
          const ok = gh === 0 || bh + xh === gh;
          return (
            <View style={{ backgroundColor: ok ? C.emeraldSoft : C.roseSoft, borderRadius: 8, padding: 11, marginBottom: 10 }}>
              <Num size={13} bold color={ok ? C.emerald : C.rose}>
                {fmt(bh)} + {fmt(xh)} = {fmt(bh + xh)}{gh && bh + xh !== gh ? ' ≠ ' + fmt(gh) : ''}
              </Num>
            </View>
          );
        })()}
      </Sheet>

      {/* إضافة الرقم الضريبي في مصدره: بطاقة المورد · مرة واحدة تفيد كل فاتورة سابقة ولاحقة */}
      {vatFixOpen && (
        <Sheet visible onClose={() => setVatFixOpen(false)} title={'الرقم الضريبي · ' + supplier.trim()}
          footer={
            <>
              <View style={{ flex: 1 }}>
                <BtnPrimary title="حفظ في بطاقة المورد" onPress={() => {
                  const v = vatFixValue.trim();
                  if (!v) { toast('أدخل الرقم الضريبي'); return; }
                  if (!selectedSupplier) { toast('اختر المورد أولاً'); return; }
                  db.transaction(() => {
                    db.run(`UPDATE suppliers SET vat = ? WHERE id = ?`, [v, selectedSupplier.id]);
                  });
                  bump(); setVatFixOpen(false);
                  toast('حُفظ الرقم في بطاقة «' + selectedSupplier.name + '» ويستفيد منه كل فواتيره');
                }} />
              </View>
            </>
          }>
          <Field label="الرقم الضريبي للمورد" value={vatFixValue} onChange={setVatFixValue} keyboard="numeric" ltr />
        </Sheet>
      )}

      {/* عارض الفاتورة الأصلية */}
      {viewOrig && (
        <FileViewer section="purchases" files={viewOrig.files} startIndex={viewOrig.index}
          onClose={() => setViewOrig(null)} onMutated={() => bump()} />
      )}

      {/* ورقة عرض الفاتورة الشاملة · الضغط على البطاقة يفتحها والتعديل زر داخلها */}
      {detailFor && (
        <PurchaseDetailSheet purchaseId={detailFor} onClose={() => setDetailFor(null)} onEdit={openEdit} />
      )}

      {/* قرار عدم التوازن · الخيارات الأربعة كاملة · Alert أندرويد يعرض ثلاثة أزرار فقط */}
      {imbalance && (() => {
        const { bh, xh, gh } = imbalance;
        const diff = gh - bh - xh;
        const bigDiff = Math.abs(diff) > 5;
        const srcRows: Array<[string, number, boolean]> = [
          ['الأساس', bh, touched.base],
          ['الضريبة', xh, touched.tax],
          ['الإجمالي', gh, touched.total],
        ];
        const close = () => setImbalance(null);
        return (
          <Sheet visible onClose={close} title="الأرقام الثلاثة لا تتوازن">
            <View style={{ backgroundColor: C.paper, borderRadius: 8, padding: 11, marginBottom: 10 }}>
              {srcRows.map(([label, v, byUser]) => (
                <Row key={label} style={{ justifyContent: 'space-between', paddingVertical: 3 }}>
                  <T size={12.5}>{label}</T>
                  <Row gap={8}>
                    <Num size={13} bold>{fmt(v)}</Num>
                    <T size={11} bold={byUser} color={byUser ? C.emerald : C.muted}>{byUser ? 'أدخلتَه أنت' : 'مُقترَح'}</T>
                  </Row>
                </Row>
              ))}
            </View>
            <Num size={12.5} color={C.muted} style={{ marginBottom: 10 }}>
              الأساس + الضريبة = {fmt(bh + xh)} · الإجمالي المُدخل = {fmt(gh)} · الفرق {fmt(Math.abs(diff))}
            </Num>
            {bigDiff ? (
              <View style={{ backgroundColor: C.roseSoft, borderRadius: 8, padding: 10, marginBottom: 10 }}>
                <T size={12.5} bold color={C.rose}>فرق كبير · تأكّد من الأرقام</T>
              </View>
            ) : null}
            <View style={{ gap: 8, marginBottom: 10 }}>
              <BtnPrimary title={'احفظ كما هي · اقبل الفرق ' + fmt(Math.abs(diff)) + ' كفرق تقريب'}
                onPress={() => { close(); doSave(bh, xh, gh, diff); }} />
              {!exempt && (
                <BtnGhost title={'عدّل الضريبة إلى ' + fmt(gh - bh)}
                  onPress={() => { close(); setTaxStr(fmt(gh - bh).replace(/,/g, '')); setTouched((t) => ({ ...t, tax: true })); doSave(bh, gh - bh, gh, 0); }} />
              )}
              <BtnGhost title={'عدّل الأساس إلى ' + fmt(gh - xh)}
                onPress={() => { close(); setSubtotal(fmt(gh - xh).replace(/,/g, '')); setTouched((t) => ({ ...t, base: true })); doSave(gh - xh, xh, gh, 0); }} />
            </View>
          </Sheet>
        );
      })()}

      {/* نافذة السداد · مقسَّم على طرق دفع متعددة ومجموعها يساوي الإجمالي ·
          قبل الحفظ حوارُ ملخصٍ للتثبيت: المورد والفاتورة والمبلغ والمصدر والتاريخ */}
      {payFor && (() => {
        const payInfo = db.get<{ no: string; supplier_name: string; t: number }>(
          `SELECT no, supplier_name, total_halalas AS t FROM purchases WHERE id = ?`, [payFor]);
        const total2 = Number(payInfo?.t ?? 0);
        const linesSum = payLines.reduce((s, l) => s + toHalalas(l.amount), 0);
        // النقد المطلوب: الطرق النقدية ناقص ما يعيده عكس سدادٍ نقدي سابق · كفاية النقد (قرار المالك ٢٠٢٦-١٠-٠٥)
        const cashNeed = payLines.filter((l) => l.method === 'cash').reduce((s, l) => s + toHalalas(l.amount), 0)
          - priorPaymentCashOut(db, payFor);
        const cashOk = cashShortfall(db, cashNeed) <= 0;
        const doPay = () => {
          try {
            withCostCenter(payCc, () => payPurchaseSplit(db, payFor,
              payLines.map((l) => ({ method: l.method, bankId: l.bankId || null, amountHalalas: toHalalas(l.amount) })),
              payDate));
            setPayFor(null); bump(); toast('تم حفظ بيانات السداد بنجاح');
          } catch (e) {
            reportFailure({ title: 'تعذّر السداد', e });
          }
        };
        const askConfirm = () => {
          const src = payLines.filter((l) => toHalalas(l.amount) > 0).map((l) => {
            const label = l.method === 'cash' ? 'نقداً' : l.method === 'bank' ? 'تحويل بنكي' : l.method === 'cheque' ? 'شيك' : 'بطاقة';
            const bankName = l.method !== 'cash' ? banks.find((b) => b.id === l.bankId)?.name ?? '' : '';
            return label + (bankName ? ' (' + bankName + ')' : '');
          }).join(' + ');
          // ما غاب من البنود غاب بعنوانه · لا «لا يوجد»
          dialog({
            title: 'تأكيد سداد الفاتورة',
            body: [
              payInfo?.supplier_name ? 'المورد: ' + payInfo.supplier_name : '',
              payInfo?.no ? 'الفاتورة: ' + payInfo.no : '',
              'المبلغ: ' + fmt(linesSum) + ' ريال',
              src ? 'المصدر: ' + src : '',
              'التاريخ: ' + dfmt(payDate),
            ].filter(Boolean).join('\n'),
            actions: [
              { label: 'رجوع', variant: 'ghost' },
              { label: 'تأكيد التسجيل', variant: 'primary', onPress: doPay },
            ],
          });
        };
        return (
        <Sheet visible onClose={() => setPayFor(null)} title="تسديد الفاتورة" tall
          footer={
            <>
              {/* المجموع لا يساوي الإجمالي فلا سداد · الزر لا يُعرض بدل أن يُعرض معطَّلاً،
                  والفارق ظاهر في شريط المجموع أسفل النافذة */}
              {linesSum === total2 && cashOk ? (
                <View style={{ flex: 1 }}><BtnPrimary title="تأكيد السداد" onPress={askConfirm} /></View>
              ) : null}
            </>
          }>
          <DateField label="تاريخ السداد" value={payDate} onChange={setPayDate} />
          <CostCenterField value={payCc} onChange={setPayCc} />
          <CashShortNote needed={cashNeed} what="سداد الفاتورة نقداً" />
          {payLines.map((l, i) => (
            <View key={i} style={{ borderWidth: 1, borderColor: C.line, borderRadius: 9, padding: 9, marginBottom: 8 }}>
              <SelectField label="الطريقة" value={l.method}
                options={[
                  { value: 'cash', icon: 'cash', label: 'نقداً' },
                  { value: 'bank', icon: 'bank', label: 'تحويل بنكي' },
                  { value: 'cheque', icon: 'invoice', label: 'شيك' },
                  { value: 'card', icon: 'card', label: 'بطاقة (مدى/ائتمانية)' },
                ]}
                onPick={(v) => setPayLines((p) => p.map((x, xi) => (xi === i ? { ...x, method: v } : x)))} />
              {l.method !== 'cash' && (
                <SelectField label="الحساب البنكي المسدَّد منه" value={l.bankId}
                  options={banks.map((b) => ({ value: b.id, label: b.name }))}
                  onPick={(v) => setPayLines((p) => p.map((x, xi) => (xi === i ? { ...x, bankId: v } : x)))}
                  placeholder="أضف حساباً بنكياً أولاً" />
              )}
              <Field label="المبلغ" value={l.amount} keyboard="numeric" ltr
                onChange={(v) => setPayLines((p) => p.map((x, xi) => (xi === i ? { ...x, amount: v } : x)))} />
              {payLines.length > 1 && (
                <BtnGhost small danger icon="trash" title="حذف الطريقة"
                  onPress={() => setPayLines((p) => p.filter((_, xi) => xi !== i))} />
              )}
            </View>
          ))}
          <BtnGhost small title="+ إضافة طريقة سداد أخرى (دفع بأكثر من طريقة)"
            onPress={() => setPayLines((p) => [...p, { method: 'cash', bankId: banks[0]?.id ?? '', amount: '' }])} />
          <View style={{
            marginTop: 10, borderRadius: 8, padding: 11, alignItems: 'center',
            backgroundColor: linesSum === total2 ? C.emeraldSoft : C.roseSoft,
          }}>
            <Num size={12.5} bold color={linesSum === total2 ? C.emerald : C.rose}>
              {fmt(linesSum)} / {fmt(total2)}
            </Num>
          </View>
        </Sheet>
        );
      })()}
    </Screen>
  );
}

/**
 * ورقة عرض فاتورة الشراء الشاملة: المورد ورقمه الضريبي، الأرقام الثلاثة، الوضع الضريبي
 * وسببه، العدّاد وقراءته، السداد ومصدره، القيود بسطورها داخل الورقة، والمرفقات ·
 * زر «تعديل» يغلقها ويفتح نموذج التعديل القائم · والمسدَّدة لا «تعديل بيانات سداد» لها.
 */
function PurchaseDetailSheet({ purchaseId, onClose, onEdit }: {
  purchaseId: string;
  onClose: () => void;
  onEdit: (id: string) => void;
}) {
  const { db, version } = useApp();
  const canManage = usePerm('purchases').manage;
  // القيود من الدفتر · لمن يرى الدفتر وحده (الحد اللازم)
  const seesLedger = usePerm('ledger').view;
  const [entryFor, setEntryFor] = useState<string | null>(null);

  const data = useMemo(() => {
    const p = db.get<{
      id: string; no: string; supplier_name: string; supplier_vatno: string; date: string; due: string;
      category: string; subtotal_halalas: number; tax_halalas: number; total_halalas: number;
      exempt: number; tax_status: string; exclude_reason: string; refund_status: string;
      paid: number; paid_date: string | null; payment_method: string | null; payment_bank_id: string | null;
      journal_entry_id: string | null; payment_journal_entry_id: string | null;
      meter_id: string | null; meter_reading: number | null;
    }>(`SELECT * FROM purchases WHERE id = ?`, [purchaseId]);
    if (!p) return null;
    const sup = db.get<{ vat: string }>(
      `SELECT vat FROM suppliers WHERE name = ? AND deleted_at IS NULL`, [p.supplier_name]);
    const meter = p.meter_id
      ? db.get<{ kind: string; number: string }>(`SELECT kind, number FROM meters WHERE id = ?`, [p.meter_id])
      : undefined;
    const bank = p.payment_bank_id
      ? db.get<{ name: string }>(`SELECT name FROM banks WHERE id = ?`, [p.payment_bank_id])
      : undefined;
    const je = p.journal_entry_id
      ? db.get<{ id: string; no: string }>(`SELECT id, no FROM journal_entries WHERE id = ?`, [p.journal_entry_id])
      : undefined;
    const payJe = p.payment_journal_entry_id
      ? db.get<{ id: string; no: string }>(`SELECT id, no FROM journal_entries WHERE id = ?`, [p.payment_journal_entry_id])
      : undefined;
    const attCount = Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM attachments WHERE entity_type = 'purchase' AND entity_id = ? AND deleted_at IS NULL`,
      [purchaseId])?.n ?? 0);
    return { p, supplierVat: (p.supplier_vatno || sup?.vat || '').trim(), meter, bank, je, payJe, attCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, purchaseId]);

  // القيد بسطوره داخل الورقة نفسها · نمط عرض القيد في تفاصيل القسط
  const entry = useMemo(() => {
    if (!entryFor) return null;
    const e = db.get<{ id: string; no: string; date: string; memo: string }>(
      `SELECT id, no, date, memo FROM journal_entries WHERE id = ?`, [entryFor]);
    if (!e) return null;
    const lines = db.all<{ account_code: string; name: string; debit_halalas: number; credit_halalas: number }>(
      `SELECT l.account_code, a.name, l.debit_halalas, l.credit_halalas
       FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE l.entry_id = ?`, [entryFor]);
    return { ...e, lines };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, entryFor]);

  if (!data) return null;
  const { p, supplierVat, meter, bank, je, payJe, attCount } = data;
  const paid = Number(p.paid);
  /** خانة تفاصيل · الفارغة لا تظهر هي ولا عنوانها · والصفر قيمة تُعرض */
  // الخانة الواحدة لكل بطاقة تفاصيل · تغيب بعنوانها إن غابت قيمتها
  const cell = (label: string, v: React.ReactNode) => <KV label={label} v={v} flex />;
  return (
    <Sheet visible onClose={onClose} title={'فاتورة شراء ' + p.no} tall>
      {/* المسدَّدة لا يُعرض لها «تعديل» · التصحيح بالتراجع عن السداد ثم التعديل */}
      <Row style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        {statusBadge({ paid, due: p.due })}
        {paid || !canManage ? null : <BtnGhost small icon="edit" title="تعديل" onPress={() => { onClose(); onEdit(p.id); }} />}
      </Row>
      <Row style={{ marginBottom: 8 }}>
        {cell('المورد', <T size={12.5} bold>{p.supplier_name}</T>)}
        {cell('الرقم الضريبي للمورد', supplierVat ? <Num size={12.5} bold>{supplierVat}</Num> : null)}
      </Row>
      <Row style={{ marginBottom: 8 }}>
        {cell('رقم الفاتورة', <Num size={12.5} bold>{p.no}</Num>)}
        {cell('الفئة', p.category ? <T size={12.5}>{p.category}</T> : null)}
      </Row>
      <Row style={{ marginBottom: 8 }}>
        {cell('تاريخ الفاتورة', <Num size={12.5} bold>{dfmt(p.date)}</Num>)}
        {cell('تاريخ الاستحقاق', p.due ? <Num size={12.5} bold>{dfmt(p.due)}</Num> : null)}
      </Row>
      <Row style={{ marginBottom: 8 }}>
        {cell('قبل الضريبة', <Money halalas={Number(p.subtotal_halalas)} size={12.5} bold />)}
        {cell('الضريبة', Number(p.exempt) ? <T size={12.5}>معفاة</T> : <Money halalas={Number(p.tax_halalas)} size={12.5} bold />)}
        {cell('الإجمالي', <Money halalas={Number(p.total_halalas)} size={12.5} bold />)}
      </Row>
      <View style={{ backgroundColor: C.paper, borderRadius: 8, padding: 10, marginBottom: 8 }}>
        <T size={10.5} color={C.muted}>الوضع الضريبي</T>
        <T size={12.5} bold>{p.tax_status || (Number(p.exempt) ? TS_EXEMPT : TS_EXCLUDED)}</T>
        {p.exclude_reason ? (
          <T size={11.5} color={C.muted} style={{ marginTop: 3 }}>سبب الاستبعاد: {p.exclude_reason}</T>
        ) : null}
      </View>
      {meter ? (
        <Row style={{ marginBottom: 8 }}>
          {cell('العدّاد المرتبط', <T size={12.5} bold>{'عداد ' + meter.kind + ' رقم ' + meter.number}</T>)}
          {cell('القراءة المسجَّلة في الفاتورة',
            p.meter_reading != null ? <Num size={12.5} bold>{String(p.meter_reading)}</Num> : null)}
        </Row>
      ) : null}
      <View style={{ backgroundColor: paid ? C.emeraldSoft : C.paper, borderRadius: 8, padding: 10, marginBottom: 8 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T size={12.5} bold color={paid ? C.emerald : C.charcoal}>{paid ? 'مسدَّدة' : 'غير مسدَّدة'}</T>
          {paid && p.paid_date ? <Num size={11.5} color={C.muted}>{dfmt(p.paid_date)}</Num> : null}
        </Row>
        {paid ? (
          <T size={11.5} color={C.muted} style={{ marginTop: 3 }}>
            المصدر: {(p.payment_method || '') + (bank ? (p.payment_method ? ' · ' : '') + bank.name : '')}
          </T>
        ) : null}
      </View>
      {je && seesLedger ? (
        <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <Row gap={6}>
            <T size={12} color={C.muted}>قيد التسجيل</T>
            <Num size={12} bold>{je.no}</Num>
          </Row>
          <BtnGhost small title="عرض القيد" onPress={() => setEntryFor((c) => (c === je.id ? null : je.id))} />
        </Row>
      ) : null}
      {payJe && seesLedger ? (
        <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <Row gap={6}>
            <T size={12} color={C.muted}>قيد السداد</T>
            <Num size={12} bold>{payJe.no}</Num>
          </Row>
          <BtnGhost small title="عرض القيد" onPress={() => setEntryFor((c) => (c === payJe.id ? null : payJe.id))} />
        </Row>
      ) : null}
      {entry ? (
        <View style={{ backgroundColor: C.paper, borderRadius: 10, padding: 12, marginTop: 4, marginBottom: 8, borderWidth: 1, borderColor: C.line }}>
          <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <T size={TYPE.cardTitle} bold>{entry.no} · {dfmt(entry.date)}</T>
            <BtnIcon icon="x" accessibilityLabel="إغلاق القيد" onPress={() => setEntryFor(null)} />
          </Row>
          <T size={11.5} color={C.muted} style={{ marginBottom: 6 }}>{entry.memo}</T>
          {entry.lines.map((l, li) => (
            <Row key={li} style={{ justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <T size={11.5} style={{ flex: 1 }}>{l.account_code} · {l.name}</T>
              <Num size={11.5}>{Number(l.debit_halalas) ? 'مدين ' + fmt(Number(l.debit_halalas)) : 'دائن ' + fmt(Number(l.credit_halalas))}</Num>
            </Row>
          ))}
        </View>
      ) : null}
      {attCount ? (
        <AttachStrip section="purchases" entityType="purchase" entityId={p.id} kind="purchase"
          linked={'فاتورة شراء ' + p.no} title="المرفقات" hideAdd />
      ) : null}
      <View style={{ height: 12 }} />
    </Sheet>
  );
}

function CheckRow({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <Pressable onPress={onToggle} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, minHeight: 44 }}>
      <View style={{
        width: 22, height: 22, borderRadius: 5, borderWidth: 2,
        borderColor: checked ? C.emerald : C.line, backgroundColor: checked ? C.emerald : '#fff',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {checked ? <Icon name="check" size={14} color="#fff" /> : null}
      </View>
      <T size={12} style={{ flex: 1 }}>{label}</T>
    </Pressable>
  );
}

/** الفواتير · الإنشاء والإصدار والمسودات وتغيير الحالة والطباعة */
import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { CashShortNote, OwnerCashInSheet } from '../src/ui/CashGate';
import { cashShortfall } from '../src/domain/cashGuard';
import { useLocalSearchParams } from 'expo-router';
import { View, FlatList, Pressable } from 'react-native';
import { Screen } from '../src/ui/Screen';
import {
  Card, T, Num, Money, EmptyState, Row, Badge, SearchBox, BtnPrimary, BtnGhost, Field, ChipGroup,
  KV,
} from '../src/ui/components';
import { Sheet, SelectField } from '../src/ui/Sheet';
import { DateField } from '../src/ui/DateField';
import { ActionMenuButton } from '../src/ui/ActionMenu';
import { FilterBar, FilterSheet, useFilterSheet, type ActiveChip } from '../src/ui/FilterSheet';
import { useDialog } from '../src/ui/AppDialog';
import { usePager, Pager } from '../src/ui/Pager';
import { useDeferredReady } from '../src/ui/useDeferredReady';
import { Skeleton } from '../src/ui/Skeleton';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { C, TYPE } from '../src/ui/theme';
import { payInvoice, deleteInvoice, invoiceTotals, collectionCashOut, invoiceNoLabel, type InvoiceLineInput, type InvoicePayMethod } from '../src/domain/invoices';
import { isIssuePending } from '../src/domain/invoiceIssue';
import { saveInvoiceNow, setInvoiceStatusNow } from '../src/services/cloud';
import { today, dfmt, addDays } from '../src/domain/dates';
import { fmt, toHalalas } from '../src/domain/money';
import { printInvoice } from '../src/services/print';
import { reportFailure } from '../src/ui/failureDialog';
import { usePerm } from '../src/ui/access';
import { rowBy } from '../src/services/access';

import { CostCenterField } from '../src/ui/CostCenters';
import { GENERAL_COST_CENTER, withCostCenter } from '../src/domain/accounting/dimensions';
const STATUS_MAP: Record<string, string> = { 'مدفوعة': 'paid', 'مستحقة': 'due', 'متأخرة': 'overdue', 'مسودة': 'draft' };

const ALL_STATUSES = ['مسودة', 'مستحقة', 'مدفوعة', 'متأخرة'] as const;
const STATUS_CHIPS: Array<[string, string]> = [['', 'الكل'], ...ALL_STATUSES.map((s): [string, string] => [s, s])];

/** الفترة تُحسب في SQL من تاريخ الإصدار نفسه */
const PERIOD_LABELS: Record<string, string> = { month: 'هذا الشهر', '90': 'آخر 90 يوماً', year: 'هذه السنة' };
const PERIOD_SQL: Record<string, string> = {
  month: `strftime('%Y-%m', issue) = strftime('%Y-%m','now','localtime')`,
  '90': `issue >= date('now','localtime','-90 day')`,
  year: `strftime('%Y', issue) = strftime('%Y','now','localtime')`,
};
const PERIOD_OPTIONS = [{ value: '', label: 'كل الفترات' },
  ...Object.entries(PERIOD_LABELS).map(([value, label]) => ({ value, label }))];

interface LineState { descr: string; qty: string; price: string; tax: string }

interface InvoiceRow {
  id: string; no: string; customer_name: string; issue: string; due: string; status: string; total_halalas: number;
}

const EMPTY_PAGE: { rows: InvoiceRow[]; total: number } = { rows: [], total: 0 };

/** بطاقة فاتورة واحدة · خارج الشاشة ومحفوظة كي لا يُعاد رسمها بلا داعٍ ·
 * الضغط عليها يفتح ورقة العرض لا التعديل · والمدفوعة لا زر تعديل لها (التصحيح بتغيير الحالة) */
const InvoiceCard = React.memo(function InvoiceCard({
  id, no, pending, customerName, issue, due, status, totalHalalas, canEdit, canManage, onView, onEdit, onStatus, onPrint, onDelete,
}: {
  id: string; no: string; customerName: string; issue: string; due: string; status: string; totalHalalas: number;
  /** طُلب إصدارها بلا اتصال · تصدر برقمها عند عودته */
  pending: boolean;
  /** كامل، أو مسودة كاتبها بإدخال · للتعديل والحذف */
  canEdit: boolean;
  /** كامل · لتغيير الحالة */
  canManage: boolean;
  onView: (id: string) => void; onEdit: (id: string) => void; onStatus: (id: string) => void;
  onPrint: (id: string) => void; onDelete: (id: string) => void;
}) {
  return (
    <Pressable onPress={() => onView(id)}>
      <Card style={{ paddingVertical: 10 }}>
        {/* زر ⋮ أعلى البطاقة يساراً بمحاذاة العنوان ·
            المدفوعة لا «تعديل» لها (التصحيح بتغيير الحالة) والمسودة لا «طباعة» لها (لم تُصدَر بعد) */}
        <Row style={{ justifyContent: 'space-between' }}>
          <T size={TYPE.sectionTitle} bold style={{ flex: 1 }}>{customerName}</T>
          <Row gap={8}>
            <Badge kind={STATUS_MAP[status] || 'draft'} label={status} />
            <ActionMenuButton title={invoiceNoLabel(no)} actions={[
              { icon: 'eye', label: 'عرض الفاتورة', onPress: () => onView(id) },
              status !== 'مدفوعة' && canEdit ? { icon: 'edit', label: 'تعديل الفاتورة', onPress: () => onEdit(id) } : null,
              canManage ? { icon: 'swap', label: 'تغيير الحالة', onPress: () => onStatus(id) } : null,
              status !== 'مسودة' ? { icon: 'print', label: 'طباعة / PDF', onPress: () => onPrint(id) } : null,
              canEdit ? { icon: 'trash', label: 'حذف', danger: true, onPress: () => onDelete(id) } : null,
            ]} />
          </Row>
        </Row>
        <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
          <Num size={TYPE.caption} color={C.muted}>{invoiceNoLabel(no) + (pending ? ' · تصدر عند عودة الاتصال' : '')} · {dfmt(issue)} إلى {dfmt(due)}</Num>
          <Money halalas={totalHalalas} size={TYPE.number} bold />
        </Row>
      </Card>
    </Pressable>
  );
});

export default function Invoices() {
  const { db, version, bump } = useApp();
  const perm = usePerm('invoices');
  const toast = useToast();
  const dialog = useDialog();
  const ready = useDeferredReady();
  const pager = usePager('invoices');
  const fsheet = useFilterSheet();
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fPeriod, setFPeriod] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [customer, setCustomer] = useState('');
  const [issue, setIssue] = useState(today());
  const [due, setDue] = useState(addDays(today(), 30));
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineState[]>([{ descr: '', qty: '1', price: '', tax: '15' }]);
  const [statusFor, setStatusFor] = useState<string | null>(null);
  const [depositFor, setDepositFor] = useState<number | null>(null);
  const canDeposit = usePerm('banks').add;
  // التحصيل (المراجعة ٤.٢): «مدفوعة» لا تُختار حالةً وحدها، بل بتحصيلٍ بتاريخه وطريقته يرحّل قيده
  const [collecting, setCollecting] = useState(false);
  const [payDate, setPayDate] = useState(today());
  const [payMethod, setPayMethod] = useState<InvoicePayMethod>('cash');
  const [payBank, setPayBank] = useState('');
  const banks = useMemo(
    () => db.all<{ id: string; name: string }>(`SELECT id, name FROM banks WHERE deleted_at IS NULL AND archived = 0 ORDER BY created_at`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, statusFor]
  );
  const [viewFor, setViewFor] = useState<string | null>(null);

  // البحث أو المرشِّحات تعيد الصفحة للأولى
  useEffect(() => {
    pager.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, fStatus, fPeriod]);

  const filter = useMemo(() => {
    const needle = q.trim();
    const where: string[] = ['deleted_at IS NULL'];
    const args: Array<string | number> = [];
    if (fStatus) { where.push('status = ?'); args.push(fStatus); }
    if (fPeriod && PERIOD_SQL[fPeriod]) where.push(PERIOD_SQL[fPeriod]);
    if (needle) {
      where.push(`(customer_name LIKE '%'||?||'%' OR no LIKE '%'||?||'%')`);
      args.push(needle, needle);
    }
    return { sql: where.join(' AND '), args };
  }, [q, fStatus, fPeriod]);

  const { rows, total } = useMemo(() => {
    if (!ready) return EMPTY_PAGE;
    const cnt = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM invoices WHERE ${filter.sql}`, filter.args)?.n ?? 0);
    const page = db.all<InvoiceRow>(
      `SELECT id, no, customer_name, issue, due, status, total_halalas FROM invoices
       WHERE ${filter.sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...filter.args, pager.limit, pager.offset]
    );
    return { rows: page, total: cnt };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, filter, ready, pager.limit, pager.offset]);

  // العدد الكلي قبل التصفية · لسطر «24 من 60»
  const totalAll = useMemo(() => {
    if (!ready) return 0;
    return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM invoices WHERE deleted_at IS NULL`)?.n ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready]);

  const tenants = useMemo(
    () => db.all<{ name: string; vat: string }>(`SELECT name, vat FROM tenants WHERE archived = 0 AND deleted_at IS NULL ORDER BY name`),
    [db, version]
  );
  // الضريبة تُعرض حين تكون مفعّلة في بيانات المنشأة وحدها · لا خيار ١٥٪ والضريبة مقفلة
  const vatOn = useMemo(
    () => !!Number(db.get<{ vat_enabled: number }>(`SELECT vat_enabled FROM company WHERE id = 1`)?.vat_enabled ?? 0),
    [db, version]
  );
  const defTax = vatOn ? '15' : '0';

  const openNew = () => {
    setEditingId(null); setCustomer(''); setIssue(today()); setDue(addDays(today(), 30));
    setNotes(''); setLines([{ descr: '', qty: '1', price: '', tax: defTax }]); setFormOpen(true);
  };
  const openEdit = useCallback((id: string) => {
    const v = db.get<{ customer_name: string; issue: string; due: string; notes: string }>(
      `SELECT customer_name, issue, due, notes FROM invoices WHERE id = ?`, [id]
    );
    if (!v) return;
    const ls = db.all<{ descr: string; qty: number; price_halalas: number; tax_pct: number }>(
      `SELECT descr, qty, price_halalas, tax_pct FROM invoice_lines WHERE invoice_id = ? ORDER BY sort`, [id]
    );
    setEditingId(id); setCustomer(v.customer_name); setIssue(v.issue); setDue(v.due); setNotes(v.notes);
    setLines(ls.length ? ls.map((l) => ({
      descr: l.descr, qty: String(l.qty), price: fmt(Number(l.price_halalas)).replace(/,/g, ''), tax: String(l.tax_pct),
    })) : [{ descr: '', qty: '1', price: '', tax: defTax }]);
    setFormOpen(true);
  }, [db, defTax]);

  // القدوم من الدفتر: ?detail=<id> يفتح ورقة عرض المستند نفسه لا القائمة
  const params = useLocalSearchParams<{ detail?: string }>();
  useEffect(() => {
    if (params.detail) setViewFor(String(params.detail));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.detail]);

  const onView = useCallback((id: string) => setViewFor(id), []);
  const onStatus = useCallback((id: string) => setStatusFor(id), []);
  const onPrint = useCallback((id: string) => {
    printInvoice(db, id).catch(() => toast('تعذّرت الطباعة'));
  }, [db, toast]);
  const onDelete = useCallback((id: string) => {
    // تحصيلٌ نقدي يُعكس بالحذف فيخرج من المحفظة · كفاية النقد (قرار المالك ٢٠٢٦-١٠-٠٥)
    const out = collectionCashOut(db, id);
    const short = cashShortfall(db, out);
    dialog({
      title: 'حذف الفاتورة',
      body: 'حذف هذه الفاتورة؟ سيُعكَس أثرها المحاسبي إن وُجد.'
        + (short > 0 ? '\nالنقد في المحفظة لا يكفي لعكس تحصيلها (' + fmt(out) + ') · ينقصه ' + fmt(short) : ''),
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        ...(short > 0
          ? (canDeposit ? [{ label: 'إيداع المالك · ' + fmt(short), variant: 'primary' as const, onPress: () => setDepositFor(short) }] : [])
          : [{ label: 'حذف', variant: 'danger' as const, onPress: () => {
            try { deleteInvoice(db, id); bump(); toast('تم الحذف · يمكن استعادته من الإعدادات'); }
            catch (e) { reportFailure({ title: 'تعذّر الحذف', e }); }
          } }]),
      ],
    });
  }, [db, bump, toast, dialog, canDeposit]);

  // المسودة يعدّلها ويحذفها كاتبها بإدخال · وما سواها كامل (وكامل لا يحتاج كاتب الصف)
  const mayEdit = useCallback(
    (id: string, status: string) =>
      perm.manage || perm.edit({ by: rowBy(db, 'invoices', id), draft: status === 'مسودة' }),
    [db, perm]
  );

  const keyExtractor = useCallback((it: InvoiceRow) => it.id, []);
  const renderItem = useCallback(({ item }: { item: InvoiceRow }) => (
    <InvoiceCard id={item.id} no={item.no} pending={isIssuePending(db, item.id)} customerName={item.customer_name} issue={item.issue}
      due={item.due} status={item.status} totalHalalas={Number(item.total_halalas)}
      canEdit={mayEdit(item.id, item.status)} canManage={perm.manage}
      onView={onView} onEdit={openEdit} onStatus={onStatus} onPrint={onPrint} onDelete={onDelete} />
  ), [onView, openEdit, onStatus, onPrint, onDelete, mayEdit, perm.manage]);

  const toInputs = (): InvoiceLineInput[] =>
    lines.map((l) => ({ descr: l.descr, qty: parseFloat(l.qty) || 0, priceHalalas: toHalalas(l.price), taxPct: parseFloat(l.tax) || 0 }));

  // الإصدار يأخذ رقم الفاتورة من عدّاد السحابة · وبلا اتصال تُحفظ مسودةً تصدر برقمها عند عودته
  const [cc, setCc] = useState(GENERAL_COST_CENTER);
  const [payCc, setPayCc] = useState(GENERAL_COST_CENTER);
  const doSave = (...a: Parameters<typeof doSaveIn>) => withCostCenter(cc, () => doSaveIn(...a));
  const doSaveIn = async (status: 'مسودة' | 'مستحقة') => {
    try {
      const cust = tenants.find((t) => t.name === customer.trim());
      const r = await saveInvoiceNow(db, {
        customer: customer.trim(), customerVat: cust?.vat ?? '', issue, due, notes, lines: toInputs(),
      }, status, editingId ?? undefined);
      setFormOpen(false); bump();
      toast(r.pending ? 'لا اتصال · حُفظت مسودة وتصدر برقمها عند عودة الاتصال'
        : status === 'مسودة' ? 'تم حفظ الفاتورة كمسودة' : 'تم إصدار الفاتورة وترحيلها محاسبياً');
    } catch (e) { reportFailure({ title: 'تعذّر الحفظ', e }); }
  };

  const totals = invoiceTotals(toInputs());

  const clearFilters = useCallback(() => { setQ(''); setFStatus(''); setFPeriod(''); }, []);
  const chips: ActiveChip[] = [
    ...(fStatus ? [{ key: 'status', label: fStatus, onClear: () => setFStatus('') }] : []),
    ...(fPeriod ? [{ key: 'period', label: PERIOD_LABELS[fPeriod] ?? fPeriod, onClear: () => setFPeriod('') }] : []),
  ];

  // حالة الفاتورة التي تُغيَّر حالتها · الحالة القائمة لا يُعرض لها زر (تغييرها إليها لا يصح)
  const statusRow = statusFor
    ? db.get<{ status: string; pj: string | null }>(`SELECT status, payment_journal_entry_id AS pj FROM invoices WHERE id = ?`, [statusFor])
    : undefined;
  const statusNow = statusRow?.status ?? '';
  // «مدفوعة» من نسخة سابقة بلا قيد تحصيل (المراجعة ٤.٢): يُعرض لها «تسجيل التحصيل» ليقيّدها المالك بتاريخها وطريقته
  const legacyPaid = statusNow === 'مدفوعة' && !statusRow?.pj;
  const legacyCount = useMemo(
    () => Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM invoices WHERE deleted_at IS NULL AND status = 'مدفوعة' AND payment_journal_entry_id IS NULL`)?.n ?? 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]
  );

  return (
    <Screen title="الفواتير" icon="invoice" scroll={false}
      actions={perm.add ? <BtnPrimary small title="+ فاتورة جديدة" onPress={openNew} /> : undefined}>
      {!ready ? <Skeleton /> : (
        <FlatList
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          ListHeaderComponent={
            <>
              <FilterBar chips={chips} onOpen={fsheet.show} onClearAll={clearFilters}
                resultCount={total} total={totalAll} filtered={total} itemName="فاتورة"
                search={<SearchBox value={q} onChange={setQ} />} />
              {legacyCount > 0 && perm.manage ? (
                <Card style={{ borderColor: C.gold, borderWidth: 1 }}>
                  <T size={12.5} bold>{legacyCount} فاتورة «مدفوعة» بلا قيد تحصيل</T>
                  <T size={12} color={C.muted}>
                    سُجّلت مدفوعةً في نسخة سابقة دون قيد، فبقيت في ذمم العملاء. افتح كلاً منها ثم «تغيير الحالة» ← «تسجيل التحصيل» بتاريخه وطريقته.
                  </T>
                </Card>
              ) : null}
            </>
          }
          ListFooterComponent={<Pager pager={pager} total={total} />}
          ListEmptyComponent={<Card><EmptyState>لا توجد فواتير مطابقة</EmptyState></Card>}
        />
      )}

      <FilterSheet open={fsheet.open} onClose={fsheet.hide} onClearAll={clearFilters} resultCount={total}>
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 5 }}>الحالة</T>
        <View style={{ marginBottom: 10 }}>
          <ChipGroup options={STATUS_CHIPS} value={fStatus} onChange={setFStatus} />
        </View>
        <SelectField label="الفترة" value={fPeriod} options={PERIOD_OPTIONS} onPick={setFPeriod} />
      </FilterSheet>

      {/* نافذة إنشاء/تعديل */}
      <Sheet visible={formOpen} onClose={() => setFormOpen(false)}
        title={editingId ? 'تعديل الفاتورة' : 'إنشاء فاتورة'} tall
        footer={
          <>
            <View style={{ flex: 1 }}><BtnGhost title="حفظ كمسودة" onPress={() => doSave('مسودة')} /></View>
            {/* الإصدار يرحّل محاسبياً · كامل وحده */}
            {perm.manage ? <View style={{ flex: 1 }}><BtnPrimary title="إصدار الفاتورة" onPress={() => doSave('مستحقة')} /></View> : null}
          </>
        }>
        <Field label="العميل" value={customer} onChange={setCustomer} />
        {tenants.length && !editingId ? (
          <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
            {tenants.slice(0, 8).map((t) => (
              <BtnGhost key={t.name} small title={t.name} onPress={() => setCustomer(t.name)} />
            ))}
          </Row>
        ) : null}
        <Row>
          <View style={{ flex: 1 }}><DateField label="تاريخ الإصدار" value={issue} onChange={setIssue} /></View>
          <View style={{ flex: 1 }}><DateField label="تاريخ الاستحقاق" value={due} onChange={setDue} /></View>
        </Row>
        <CostCenterField value={cc} onChange={setCc} />
        <T size={13} bold color={C.ink} style={{ marginVertical: 8 }}>بنود الفاتورة</T>
        {lines.map((l, i) => (
          <View key={i} style={{ borderWidth: 1, borderColor: C.line, borderRadius: 9, padding: 9, marginBottom: 8 }}>
            <Field label="الوصف" value={l.descr}
              onChange={(v) => setLines((p) => p.map((x, xi) => (xi === i ? { ...x, descr: v } : x)))} />
            <Row>
              <View style={{ flex: 1 }}>
                <Field label="الكمية" value={l.qty} keyboard="numeric" ltr
                  onChange={(v) => setLines((p) => p.map((x, xi) => (xi === i ? { ...x, qty: v } : x)))} />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="السعر" value={l.price} keyboard="numeric" ltr
                  onChange={(v) => setLines((p) => p.map((x, xi) => (xi === i ? { ...x, price: v } : x)))} />
              </View>
              <View style={{ flex: 1 }}>
                <SelectField label="الضريبة" value={l.tax}
                  options={vatOn
                    ? [{ value: '15', label: '15٪' }, { value: '0', label: '0٪ (معفى)' }]
                    : [{ value: '0', label: '0٪ (معفى)' }]}
                  onPick={(v) => setLines((p) => p.map((x, xi) => (xi === i ? { ...x, tax: v } : x)))} />
              </View>
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Num size={12} bold>الإجمالي: {fmt(Math.round((parseFloat(l.qty) || 0) * toHalalas(l.price)))}</Num>
              {lines.length > 1 && (
                <BtnGhost small danger icon="trash" title="حذف البند"
                  onPress={() => setLines((p) => p.filter((_, xi) => xi !== i))} />
              )}
            </Row>
          </View>
        ))}
        <BtnGhost small title="+ إضافة بند جديد"
          onPress={() => setLines((p) => [...p, { descr: '', qty: '1', price: '', tax: defTax }])} />
        <View style={{ backgroundColor: C.ink, borderRadius: 10, padding: 14, marginTop: 12, marginBottom: 10 }}>
          <Row style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
            <T size={12.5} color="#B6BFD6">المجموع الفرعي</T>
            <Num size={12.5} color="#fff">{fmt(totals.subtotal)}</Num>
          </Row>
          <Row style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
            <T size={12.5} color="#B6BFD6">ضريبة القيمة المضافة</T>
            <Num size={12.5} color="#fff">{fmt(totals.tax)}</Num>
          </Row>
          <Row style={{ justifyContent: 'space-between', paddingTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.15)' }}>
            <T size={14} bold color="#fff">الإجمالي المستحق</T>
            <Money halalas={totals.total} size={14} bold color={C.gold} />
          </Row>
        </View>
        <Field label="ملاحظات" value={notes} onChange={setNotes} multiline />
      </Sheet>

      {/* تغيير الحالة */}
      {statusFor && perm.manage && !collecting && (
        <Sheet visible onClose={() => setStatusFor(null)} title="تغيير حالة الفاتورة">
          {/* الرجوع عن «مدفوعة» يعكس تحصيلاً نقدياً فيخرج من المحفظة · لا يظهر حين لا يكفي النقد */}
          {statusNow === 'مدفوعة' && !legacyPaid ? <CashShortNote needed={collectionCashOut(db, statusFor)} what="عكس تحصيل الفاتورة" /> : null}
          {/* المسودة لا تُحصَّل فلا يظهر لها «تسجيل التحصيل» */}
          {ALL_STATUSES.filter((s) => (s !== statusNow || legacyPaid) && !(s === 'مدفوعة' && statusNow === 'مسودة'))
            .filter((s) => s === 'مدفوعة' || statusNow !== 'مدفوعة' || legacyPaid || cashShortfall(db, collectionCashOut(db, statusFor)) <= 0).map((s) => (
            <View key={s} style={{ marginBottom: 8 }}>
              <BtnGhost
                title={s === 'مدفوعة' ? 'مدفوعة · تسجيل التحصيل'
                  : (s === 'مسودة' ? 'مسودة (بدون ترحيل محاسبي)' : s) + (statusNow === 'مدفوعة' && !legacyPaid ? ' · يعكس قيد التحصيل' : '')}
                onPress={() => {
                  if (s === 'مدفوعة') {
                    setPayDate(today());
                    setPayMethod(banks.length ? 'bank' : 'cash');
                    setPayBank(banks[0]?.id ?? '');
                    setCollecting(true);
                    return;
                  }
                  setInvoiceStatusNow(db, statusFor, s as 'مسودة' | 'مستحقة' | 'متأخرة').then((r) => {
                    setStatusFor(null); bump();
                    toast(r.pending ? 'لا اتصال · تبقى مسودة وتصدر برقمها عند عودة الاتصال' : 'تم تحديث حالة الفاتورة');
                  }).catch((e) => reportFailure({ title: 'تعذّر تغيير الحالة', e }));
                }} />
            </View>
          ))}
        </Sheet>
      )}
      {statusFor && perm.manage && collecting && (
        <Sheet visible onClose={() => setCollecting(false)} title="تسجيل تحصيل الفاتورة"
          footer={
            payMethod === 'cash' || payBank ? (
              <BtnPrimary title="تأكيد التحصيل" onPress={() => {
                try {
                  withCostCenter(payCc, () => payInvoice(db, statusFor, { method: payMethod, bankId: payMethod === 'cash' ? null : payBank, date: payDate }));
                  setCollecting(false); setStatusFor(null); bump(); toast('سُجّل التحصيل ورُحّل قيده');
                } catch (e) { reportFailure({ title: 'تعذّر تسجيل التحصيل', e }); }
              }} />
            ) : undefined
          }>
          <T size={12} color={C.muted} style={{ marginBottom: 10 }}>
            يُرحَّل قيد: مدين النقد أو البنك، دائن ذمم العملاء، بإجمالي الفاتورة.
          </T>
          <DateField label="تاريخ التحصيل" value={payDate} onChange={setPayDate} />
          <CostCenterField value={payCc} onChange={setPayCc} />
          <SelectField label="الطريقة" value={payMethod}
            options={[
              { value: 'cash', icon: 'cash', label: 'نقداً' },
              { value: 'bank', icon: 'bank', label: 'تحويل بنكي' },
              { value: 'cheque', icon: 'invoice', label: 'شيك' },
              { value: 'card', icon: 'card', label: 'بطاقة (مدى/ائتمانية)' },
            ]}
            onPick={(v) => setPayMethod(v as InvoicePayMethod)} />
          {payMethod !== 'cash' && (
            <SelectField label="الحساب البنكي المحصَّل فيه" value={payBank}
              options={banks.map((b) => ({ value: b.id, label: b.name }))}
              onPick={setPayBank}
              placeholder="أضف حساباً بنكياً أولاً" />
          )}
        </Sheet>
      )}

      {depositFor !== null ? <OwnerCashInSheet amountHalalas={depositFor} onClose={() => setDepositFor(null)} /> : null}
      {/* ورقة عرض الفاتورة الكاملة · الضغط على البطاقة يفتحها والتعديل زر داخلها */}
      {viewFor && (
        <InvoiceViewSheet invoiceId={viewFor} onClose={() => setViewFor(null)} onEdit={openEdit} mayEdit={mayEdit} />
      )}
    </Screen>
  );
}

/**
 * ورقة عرض الفاتورة الكاملة: العميل ورقمه الضريبي والتاريخان والحالة وبنودها
 * ومجاميعها وملاحظاتها · زر «تعديل» يغلقها ويفتح نموذج التعديل القائم،
 * والمدفوعة بلا زر تعديل · تصحيحها عبر «تغيير الحالة» القائم.
 */
function InvoiceViewSheet({ invoiceId, onClose, onEdit, mayEdit }: {
  invoiceId: string;
  onClose: () => void;
  onEdit: (id: string) => void;
  mayEdit: (id: string, status: string) => boolean;
}) {
  const { db, version } = useApp();
  const data = useMemo(() => {
    const v = db.get<{
      id: string; no: string; customer_name: string; customer_vat: string; issue: string; due: string;
      status: string; subtotal_halalas: number; tax_halalas: number; total_halalas: number; notes: string;
    }>(`SELECT * FROM invoices WHERE id = ?`, [invoiceId]);
    if (!v) return null;
    const vLines = db.all<{ descr: string; qty: number; price_halalas: number; tax_pct: number }>(
      `SELECT descr, qty, price_halalas, tax_pct FROM invoice_lines WHERE invoice_id = ? ORDER BY sort`, [invoiceId]);
    return { v, vLines };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, invoiceId]);
  if (!data) return null;
  const { v, vLines } = data;
  // الخانة الواحدة لكل بطاقة تفاصيل · تغيب بعنوانها إن غابت قيمتها
  const cell = (label: string, val: React.ReactNode) => <KV label={label} v={val} flex />;
  return (
    <Sheet visible onClose={onClose} title={'فاتورة ' + invoiceNoLabel(v.no)} tall>
      <Row style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <Badge kind={STATUS_MAP[v.status] || 'draft'} label={v.status} />
        {v.status !== 'مدفوعة' && mayEdit(v.id, v.status) ? (
          <BtnGhost small icon="edit" title="تعديل" onPress={() => { onClose(); onEdit(v.id); }} />
        ) : null}
      </Row>
      <Row style={{ marginBottom: 8 }}>
        {cell('العميل', <T size={12.5} bold>{v.customer_name}</T>)}
        {cell('الرقم الضريبي للعميل',
          v.customer_vat ? <Num size={12.5} bold>{v.customer_vat}</Num> : null)}
      </Row>
      <Row style={{ marginBottom: 8 }}>
        {cell('تاريخ الإصدار', <Num size={12.5} bold>{dfmt(v.issue)}</Num>)}
        {cell('تاريخ الاستحقاق', <Num size={12.5} bold>{dfmt(v.due)}</Num>)}
      </Row>
      <T size={13} bold color={C.ink} style={{ marginTop: 4, marginBottom: 6 }}>بنود الفاتورة ({vLines.length})</T>
      {vLines.length ? vLines.map((l, i) => (
        <View key={i} style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
          {l.descr ? <T size={12.5}>{l.descr}</T> : null}
          <Row style={{ justifyContent: 'space-between', marginTop: 3 }}>
            <Num size={11.5} color={C.muted}>{fmt(Number(l.price_halalas))} × {String(l.qty)} · ضريبة {l.tax_pct}٪</Num>
            <Money halalas={Math.round(Number(l.qty) * Number(l.price_halalas))} size={12} bold />
          </Row>
        </View>
      )) : <EmptyState>لا بنود في هذه الفاتورة</EmptyState>}
      <View style={{ backgroundColor: C.paper, borderRadius: 8, padding: 11, marginTop: 10, marginBottom: 8 }}>
        <Row style={{ justifyContent: 'space-between', paddingVertical: 3 }}>
          <T size={12} color={C.muted}>المجموع الفرعي</T>
          <Money halalas={Number(v.subtotal_halalas)} size={12} />
        </Row>
        <Row style={{ justifyContent: 'space-between', paddingVertical: 3 }}>
          <T size={12} color={C.muted}>ضريبة القيمة المضافة</T>
          <Money halalas={Number(v.tax_halalas)} size={12} />
        </Row>
        <Row style={{ justifyContent: 'space-between', paddingTop: 6, borderTopWidth: 1, borderTopColor: C.line }}>
          <T size={13} bold>الإجمالي المستحق</T>
          <Money halalas={Number(v.total_halalas)} size={13} bold />
        </Row>
      </View>
      {v.notes ? (
        <View style={{ marginBottom: 8 }}>
          <T size={10.5} color={C.muted}>ملاحظات</T>
          <T size={12}>{v.notes}</T>
        </View>
      ) : null}
      <View style={{ height: 12 }} />
    </Sheet>
  );
}

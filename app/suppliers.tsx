/** الموردون · بنوع الخدمة (كهرباء/ماء) وعداداتهم وسجل فواتيرهم */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Pressable, FlatList, type ListRenderItem } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen } from '../src/ui/Screen';
import {
  Card, T, Num, Money, EmptyState, Row, Badge, SearchBox, BtnPrimary, BtnGhost, BtnIcon, Field,
} from '../src/ui/components';
import { Icon, type IconName } from '../src/ui/icons';
import { Sheet, SelectField } from '../src/ui/Sheet';
import { ActionMenuButton } from '../src/ui/ActionMenu';
import { CollapsibleSection } from '../src/ui/Collapsible';
import { FilterBar, FilterSheet, useFilterSheet, type ActiveChip } from '../src/ui/FilterSheet';
import { useDialog } from '../src/ui/AppDialog';
import { useApp } from '../src/ui/store';
import { AttachStrip } from '../src/ui/AttachStrip';
import { MeterSheet } from '../src/ui/MeterSheet';
import { useToast } from '../src/ui/Toast';
import { C, TYPE } from '../src/ui/theme';
import { usePager, Pager } from '../src/ui/Pager';
import { useDeferredReady } from '../src/ui/useDeferredReady';
import { Skeleton } from '../src/ui/Skeleton';
import { supplierMeters, METER_ICON, UTILITY_KINDS, type LabeledMeter } from '../src/domain/meters';
import { saveSupplier } from '../src/domain/suppliers';
import { t } from '../src/i18n';
import { TS_DEDUCTIBLE, TS_EXEMPT } from '../src/domain/purchases';
import { uid } from '../src/domain/ids';
import { fmt, toHalalas } from '../src/domain/money';
import { dfmt } from '../src/domain/dates';
import { logAudit } from '../src/domain/audit';
import { usePerm } from '../src/ui/access';

interface SupplierRow {
  id: string; name: string; vat: string; phone: string; category: string; utility_type: string; archived: number;
  /** أعليه ارتباط حيّ (فاتورة أو عداد أو مرفق)؟ · صفر أو واحد */
  linked_n: number;
}

const EMPTY_SUPPLIERS: SupplierRow[] = [];

/** ارتباط حيّ بالمورد · EXISTS تتوقف عند أول سطر · بها يُقرَّر عرض زر الحذف قبل الضغط */
const LINKED_SQL = `(EXISTS(SELECT 1 FROM purchases WHERE supplier_name = s.name AND deleted_at IS NULL)
  OR EXISTS(SELECT 1 FROM meters WHERE supplier_id = s.id AND deleted_at IS NULL)
  OR EXISTS(SELECT 1 FROM attachments WHERE entity_type = 'supplier' AND entity_id = s.id AND deleted_at IS NULL))`;

// نوع الخدمة باسمه وشعاره ولونه · والغاز معها (الهجرة ٤٠)
const UTILITY_KEY: Record<string, string> = { 'كهرباء': 'power', 'ماء': 'water', 'غاز': 'gas' }; // i18n-exempt: أنواع الخدمة المخزّنة
const UTILITY_COLOR: Record<string, string> = { power: C.gold, water: '#2E7CB8', gas: '#C2410C' };
const utilityLabel = (v: string) => t('suppliers.utility.' + (UTILITY_KEY[v] ?? 'plain'));
const utilityColor = (v: string) => UTILITY_COLOR[UTILITY_KEY[v]] ?? C.muted;
const utilityIcon = (v: string) => (METER_ICON[v] ?? 'bolt') as IconName;
const utilityOptions = () => [{ value: '', label: t('suppliers.utility.all') },
  ...UTILITY_KINDS.map((v) => ({ value: v as string, label: utilityLabel(v), icon: utilityIcon(v) })),
  { value: 'plain', label: utilityLabel('') }];
const STATE_OPTIONS = [{ value: 'active', label: 'الموردون النشطون' }, { value: 'archived', label: 'الأرشيف' }];

/** بطاقة مورد واحدة · معزولة وممذكَّرة كي لا يعاد رسم القائمة كلها */
const SupplierCard = React.memo(function SupplierCard({
  id, name, vat, phone, category, utilityType, archived, linked, canManage, onDetail, onEdit, onArchiveToggle, onDelete,
}: {
  id: string; name: string; vat: string; phone: string; category: string; utilityType: string;
  archived: number; linked: boolean;
  /** «المشتريات والموردون: كامل» · التعديل والأرشفة والحذف */
  canManage: boolean;
  onDetail: (id: string) => void;
  onEdit: (id: string) => void;
  onArchiveToggle: (id: string, archived: number) => void;
  onDelete: (id: string, name: string) => void;
}) {
  return (
    <Card style={{ paddingVertical: 10 }}>
      {/* زر ⋮ أعلى البطاقة يساراً بمحاذاة العنوان ·
          والمورد ذو الفواتير أو العدادات لا يُعرض له «حذف» · الأرشفة بديلها */}
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={() => onDetail(id)} style={{ flex: 1 }}>
          <T size={TYPE.sectionTitle} bold>{name}</T>
        </Pressable>
        <Row gap={6}>
          {utilityType ? (
            <>
              <Icon name={utilityIcon(utilityType)} size={15} color={utilityColor(utilityType)} />
              <Badge kind="due" label={utilityLabel(utilityType)} />
            </>
          ) : null}
          {archived ? <Badge kind="draft" label="مؤرشف" /> : null}
          <ActionMenuButton title={name} actions={[
            { icon: 'eye', label: 'عرض التفاصيل', onPress: () => onDetail(id) },
            canManage ? { icon: 'edit', label: 'تعديل', onPress: () => onEdit(id) } : null,
            canManage ? {
              icon: archived ? 'undo' : 'archive', label: archived ? 'إلغاء الأرشفة' : 'أرشفة',
              onPress: () => onArchiveToggle(id, archived),
            } : null,
            linked || !canManage ? null : { icon: 'trash' as const, label: 'حذف', danger: true, onPress: () => onDelete(id, name) },
          ]} />
        </Row>
      </Row>
      <Pressable onPress={() => onDetail(id)}>
        <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
          {vat || phone ? <Num size={TYPE.caption} color={C.muted}>{[vat, phone].filter(Boolean).join(' · ')}</Num> : null}
          {category ? <T size={TYPE.caption} color={C.muted}>{category}</T> : null}
        </Row>
      </Pressable>
    </Card>
  );
});

export default function Suppliers() {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const ready = useDeferredReady();
  const fsheet = useFilterSheet();
  const perm = usePerm('purchases');
  const [q, setQ] = useState('');
  const [fState, setFState] = useState('active');
  const [fUtility, setFUtility] = useState('');
  const [fCategory, setFCategory] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [vat, setVat] = useState('');
  const [phone, setPhone] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [utility, setUtility] = useState('');
  const pager = usePager('suppliers');

  const needle = q.trim();
  useEffect(() => {
    pager.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, fState, fUtility, fCategory]);

  const filter = useMemo(() => {
    const where: string[] = ['s.deleted_at IS NULL', 's.archived = ?'];
    const args: Array<string | number> = [fState === 'archived' ? 1 : 0];
    if (needle) {
      where.push(`(s.name LIKE '%'||?||'%' OR s.phone LIKE '%'||?||'%' OR s.category LIKE '%'||?||'%' OR s.vat LIKE '%'||?||'%')`);
      args.push(needle, needle, needle, needle);
    }
    if (fUtility === 'plain') where.push(`TRIM(COALESCE(s.utility_type,'')) = ''`);
    else if (fUtility) { where.push('s.utility_type = ?'); args.push(fUtility); }
    if (fCategory) { where.push('TRIM(s.category) = ?'); args.push(fCategory); }
    return { sql: where.join(' AND '), args };
  }, [needle, fState, fUtility, fCategory]);

  const { rows, total, totalAll } = useMemo(() => {
    if (!ready) return { rows: EMPTY_SUPPLIERS, total: 0, totalAll: 0 };
    const page = db.all<SupplierRow>(
      `SELECT s.id, s.name, s.vat, s.phone, s.category, s.utility_type, s.archived, ${LINKED_SQL} AS linked_n
       FROM suppliers s WHERE ${filter.sql} ORDER BY s.name LIMIT ? OFFSET ?`,
      [...filter.args, pager.limit, pager.offset]
    );
    const count = Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM suppliers s WHERE ${filter.sql}`, filter.args)?.n ?? 0);
    // العدد الكلي في النطاق نفسه قبل البحث والمرشِّحات · لسطر «24 من 60»
    const all = Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM suppliers WHERE deleted_at IS NULL AND archived = ?`,
      [fState === 'archived' ? 1 : 0])?.n ?? 0);
    return { rows: page, total: count, totalAll: all };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready, filter, fState, pager.limit, pager.offset]);

  const categories = useMemo(() => {
    if (!ready) return [] as string[];
    return db.all<{ c: string }>(
      `SELECT DISTINCT TRIM(category) AS c FROM suppliers
       WHERE deleted_at IS NULL AND TRIM(COALESCE(category,'')) != '' ORDER BY c`
    ).map((r) => r.c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready]);

  const openNew = () => {
    setEditingId(null); setName(''); setVat(''); setPhone(''); setCategory(''); setAmount(''); setUtility('');
    setFormOpen(true);
  };
  const openEdit = useCallback((id: string) => {
    const s = db.get<{ name: string; vat: string; phone: string; category: string; default_amount_halalas: number | null; utility_type: string }>(
      `SELECT * FROM suppliers WHERE id = ?`, [id]
    );
    if (!s) return;
    setEditingId(id); setName(s.name); setVat(s.vat); setPhone(s.phone); setCategory(s.category);
    setAmount(s.default_amount_halalas != null ? fmt(Number(s.default_amount_halalas)).replace(/,/g, '') : '');
    setUtility(s.utility_type); setFormOpen(true);
  }, [db]);
  const save = () => {
    // الحفظ في المنطق (src/domain/suppliers.ts): تعديل الاسم يتبعه في فواتير شرائه (دراسة القائم)
    try {
      saveSupplier(db, editingId, { name, vat, phone, category, amountHalalas: amount.trim() ? toHalalas(amount) : null, utility });
    } catch (e) { toast((e as Error).message); return; }
    setFormOpen(false); bump();
    toast(editingId ? 'تم تحديث المورد' : `تمت إضافة المورد "${name.trim()}"`);
  };

  const onDetail = useCallback((id: string) => setDetailId(id), []);
  const onArchiveToggle = useCallback((id: string, archived: number) => {
    db.transaction(() => db.run(`UPDATE suppliers SET archived=? WHERE id=?`, [archived ? 0 : 1, id]));
    bump(); toast(archived ? 'تم إلغاء الأرشفة' : 'تمت الأرشفة');
  }, [db, bump, toast]);
  const onDelete = useCallback((id: string, supplierName: string) => {
    // لا يصل هنا إلا مورد بلا ارتباط · المرتبط لا يُعرض له زر حذف أصلاً
    dialog({
      title: 'حذف المورد',
      body: `حذف المورد "${supplierName}"؟`,
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'حذف', variant: 'danger',
          onPress: () => {
            db.transaction(() => db.run(`UPDATE suppliers SET deleted_at=? WHERE id=?`, [new Date().toISOString(), id]));
            bump(); toast('تم الحذف · يمكن استعادته من الإعدادات');
          },
        },
      ],
    });
  }, [db, bump, toast, dialog]);

  const keyExtractor = useCallback((item: SupplierRow) => item.id, []);
  const renderItem: ListRenderItem<SupplierRow> = useCallback(({ item }) => (
    <SupplierCard id={item.id} name={item.name} vat={item.vat} phone={item.phone}
      category={item.category} utilityType={item.utility_type} archived={Number(item.archived)}
      linked={!!Number(item.linked_n)} canManage={perm.manage}
      onDetail={onDetail} onEdit={openEdit} onArchiveToggle={onArchiveToggle} onDelete={onDelete} />
  ), [onDetail, openEdit, onArchiveToggle, onDelete, perm.manage]);

  const editingMeters = useMemo(
    () => (editingId ? supplierMeters(db, editingId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, editingId]
  );

  const clearFilters = useCallback(() => {
    setQ(''); setFState('active'); setFUtility(''); setFCategory('');
  }, []);
  const chips: ActiveChip[] = [
    ...(fState === 'archived' ? [{ key: 'state', label: 'الأرشيف', onClear: () => setFState('active') }] : []),
    ...(fUtility ? [{ key: 'utility', label: utilityLabel(fUtility), onClear: () => setFUtility('') }] : []),
    ...(fCategory ? [{ key: 'category', label: fCategory, onClear: () => setFCategory('') }] : []),
  ];

  return (
    <Screen title="الموردون" icon="supplier" scroll={false}
      actions={perm.add ? <BtnPrimary small title="+ مورد جديد" onPress={openNew} /> : undefined}>
      <FilterBar chips={chips} onOpen={fsheet.show} onClearAll={clearFilters}
        resultCount={total} total={totalAll} filtered={total} itemName="مورداً"
        search={<SearchBox value={q} onChange={setQ} />} />
      {!ready ? <Skeleton /> : (
        <FlatList
          data={rows}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 12 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          ListEmptyComponent={<Card><EmptyState>لا يوجد موردون مطابقون</EmptyState></Card>}
          ListFooterComponent={<Pager pager={pager} total={total} />}
        />
      )}

      <FilterSheet open={fsheet.open} onClose={fsheet.hide} onClearAll={clearFilters} resultCount={total}>
        <SelectField label="الحالة" value={fState} options={STATE_OPTIONS} onPick={setFState} />
        <SelectField label="نوع الخدمة" value={fUtility} options={utilityOptions()} onPick={setFUtility} />
        <SelectField label="الفئة" value={fCategory}
          options={[{ value: '', label: 'كل الفئات' }, ...categories.map((c) => ({ value: c, label: c }))]}
          onPick={setFCategory} />
      </FilterSheet>

      {/* نافذة مورد جديد/تعديل */}
      <Sheet visible={formOpen} onClose={() => setFormOpen(false)}
        title={editingId ? 'تعديل المورد' : 'مورد جديد'} tall
        footer={
          <>
            <View style={{ flex: 1 }}><BtnPrimary title={editingId ? 'حفظ التعديل' : 'إضافة المورد'} onPress={save} /></View>
          </>
        }>
        <Field label="اسم المورد" value={name} onChange={setName} />
        {editingId ? (
          <AttachStrip section="purchases" entityType="supplier" entityId={editingId} kind="purchase"
            linked="المورد" title="فواتيره وعقده" />
        ) : null}
        <Row>
          <View style={{ flex: 1 }}><Field label="الرقم الضريبي" value={vat} onChange={setVat} keyboard="numeric" ltr /></View>
          <View style={{ flex: 1 }}><Field label="رقم الجوال" value={phone} onChange={setPhone} keyboard="phone-pad" ltr /></View>
        </Row>
        <Row>
          <View style={{ flex: 1 }}><Field label="الفئة" value={category} onChange={setCategory} /></View>
          <View style={{ flex: 1 }}><Field label="المبلغ المعتاد" value={amount} onChange={setAmount} keyboard="numeric" ltr /></View>
        </Row>
        <SelectField label="نوع الخدمة" value={utility}
          options={[{ value: '', label: utilityLabel('') },
            ...UTILITY_KINDS.map((v) => ({ value: v as string, icon: utilityIcon(v), label: utilityLabel(v) }))]}
          onPick={setUtility} />
        {utility ? (
          <View style={{ marginBottom: 8 }}>
            <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 5 }}>
              العدادات المرتبطة بهذا المورد ({editingMeters.length})
            </T>
            {editingMeters.length ? editingMeters.map((m) => (
              <Row key={m.id} style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
                <T size={TYPE.body}>{m.label}</T>
                <Num size={TYPE.caption}>{m.number}</Num>
              </Row>
            )) : <T size={TYPE.body} color={C.muted}>تُربط العدادات من نافذة الوحدة أو العقار</T>}
          </View>
        ) : null}
      </Sheet>

      {/* صفحة المورد · زر «تعديل» فيها يفتح النموذج القائم */}
      {detailId && (
        <SupplierDetail supplierId={detailId} onClose={() => setDetailId(null)}
          onEdit={(id) => { setDetailId(null); openEdit(id); }} />
      )}
    </Screen>
  );
}

/* ═══════════ صفحة المورد · بياناته وملخصه المالي ثم أقسامه المطوية ═══════════ */
/**
 * الأقسام: فواتيره · عدّاداته · مدفوعاته · قيوده · مرفقاته.
 * العدّاد وحده يُحسب مسبقاً باستعلام COUNT خفيف، والقسم الفارغ لا يُعرض إطلاقاً،
 * والمملوء مطويّ لا يُنفَّذ استعلام محتواه إلا عند فتحه، وداخله تقسيم صفحات.
 */
function SupplierDetail({ supplierId, onClose, onEdit }: {
  supplierId: string; onClose: () => void; onEdit: (id: string) => void;
}) {
  const { db, version } = useApp();
  const router = useRouter();
  const canManage = usePerm('purchases').manage;
  // القيود من الدفتر · قسمها لمن يرى الدفتر وحده (الحد اللازم)
  const seesLedger = usePerm('ledger').view;
  const [entryFor, setEntryFor] = useState<string | null>(null);
  const [meterOpen, setMeterOpen] = useState<LabeledMeter | null>(null);

  const s = useMemo(
    () => db.get<{ name: string; vat: string; phone: string; category: string; utility_type: string }>(
      `SELECT name, vat, phone, category, utility_type FROM suppliers WHERE id = ?`, [supplierId]
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, supplierId]
  );

  // الملخص المالي · الربط بالاسم: purchases بلا عمود معرّف للمورد (supplier_name فقط في المخطط)
  const fin = useMemo(() => {
    if (!s) return null;
    return db.get<{ cnt: number; billed: number; paid_sum: number; due_sum: number; ded_tax: number; nonded_tax: number }>(
      `SELECT COUNT(*) AS cnt,
              COALESCE(SUM(total_halalas),0) AS billed,
              COALESCE(SUM(CASE WHEN paid = 1 THEN total_halalas ELSE 0 END),0) AS paid_sum,
              COALESCE(SUM(CASE WHEN paid = 0 THEN total_halalas ELSE 0 END),0) AS due_sum,
              COALESCE(SUM(CASE WHEN tax_status = ? THEN tax_halalas ELSE 0 END),0) AS ded_tax,
              COALESCE(SUM(CASE WHEN tax_status != ? AND tax_status != ? THEN tax_halalas ELSE 0 END),0) AS nonded_tax
       FROM purchases WHERE supplier_name = ? AND deleted_at IS NULL`,
      [TS_DEDUCTIBLE, TS_DEDUCTIBLE, TS_EXEMPT, s.name]
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, s]);

  /** عدّادات الأقسام وحدها · استعلامات COUNT خفيفة لا تجلب سطراً واحداً */
  const counts = useMemo(() => {
    if (!s) return { purchases: 0, meters: 0, pays: 0, entries: 0, atts: 0 };
    const one = (sql: string, args: Array<string | number>) => Number(db.get<{ n: number }>(sql, args)?.n ?? 0);
    return {
      purchases: one(`SELECT COUNT(*) AS n FROM purchases WHERE supplier_name = ? AND deleted_at IS NULL`, [s.name]),
      meters: one(`SELECT COUNT(*) AS n FROM meters WHERE supplier_id = ? AND deleted_at IS NULL`, [supplierId]),
      pays: one(`SELECT COUNT(*) AS n FROM purchases WHERE supplier_name = ? AND deleted_at IS NULL AND paid = 1`, [s.name]),
      entries: one(
        `SELECT COUNT(*) AS n FROM journal_entries WHERE deleted_at IS NULL AND id IN (
           SELECT journal_entry_id FROM purchases
           WHERE supplier_name = ? AND deleted_at IS NULL AND journal_entry_id IS NOT NULL
           UNION
           SELECT payment_journal_entry_id FROM purchases
           WHERE supplier_name = ? AND deleted_at IS NULL AND payment_journal_entry_id IS NOT NULL)`,
        [s.name, s.name]),
      atts: one(
        `SELECT COUNT(*) AS n FROM attachments WHERE entity_type = 'supplier' AND entity_id = ? AND deleted_at IS NULL`,
        [supplierId]),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, s, supplierId]);

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
  }, [db, entryFor]);

  if (!s || !fin) return null;

  const openPurchase = (id: string) => { onClose(); router.push(`/purchases?detail=${id}`); };

  const finRow = (label: string, value: React.ReactNode, last?: boolean) => (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: last ? 0 : 1, borderBottomColor: C.paperLine }}>
      <T size={TYPE.body} color={C.muted}>{label}</T>
      {value}
    </Row>
  );

  /** بطاقة القيد · تُرسم تحت القيد المضغوط مباشرةً داخل القائمة نفسها */
  const entryCard = entry ? (
    <View style={{ backgroundColor: C.paper, borderRadius: 10, padding: 12, marginTop: 4, marginBottom: 8, borderWidth: 1, borderColor: C.line }}>
      <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <T size={TYPE.cardTitle} bold>{entry.no} · {dfmt(entry.date)}</T>
        <BtnIcon icon="x" accessibilityLabel="إغلاق القيد" onPress={() => setEntryFor(null)} />
      </Row>
      <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 6 }}>{entry.memo}</T>
      {entry.lines.map((l, li) => (
        <Row key={li} style={{ justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
          <T size={TYPE.caption} style={{ flex: 1 }}>{l.account_code} · {l.name}</T>
          <Num size={TYPE.caption}>{Number(l.debit_halalas) ? 'مدين ' + fmt(Number(l.debit_halalas)) : 'دائن ' + fmt(Number(l.credit_halalas))}</Num>
        </Row>
      ))}
    </View>
  ) : null;

  return (
    <Sheet visible onClose={onClose} title={s.name} tall
      footer={canManage ? (
        <>
          {/* الإغلاق بعلامة ✕ في رأس الورقة وحدها */}
          <View style={{ flex: 1 }}><BtnPrimary title="تعديل" onPress={() => onEdit(supplierId)} /></View>
        </>
      ) : undefined}>
      {/* بياناته */}
      <Row style={{ marginBottom: 8 }}>
        {s.vat ? <View style={{ flex: 1 }}><T size={TYPE.caption} color={C.muted}>الرقم الضريبي</T><Num size={TYPE.cardTitle}>{s.vat}</Num></View> : null}
        {s.phone ? <View style={{ flex: 1 }}><T size={TYPE.caption} color={C.muted}>الجوال</T><Num size={TYPE.cardTitle}>{s.phone}</Num></View> : null}
      </Row>
      <Row style={{ marginBottom: 10 }}>
        {s.category ? <View style={{ flex: 1 }}><T size={TYPE.caption} color={C.muted}>التصنيف</T><T size={TYPE.cardTitle}>{s.category}</T></View> : null}
        {s.utility_type ? (
          <View style={{ flex: 1 }}>
            <T size={TYPE.caption} color={C.muted}>نوع الخدمة</T>
            <Row gap={5}>
              <Icon name={utilityIcon(s.utility_type)} size={13} color={utilityColor(s.utility_type)} />
              <T size={TYPE.cardTitle}>{utilityLabel(s.utility_type)}</T>
            </Row>
          </View>
        ) : null}
      </Row>

      {/* ملخصه المالي · خمسة صفوف */}
      <T size={TYPE.sectionTitle} bold color={C.ink} style={{ marginBottom: 4 }}>الملخص المالي</T>
      <View style={{ backgroundColor: C.paper, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: C.line, marginBottom: 10 }}>
        {finRow(`إجمالي الفواتير (${fin.cnt})`, <Money halalas={Number(fin.billed)} size={TYPE.cardTitle} bold />)}
        {finRow('المسدَّد', <Money halalas={Number(fin.paid_sum)} size={TYPE.cardTitle} bold color={C.emerald} />)}
        {finRow('الذمة القائمة', <Money halalas={Number(fin.due_sum)} size={TYPE.cardTitle} bold color={Number(fin.due_sum) > 0 ? C.rose : C.emerald} />)}
        {finRow('ضريبة قابلة للخصم', <Money halalas={Number(fin.ded_tax)} size={TYPE.cardTitle} bold />)}
        {finRow('ضريبة غير قابلة للخصم', <Money halalas={Number(fin.nonded_tax)} size={TYPE.cardTitle} bold />, true)}
      </View>

      {/* فواتيره · الضغط يقفل الورقة ويفتح تفاصيل الفاتورة في شاشتها */}
      <CollapsibleSection title="فواتيره" count={counts.purchases} icon="invoice" pageKey="supplierPurchases">
        {(page) => db.all<{ id: string; no: string; date: string; total_halalas: number; paid: number }>(
          `SELECT id, no, date, total_halalas, paid FROM purchases
           WHERE supplier_name = ? AND deleted_at IS NULL
           ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`,
          [s.name, page.limit, page.offset]
        ).map((p) => (
          <Pressable key={p.id} onPress={() => openPurchase(p.id)}>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <Num size={TYPE.body}>{p.no} · {dfmt(p.date)}</Num>
              <Row gap={8}>
                <Badge kind={Number(p.paid) ? 'paid' : 'due'} label={Number(p.paid) ? 'مسدَّدة' : 'غير مسدَّدة'} />
                <Money halalas={Number(p.total_halalas)} size={TYPE.body} bold />
              </Row>
            </Row>
          </Pressable>
        ))}
      </CollapsibleSection>

      {/* عدّاداته */}
      <CollapsibleSection title="عدّاداته" count={counts.meters} icon="bolt" pageKey="supplierMeters">
        {(page) => supplierMeters(db, supplierId).slice(page.offset, page.offset + page.limit).map((m) => (
          <Pressable key={m.id} onPress={() => setMeterOpen(m)}>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <Row gap={6}>
                <Icon name={(METER_ICON[m.kind] ?? 'settings') as IconName} size={15}
                  color={m.kind === 'كهرباء' ? C.gold : m.kind === 'ماء' ? '#2E7CB8' : C.emerald} />
                <T size={TYPE.body} color={C.emerald}>{m.label}</T>
              </Row>
              <Num size={TYPE.caption} color={C.muted}>{m.number}</Num>
            </Row>
          </Pressable>
        ))}
      </CollapsibleSection>

      {/* مدفوعاته · فواتيره المسدَّدة بتاريخ السداد ومصدره */}
      <CollapsibleSection title="مدفوعاته" count={counts.pays} icon="wallet" pageKey="supplierPays">
        {(page) => db.all<{ id: string; no: string; paid_date: string | null; total_halalas: number; bank_name: string | null }>(
          `SELECT p.id, p.no, p.paid_date, p.total_halalas, b.name AS bank_name
           FROM purchases p LEFT JOIN banks b ON b.id = p.payment_bank_id
           WHERE p.supplier_name = ? AND p.deleted_at IS NULL AND p.paid = 1
           ORDER BY p.paid_date DESC, p.created_at DESC LIMIT ? OFFSET ?`,
          [s.name, page.limit, page.offset]
        ).map((p) => (
          <Pressable key={p.id} onPress={() => openPurchase(p.id)}>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <View>
                <Num size={TYPE.body}>{[p.paid_date ? dfmt(p.paid_date) : '', p.no].filter(Boolean).join(' · ')}</Num>
                <T size={TYPE.caption} color={C.muted}>{p.bank_name || 'نقداً'}</T>
              </View>
              <Money halalas={Number(p.total_halalas)} size={TYPE.body} bold color={C.rose} />
            </Row>
          </Pressable>
        ))}
      </CollapsibleSection>

      {/* قيوده · قيدا التسجيل والسداد من فواتيره */}
      <CollapsibleSection title="قيوده" count={seesLedger ? counts.entries : 0} icon="clipboard" pageKey="supplierEntries">
        {(page) => db.all<{ id: string; no: string; date: string; memo: string }>(
          `SELECT id, no, date, memo FROM journal_entries
           WHERE deleted_at IS NULL AND id IN (
             SELECT journal_entry_id FROM purchases
             WHERE supplier_name = ? AND deleted_at IS NULL AND journal_entry_id IS NOT NULL
             UNION
             SELECT payment_journal_entry_id FROM purchases
             WHERE supplier_name = ? AND deleted_at IS NULL AND payment_journal_entry_id IS NOT NULL)
           ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`,
          [s.name, s.name, page.limit, page.offset]
        ).map((e) => (
          <View key={e.id}>
            <Pressable onPress={() => setEntryFor(entryFor === e.id ? null : e.id)}>
              <View style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <Num size={TYPE.body} bold>{e.no} · {dfmt(e.date)}</Num>
                <T size={TYPE.caption} color={C.muted}>{e.memo}</T>
              </View>
            </Pressable>
            {entryFor === e.id ? entryCard : null}
          </View>
        ))}
      </CollapsibleSection>

      {/* مرفقاته · عرض فقط · الإضافة من نافذة تعديل المورد */}
      <CollapsibleSection title="مرفقاته" count={counts.atts} icon="attach">
        {() => (
          <AttachStrip section="purchases" entityType="supplier" entityId={supplierId} kind="purchase" linked="المورد" title="مرفقاته" hideAdd />
        )}
      </CollapsibleSection>

      <View style={{ height: 12 }} />
      {meterOpen && <MeterSheet meter={meterOpen} onClose={() => setMeterOpen(null)} />}
    </Sheet>
  );
}

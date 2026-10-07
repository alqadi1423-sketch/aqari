/** المطالبات · يدوية وتلقائية (تسوية التأمين)، بإرفاق فواتير وصور، وتحصيلها */
import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { View, FlatList } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Screen } from '../src/ui/Screen';
import { Card, T, Num, Money, EmptyState, Row, Badge, BtnPrimary, BtnGhost, Field, SearchBox, ChipGroup } from '../src/ui/components';
import { Sheet, SelectField } from '../src/ui/Sheet';
import { DateField } from '../src/ui/DateField';
import { ActionMenuButton } from '../src/ui/ActionMenu';
import { FilterBar, FilterSheet, useFilterSheet, type ActiveChip } from '../src/ui/FilterSheet';
import { useDialog } from '../src/ui/AppDialog';
import { usePager, Pager } from '../src/ui/Pager';
import { useDeferredReady } from '../src/ui/useDeferredReady';
import { Skeleton } from '../src/ui/Skeleton';
import { useApp } from '../src/ui/store';
import { AttachStrip } from '../src/ui/AttachStrip';
import { useToast } from '../src/ui/Toast';
import { C, TYPE } from '../src/ui/theme';
import { saveClaim, collectClaim, deleteClaim } from '../src/domain/claims';
import { today, dfmt } from '../src/domain/dates';
import { toHalalas, fmt } from '../src/domain/money';
import { appFilesEnv } from '../src/services/filesEnv';
import { putAttachment } from '../src/files/store';
import { printClaim } from '../src/services/print';
import { reportFailure } from '../src/ui/failureDialog';
import { usePerm } from '../src/ui/access';

import { CostCenterField } from '../src/ui/CostCenters';
import { GENERAL_COST_CENTER, withCostCenter } from '../src/domain/accounting/dimensions';
interface ClaimRow {
  id: string; contract_id: string; amount_halalas: number; reason: string; date: string;
  status: string; source: string; contract_no: string | null; tenant_name: string;
}

const EMPTY_PAGE: { rows: ClaimRow[]; total: number } = { rows: [], total: 0 };

const STATUS_OPTIONS: Array<[string, string]> = [['', 'الكل'], ['مفتوحة', 'مفتوحة'], ['محصَّلة', 'محصَّلة']];
const SOURCE_OPTIONS: Array<[string, string]> = [['', 'الكل'], ['يدوية', 'يدوية'], ['تسوية تأمين', 'تسوية تأمين']];

/** الفترة تُحسب في SQL من عمود تاريخ المطالبة */
const PERIOD_LABELS: Record<string, string> = { month: 'هذا الشهر', '90': 'آخر 90 يوماً', year: 'هذه السنة' };
const PERIOD_SQL: Record<string, string> = {
  month: `strftime('%Y-%m', cl.date) = strftime('%Y-%m','now','localtime')`,
  '90': `cl.date >= date('now','localtime','-90 day')`,
  year: `strftime('%Y', cl.date) = strftime('%Y','now','localtime')`,
};
const PERIOD_OPTIONS = [{ value: '', label: 'كل الفترات' },
  ...Object.entries(PERIOD_LABELS).map(([value, label]) => ({ value, label }))];

/** بطاقة مطالبة واحدة · خارج الشاشة ومحفوظة كي لا يُعاد رسمها بلا داعٍ */
const ClaimCard = React.memo(function ClaimCard({
  id, tenantName, contractNo, date, status, source, reason, amountHalalas,
  canManage, onCollect, onEdit, onPrint, onDelete,
}: {
  id: string; tenantName: string; contractNo: string | null; date: string; status: string; source: string;
  reason: string; amountHalalas: number;
  /** «المطالبات: كامل» · التحصيل والتعديل والحذف */
  canManage: boolean;
  onCollect: (id: string) => void; onEdit: (id: string) => void; onPrint: (id: string) => void; onDelete: (id: string) => void;
}) {
  const open = status === 'مفتوحة';
  return (
    <Card style={{ paddingVertical: 10 }}>
      {/* زر ⋮ أعلى البطاقة يساراً بمحاذاة العنوان ·
          والمحصَّلة لا يُعرض لها «تحصيل» ولا «تعديل»: قيدها أُقفل فتصحيحها بحذفها */}
      <Row style={{ justifyContent: 'space-between' }}>
        <T size={TYPE.sectionTitle} bold style={{ flex: 1 }}>{tenantName}</T>
        <Row gap={8}>
          <Badge kind={source === 'تسوية تأمين' ? 'due' : 'draft'}
            label={source === 'تسوية تأمين' ? 'تسوية تأمين تلقائية' : 'يدوية'} />
          <ActionMenuButton title={tenantName} actions={[
            open && canManage ? { icon: 'wallet', label: 'تحصيل المطالبة', onPress: () => onCollect(id) } : null,
            open && canManage ? { icon: 'edit', label: 'تعديل', onPress: () => onEdit(id) } : null,
            { icon: 'print', label: 'طباعة / PDF', onPress: () => onPrint(id) },
            canManage ? { icon: 'trash', label: 'حذف', danger: true, onPress: () => onDelete(id) } : null,
          ]} />
        </Row>
      </Row>
      <Row style={{ justifyContent: 'space-between', marginTop: 3 }}>
        <Num size={TYPE.caption} color={C.muted}>{[contractNo, dfmt(date)].filter(Boolean).join(' · ')}</Num>
        <Badge kind={open ? 'overdue' : 'paid'} label={status} />
      </Row>
      <Row style={{ justifyContent: 'space-between', marginTop: 5 }}>
        <T size={TYPE.body} style={{ flex: 1 }}>{(reason || '').slice(0, 60)}{(reason || '').length > 60 ? '…' : ''}</T>
        <Money halalas={amountHalalas} size={TYPE.number} bold color={open ? C.rose : C.emerald} />
      </Row>
    </Card>
  );
});

export default function Claims() {
  const { db, version, bump } = useApp();
  const perm = usePerm('claims');
  const toast = useToast();
  const dialog = useDialog();
  const ready = useDeferredReady();
  const pager = usePager('claims');
  const fsheet = useFilterSheet();
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fSource, setFSource] = useState('');
  const [fPeriod, setFPeriod] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  /** حالة المطالبة المفتوحة في النموذج · المحصَّلة تُعرض ولا تُحفظ فقيدها أُقفل */
  const [editingStatus, setEditingStatus] = useState('');
  const [contractId, setContractId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today());
  const [pendingFiles, setPendingFiles] = useState<Array<{ uri: string; name: string; mime: string; kind: string }>>([]);

  // البحث أو المرشِّحات تعيد الصفحة للأولى
  useEffect(() => {
    pager.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, fStatus, fSource, fPeriod]);

  const filter = useMemo(() => {
    const needle = q.trim();
    const where: string[] = ['cl.deleted_at IS NULL'];
    const args: Array<string | number> = [];
    if (needle) {
      where.push(`(c.tenant_name LIKE '%'||?||'%' OR IFNULL(c.contract_no, '') LIKE '%'||?||'%' OR cl.reason LIKE '%'||?||'%')`);
      args.push(needle, needle, needle);
    }
    if (fStatus) { where.push('cl.status = ?'); args.push(fStatus); }
    if (fSource) { where.push('cl.source = ?'); args.push(fSource); }
    if (fPeriod && PERIOD_SQL[fPeriod]) where.push(PERIOD_SQL[fPeriod]);
    return { sql: where.join(' AND '), args };
  }, [q, fStatus, fSource, fPeriod]);

  const { rows, total } = useMemo(() => {
    if (!ready) return EMPTY_PAGE;
    const cnt = Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM claims cl JOIN contracts c ON c.id = cl.contract_id WHERE ${filter.sql}`, filter.args
    )?.n ?? 0);
    const page = db.all<ClaimRow>(
      `SELECT cl.*, c.contract_no, c.tenant_name FROM claims cl
       JOIN contracts c ON c.id = cl.contract_id
       WHERE ${filter.sql} ORDER BY cl.created_at DESC LIMIT ? OFFSET ?`,
      [...filter.args, pager.limit, pager.offset]
    );
    return { rows: page, total: cnt };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, filter, ready, pager.limit, pager.offset]);

  // العدد الكلي قبل التصفية · لسطر «24 من 60»
  const totalAll = useMemo(() => {
    if (!ready) return 0;
    return Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM claims cl JOIN contracts c ON c.id = cl.contract_id WHERE cl.deleted_at IS NULL`
    )?.n ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready]);

  const contracts = useMemo(
    () => db.all<{ id: string; contract_no: string | null; tenant_name: string }>(
      `SELECT id, contract_no, tenant_name FROM contracts WHERE deleted_at IS NULL AND status != 'مسودة' ORDER BY created_at DESC`
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]
  );

  const openNew = () => {
    setEditingId(null); setEditingStatus(''); setContractId(contracts[0]?.id ?? ''); setAmount(''); setReason('');
    setDate(today()); setPendingFiles([]); setFormOpen(true);
  };
  const openEdit = useCallback((id: string) => {
    const r = db.get<{ contract_id: string; amount_halalas: number; reason: string; date: string; status: string }>(
      `SELECT contract_id, amount_halalas, reason, date, status FROM claims WHERE id = ?`, [id]
    );
    if (!r) return;
    setEditingId(id); setEditingStatus(r.status); setContractId(r.contract_id);
    setAmount(fmt(Number(r.amount_halalas)).replace(/,/g, ''));
    setReason(r.reason); setDate(r.date); setPendingFiles([]); setFormOpen(true);
  }, [db]);

  // القدوم من الدفتر: ?detail=<id> يفتح المستند نفسه لا القائمة
  const params = useLocalSearchParams<{ detail?: string }>();
  useEffect(() => {
    if (params.detail) openEdit(String(params.detail));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.detail]);

  const onCollect = useCallback((id: string) => {
    try { collectClaim(db, id); bump(); toast('حُصِّلت المطالبة وقُفلت ذمتها'); }
    catch (e) { reportFailure({ title: 'تعذّر التحصيل', e }); }
  }, [db, bump, toast]);
  const onPrint = useCallback((id: string) => {
    printClaim(db, id).catch(() => toast('تعذّرت الطباعة'));
  }, [db, toast]);
  const onDelete = useCallback((id: string) => {
    dialog({
      title: 'حذف المطالبة',
      body: 'حذف هذي المطالبة؟',
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        { label: 'حذف', variant: 'danger', onPress: () => { deleteClaim(db, id); bump(); toast('تم حذف المطالبة'); } },
      ],
    });
  }, [db, bump, toast, dialog]);

  const keyExtractor = useCallback((it: ClaimRow) => it.id, []);
  const renderItem = useCallback(({ item }: { item: ClaimRow }) => (
    <ClaimCard id={item.id} tenantName={item.tenant_name} contractNo={item.contract_no}
      date={item.date} status={item.status} source={item.source} reason={item.reason}
      amountHalalas={Number(item.amount_halalas)} canManage={perm.manage}
      onCollect={onCollect} onEdit={openEdit} onPrint={onPrint} onDelete={onDelete} />
  ), [onCollect, openEdit, onPrint, onDelete, perm.manage]);

  const pickInvoices = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/*'], multiple: true });
    if (res.canceled) return;
    setPendingFiles((p) => [...p, ...res.assets.map((a) => ({ uri: a.uri, name: a.name ?? 'ملف', mime: a.mimeType ?? '', kind: 'purchase' }))]);
  };
  const pickPhotos = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true });
    if (res.canceled) return;
    setPendingFiles((p) => [...p, ...res.assets.map((a) => ({ uri: a.uri, name: a.fileName ?? 'صورة.jpg', mime: a.mimeType ?? 'image/jpeg', kind: 'claim' }))]);
  };

  const [cc, setCc] = useState(GENERAL_COST_CENTER);
  const save = (...a: Parameters<typeof saveIn>) => withCostCenter(cc, () => saveIn(...a));
  const saveIn = async () => {
    try {
      const id = saveClaim(db, { contractId, amountHalalas: toHalalas(amount), reason, date }, editingId ?? undefined);
      const env = appFilesEnv(db);
      for (const f of pendingFiles) {
        try {
          const bytes = new File(f.uri).bytesSync();
          await putAttachment(env, bytes, { entityType: 'claim', entityId: id, kind: f.kind, originalName: f.name, mime: f.mime });
        } catch { /* ملف تعذّر */ }
      }
      setFormOpen(false); bump();
      toast(editingId ? 'تم تحديث المطالبة' : 'تمت إضافة المطالبة');
    } catch (e) { reportFailure({ title: 'تعذّر الحفظ', e }); }
  };

  const existingCounts = editingId
    ? {
        inv: Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments WHERE entity_type='claim' AND entity_id=? AND kind='purchase' AND deleted_at IS NULL`, [editingId])!.n),
        ph: Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments WHERE entity_type='claim' AND entity_id=? AND kind='claim' AND deleted_at IS NULL`, [editingId])!.n),
      }
    : null;

  // الجديدة بإدخال · وتعديل المفتوحة بكامل · وما سوى ذلك عرضٌ بلا حفظ ولا إرفاق
  const canSave = !editingId ? perm.add : editingStatus === 'مفتوحة' && perm.manage;

  const clearFilters = useCallback(() => { setQ(''); setFStatus(''); setFSource(''); setFPeriod(''); }, []);
  const chips: ActiveChip[] = [
    ...(fStatus ? [{ key: 'status', label: fStatus, onClear: () => setFStatus('') }] : []),
    ...(fSource ? [{ key: 'source', label: fSource, onClear: () => setFSource('') }] : []),
    ...(fPeriod ? [{ key: 'period', label: PERIOD_LABELS[fPeriod] ?? fPeriod, onClear: () => setFPeriod('') }] : []),
  ];

  return (
    <Screen title="المطالبات" icon="claim" scroll={false}
      /* لا عقد موثَّق فلا مطالبة تُسجَّل · الزر لا يُعرض بدل أن يُعرض ويرفض */
      actions={contracts.length && perm.add ? <BtnPrimary small title="+ مطالبة جديدة" onPress={openNew} /> : undefined}>
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
            <FilterBar chips={chips} onOpen={fsheet.show} onClearAll={clearFilters}
              resultCount={total} total={totalAll} filtered={total} itemName="مطالبة"
              search={<SearchBox value={q} onChange={setQ} />} />
          }
          ListFooterComponent={<Pager pager={pager} total={total} />}
          ListEmptyComponent={<Card><EmptyState>{contracts.length
            ? 'لا توجد مطالبات مطابقة · أضف مطالبة من الزر أعلاه'
            : 'لا مطالبات · وثّق عقداً أولاً فالمطالبة تُبنى على عقد'}</EmptyState></Card>}
        />
      )}

      <FilterSheet open={fsheet.open} onClose={fsheet.hide} onClearAll={clearFilters} resultCount={total}>
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 5 }}>الحالة</T>
        <View style={{ marginBottom: 10 }}>
          <ChipGroup options={STATUS_OPTIONS} value={fStatus} onChange={setFStatus} />
        </View>
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 5 }}>المصدر</T>
        <View style={{ marginBottom: 10 }}>
          <ChipGroup options={SOURCE_OPTIONS} value={fSource} onChange={setFSource} />
        </View>
        <SelectField label="الفترة" value={fPeriod} options={PERIOD_OPTIONS} onPick={setFPeriod} />
      </FilterSheet>

      {/* المطالبة المحصَّلة تُعرض ولا تُحفظ · قيدها أُقفل فلا يُعرض لها زر حفظ */}
      <Sheet visible={formOpen} onClose={() => setFormOpen(false)}
        title={!editingId ? 'مطالبة جديدة' : editingStatus !== 'مفتوحة' ? 'المطالبة المحصَّلة' : canSave ? 'تعديل المطالبة' : 'المطالبة'} tall
        footer={
          <>
            {/* الإغلاق بعلامة ✕ في رأس الورقة وحدها */}
            {canSave ? (
              <View style={{ flex: 1 }}><BtnPrimary title="حفظ المطالبة" onPress={save} /></View>
            ) : null}
          </>
        }>
        <SelectField label="العقد المرتبط" value={contractId}
          options={contracts.map((c) => ({ value: c.id, label: [c.contract_no, c.tenant_name].filter(Boolean).join(' · ') }))}
          onPick={setContractId} />
        <Field label="المبلغ" value={amount} onChange={setAmount} keyboard="numeric" ltr />
        <Field label="السبب / وصف المشكلة" value={reason} onChange={setReason} multiline />
        {editingId ? (
          <AttachStrip section="claims" entityType="claim" entityId={editingId} kind="claim"
            linked="المطالبة" title="صور الضرر وفواتير الإصلاح" />
        ) : null}
        <DateField label="التاريخ" value={date} onChange={setDate} />
        <CostCenterField value={cc} onChange={setCc} />
        {canSave ? (
          <Row style={{ marginBottom: 8 }}>
            <View style={{ flex: 1 }}><BtnGhost small icon="attach" title="إرفاق فواتير تكاليف" onPress={pickInvoices} /></View>
            <View style={{ flex: 1 }}><BtnGhost small icon="attach" title="إرفاق صور المشكلة" onPress={pickPhotos} /></View>
          </Row>
        ) : null}
        {pendingFiles.length ? <T size={TYPE.caption} color={C.muted}>سيُرفع {pendingFiles.length} ملف عند الحفظ</T> : null}
        {existingCounts && (existingCounts.inv || existingCounts.ph) ? (
          <T size={TYPE.caption} color={C.muted}>
            يوجد بالفعل: {existingCounts.inv} فاتورة، {existingCounts.ph} صورة (سيُضاف الجديد لها)
          </T>
        ) : null}
      </Sheet>
    </Screen>
  );
}

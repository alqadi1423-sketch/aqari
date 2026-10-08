/**
 * عقود الإيجار · القائمة، الإنشاء بمراجعة إلزامية، القفل بعد الإنشاء،
 * التفاصيل والدفعات، التجديد، الإلغاء، التقييم والتصرف بالتأمين بعد الانتهاء،
 * نماذج الاستلام والتسليم، وقراءة العقد من PDF.
 */
import React, { useMemo, useState, useEffect } from 'react';
import { CashShortNote, useCashOk } from '../../src/ui/CashGate';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { View, Pressable, FlatList } from 'react-native';
import { Screen, BackButton } from '../../src/ui/Screen';
import {
  Card, T, Num, Money, EmptyState, Row, Badge, SearchBox, BtnPrimary, BtnGhost, Field, Divider, Note,
  Sar, ChipGroup,
} from '../../src/ui/components';
import { Sheet, SelectField } from '../../src/ui/Sheet';
import { DateField } from '../../src/ui/DateField';
import { ActionMenuButton } from '../../src/ui/ActionMenu';
import { printTenantStatement, printContractDoc, printReceipt } from '../../src/services/print';
import { paymentForInstallment } from '../../src/domain/contracts/service';
import { INSTALLMENT_DISCOUNT_SQL, installmentRemaining } from '../../src/domain/contracts/installments';
import { FURNISHED_OPTIONS, CYCLE_OPTIONS } from '../../src/domain/contracts/vocab';
import { depositState } from '../../src/domain/contracts/vocab';
import { InstallmentSheet } from '../../src/ui/InstallmentSheet';
import { contractRemainingHalalas } from '../../src/domain/stats';
import { OccupantSheet } from '../../src/ui/OccupantSheet';
import { usePager, Pager } from '../../src/ui/Pager';
import { useDeferredReady } from '../../src/ui/useDeferredReady';
import { Skeleton } from '../../src/ui/Skeleton';
import {
  markOccupantLeft, deleteOccupant, occupantsOf,
  type OccupantRow,
} from '../../src/domain/occupants';
import { Icon } from '../../src/ui/icons';
import { useApp } from '../../src/ui/store';
import { AttachStrip } from '../../src/ui/AttachStrip';
import { FileViewer, type ViewerFile } from '../../src/ui/FileViewer';
import { useToast } from '../../src/ui/Toast';
import { useDialog } from '../../src/ui/AppDialog';
import { C } from '../../src/ui/theme';
import { useContractForm, ContractFormFields, emptyContractForm, formToInput } from '../../src/ui/contractForm';
import {
  saveDraft, deleteDraft, confirmContract, cancelContract, renewContract, renewWarnings,
  saveDepositSettlement, saveTenantRating, tenantRatingOverall, RuleViolation, depositCarried,
} from '../../src/domain/contracts/service';
import {
  contractDisplayId, contractDisplayStatus, contractStatusKind, contractStatusLabel, refreshContractStatuses,
  canRenewContract, contractEnded, renewBlockReason,
  type ContractRow, RENEW_WINDOW_DAYS,
} from '../../src/domain/contracts/rules';
import { keyMoneyBlockReason } from '../../src/domain/contracts/rules';
import { recordKeyMoneyDeal } from '../../src/domain/keymoney';
import { generateInstallments } from '../../src/domain/contracts/installments';
import { today, dfmt, addDays, approxMonths, periodLabel, daysBetween, contractEndFromDuration, periodBounds } from '../../src/domain/dates';
import { fmt, toHalalas } from '../../src/domain/money';
import { naturalCompare } from '../../src/domain/sortKey';
import { rescheduleAllNotifications } from '../../src/services/notifications';
import { HandoverSheet } from '../../src/ui/HandoverSheet';
import { attachPicked, pickFile } from '../../src/ui/attach';
import { attachmentsFor } from '../../src/files/store';
import { logAudit } from '../../src/domain/audit';
import { FilterBar, FilterSheet, useFilterSheet, type ActiveChip } from '../../src/ui/FilterSheet';
import { usePerm, useAccess } from '../../src/ui/access';
import { rowBy } from '../../src/services/access';
import { routeAllowed } from '../../src/domain/access/routes';

type SortKey = 'start' | 'contract_no' | 'value_halalas' | 'tenant_name';

export default function Contracts() {
  const { db, version, bump } = useApp();
  // القدوم من الدفتر أو تقرير: ?detail=<id> يفتح المستند مباشرة والرجوع يعيد من حيث أتيت
  const params = useLocalSearchParams<{ detail?: string; status?: string }>();
  useEffect(() => {
    if (params.detail) setDetailId(String(params.detail));
    if (params.status) setFStatus(String(params.status));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.detail, params.status]);
  const toast = useToast();
  const dialog = useDialog();
  const perm = usePerm('contracts');
  const handoverPerm = usePerm('handover');
  const kmPerm = usePerm('reservations');
  const [q, setQ] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('start');
  const [showArchived, setShowArchived] = useState(false);
  // مرشِّحات تُجمع: الحالة · العقار · الوحدة · الفترة · الدورية
  const [fStatus, setFStatus] = useState('');
  const [fProp, setFProp] = useState('');
  const [fUnit, setFUnit] = useState('');
  const [fPeriod, setFPeriod] = useState('');
  const [fCycle, setFCycle] = useState('');
  const [instSheetFor, setInstSheetFor] = useState<string | null>(null);
  const ready = useDeferredReady();
  const pager = usePager('contracts');
  const fsheet = useFilterSheet();
  const clearFilters = () => { setFStatus(''); setFProp(''); setFUnit(''); setFPeriod(''); setFCycle(''); setQ(''); };

  const [formOpen, setFormOpen] = useState(false);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const form = useContractForm();
  const [reviewOpen, setReviewOpen] = useState(false);
  // بنود عقد إيجار المقروءة مقارنةً بالقائم · وما وافق المستخدم على كتابته
  const leaseDiffs = useLeaseDiffs(form.state.extras, form.state.unitId, form.state.tenant);
  const [approvedExtras, setApprovedExtras] = useState<Set<ExtraKey>>(new Set());
  const { t } = useLang();

  const [detailId, setDetailId] = useState<string | null>(null);
  const [renewId, setRenewId] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [handoverFor, setHandoverFor] = useState<string | null>(null);
  const [ratingId, setRatingId] = useState<string | null>(null);
  const [settleId, setSettleId] = useState<string | null>(null);
  const [kmContract, setKmContract] = useState<ContractRow | null>(null);

  // خيارات المرشِّحات والقائمة المقسّمة · الاستعلام يجلب صفحة واحدة
  const filterOpts = useMemo(() => {
    if (!ready) return { props: [] as Array<{ id: string; name: string }>, units: [] as Array<{ id: string; unit_no: string }>, wallet1265: new Set<string>() };
    const props = db.all<{ id: string; name: string }>(
      `SELECT id, name FROM properties WHERE deleted_at IS NULL ORDER BY name`);
    const units = fProp
      ? db.all<{ id: string; unit_no: string }>(
          `SELECT id, unit_no FROM units WHERE property_id = ? AND deleted_at IS NULL ORDER BY COALESCE(unit_no_key, unit_no), unit_no`, [fProp])
      : [];
    // العقود التي استقر مخصوم تأمينها في محفظة إيجار (1265) · للرقم الذهبي
    const wallet1265 = new Set(
      db.all<{ contract_id: string }>(
        `SELECT contract_id FROM deposit_settlements WHERE deduction_halalas > 0 AND deduct_destination = 'محفظة إيجار'`
      ).map((r) => r.contract_id));
    return { props, units, wallet1265 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready, fProp]);

  // بعد ستين يوماً بالتقويم المحلي (المراجعة ٤.١٤)
  // يُعاد بتغيّر اليوم (المراجعة ٤.١٥ · مراقب اليوم يرفع النسخة)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const T60 = useMemo(() => addDays(today(), 60), [version]);

  const { rows, totalRows, allRows } = useMemo(() => {
    if (!ready) return { rows: [] as ContractRow[], totalRows: 0, allRows: 0 };
    const T0 = today();
    const where: string[] = ['c.deleted_at IS NULL', 'c.archived = ?'];
    const args: Array<string | number> = [showArchived ? 1 : 0];
    const needle = q.trim();
    if (needle) {
      where.push(`(c.contract_no LIKE '%'||?||'%' OR c.tenant_name LIKE '%'||?||'%' OR c.phone LIKE '%'||?||'%' OR c.unit_label LIKE '%'||?||'%' OR c.ejar_no LIKE '%'||?||'%')`);
      args.push(needle, needle, needle, needle, needle);
    }
    if (fStatus === 'مسودة' || fStatus === 'ملغى') { where.push('c.status = ?'); args.push(fStatus); }
    else if (fStatus === 'موثَّق ولم يبدأ') { where.push(`c.status NOT IN ('مسودة','ملغى') AND c.start > ?`); args.push(T0); }
    else if (fStatus === 'منتهٍ') { where.push(`c.status NOT IN ('مسودة','ملغى') AND c.end < ?`); args.push(T0); }
    else if (fStatus === 'ينتهي قريباً') { where.push(`c.status NOT IN ('مسودة','ملغى') AND c.start <= ? AND c.end >= ? AND c.end <= ?`); args.push(T0, T0, T60); }
    else if (fStatus === 'سارٍ') { where.push(`c.status NOT IN ('مسودة','ملغى') AND c.start <= ? AND c.end >= ?`); args.push(T0, T0); }
    if (fProp) { where.push(`c.unit_id IN (SELECT id FROM units WHERE property_id = ?)`); args.push(fProp); }
    if (fUnit) { where.push('c.unit_id = ?'); args.push(fUnit); }
    if (fCycle) { where.push('c.cycle = ?'); args.push(fCycle); }
    if (fPeriod) {
      // حدود الفترة بالتقويم المحلي (المراجعة ٤.١٤)
      const { from: fromD, to: toD } = periodBounds(fPeriod === 'month' || fPeriod === 'quarter' ? fPeriod : 'year');
      where.push('c.start <= ? AND c.end >= ?');
      args.push(toD, fromD);
    }
    const w = where.join(' AND ');
    const order = sortKey === 'start' ? 'c.start DESC'
      : sortKey === 'value_halalas' ? `${contractTotalSql(db, 'c.')} DESC`
      : sortKey === 'tenant_name' ? 'c.tenant_name'
      : 'c.contract_no';
    const total = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contracts c WHERE ${w}`, args)?.n ?? 0);
    // العدد قبل أي مرشِّح · سطر «24 من 60» يقيس عليه
    const all = Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM contracts c WHERE c.deleted_at IS NULL AND c.archived = ?`,
      [showArchived ? 1 : 0])?.n ?? 0);
    const page = db.all<ContractRow>(
      `SELECT c.* FROM contracts c WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...args, pager.limit, pager.offset]);
    return { rows: page, totalRows: total, allRows: all };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready, q, sortKey, showArchived, fStatus, fProp, fUnit, fCycle, fPeriod, pager.limit, pager.offset, T60]);

  useEffect(() => { pager.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, fStatus, fProp, fUnit, fCycle, fPeriod, showArchived]);

  const afterMutation = (msg?: string) => {
    bump();
    rescheduleAllNotifications(db).catch(() => {});
    if (msg) toast(msg);
  };

  const openNew = () => {
    form.reset(emptyContractForm());
    setEditingDraftId(null);
    setFormOpen(true);
  };

  const openEditDraft = (c: ContractRow) => {
    form.reset({
      tenant: c.tenant_name, phone: c.phone, idNumber: c.id_number, unitId: c.unit_id,
      value: c.value_halalas ? fmt(c.value_halalas).replace(/,/g, '') : '',
      cycle: c.cycle, start: c.start ?? '', end: c.end ?? '',
      deposit: c.deposit_halalas ? fmt(c.deposit_halalas).replace(/,/g, '') : '',
      depositHolder: (c as unknown as { deposit_holder?: string }).deposit_holder ?? 'المكتب',
      depositHolderName: (c as unknown as { deposit_holder_name?: string }).deposit_holder_name ?? '',
      ejarNo: c.ejar_no, services: c.services, furnished: c.furnished,
      typeSpecific: JSON.parse(c.type_specific || '{}'),
      pendingFile: null,
      // تحويل الحجز يُختار عند التوثيق صراحةً ولا يُحفظ في المسودة
      reservationId: '',
      // جدول الدفعات المقروء من ملف إيجار محفوظٌ مع المسودة (الهجرة ٢٤)
      schedule: (() => {
        const raw = (c as unknown as { ejar_schedule?: string | null }).ejar_schedule;
        try { return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
      })(),
      fromEjarFile: (c as unknown as { installments_source?: string | null }).installments_source ? true : undefined,
      split: {
        servicesHalalas: Number((c as unknown as { services_halalas?: number }).services_halalas ?? 0) || undefined,
        parkingHalalas: Number((c as unknown as { parking_halalas?: number }).parking_halalas ?? 0) || undefined,
      },
    });
    setEditingDraftId(c.id);
    setFormOpen(true);
  };

  // الرفض يظهر في مربع تنبيه ثابت بسببه الكامل، والحقل المسبِّب يُظلَّل بالأحمر
  const showContractError = (e: unknown, title: string) => {
    if (e instanceof RuleViolation && e.field) form.setErrorField(e.field);
    reportFailure({ title, e });
  };

  const doSaveDraft = () => {
    try {
      const id = saveDraft(db, formToInput(form.state), editingDraftId ?? undefined);
      if (form.state.pendingFile) {
        attachPicked(db, form.state.pendingFile, 'contract', id, 'lease').catch((e) => reportFailure({ title: 'تعذّر حفظ ملف العقد', e }));
      }
      setFormOpen(false);
      afterMutation('تم حفظ العقد كمسودة');
    } catch (e) { showContractError(e, 'تعذّر حفظ المسودة'); }
  };

  /** «مراجعة قبل الإنشاء» · صفحة المراجعة الإلزامية */
  const doOpenReview = () => {
    setFormOpen(false);
    setReviewOpen(true);
  };

  const [cc, setCc] = useState(GENERAL_COST_CENTER);
  const doConfirmCreate = (...a: Parameters<typeof doConfirmCreateIn>) => withCostCenter(cc, () => doConfirmCreateIn(...a));
  const doConfirmCreateIn = () => {
    try {
      const id = confirmContract(db, formToInput(form.state), editingDraftId ?? undefined);
      // ما وافق عليه المستخدم من بنود العقد المقروءة يُكتب في العقار والوحدة والمستأجر والعدادات
      if (leaseDiffs.length && approvedExtras.size) {
        applyExtras(db, leaseDiffs, approvedExtras, { unitId: form.state.unitId, tenantName: form.state.tenant, start: form.state.start, handoverRef: t('lease.handoverReading', { lng: 'ar' }) });
      }
      if (form.state.pendingFile) {
        attachPicked(db, form.state.pendingFile, 'contract', id, 'lease').catch((e) => reportFailure({ title: 'تعذّر حفظ ملف العقد', e }));
      }
      setReviewOpen(false);
      afterMutation(`تمت إضافة عقد "${form.state.tenant}"`);
      // عرض فتح نموذج الاستلام لمن له إنشاؤه وحده
      if (handoverPerm.add) dialog({
        title: 'تم توثيق العقد',
        body: 'العقد تم توثيقه بنجاح. هل تبي تفتح نموذج الاستلام الآن لتوثيق حالة الوحدة عند بداية العقد؟',
        tone: 'normal',
        actions: [
          { label: 'لاحقاً', variant: 'ghost' },
          {
            label: 'فتح النموذج', variant: 'primary',
            onPress: () => {
              const c = db.get<{ id: string }>(
                `SELECT id FROM contracts WHERE TRIM(tenant_name)=TRIM(?) ORDER BY created_at DESC LIMIT 1`,
                [form.state.tenant]
              );
              if (c) setHandoverFor(c.id);
            },
          },
        ],
      });
    } catch (e) {
      setReviewOpen(false);
      setFormOpen(true);
      showContractError(e, 'تعذّر إنشاء العقد');
    }
  };

  const doDeleteDraft = (c: ContractRow) => {
    dialog({
      title: 'حذف العقد',
      body: 'حذف هذا العقد؟',
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'حذف', variant: 'danger',
          onPress: () => {
            try {
              deleteDraft(db, c.id);
              afterMutation('تم الحذف · يمكن استعادته خلال مدة السلة من الإعدادات');
            } catch (e) { reportFailure({ title: 'تعذّر الحذف', e }); }
          },
        },
      ],
    });
  };

  // الحالة من الدالة الواحدة التي تستدعيها كل الشاشات · لا حساب مكرر فلا تناقض
  // اللون من الحالة المنطقية والنص من دالة العرض التي تكتب عدد أيام الانتهاء
  // اللون والنص من الدالتين الأمّ · فتتطابق الشارة في كل شاشة
  const statusBadge = (c: ContractRow) => (
    <Badge kind={contractStatusKind(c)} label={contractStatusLabel(c)} />
  );

  // بطاقة عقد واحدة · تُرسم افتراضياً داخل FlatList
  const renderContract = ({ item: c }: { item: ContractRow }) => {
    const draft = c.status === 'مسودة';
    // المسودة يعدّلها ويحذفها كاتبها بإدخال · وما بعدها لصاحب «كامل»
    const draftEditable = draft && perm.edit({ by: rowBy(db, 'contracts', c.id), draft: true });
    return (
        <Card style={{ paddingVertical: 10 }}>
          <Pressable onPress={() => setDetailId(c.id)}>
            {/* صف العنوان: اسم المستأجر يميناً وشارته ثم ⋮ في أقصى اليسار بمحاذاته */}
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={13.5} bold style={{ flex: 1 }}>{c.tenant_name}</T>
              <Row gap={6}>
                {statusBadge(c)}
                <ActionMenuButton title={c.tenant_name} actions={[
                  { icon: 'eye', label: 'عرض التفاصيل والدفعات', onPress: () => setDetailId(c.id) },
                  // يظهر فقط إن لم يكن للعقد مستند من نوعه · الرفع بالمسار الواحد نفسه attachPicked
                  perm.add && attachmentsFor(db, 'contract', c.id, 'lease').length === 0 ? {
                    icon: 'attach', label: 'إرفاق مستند العقد',
                    onPress: async () => {
                      const f = await pickFile(['application/pdf', 'image/*']);
                      if (!f) return;
                      attachPicked(db, f, 'contract', c.id, 'lease')
                        .then(() => afterMutation('أُرفق مستند العقد وظهر في المكتبة'))
                        .catch((e) => reportFailure({ title: 'تعذّر الإرفاق', e }));
                    },
                  } : null,
                  draftEditable ? { icon: 'edit', label: 'تعديل', onPress: () => openEditDraft(c) } : null,
                  draftEditable ? { icon: 'trash', label: 'حذف', danger: true, onPress: () => doDeleteDraft(c) } : null,
                  // النموذج يُنشأ عند فتحه · فهو إضافة في قسم الاستلام والتسليم
                  !draft && handoverPerm.add ? { icon: 'clipboard', label: 'نموذج الاستلام والتسليم', onPress: () => setHandoverFor(c.id) } : null,
                  c.status !== 'مسودة' ? { icon: 'print', label: 'كشف حساب المستأجر', onPress: () => { printTenantStatement(db, c.id).catch(() => toast('تعذّرت الطباعة')); } } : null,
                  c.status !== 'مسودة' ? { icon: 'export', label: 'طباعة العقد · نسخة المكتب', onPress: () => { printContractDoc(db, c.id).catch(() => toast('تعذّرت الطباعة')); } } : null,
                  perm.manage && canRenewContract(c) ? { icon: 'reload', label: 'تجديد العقد', onPress: () => setRenewId(c.id) } : null,
                  perm.manage && c.status !== 'ملغى' && c.status !== 'مسودة'
                    ? { icon: 'cancel', label: 'إلغاء العقد', danger: true, onPress: () => setCancelId(c.id) } : null,
                  // التقبيل لا يُسجَّل على ملغى ولا مسودة · فإن مُنع لم يُعرض زره
                  !kmPerm.add || keyMoneyBlockReason(c) ? null
                    : { icon: 'clipboard', label: 'تسجيل تقبيل', onPress: () => setKmContract(c) },
                  perm.manage && !draft ? {
                    icon: c.archived ? 'undo' : 'archive',
                    label: c.archived ? 'إلغاء الأرشفة' : 'أرشفة',
                    onPress: () => {
                      db.transaction(() => db.run(`UPDATE contracts SET archived = ? WHERE id = ?`, [c.archived ? 0 : 1, c.id]));
                      afterMutation(c.archived ? 'تم إلغاء الأرشفة' : 'تمت الأرشفة');
                    },
                  } : null,
                ]} />
              </Row>
            </Row>
            <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
              <T size={11.5} color={C.muted}>{c.unit_label} · {c.cycle}</T>
              {c.status !== 'مسودة' && c.contract_no ? <Num size={11.5} color={C.muted}>{contractDisplayId(c)}</Num> : null}
            </Row>
            <Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
              <Row gap={12}>
                <View><T size={10} color={C.muted}>{t('lease.contractTotal')}</T><Money halalas={contractTotalOf(c)} size={12} bold /></View>
                <View>
                  <T size={10} color={C.muted}>التأمين</T>
                  <Money halalas={Number(c.deposit_halalas)} size={12} bold
                    color={Number(c.deposit_halalas) > 0
                      ? depositState(
                          (c as unknown as { deposit_holder?: string }).deposit_holder,
                          (c as unknown as { deposit_holder_name?: string }).deposit_holder_name,
                          filterOpts.wallet1265.has(c.id)
                        ).fg
                      : undefined} />
                </View>
                {c.start && c.end ? <View><T size={10} color={C.muted}>المدة</T><Num size={12}>{`${dfmt(c.start)} · ${dfmt(c.end)}`}</Num></View> : null}
              </Row>
            </Row>
          </Pressable>
        </Card>
    );
  };

  return (
    <Screen title="عقود الإيجار" noBack scroll={false}
      actions={perm.add ? <BtnPrimary small title="+ عقد جديد" onPress={openNew} /> : null}>
      {/* هيكل فقط قبل الجاهزية · الرأس فيه حقل بحث أصلي يثقل أول إيداع */}
      {!ready ? <Skeleton rows={6} /> : (
      <FlatList
        data={rows}
        keyExtractor={(c) => c.id}
        renderItem={renderContract}
        ListHeaderComponent={
          <View>
            <FilterBar
              search={
                <Row>
                  <View style={{ flex: 1 }}><SearchBox value={q} onChange={setQ} /></View>
                  <ActionMenuButton title="الترتيب والأرشيف" actions={[
                    { label: 'ترتيب حسب: التاريخ', onPress: () => setSortKey('start') },
                    { label: 'ترتيب حسب: الرقم', onPress: () => setSortKey('contract_no') },
                    { label: 'ترتيب حسب: القيمة', onPress: () => setSortKey('value_halalas') },
                    { label: 'ترتيب حسب: المستأجر', onPress: () => setSortKey('tenant_name') },
                    { icon: 'archive', label: showArchived ? 'عرض العقود النشطة' : 'عرض الأرشيف', onPress: () => setShowArchived((v) => !v) },
                  ]} />
                </Row>
              }
              total={allRows}
              filtered={totalRows}
              itemName="عقداً"
              chips={([
                fStatus ? { key: 'st', label: fStatus, onClear: () => setFStatus('') } : null,
                fProp ? { key: 'pr', label: filterOpts.props.find((x) => x.id === fProp)?.name ?? 'عقار', onClear: () => { setFProp(''); setFUnit(''); } } : null,
                fUnit ? { key: 'un', label: 'وحدة ' + (filterOpts.units.find((x) => x.id === fUnit)?.unit_no ?? ''), onClear: () => setFUnit('') } : null,
                fPeriod ? { key: 'pe', label: fPeriod === 'month' ? 'سارية هذا الشهر' : fPeriod === 'quarter' ? 'سارية هذا الربع' : 'سارية هذه السنة', onClear: () => setFPeriod('') } : null,
                fCycle ? { key: 'cy', label: fCycle, onClear: () => setFCycle('') } : null,
              ].filter(Boolean)) as ActiveChip[]}
              onOpen={fsheet.show}
              onClearAll={clearFilters}
              resultCount={totalRows}
            />
          </View>
        }
        ListFooterComponent={<Pager pager={pager} total={totalRows} />}
        ListEmptyComponent={ready ? <Card><EmptyState>لا توجد عقود مطابقة</EmptyState></Card> : <View style={{ paddingTop: 4 }}><Skeleton rows={6} /></View>}
        initialNumToRender={6}
        maxToRenderPerBatch={10}
        windowSize={5}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      />
      )}

      <FilterSheet open={fsheet.open} onClose={fsheet.hide} onClearAll={clearFilters} resultCount={totalRows}>
        <T size={11.5} color={C.muted} style={{ marginBottom: 5 }}>الحالة</T>
        <ChipGroup
          options={[['', 'الكل'], ['سارٍ', 'سارٍ'], ['ينتهي قريباً', 'ينتهي قريباً'], ['موثَّق ولم يبدأ', 'موثَّق ولم يبدأ'], ['منتهٍ', 'منتهٍ'], ['مسودة', 'مسودة'], ['ملغى', 'ملغى']]}
          value={fStatus} onChange={setFStatus} />
        <Row style={{ marginTop: 8 }}>
          <View style={{ flex: 1 }}>
            <SelectField label="العقار" value={fProp}
              options={[{ value: '', label: 'كل العقارات' }, ...filterOpts.props.map((pr) => ({ value: pr.id, label: pr.name }))]}
              onPick={(v) => { setFProp(v); setFUnit(''); }} />
          </View>
          <View style={{ flex: 1 }}>
            <SelectField label="الوحدة" value={fUnit}
              options={[{ value: '', label: 'كل الوحدات' }, ...filterOpts.units.map((u) => ({ value: u.id, label: u.unit_no }))]}
              onPick={setFUnit}
              emptyText="اختر عقاراً أولاً" />
          </View>
        </Row>
        <T size={11.5} color={C.muted} style={{ marginBottom: 5 }}>الفترة</T>
        <ChipGroup
          options={[['', 'الكل'], ['month', 'سارية هذا الشهر'], ['quarter', 'سارية هذا الربع'], ['year', 'سارية هذه السنة']]}
          value={fPeriod} onChange={setFPeriod} />
        <T size={11.5} color={C.muted} style={{ marginVertical: 5 }}>الدورية</T>
        <ChipGroup
          options={[['', 'الكل'], ...CYCLE_OPTIONS.map((cy) => [cy, cy] as [string, string])]}
          value={fCycle} onChange={setFCycle} />
      </FilterSheet>

      {/* نافذة عقد جديد / تعديل مسودة */}
      <Sheet
        visible={formOpen}
        onClose={() => setFormOpen(false)}
        title={editingDraftId ? 'تعديل عقد الإيجار' : 'عقد إيجار جديد'}
        tall
        footer={
          <>
            <View style={{ flex: 1 }}><BtnGhost title="حفظ كمسودة" onPress={doSaveDraft} /></View>
            <View style={{ flex: 1 }}><BtnPrimary title="مراجعة قبل الإنشاء" onPress={doOpenReview} /></View>
          </>
        }
      >
        <ContractFormFields form={form} />
      </Sheet>

      {/* صفحة المراجعة الإلزامية */}
      <ReviewSheet
        visible={reviewOpen}
        form={form.state}
        onBack={() => { setReviewOpen(false); setFormOpen(true); }}
        onConfirm={doConfirmCreate}
        cc={cc} onCc={setCc}
        leaseDiffs={leaseDiffs} approved={approvedExtras} onApproved={setApprovedExtras}
        db={db}
      />

      {detailId && (
        <ContractDetailSheet
          contractId={detailId}
          onClose={() => setDetailId(null)}
          onOpenRating={() => setRatingId(detailId)}
          onOpenSettlement={() => setSettleId(detailId)}
        />
      )}
      {renewId && <RenewSheet contractId={renewId} onClose={() => setRenewId(null)} onDone={afterMutation} />}
      {cancelId && <CancelSheet contractId={cancelId} onClose={() => setCancelId(null)} onDone={(msg) => {
        afterMutation(msg);
        if (handoverPerm.add) dialog({
          title: 'تم إلغاء العقد',
          body: 'تم إلغاء العقد. هل تبي تفتح نموذج التسليم الآن لتوثيق حالة الوحدة عند إخلائها؟',
          tone: 'normal',
          actions: [
            { label: 'لاحقاً', variant: 'ghost' },
            { label: 'فتح النموذج', variant: 'primary', onPress: () => setHandoverFor(cancelId) },
          ],
        });
      }} />}
      {handoverFor && (
        <HandoverSheet
          contractId={handoverFor}
          onClose={() => setHandoverFor(null)}
          onSaved={() => { setHandoverFor(null); afterMutation(); }}
        />
      )}
      {ratingId && <RatingSheet contractId={ratingId} onClose={() => setRatingId(null)} onDone={afterMutation} />}
      {settleId && <SettlementSheet contractId={settleId} onClose={() => setSettleId(null)} onDone={afterMutation} />}
      {kmContract && (
        <KeyMoneySheet contract={kmContract} onClose={() => setKmContract(null)} onDone={afterMutation} />
      )}
    </Screen>
  );
}

/* ═══════════ صفحة المراجعة الإلزامية ═══════════ */
import type { DB } from '../../src/db/adapter';
import type { ContractFormState } from '../../src/ui/contractForm';
import { reportFailure } from '../../src/ui/failureDialog';

import { CostCenterField } from '../../src/ui/CostCenters';
import { ScheduleReview } from '../../src/ui/ScheduleReview';
import { formSplit } from '../../src/ui/contractForm';
import { LeaseCompare, useLeaseDiffs } from '../../src/ui/LeaseCompare';
import { applyExtras, type ExtraDiff, type ExtraKey } from '../../src/domain/pdf/ejarExtras';
import { useLang } from '../../src/i18n';
import { GENERAL_COST_CENTER, withCostCenter } from '../../src/domain/accounting/dimensions';
import { contractTotalOf, contractTotalSql } from '../../src/domain/accounting/rentSplit';
function ReviewSheet({
  visible, form, onBack, onConfirm, db, cc, onCc, leaseDiffs, approved, onApproved,
}: { visible: boolean; form: ContractFormState; onBack: () => void; onConfirm: () => void; db: DB; cc: string; onCc: (v: string) => void;
  leaseDiffs: ExtraDiff[]; approved: Set<ExtraKey>; onApproved: (s: Set<ExtraKey>) => void }) {
  const u = form.unitId
    ? db.get<{ unit_no: string; property_id: string }>(`SELECT unit_no, property_id FROM units WHERE id = ?`, [form.unitId])
    : undefined;
  const p = u ? db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [u.property_id]) : undefined;
  const months = form.start && form.end ? Math.max(1, approxMonths(form.start, form.end)) : 0;
  const per = ({ 'شهرية': 1, 'ربع سنوية': 3, 'نصف سنوية': 6, 'سنوية': 12 } as Record<string, number>)[form.cycle] || 1;
  const n = Math.max(1, Math.round(months / per));
  const each = toHalalas(form.value) / n;
  const rows: Array<[string, React.ReactNode]> = [
    ['المستأجر', form.tenant], ['الجوال', form.phone], ['الهوية / السجل', form.idNumber],
    ['العقار', p?.name ?? ''], ['الوحدة', u?.unit_no ?? ''],
    ['قيمة العقد', fmt(toHalalas(form.value))], ['الدورية', form.cycle],
    ['البداية', dfmt(form.start)], ['النهاية', dfmt(form.end)],
    ['المدة', months + ' شهراً'],
    ['عدد الدفعات', n + ' دفعة × ' + fmt(Math.round(each))],
    ['التأمين', fmt(toHalalas(form.deposit))],
    ['رقم إيجار', form.ejarNo], ['الخدمات المشمولة', form.services],
    ['الأثاث', form.furnished],
  ];
  return (
    <Sheet
      visible={visible}
      onClose={onBack}
      title="مراجعة بيانات العقد"
      tall
      footer={
        <>
          <View style={{ flex: 1, justifyContent: 'center' }}><BackButton onPress={onBack} /></View>
          <View style={{ flex: 1 }}><BtnPrimary title="تأكيد وإنشاء العقد" onPress={onConfirm} /></View>
        </>
      }
    >
      {/* الخانة الفارغة لا تظهر هي ولا عنوانها · والصفر قيمة تُعرض */}
      {rows.filter(([, v]) => v != null && v !== '' && v !== false).map(([k, v]) => (
        <Row key={k} style={{ justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <T size={12} color={C.muted}>{k}</T>
          <T size={12.5} bold>{v}</T>
        </Row>
      ))}
      <View style={{ marginTop: 12 }}>
        <ScheduleReview start={form.start} end={form.end} value={form.value} cycle={form.cycle} schedule={form.schedule} fromEjarFile={form.fromEjarFile} financial={form.extras?.financial} split={formSplit(form)} />
        <LeaseCompare extras={form.extras} diffs={leaseDiffs} approved={approved} onChange={onApproved} />
        <CostCenterField value={cc} onChange={onCc} />
        <Note>بعد الإنشاء لا يمكن تعديل العقد أو حذفه · يُلغى فقط.</Note>
      </View>
    </Sheet>
  );
}

/* ═══════════ تفاصيل العقد والدفعات ═══════════ */
function ContractDetailSheet({
  contractId, onClose, onOpenRating, onOpenSettlement,
}: { contractId: string; onClose: () => void; onOpenRating: () => void; onOpenSettlement: () => void }) {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const router = useRouter();
  const access = useAccess();
  const perm = usePerm('contracts');
  const depPerm = usePerm('deposits');
  const collectPerm = usePerm('collect');
  const seesPurchases = routeAllowed(access, '/purchases');
  const { t } = useLang();
  const [occEditing, setOccEditing] = useState<OccupantRow | null>(null);
  const [instFor, setInstFor] = useState<string | null>(null);
  const [expOpen, setExpOpen] = useState(false);
  /** إضافة الساكن وتعديله في ورقته الخاصة فوق العقد (قرار المالك 2026-10-07) */
  const [occOpen, setOccOpen] = useState(false);
  const onAddOccupant = () => { setOccEditing(null); setOccOpen(true); };
  const onEditOccupant = (o: OccupantRow) => { setOccEditing(o); setOccOpen(true); };
  const c = useMemo(
    () => db.get<ContractRow>(`SELECT * FROM contracts WHERE id = ?`, [contractId]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, contractId, version]
  );
  if (!c) return null;
  const insts = db.all<{ id: string; due_date: string; amount_halalas: number; paid_halalas: number; discount: number; status: string; agreed_date: string | null; grace_until: string | null }>(
    `SELECT i.id, i.due_date, i.amount_halalas, i.paid_halalas, ${INSTALLMENT_DISCOUNT_SQL} AS discount, i.status, i.agreed_date, i.grace_until
     FROM contract_installments i
     WHERE i.contract_id = ? ORDER BY i.due_date`,
    [contractId]
  );
  // الأقساط التي لها سند فعلاً · زر «سند القبض» لا يُعرض لقسط بلا دفعة مسجَّلة
  const receiptIds = new Set(
    db.all<{ iid: string }>(
      `SELECT DISTINCT p.installment_id AS iid FROM contract_payments p
       WHERE p.contract_id = ? AND p.installment_id IS NOT NULL AND p.cancelled_at IS NULL
       UNION
       SELECT DISTINCT a.installment_id AS iid FROM payment_allocations a
       JOIN contract_payments p ON p.id = a.payment_id WHERE p.contract_id = ? AND p.cancelled_at IS NULL`,
      [contractId, contractId]
    ).map((r) => r.iid)
  );
  // القسمان: المستحق غير المسدَّد أولاً · ثم سجل المسدَّد كلياً والملغى
  // المتبقي يطرح الخصم (المراجعة ٤.١٠) · فالمسدَّد مع خصم في السجل لا في المستحق
  const instRem = (i: (typeof insts)[number]) => installmentRemaining(Number(i.amount_halalas), Number(i.paid_halalas), Number(i.discount));
  const dueInsts = insts.filter((i) => instRem(i) > 0 && i.status !== 'ملغية');
  const historyInsts = insts.filter((i) => instRem(i) <= 0 || i.status === 'ملغية');
  const occupants = occupantsOf(db, contractId);
  const settlement = db.get<{ date: string; deduction_halalas: number; deduction_reason: string; refund_halalas: number; notes: string }>(
    `SELECT * FROM deposit_settlements WHERE contract_id = ?`, [contractId]
  );
  const rating = db.get<{ on_time: string; payment_commit: string; contract_commit: string; unit_condition: string; neighbor_complaints: string; notes: string }>(
    `SELECT * FROM tenant_ratings WHERE contract_id = ?`, [contractId]
  );
  const totalPaid = Number(db.get<{ s: number }>(
    `SELECT COALESCE(SUM(net_halalas),0) AS s FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL`, [contractId]
  )!.s);
  const ended = contractEnded(c);
  const overall = rating
    ? tenantRatingOverall({
        onTime: rating.on_time, paymentCommit: rating.payment_commit, contractCommit: rating.contract_commit,
        unitCondition: rating.unit_condition, neighborComplaints: rating.neighbor_complaints, notes: rating.notes,
      })
    : null;
  const instBadge = (i: (typeof insts)[number]) => {
    let display = i.status;
    if (i.status === 'مستحقة' && i.due_date > today()) display = 'قادمة';
    const map: Record<string, string> = { 'مستحقة': 'due', 'قادمة': 'draft', 'متأخرة': 'overdue', 'مدفوعة': 'paid', 'مدفوعة جزئياً': 'due', 'ملغية': 'draft' };
    const rem = installmentRemaining(Number(i.amount_halalas), Number(i.paid_halalas), Number(i.discount));
    const note = i.status === 'مدفوعة جزئياً' && rem > 0 ? ` (متبقي ${fmt(rem)})` : '';
    return <Badge kind={map[display] || 'draft'} label={display + note} />;
  };
  // صف قسط واحد · مشترك بين قسمي المستحق والسجل · الضغط يفتح تفاصيل القسط
  const renderInst = (i: (typeof insts)[number]) => {
    const remaining = installmentRemaining(Number(i.amount_halalas), Number(i.paid_halalas), Number(i.discount));
    // زر «تحصيل» تسجيل دفعة · لصاحب الإضافة في التحصيل
    // متأخرات العقد الملغى تُحصَّل (المراجعة ٤.٩)
    const payable = collectPerm.add && remaining > 0 && i.status !== 'ملغية';
    return (
      <Pressable key={i.id} onPress={() => setInstFor(i.id)}
        style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Row gap={6}>
            <T size={12.5} med>{periodLabel(i.due_date)}</T>
            {i.agreed_date ? <Badge kind="due" label="موعد متفق عليه" /> : null}
          </Row>
          {instBadge(i)}
        </Row>
        <Row style={{ justifyContent: 'space-between', marginTop: 3 }}>
          <Num size={11.5} color={i.agreed_date ? '#1D4ED8' : C.muted}>{dfmt(i.agreed_date ?? i.due_date)}</Num>
          <Row gap={8}>
            <Money halalas={Number(i.amount_halalas)} size={12} bold />
            {payable ? (
              <BtnPrimary small title="تحصيل" onPress={() => { onClose(); router.push(`/collect?pay=${i.id}`); }} />
            ) : remaining <= 0 && i.status !== 'ملغية' && receiptIds.has(i.id) ? (
              <BtnGhost small icon="print" title="سند القبض" onPress={() => {
                const pid = paymentForInstallment(db, i.id);
                if (pid) printReceipt(db, pid, 'tenant').catch(() => toast('تعذّرت الطباعة'));
                else toast('لا سند لهذا القسط · سُدّد قبل اعتماد السندات');
              }} />
            ) : null}
          </Row>
        </Row>
      </Pressable>
    );
  };
  return (
    <Sheet visible onClose={onClose} title={['عقد' + (c.status !== 'مسودة' && c.contract_no ? ' ' + contractDisplayId(c) : ''), c.tenant_name].join(' · ')} tall>
      <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        {c.unit_label ? <View><T size={11} color={C.muted}>الوحدة</T><T size={12.5} med>{c.unit_label}</T></View> : null}
        <View><T size={11} color={C.muted}>الحالة</T><T size={12.5} med>{contractStatusLabel(c)}</T></View>
      </Row>
      <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        {c.start ? <View><T size={11} color={C.muted}>من</T><Num size={12.5}>{dfmt(c.start)}</Num></View> : null}
        {c.end ? <View><T size={11} color={C.muted}>إلى</T><Num size={12.5}>{dfmt(c.end)}</Num></View> : null}
        {c.ejar_no ? <View><T size={11} color={C.muted}>رقم إيجار</T><Num size={12.5}>{c.ejar_no}</Num></View> : null}
        {c.furnished ? <View><T size={11} color={C.muted}>الأثاث</T><T size={12.5}>{c.furnished}</T></View> : null}
      </Row>
      {Number(c.deposit_halalas) > 0 ? (() => {
        // الرقم الملوّن وحده في التفاصيل والقوائم · النص للمطبوعات وحدها (label)
        const dst = depositState(
          (c as unknown as { deposit_holder?: string }).deposit_holder,
          (c as unknown as { deposit_holder_name?: string }).deposit_holder_name,
          !!db.get(
            `SELECT contract_id FROM deposit_settlements WHERE contract_id = ? AND deduction_halalas > 0 AND deduct_destination = 'محفظة إيجار'`,
            [contractId]
          )
        );
        return (
          <View style={{ marginBottom: 6 }}>
            <T size={11} color={C.muted}>التأمين</T>
            <Money halalas={Number(c.deposit_halalas)} size={12.5} bold color={dst.fg} />
          </View>
        );
      })() : null}
      {c.services ? <View style={{ marginBottom: 6 }}><T size={11} color={C.muted}>الخدمات المشمولة</T><T size={12.5}>{c.services}</T></View> : null}
      {/* إجمالي العقد وتفصيله (المراجعة #5) · يغيب إن لم يكن فيه خدمات ولا مواقف */}
      {contractTotalOf(c as never) !== Number(c.value_halalas) ? (
        <View style={{ marginBottom: 6 }}>
          <T size={11} color={C.muted}>{t('lease.contractTotal')}</T>
          <Money halalas={contractTotalOf(c as never)} size={12.5} bold />
          <T size={11} color={C.muted}>{t('lease.splitLine', {
            rent: fmt(Number(c.value_halalas)),
            services: fmt(Number((c as unknown as { services_halalas?: number }).services_halalas ?? 0)),
            parking: fmt(Number((c as unknown as { parking_halalas?: number }).parking_halalas ?? 0)),
          })}</T>
        </View>
      ) : null}
      <ContractFileButton contractId={contractId} linked={'عقد ' + (c.contract_no || c.tenant_name)} />

      {/* دخل العقد ومصاريفه */}
      {(() => {
        const income = db.get<{ s: number }>(
          `SELECT COALESCE(SUM(net_halalas),0) AS s FROM contract_payments WHERE contract_id = ? AND cancelled_at IS NULL`,
          [contractId]
        )!.s;
        const expenses = c.unit_id
          ? db.get<{ s: number }>(
              `SELECT COALESCE(SUM(total_halalas),0) AS s FROM purchases
               WHERE deleted_at IS NULL AND unit_id = ?
                 AND (? IS NULL OR date >= ?) AND (? IS NULL OR date <= ?)`,
              [c.unit_id, c.start, c.start, c.end, c.end]
            )!.s
          : 0;
        const net = Number(income) - Number(expenses);
        return (
          <View style={{ backgroundColor: C.paper, borderRadius: 9, padding: 11, marginTop: 8, marginBottom: 6 }}>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 3 }}>
              <T size={12}>دخل العقد (المحصَّل)</T>
              <Money halalas={Number(income)} size={12.5} bold color={C.emerald} />
            </Row>
            <Pressable onPress={() => setExpOpen((v) => !v)}>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 3 }}>
                <T size={12}>مصاريف الوحدة خلال مدته</T>
                <Money halalas={Number(expenses)} size={12.5} bold color={C.rose} />
              </Row>
            </Pressable>
            {expOpen && c.unit_id ? db.all<{ id: string; no: string; supplier_name: string; date: string; total_halalas: number }>(
              `SELECT id, no, supplier_name, date, total_halalas FROM purchases
               WHERE deleted_at IS NULL AND unit_id = ?
                 AND (? IS NULL OR date >= ?) AND (? IS NULL OR date <= ?) ORDER BY date DESC`,
              [c.unit_id, c.start, c.start, c.end, c.end]
            ).map((pu) => (
              <Pressable key={pu.id} disabled={!seesPurchases} onPress={() => { onClose(); router.push(`/purchases?detail=${pu.id}`); }}>
                <Row style={{ justifyContent: 'space-between', paddingVertical: 4, paddingStart: 10 }}>
                  <Num size={11} color={C.muted}>{pu.supplier_name} · {dfmt(pu.date)}</Num>
                  <Money halalas={Number(pu.total_halalas)} size={11.5} />
                </Row>
              </Pressable>
            )) : null}
            <Row style={{ justifyContent: 'space-between', paddingVertical: 3, borderTopWidth: 1, borderTopColor: C.line }}>
              <T size={12} bold>الصافي</T>
              <Money halalas={net} size={12.5} bold color={net >= 0 ? C.emerald : C.rose} />
            </Row>
          </View>
        );
      })()}


      {ended && (
        <>
          <Row style={{ justifyContent: 'space-between', marginTop: 12, marginBottom: 8 }}>
            <T size={13.5} bold color={C.ink}>التصرف بالتأمين</T>
            {(settlement ? depPerm.manage : depPerm.add) && !depositCarried(db, c.id)
              ? <BtnGhost small icon="edit" title={settlement ? 'تعديل التسوية' : 'تسجيل التسوية'} onPress={onOpenSettlement} />
              : null}
          </Row>
          {settlement ? (
            <View>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
                <T size={12}>تاريخ التسوية</T><Num size={12}>{dfmt(settlement.date)}</Num>
              </Row>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
                <T size={12}>الخصم من التأمين</T>
                <Num size={12}>{fmt(Number(settlement.deduction_halalas))} {settlement.deduction_reason ? '· ' + settlement.deduction_reason : ''}</Num>
              </Row>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
                <T size={12}>المسترَد للمستأجر</T><Money halalas={Number(settlement.refund_halalas)} size={12} />
              </Row>
            </View>
          ) : (
            <T size={12} color={C.muted}>لم تُسجَّل تسوية للتأمين بعد (المبلغ الأصلي: {fmt(Number(c.deposit_halalas))})</T>
          )}

          <Row style={{ justifyContent: 'space-between', marginTop: 14, marginBottom: 8 }}>
            <Row gap={6}>
              <T size={13.5} bold color={C.ink}>تقييم المستأجر</T>
              {overall ? <Badge kind={overall.cls} label={overall.label} /> : null}
            </Row>
            {(rating ? perm.manage : perm.add)
              ? <BtnGhost small icon="edit" title={rating ? 'تعديل' : 'تقييم الآن'} onPress={onOpenRating} />
              : null}
          </Row>
          {rating ? (
            <View>
              {[['السداد في الوقت المحدَّد', rating.on_time], ['الالتزام العام بالسداد', rating.payment_commit],
                ['الالتزام ببنود العقد', rating.contract_commit], ['تسليم الوحدة بحالة الاستلام', rating.unit_condition],
                ['شكاوى من الجيران', rating.neighbor_complaints]].map(([k, v]) => (
                <Row key={k} style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
                  <T size={12}>{k}</T><T size={12} med>{v}</T>
                </Row>
              ))}
            </View>
          ) : <T size={12} color={C.muted}>لم يُقيَّم المستأجر بعد</T>}
        </>
      )}

      {c.status === 'ملغى' && (
        <View style={{ backgroundColor: C.roseSoft, borderRadius: 9, padding: 11, marginTop: 12 }}>
          <T size={13} bold>تفاصيل الإلغاء</T>
          <T size={12} style={{ marginTop: 4 }}>تاريخ الإنهاء: {dfmt(c.cancel_date)}</T>
          {c.cancel_reason ? <T size={12}>السبب: {c.cancel_reason}</T> : null}
          {c.cancel_deduction_halalas != null ? (
            <T size={12}>الخصم من التأمين: {fmt(Number(c.cancel_deduction_halalas))} {c.cancel_deduction_reason ? '· ' + c.cancel_deduction_reason : ''}</T>
          ) : null}
          {c.cancel_refund_halalas != null ? <T size={12}>المسترَد للمستأجر: {fmt(Number(c.cancel_refund_halalas))}</T> : null}
        </View>
      )}

      <ContractAttachments contractId={contractId} linked={'عقد ' + (c.contract_no || c.tenant_name)} />
      <Row style={{ justifyContent: 'space-between', marginTop: 14, marginBottom: 8 }}>
        <T size={13.5} bold color={C.ink}>ساكنو الوحدة ({occupants.filter((o) => !o.moved_out).length})</T>
        {/* العقد الملغى لا يُسكَّن فيه أحد · يبقى سجل ساكنيه للعرض وحده */}
        {c.status === 'ملغى' || !perm.add ? null : <BtnGhost small title="+ إضافة ساكن" onPress={() => onAddOccupant()} />}
      </Row>
      {occOpen ? <OccupantSheet contractId={contractId} editing={occEditing} onClose={() => setOccOpen(false)} /> : null}
      {occupants.length ? occupants.map((o) => (
        <Row key={o.id} style={{ justifyContent: 'space-between', paddingVertical: 5, opacity: o.moved_out ? 0.55 : 1 }}>
          <View style={{ flex: 1 }}>
            <T size={12.5}>{o.name} · {o.relation}</T>
            <Num size={11} color={C.muted}>
              {o.national_id}{o.national_id && o.phone ? ' · ' : ''}{o.phone}
              {o.moved_out ? ' · غادر ' + dfmt(o.moved_out) : ''}
            </Num>
          </View>
          <ActionMenuButton title={o.name} actions={[
            perm.manage ? { icon: 'edit', label: 'تعديل', onPress: () => onEditOccupant(o) } : null,
            ...(perm.manage && !o.moved_out ? [{
              icon: 'undo' as const, label: 'تسجيل مغادرة',
              onPress: () => {
                markOccupantLeft(db, o.id, today());
                bump(); toast('سُجّلت المغادرة وبقي في السجل بتاريخه');
              },
            }] : []),
            // هوية الساكن مرفوعة أصلاً · لا يُعرض إرفاقها ثانيةً
            !perm.add || attachmentsFor(db, 'occupant', o.id, 'tenant_id').length ? null : {
              icon: 'attach' as const, label: 'إرفاق صورة الهوية',
              onPress: async () => {
                const f = await pickFile();
                if (f) attachPicked(db, f, 'occupant', o.id, 'tenant_id')
                  .then(() => { bump(); toast('حُفظت الهوية في المكتبة تحت هويات المستأجرين'); })
                  .catch((e) => reportFailure({ title: 'تعذّر الإرفاق', e }));
              },
            },
            !perm.manage ? null : { icon: 'trash', label: 'حذف', danger: true, onPress: () => {
              dialog({
                title: 'حذف الساكن',
                body: o.name + '؟',
                tone: 'danger',
                actions: [
                  { label: 'تراجع', variant: 'ghost' },
                  { label: 'حذف', variant: 'danger', onPress: () => { deleteOccupant(db, o.id); bump(); toast('حُذف'); } },
                ],
              });
            } },
          ]} />
        </Row>
      )) : <T size={12} color={C.muted}>لم يُضَف ساكنون بعد</T>}

      <T size={13.5} bold color={C.ink} style={{ marginTop: 14, marginBottom: 8 }}>
        جدول الدفعات المستحقة ({dueInsts.length})
      </T>
      {/* عقد قُرئ من ملف إيجار وتعذّر جدول دفعاته: التواريخ محسوبة لا مقروءة (قرار المالك ٢٠٢٦-١٠-٠٥) */}
      {(c as unknown as { installments_source?: string | null }).installments_source === 'محسوبة' ? (
        <Note>تواريخ الأقساط محسوبة لا مقروءة: تعذّرت قراءة جدول الدفعات من ملف إيجار · طابقها بالجدول في الملف.</Note>
      ) : null}
      {dueInsts.length ? dueInsts.map(renderInst) : <T size={12} color={C.muted}>لا دفعات مستحقة</T>}

      <T size={13.5} bold color={C.ink} style={{ marginTop: 14, marginBottom: 8 }}>
        سجل دفعات الإيجار ({historyInsts.length}) · إجمالي محصَّل: {fmt(totalPaid)}
      </T>
      {historyInsts.length ? historyInsts.map(renderInst) : <T size={12} color={C.muted}>لا توجد دفعات مسجَّلة بعد</T>}
      {instFor ? (
        <InstallmentSheet installmentId={instFor}
          onClose={() => setInstFor(null)}
          onCollect={(iid) => { setInstFor(null); onClose(); router.push(`/collect?pay=${iid}`); }} />
      ) : null}
      <View style={{ height: 16 }} />
    </Sheet>
  );
}

/**
 * مستندات العقد في التفاصيل · عرض وفتح فقط بلا زر «إضافة مرفق» في كل الحالات
 * (بلا مرفقات يظهر «لا مرفقات بعد» وحده) · الإرفاق من قائمة ⋮ عبر إجراء
 * «إرفاق مستند العقد» أو من نموذج الإنشاء وحدهما.
 */
function ContractAttachments({ contractId, linked }: { contractId: string; linked: string }) {
  return (
    <AttachStrip section="contracts" entityType="contract" entityId={contractId} kind="lease"
      linked={linked} title="مستندات العقد" hideAdd />
  );
}

/** زر فتح ملف العقد الأصلي إن وُجد · يفتح العارض الداخلي، والمشاركة زر داخله */
function ContractFileButton({ contractId, linked }: { contractId: string; linked: string }) {
  const { db, version, bump } = useApp();
  const [open, setOpen] = useState(false);
  const att = useMemo(() => attachmentsFor(db, 'contract', contractId, 'lease')[0],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, contractId]);
  if (!att) return null;
  const file: ViewerFile = {
    attId: att.id, sha256: att.sha256, ext: att.ext,
    name: att.display_name || att.original_name || 'مستند',
    mime: att.mime, sizeBytes: Number(att.size_bytes), createdAt: att.created_at,
    cat: att.cat_override || att.kind, linked,
  };
  return (
    <View style={{ marginBottom: 8 }}>
      <BtnGhost small icon="attach" title="فتح ملف العقد الأصلي" onPress={() => setOpen(true)} />
      {open && (
        <FileViewer section="contracts" files={[file]} startIndex={0}
          onClose={() => setOpen(false)} onMutated={() => bump()} />
      )}
    </View>
  );
}

/* ═══════════ التجديد ═══════════ */
function RenewSheet({ contractId, onClose, onDone }: { contractId: string; onClose: () => void; onDone: (msg?: string) => void }) {
  const { db } = useApp();
  const toast = useToast();
  const depPerm = usePerm('deposits');
  const c = db.get<ContractRow>(`SELECT * FROM contracts WHERE id = ?`, [contractId])!;
  const defaultStart = c.end ? addDays(c.end, 1) : today();
  const [start, setStart] = useState(defaultStart);
  const [durMonths, setDurMonths] = useState<string>('12');
  const [customEnd, setCustomEnd] = useState('');
  const [value, setValue] = useState(fmt(Number(c.value_halalas)).replace(/,/g, ''));
  const [raise, setRaise] = useState('');
  const [cycle, setCycle] = useState(c.cycle || 'سنوية');
  const [carry, setCarry] = useState(Number(c.deposit_halalas) > 0);
  const [extraDeposit, setExtraDeposit] = useState('');
  const [services, setServices] = useState(c.services || '');
  const [furnished, setFurnished] = useState(c.furnished || '');
  const [ejar, setEjar] = useState('');
  const [note, setNote] = useState('');
  // الخدمات والمواقف تنتقل من العقد السابق وتدخل الأقساط وفصل الإيراد (المراجعة #3)
  const cx = c as ContractRow & { services_halalas?: number; parking_halalas?: number };
  const [servicesAmt, setServicesAmt] = useState(Number(cx.services_halalas ?? 0) ? fmt(Number(cx.services_halalas)).replace(/,/g, '') : '');
  const [parkingAmt, setParkingAmt] = useState(Number(cx.parking_halalas ?? 0) ? fmt(Number(cx.parking_halalas)).replace(/,/g, '') : '');
  const { t } = useLang();

  const end = durMonths === 'custom'
    ? customEnd
    : start ? contractEndFromDuration(start, Number(durMonths)) : '';
  const valueH = toHalalas(value);
  const totalDep = (carry ? Number(c.deposit_halalas) : 0) + toHalalas(extraDeposit);
  const totalH = valueH + toHalalas(servicesAmt) + toHalalas(parkingAmt);
  const ins = start && end && valueH ? generateInstallments(start, end, totalH, cycle) : [];
  const warns = renewWarnings(db, contractId, { start, end, valueHalalas: valueH });
  const block = renewBlockReason(c);
  // المتبقي من الأقساط الحيّة بعد المسدَّد والخصم (المراجعة #8)
  const due = contractRemainingHalalas(db, contractId);

  const applyRaise = (r: string) => {
    setRaise(r);
    const pct = parseFloat(r);
    if (!isNaN(pct)) setValue(String(Math.round((Number(c.value_halalas) * (1 + pct / 100))) / 100));
  };

  const [cc, setCc] = useState(GENERAL_COST_CENTER);
  const confirm = (...a: Parameters<typeof confirmIn>) => withCostCenter(cc, () => confirmIn(...a));
  const confirmIn = () => {
    try {
      renewContract(db, contractId, {
        start, end, valueHalalas: valueH, cycle,
        carryDeposit: carry, extraDepositHalalas: toHalalas(extraDeposit),
        services, furnished, ejarNo: ejar, note,
        servicesHalalas: toHalalas(servicesAmt), parkingHalalas: toHalalas(parkingAmt),
      });
      onClose();
      onDone('جُدِّد العقد بنجاح');
    } catch (e) { reportFailure({ title: 'تعذّر التجديد', e }); }
  };

  return (
    <Sheet visible onClose={onClose} title="تجديد العقد" tall
      footer={
        <>
          {/* التجديد المرفوض لا يُعرض زره · سببه معروض فوق بلونه */}
          {!block && warns.length === 0 && start && end && valueH > 0 ? (
            <View style={{ flex: 1 }}><BtnPrimary title="تنفيذ التجديد" onPress={confirm} /></View>
          ) : null}
        </>
      }>
      <View style={{ backgroundColor: C.paper, borderRadius: 8, padding: 11, marginBottom: 12 }}>
        <T size={12.5} bold>{[c.tenant_name, c.unit_label, c.status !== 'مسودة' && c.contract_no ? contractDisplayId(c) : ''].filter(Boolean).join(' · ')}</T>
        <T size={11.5} color={C.muted} style={{ marginTop: 3 }}>
          العقد الحالي: {dfmt(c.start)} إلى {dfmt(c.end)} · القيمة {fmt(Number(c.value_halalas))} · التأمين {fmt(Number(c.deposit_halalas))}
        </T>
        {due > 0 ? <T size={11.5} bold color={C.rose} style={{ marginTop: 4 }}>متبقٍ غير مسدَّد على العقد الحالي: {fmt(due)}</T> : null}
      </View>
      {block ? <Note tone="danger">{block}</Note> : null}
      <DateField label="تاريخ بداية العقد الجديد" value={start} onChange={setStart} />
      <CostCenterField value={cc} onChange={setCc} />
      <SelectField
        label="مدة العقد الجديد" value={durMonths}
        options={[
          { value: '3', label: '٣ أشهر' }, { value: '6', label: '٦ أشهر' },
          { value: '12', label: 'سنة واحدة' }, { value: '24', label: 'سنتان' },
          { value: '36', label: '٣ سنوات' }, { value: 'custom', label: 'مدة مخصَّصة' },
        ]}
        onPick={setDurMonths}
      />
      {durMonths === 'custom' && <DateField label="تاريخ نهاية العقد الجديد" value={customEnd} onChange={setCustomEnd} />}
      <Row>
        <View style={{ flex: 1 }}><Field label="قيمة العقد الجديدة" value={value} onChange={setValue} keyboard="numeric" ltr /></View>
        <View style={{ flex: 1 }}><Field label="نسبة الزيادة ٪" value={raise} onChange={applyRaise} keyboard="numeric" ltr /></View>
      </Row>
      <Row>
        <View style={{ flex: 1 }}>
          <SelectField label="دورة السداد" value={cycle}
            options={CYCLE_OPTIONS.map((v) => ({ value: v, label: v }))}
            onPick={setCycle} />
        </View>
        {/* استلام التأمين وترحيله من قسم التأمينات · ومن لا يملكه يجدد بالترحيل الافتراضي */}
        {depPerm.add ? <View style={{ flex: 1 }}><Field label="تأمين إضافي" value={extraDeposit} onChange={setExtraDeposit} keyboard="numeric" ltr /></View> : null}
      </Row>
      <Row>
        <View style={{ flex: 1 }}><Field label={t('lease.renewServices')} value={servicesAmt} onChange={setServicesAmt} keyboard="numeric" ltr /></View>
        <View style={{ flex: 1 }}><Field label={t('lease.renewParking')} value={parkingAmt} onChange={setParkingAmt} keyboard="numeric" ltr /></View>
      </Row>
      {depPerm.add && Number(c.deposit_halalas) > 0 && (
        <Pressable onPress={() => setCarry((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, minHeight: 44 }}>
          <View style={{
            width: 22, height: 22, borderRadius: 5, borderWidth: 2,
            borderColor: carry ? C.emerald : C.line, backgroundColor: carry ? C.emerald : '#fff',
            alignItems: 'center', justifyContent: 'center',
          }}>
            {carry ? <Icon name="check" size={14} color="#fff" /> : null}
          </View>
          <T size={12.5}>ترحيل التأمين الحالي ({fmt(Number(c.deposit_halalas))}) إلى العقد الجديد</T>
        </Pressable>
      )}
      <Row>
        <View style={{ flex: 1 }}><Field label="الخدمات المشمولة" value={services} onChange={setServices} /></View>
        <View style={{ flex: 1 }}>
          <SelectField label="حالة الأثاث" value={furnished}
            options={FURNISHED_OPTIONS.map((v) => ({ value: v, label: v }))}
            onPick={setFurnished} display={furnished || undefined} />
        </View>
      </Row>
      <Row>
        <View style={{ flex: 1 }}><Field label="رقم عقد إيجار الجديد" value={ejar} onChange={setEjar} ltr /></View>
        <View style={{ flex: 1 }}><Field label="ملاحظة التجديد" value={note} onChange={setNote} /></View>
      </Row>
      <View style={{ backgroundColor: C.paper, borderRadius: 8, padding: 11, marginTop: 4 }}>
        {([
          ['الفترة الجديدة', start && end ? dfmt(start) + ' · ' + dfmt(end) : ''],
          ['المدة', start && end ? Math.max(1, approxMonths(start, end)) + ' شهراً' : ''],
          ['القيمة', fmt(valueH)],
          [t('lease.contractTotal'), totalH !== valueH ? fmt(totalH) : ''],
          ['عدد الدفعات', ins.length ? String(ins.length) : ''],
          ['أول دفعة', ins.length ? fmt(ins[0].amountHalalas) + ' · ' + dfmt(ins[0].dueDate) : ''],
          ['آخر دفعة', ins.length ? fmt(ins[ins.length - 1].amountHalalas) + ' · ' + dfmt(ins[ins.length - 1].dueDate) : ''],
          ['التأمين', fmt(totalDep) + (carry && toHalalas(extraDeposit) ? ' (مرحَّل + إضافي)' : carry ? ' (مرحَّل)' : toHalalas(extraDeposit) ? ' (جديد)' : '')],
        ] as Array<[string, React.ReactNode]>).filter(([, v]) => v != null && v !== '').map(([k, v]) => (
          <Row key={k} style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
            <T size={12} color={C.muted}>{k}</T>
            <Num size={12} bold>{v}</Num>
          </Row>
        ))}
      </View>
      {warns.map((w) => <T key={w} size={11.5} color={C.rose} style={{ marginTop: 6 }}>{w}</T>)}
      <View style={{ height: 12 }} />
    </Sheet>
  );
}

/* ═══════════ الإلغاء ═══════════ */
function CancelSheet({ contractId, onClose, onDone }: { contractId: string; onClose: () => void; onDone: (msg: string) => void }) {
  const { db } = useApp();
  const toast = useToast();
  const c = db.get<ContractRow>(`SELECT * FROM contracts WHERE id = ?`, [contractId])!;
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const [fate, setFate] = useState<'keep' | 'cancel'>('keep');
  const [settle, setSettle] = useState(false);
  const [deduction, setDeduction] = useState('');
  const [refund, setRefund] = useState('');
  const [dedReason, setDedReason] = useState('');
  const depPerm = usePerm('deposits');
  const { t } = useLang();
  // تسوية التأمين في الإلغاء لعقدٍ لم يُسوَّ تأمينه ولم يُرحَّل (التحقق المستقل: D2 وN1) · والإلغاء بلا تسوية متاح دائماً
  const canSettleHere = !db.get(`SELECT 1 FROM deposit_settlements WHERE contract_id = ?`, [contractId]) && !depositCarried(db, contractId);
  const otherHeld = (c as unknown as { deposit_holder?: string }).deposit_holder === 'طرف آخر';
  const [received, setReceived] = useState(false);

  const dedH = toHalalas(deduction);
  const depH = Number(c.deposit_halalas) || 0;
  const excess = dedH > depH ? dedH - depH : 0;
  // «الفارق يُحوَّل تلقائياً إلى مطالبة» · والمسترد يُحتسب تلقائياً
  const autoRefund = dedH > depH ? 0 : depH - dedH;
  // ردّ التأمين نقداً حين يقبضه المكتب · كفاية النقد (قرار المالك ٢٠٢٦-١٠-٠٥)
  const officeHeld = ((c as unknown as { deposit_holder?: string | null }).deposit_holder || 'المكتب') === 'المكتب';
  const refundCash = settle && officeHeld ? (refund.trim() ? toHalalas(refund) : autoRefund) : 0;
  const cashOk = useCashOk(refundCash);

  const [cc, setCc] = useState(GENERAL_COST_CENTER);
  const confirm = (...a: Parameters<typeof confirmIn>) => withCostCenter(cc, () => confirmIn(...a));
  const confirmIn = () => {
    try {
      const { excessClaimCreated } = cancelContract(db, contractId, {
        date, reason, installmentsFate: fate, settle,
        deductionHalalas: dedH,
        refundHalalas: settle ? (refund.trim() ? toHalalas(refund) : autoRefund) : 0,
        deductionReason: dedReason,
        deductReceived: otherHeld ? received : undefined,
      });
      onClose();
      onDone(excessClaimCreated
        ? 'تم إلغاء العقد · وأُنشئت مطالبة تلقائياً بالفرق الزائد عن التأمين'
        : 'تم إلغاء العقد');
    } catch (e) { reportFailure({ title: 'تعذّر الإلغاء', e }); }
  };

  return (
    <Sheet visible onClose={onClose} title="إلغاء العقد" tall
      footer={
        <>
          {cashOk ? <View style={{ flex: 1 }}><BtnPrimary danger title="تأكيد إلغاء العقد" onPress={confirm} /></View> : null}
        </>
      }>
      <CashShortNote needed={refundCash} what="ردّ التأمين للمستأجر" />
      <DateField label="تاريخ إنهاء العقد" value={date} onChange={setDate} />
      <CostCenterField value={cc} onChange={setCc} />
      <Field label="سبب الإلغاء" value={reason} onChange={setReason} />
      <SelectField
        label="الدفعات المتبقية بعد تاريخ الإلغاء" value={fate}
        options={[
          { value: 'keep', label: 'تبقى مستحقة (المستأجر ما زال مديناً بها)' },
          { value: 'cancel', label: 'تُلغى جميعها (لا مستحقات بعد الإلغاء)' },
        ]}
        onPick={setFate}
      />
      {/* تسوية التأمين من قسم التأمينات · بلا صلاحيته يُلغى العقد بلا تسوية وتُسوّى لاحقاً */}
      {depPerm.add && canSettleHere ? (
        <Pressable onPress={() => setSettle((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, minHeight: 44 }}>
          <View style={{
            width: 22, height: 22, borderRadius: 5, borderWidth: 2,
            borderColor: settle ? C.emerald : C.line, backgroundColor: settle ? C.emerald : '#fff',
            alignItems: 'center', justifyContent: 'center',
          }}>
            {settle ? <Icon name="check" size={14} color="#fff" /> : null}
          </View>
          <T size={12.5}>تسوية التأمين عند الإلغاء</T>
        </Pressable>
      ) : null}
      {settle && (
        <>
          <Row>
            <View style={{ flex: 1 }}>
              <Field label="مبلغ الخصم من التأمين" value={deduction} onChange={setDeduction} keyboard="numeric" ltr />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="المبلغ المسترَد للمستأجر" value={refund || (dedH ? fmt(autoRefund).replace(/,/g, '') : '')} onChange={setRefund} keyboard="numeric" ltr />
            </View>
          </Row>
          <Field label="سبب الخصم" value={dedReason} onChange={setDedReason} />
          {/* «طرف آخر»: وصل المخصوم للمكتب فيُسجَّل قبضاً (قرار المالك على #26 · التحقق المستقل N4) */}
          {otherHeld && dedH > 0 ? (
            <SelectField label={t('deposit.received')} value={received ? 'y' : 'n'}
              options={[{ value: 'y', label: t('deposit.received') }, { value: 'n', label: t('deposit.receivedNo') }]}
              onPick={(v) => setReceived(v === 'y')} />
          ) : null}
          {excess > 0 && (
            <Note tone="danger">
              مبلغ الخصم ({fmt(dedH)}) أكبر من التأمين المحجوز ({fmt(depH)}) · الفارق {fmt(excess)} سيُحوَّل تلقائياً إلى مطالبة عند تأكيد الإلغاء.
            </Note>
          )}
        </>
      )}
    </Sheet>
  );
}

/* ═══════════ تقييم المستأجر ═══════════ */
const RATING_OPTS = ['ممتاز', 'جيد', 'متوسط', 'ضعيف'];
function RatingSheet({ contractId, onClose, onDone }: { contractId: string; onClose: () => void; onDone: (msg: string) => void }) {
  const { db } = useApp();
  const toast = useToast();
  const existing = db.get<{ on_time: string; payment_commit: string; contract_commit: string; unit_condition: string; neighbor_complaints: string; notes: string }>(
    `SELECT * FROM tenant_ratings WHERE contract_id = ?`, [contractId]
  );
  const [onTime, setOnTime] = useState(existing?.on_time || 'ممتاز');
  const [payCommit, setPayCommit] = useState(existing?.payment_commit || 'ممتاز');
  const [ctCommit, setCtCommit] = useState(existing?.contract_commit || 'ممتاز');
  const [unitCond, setUnitCond] = useState(existing?.unit_condition || 'لم يُسلَّم بعد');
  const [complaints, setComplaints] = useState(existing?.neighbor_complaints || 'لا توجد');
  const [notes, setNotes] = useState(existing?.notes || '');
  const save = () => {
    try {
      saveTenantRating(db, contractId, {
        onTime, paymentCommit: payCommit, contractCommit: ctCommit,
        unitCondition: unitCond, neighborComplaints: complaints, notes,
      });
      onClose();
      onDone('تم حفظ تقييم المستأجر');
    } catch (e) { reportFailure({ title: 'تعذّر الحفظ', e }); }
  };
  return (
    <Sheet visible onClose={onClose} title="تقييم المستأجر" tall
      footer={
        <>
          <View style={{ flex: 1 }}><BtnPrimary title="حفظ التقييم" onPress={save} /></View>
        </>
      }>
      <SelectField label="السداد في الوقت المحدَّد" value={onTime} options={RATING_OPTS.map((v) => ({ value: v, label: v }))} onPick={setOnTime} />
      <SelectField label="الالتزام العام بالسداد" value={payCommit} options={RATING_OPTS.map((v) => ({ value: v, label: v }))} onPick={setPayCommit} />
      <SelectField label="الالتزام ببنود العقد" value={ctCommit} options={RATING_OPTS.map((v) => ({ value: v, label: v }))} onPick={setCtCommit} />
      <SelectField label="تسليم الوحدة بحالة الاستلام" value={unitCond}
        options={[...RATING_OPTS, 'لم يُسلَّم بعد'].map((v) => ({ value: v, label: v }))} onPick={setUnitCond} />
      <SelectField label="شكاوى من الجيران" value={complaints}
        options={['لا توجد', 'نادرة', 'متكررة'].map((v) => ({ value: v, label: v }))} onPick={setComplaints} />
      <Field label="ملاحظات إضافية" value={notes} onChange={setNotes} />
    </Sheet>
  );
}

/* ═══════════ التصرف بالتأمين ═══════════ */
function SettlementSheet({ contractId, onClose, onDone }: { contractId: string; onClose: () => void; onDone: (msg: string) => void }) {
  const { db } = useApp();
  const { t } = useLang();
  const toast = useToast();
  const c = db.get<ContractRow>(`SELECT * FROM contracts WHERE id = ?`, [contractId])!;
  const existing = db.get<{ date: string; deduction_halalas: number; deduction_reason: string; refund_halalas: number; notes: string; deduct_destination: string }>(
    `SELECT * FROM deposit_settlements WHERE contract_id = ?`, [contractId]
  );
  const [date, setDate] = useState(existing?.date || today());
  // الخصم كما سُجّل كاملاً: المخصوم من التأمين ومطالبة زيادته إن وُجدت (التحقق المستقل E1: كان الحفظ بلا تغيير يُرفض)
  const excessClaim = Number(db.get<{ a: number }>(
    `SELECT COALESCE(SUM(amount_halalas), 0) AS a FROM claims WHERE contract_id = ? AND source = 'تسوية تأمين' AND deleted_at IS NULL`, [contractId])?.a ?? 0); // i18n-exempt: مصدر مخزَّن
  const [deduction, setDeduction] = useState(existing ? fmt(Number(existing.deduction_halalas) + excessClaim).replace(/,/g, '') : '');
  const [dedReason, setDedReason] = useState(existing?.deduction_reason || '');
  const [refund, setRefund] = useState(
    existing ? fmt(Number(existing.refund_halalas)).replace(/,/g, '') : fmt(Number(c.deposit_halalas)).replace(/,/g, '')
  );
  const [notes, setNotes] = useState(existing?.notes || '');
  const [dest, setDest] = useState<'محفظة إيجار' | 'حسابنا'>(
    (existing?.deduct_destination as 'محفظة إيجار' | 'حسابنا') || 'محفظة إيجار'
  );
  const platformHeld = (c as unknown as { deposit_holder?: string }).deposit_holder === 'منصة إيجار';
  const otherHeld = (c as unknown as { deposit_holder?: string }).deposit_holder === 'طرف آخر';
  // «طرف آخر»: وصل المخصوم للمكتب؟ · من قيده إن سُجّل قبضاً سابقاً (قرار المالك على #26)
  const [received, setReceived] = useState<boolean>(
    !!db.get(`SELECT 1 FROM journal_entries WHERE src_type = 'deposit_deduct' AND src_id = ? AND reversed_by IS NULL AND deleted_at IS NULL`, [contractId]));
  const diff = toHalalas(deduction) + toHalalas(refund) - Number(c.deposit_halalas);
  // ردّ التأمين نقداً حين يقبضه المكتب · بصافي الفرق عن ردٍّ سابق (قرار المالك ٢٠٢٦-١٠-٠٥)
  const officeHeld = ((c as unknown as { deposit_holder?: string | null }).deposit_holder || 'المكتب') === 'المكتب';
  const refundCash = officeHeld ? toHalalas(refund) - Number(existing?.refund_halalas ?? 0) : 0;
  const cashOk = useCashOk(refundCash);
  const [cc, setCc] = useState(GENERAL_COST_CENTER);
  const save = (...a: Parameters<typeof saveIn>) => withCostCenter(cc, () => saveIn(...a));
  const saveIn = () => {
    try {
      saveDepositSettlement(db, contractId, {
        date, deductionHalalas: toHalalas(deduction), deductionReason: dedReason,
        refundHalalas: toHalalas(refund), notes,
        deductDestination: platformHeld ? dest : undefined,
        deductReceived: otherHeld ? received : undefined,
      });
      onClose();
      onDone('تم حفظ تفاصيل التصرف بالتأمين');
    } catch (e) { reportFailure({ title: 'تعذّر الحفظ', e }); }
  };
  return (
    <Sheet visible onClose={onClose} title="تفاصيل التصرف بالتأمين" tall
      footer={
        <>
          {/* النقص عن التأمين لا يُحفظ حتى يُوزَّع (قرار المالك على #27) · فلا يظهر الزر ويظهر سببه */}
          {cashOk && diff >= 0 ? <View style={{ flex: 1 }}><BtnPrimary title="حفظ التسوية" onPress={save} /></View> : null}
        </>
      }>
      <CashShortNote needed={refundCash} what="ردّ التأمين للمستأجر" />
      <View style={{ marginBottom: 10 }}>
        <T size={11.5} color={C.muted}>مبلغ التأمين الأصلي</T>
        <Money halalas={Number(c.deposit_halalas)} size={14} bold />
      </View>
      <DateField label="تاريخ التسوية" value={date} onChange={setDate} />
      <CostCenterField value={cc} onChange={setCc} />
      <Field label="مبلغ الخصم من التأمين" value={deduction} onChange={setDeduction} keyboard="numeric" ltr />
      <Field label="سبب الخصم" value={dedReason} onChange={setDedReason} />
      {platformHeld && toHalalas(deduction) > 0 ? (
        <SelectField label="وجهة المخصوم بعد إقفال محتجزات المنصة" value={dest}
          options={[
            { value: 'محفظة إيجار', label: 'بقي في محفظة إيجار (1265)' },
            { value: 'حسابنا', label: 'حُوّل إلى حسابنا (1100)' },
          ]}
          onPick={setDest} />
      ) : null}
      {otherHeld && toHalalas(deduction) > 0 ? (
        <SelectField label={t('deposit.received')} value={received ? 'y' : 'n'}
          options={[{ value: 'y', label: t('deposit.received') }, { value: 'n', label: t('deposit.receivedNo') }]}
          onPick={(v) => setReceived(v === 'y')} />
      ) : null}
      <Field label="المبلغ المسترَد للمستأجر" value={refund} onChange={setRefund} keyboard="numeric" ltr />
      <View style={{ backgroundColor: C.paper, borderRadius: 8, padding: 11, marginBottom: 10 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T size={12.5} bold>الفرق (خصم + مسترَد مقابل الأصلي):</T>
          <Num size={12.5} bold color={diff === 0 ? C.emerald : C.rose}>{fmt(diff)}</Num>
        </Row>
        {diff < 0 ? <T size={11.5} color={C.rose} style={{ marginTop: 4 }}>{t('deposit.mustDistribute', { left: fmt(-diff) })}</T> : null}
        {diff > 0 ? <T size={11.5} color={C.muted} style={{ marginTop: 4 }}>{t('deposit.excessNote')}</T> : null}
      </View>
      <Field label="ملاحظات" value={notes} onChange={setNotes} />
    </Sheet>
  );
}

/* ═══════════ تسجيل تقبيل ═══════════ */
function KeyMoneySheet({ contract, onClose, onDone }: { contract: ContractRow; onClose: () => void; onDone: (msg: string) => void }) {
  const { db } = useApp();
  const toast = useToast();
  const [outgoing, setOutgoing] = useState('');
  const [incoming, setIncoming] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [commission, setCommission] = useState('');
  const [method, setMethod] = useState<'bank' | 'cash'>('bank');
  const [bankId, setBankId] = useState<string>('');
  const [notes, setNotes] = useState('');
  const banks = db.all<{ id: string; name: string }>(`SELECT id, name FROM banks WHERE deleted_at IS NULL AND archived = 0 ORDER BY created_at`);
  /** الاتفاق لا يُسجَّل بلا طرفين ومبلغ، ولا بعمولة بنكية بلا حساب · فلا يُعرض زره قبلها */
  const ready = !!outgoing.trim() && !!incoming.trim() && toHalalas(amount) > 0
    && (toHalalas(commission) <= 0 || method === 'cash' || !!bankId);
  const [cc, setCc] = useState(GENERAL_COST_CENTER);
  const save = (...a: Parameters<typeof saveIn>) => withCostCenter(cc, () => saveIn(...a));
  const saveIn = () => {
    try {
      recordKeyMoneyDeal(db, {
        unitId: contract.unit_id, contractId: contract.id,
        outgoing, incoming, amountHalalas: toHalalas(amount), date,
        commissionHalalas: toHalalas(commission),
        method: toHalalas(commission) > 0 ? method : null,
        bankId: bankId || null, notes,
      });
      onClose();
      onDone('تم تسجيل اتفاق التقبيل بنجاح');
    } catch (e) { reportFailure({ title: 'تعذّر التسجيل', e }); }
  };
  return (
    <Sheet visible onClose={onClose} title="تسجيل تقبيل (تنازل عن الموقع بمقابل مالي)" tall
      footer={
        <>
          {ready ? <View style={{ flex: 1 }}><BtnPrimary title="تسجيل الاتفاق" onPress={save} /></View> : null}
        </>
      }>
      <View style={{ backgroundColor: C.paper, borderRadius: 8, padding: 10, marginBottom: 10 }}>
        <T size={12.5} med>الوحدة: {contract.unit_label}</T>
      </View>
      <Row>
        <View style={{ flex: 1 }}><Field label="المتنازل (الطرف الخارج)" value={outgoing} onChange={setOutgoing} /></View>
        <View style={{ flex: 1 }}><Field label="المتنازل له (الطرف الداخل)" value={incoming} onChange={setIncoming} /></View>
      </Row>
      <Row>
        <View style={{ flex: 1 }}><Field label="مبلغ التقبيل الإجمالي" value={amount} onChange={setAmount} keyboard="numeric" ltr /></View>
        <View style={{ flex: 1 }}><DateField label="تاريخ الاتفاق" value={date} onChange={setDate} /></View>
      </Row>
      <CostCenterField value={cc} onChange={setCc} />
      <Field label="عمولة الشركة/المالك" value={commission} onChange={setCommission} keyboard="numeric" ltr />
      {toHalalas(commission) > 0 && (
        <>
          <SelectField label="طريقة استلام العمولة" value={method}
            options={[{ value: 'bank', icon: 'card', label: 'تحويل بنكي' }, { value: 'cash', icon: 'cash', label: 'نقداً' }]}
            onPick={setMethod} />
          {method === 'bank' && (
            <SelectField label="الحساب البنكي" value={bankId}
              options={banks.map((b) => ({ value: b.id, label: b.name }))}
              onPick={setBankId} placeholder="أضف حساباً بنكياً أولاً" emptyText="أضف حساباً بنكياً أولاً من شاشة البنوك" />
          )}
        </>
      )}
      <Field label="ملاحظات" value={notes} onChange={setNotes} />
    </Sheet>
  );
}

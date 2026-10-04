/**
 * الوحدات · صفحة مستقلة بكل وحدات المحفظة.
 * ترقيم صفحات في SQL (LIMIT/OFFSET) وبحث ومرشِّحات في WHERE · تتحمل مئات الوحدات.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { View, Pressable, FlatList } from 'react-native';
import { Screen } from '../src/ui/Screen';
import { Card, T, Money, EmptyState, Row, Badge, SearchBox, BtnPrimary, KpiCard, ChipGroup } from '../src/ui/components';
import { useDialog } from '../src/ui/AppDialog';
import { FilterBar, FilterSheet, useFilterSheet, type ActiveChip } from '../src/ui/FilterSheet';
import { ActionMenuButton } from '../src/ui/ActionMenu';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { C, TYPE } from '../src/ui/theme';
import { usePager, Pager } from '../src/ui/Pager';
import { useDeferredReady } from '../src/ui/useDeferredReady';
import { Skeleton } from '../src/ui/Skeleton';
import {
  allUnitStatuses, portfolioStats, computeTopPerformers,
  type UnitStatusInfo, type PropertyStats, type TopPerformers,
} from '../src/domain/stats';
import { deleteUnit, setUnitArchived, toggleUnitMaintenance } from '../src/domain/propertiesService';
import { fmt } from '../src/domain/money';
import { UnitDetailSheet, UnitFormSheet } from '../src/ui/unitSheets';
import { ReservationSheet } from '../src/ui/ReservationSheet';
import { reportFailure } from '../src/ui/failureDialog';
import { usePerm } from '../src/ui/access';

interface UnitRow {
  id: string; property_id: string; unit_no: string; floor: string; type: string;
  subtype: string; rent_monthly_halalas: number; under_maintenance: number; archived: number;
  /** أعليها ارتباط حيّ (عقد أو حجز أو فاتورة أو ساكن أو عداد أو مرفق)؟ · صفر أو واحد */
  linked_n: number;
}

/**
 * وجود ارتباط حيّ بالوحدة · EXISTS تتوقف عند أول سطر فلا تُحصي، وترتيب الشروط
 * يضع الأكثر شيوعاً أولاً · بها يُقرَّر عرض زر الحذف من عدمه قبل الضغط لا بعده.
 */
const LINKED_SQL = `(EXISTS(SELECT 1 FROM contracts WHERE unit_id = u.id AND deleted_at IS NULL)
  OR EXISTS(SELECT 1 FROM purchases WHERE unit_id = u.id AND deleted_at IS NULL)
  OR EXISTS(SELECT 1 FROM reservations WHERE unit_id = u.id AND deleted_at IS NULL)
  OR EXISTS(SELECT 1 FROM occupants WHERE unit_id = u.id AND deleted_at IS NULL)
  OR EXISTS(SELECT 1 FROM meters WHERE owner_type = 'unit' AND owner_id = u.id AND deleted_at IS NULL)
  OR EXISTS(SELECT 1 FROM attachments WHERE entity_type = 'unit' AND entity_id = u.id AND deleted_at IS NULL))`;

type OccFilter = 'all' | 'occupied' | 'vacant';
type RentFilter = 'all' | 'upto1000' | 'from1000to3000' | 'over3000';

const VACANT_ST: UnitStatusInfo = { key: 'vacant', label: 'شاغرة', color: '#8A93A6', bg: '#F0F1F3' };

const RENT_LABELS: Record<Exclude<RentFilter, 'all'>, string> = {
  upto1000: 'حتى 1000',
  from1000to3000: 'من 1000 إلى 3000',
  over3000: 'فوق 3000',
};

const EMPTY_PF: PropertyStats = { total: 0, occupied: 0, vacant: 0, occupancyPct: 0, income: 0, cancelledValue: 0, cancelledCount: 0 };
const EMPTY_TOP: TopPerformers = { topPropRevenue: null, topPropExpense: null, topUnitRevenue: null, topUnitExpense: null };
const EMPTY_BASE = {
  propNames: new Map<string, string>(),
  statuses: new Map<string, UnitStatusInfo>(),
  pf: EMPTY_PF,
  top: EMPTY_TOP,
  archivedCount: 0,
  addableProps: 0,
  floors: [] as string[],
  types: [] as string[],
  topRevenueLabel: '',
  topExpenseLabel: '',
};
const EMPTY_PAGE = { rows: [] as UnitRow[], total: 0, totalAll: 0 };

/** بطاقة وحدة واحدة · خارج الشاشة ومغلّفة بـ memo كي لا يُعاد رسم القائمة كلها */
const UnitCard = React.memo(function UnitCard({
  u, propName, stKey, stLabel, canManage, canMaint, showRent, onDetail, onEdit, onToggleMaintenance, onToggleArchive, onDelete,
}: {
  u: UnitRow; propName: string; stKey: UnitStatusInfo['key']; stLabel: string;
  /** «العقارات: كامل» · التعديل والأرشفة والحذف */
  canManage: boolean;
  /** «الصيانة: كامل» · وضع الوحدة تحت الصيانة وإنهاؤها */
  canMaint: boolean;
  /** الإيجار من بيانات العقود · لا يُعرض لمن لا يرى العقود */
  showRent: boolean;
  onDetail: (id: string) => void;
  onEdit: (id: string) => void;
  onToggleMaintenance: (id: string) => void;
  onToggleArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string, name: string) => void;
}) {
  return (
    <Card style={{ paddingVertical: 10 }}>
      {/* زر ⋮ أعلى البطاقة يساراً بمحاذاة العنوان ·
          والوحدة المرتبطة بعقد أو حجز أو فاتورة أو ساكن أو عداد لا يُعرض لها «حذف» · الأرشفة بديلها */}
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={() => onDetail(u.id)} style={{ flex: 1 }}>
          <T size={TYPE.sectionTitle} bold>{[propName, u.unit_no].filter(Boolean).join(' · ')}</T>
        </Pressable>
        <Row gap={6}>
          {Number(u.archived) ? <Badge kind="draft" label="مؤرشفة" /> : null}
          <Badge kind={stKey === 'rented' ? 'paid' : stKey === 'reserved' ? 'due' : stKey === 'maintenance' ? 'overdue' : 'draft'} label={stLabel} />
          <ActionMenuButton title={u.unit_no} actions={[
            { icon: 'eye', label: 'عرض التفاصيل', onPress: () => onDetail(u.id) },
            canManage ? { icon: 'edit', label: 'تعديل', onPress: () => onEdit(u.id) } : null,
            canMaint ? {
              icon: Number(u.under_maintenance) ? 'check' : 'wrench',
              label: Number(u.under_maintenance) ? 'إنهاء الصيانة' : 'وضع تحت الصيانة',
              onPress: () => onToggleMaintenance(u.id),
            } : null,
            canManage ? {
              icon: Number(u.archived) ? 'undo' : 'archive',
              label: Number(u.archived) ? 'إلغاء الأرشفة' : 'أرشفة',
              onPress: () => onToggleArchive(u.id, !!Number(u.archived)),
            } : null,
            Number(u.linked_n) || !canManage ? null : {
              icon: 'trash' as const, label: 'حذف', danger: true,
              onPress: () => onDelete(u.id, [propName, u.unit_no].filter(Boolean).join(' · ')),
            },
          ]} />
        </Row>
      </Row>
      <Pressable onPress={() => onDetail(u.id)}>
        <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
          {[u.floor, u.type, u.subtype].filter(Boolean).length
            ? <T size={TYPE.cardTitle} color={C.muted}>{[u.floor, u.type, u.subtype].filter(Boolean).join(' · ')}</T>
            : null}
          {showRent ? <Money halalas={Number(u.rent_monthly_halalas)} size={TYPE.cardTitle} bold /> : null}
        </Row>
      </Pressable>
    </Card>
  );
});

export default function Units() {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const ready = useDeferredReady();
  const pager = usePager('units');
  const fsheet = useFilterSheet();
  const perm = usePerm('props');
  // وضع الوحدة تحت الصيانة عمل الصيانة نفسه · «إدخال» يكفيه (فني الصيانة) كما في OP_WRITES
  const canMaint = usePerm('maintenance').add;
  // المبالغ بيانات مرتبطة · لا تُعرض إلا لمن له قسمها (الحد اللازم)
  const seesRent = usePerm('contracts').view;
  const seesInvoices = usePerm('invoices').view;
  const seesPurchases = usePerm('purchases').view;
  const [q, setQ] = useState('');
  const [formFor, setFormFor] = useState<{ propertyId?: string; unitId?: string } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [reserveId, setReserveId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [floorF, setFloorF] = useState('');
  const [typeF, setTypeF] = useState('');
  const [occF, setOccF] = useState<OccFilter>('all');
  const [rentF, setRentF] = useState<RentFilter>('all');
  // القدوم من مؤشرات الرئيسية: ?occ=rented أو vacant
  const occParams = useLocalSearchParams<{ occ?: string }>();
  useEffect(() => {
    if (occParams.occ === 'rented') setOccF('occupied');
    else if (occParams.occ === 'vacant') setOccF('vacant');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occParams.occ]);

  // الأساس الثقيل (الحالات والأسماء والمؤشرات) · لا يُعاد حسابه مع كل حرف بحث
  const base = useMemo(() => {
    if (!ready) return EMPTY_BASE;
    const propNames = new Map(
      db.all<{ id: string; name: string }>(`SELECT id, name FROM properties`).map((p) => [p.id, p.name])
    );
    const statuses = allUnitStatuses(db);
    const pf = portfolioStats(db);
    const top = computeTopPerformers(db);
    const archivedCount = Number(db.get<{ c: number }>(`SELECT COUNT(*) c FROM units WHERE deleted_at IS NULL AND archived = 1`)?.c ?? 0);
    // العقارات التي تصلح أن تُضاف إليها وحدة · بها وحدها يُعرض زر «+ وحدة جديدة»
    const addableProps = Number(db.get<{ c: number }>(
      `SELECT COUNT(*) c FROM properties WHERE deleted_at IS NULL AND archived = 0`)?.c ?? 0);
    const floors = db.all<{ f: string }>(
      `SELECT DISTINCT floor AS f FROM units WHERE deleted_at IS NULL AND TRIM(COALESCE(floor,'')) != '' ORDER BY floor`
    ).map((r) => r.f);
    const types = db.all<{ t: string }>(
      `SELECT DISTINCT type AS t FROM units WHERE deleted_at IS NULL AND TRIM(COALESCE(type,'')) != '' ORDER BY type`
    ).map((r) => r.t);
    const unitLabel = (id: string) => {
      const u = db.get<{ unit_no: string; property_id: string }>(`SELECT unit_no, property_id FROM units WHERE id = ?`, [id]);
      return u ? [propNames.get(u.property_id), u.unit_no].filter(Boolean).join(' · ') : '';
    };
    return {
      propNames, statuses, pf, top, archivedCount, addableProps, floors, types,
      topRevenueLabel: top.topUnitRevenue ? unitLabel(top.topUnitRevenue.id) : '',
      topExpenseLabel: top.topUnitExpense ? unitLabel(top.topUnitExpense.id) : '',
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready]);

  // صفحة واحدة فقط من قاعدة البيانات · البحث والمرشِّحات كلها داخل WHERE
  const page = useMemo(() => {
    if (!ready) return EMPTY_PAGE;
    const where: string[] = ['u.deleted_at IS NULL', 'u.archived = ?'];
    const params: (string | number)[] = [showArchived ? 1 : 0];
    const needle = q.trim();
    if (needle) {
      where.push(`(u.unit_no LIKE '%'||?||'%' OR u.type LIKE '%'||?||'%' OR u.floor LIKE '%'||?||'%' OR COALESCE(p.name,'') LIKE '%'||?||'%')`);
      params.push(needle, needle, needle, needle);
    }
    if (floorF) { where.push('u.floor = ?'); params.push(floorF); }
    if (typeF) { where.push('u.type = ?'); params.push(typeF); }
    if (rentF === 'upto1000') where.push('u.rent_monthly_halalas <= 100000');
    else if (rentF === 'from1000to3000') where.push('u.rent_monthly_halalas > 100000 AND u.rent_monthly_halalas <= 300000');
    else if (rentF === 'over3000') where.push('u.rent_monthly_halalas > 300000');
    if (occF !== 'all') {
      // خريطة الحالات محسوبة دفعة واحدة في الأساس · نمرّر معرّفاتها إلى WHERE ليصح العدّاد
      const want = occF === 'occupied' ? 'rented' : 'vacant';
      const ids: string[] = [];
      base.statuses.forEach((st, id) => { if (st.key === want) ids.push(id); });
      if (ids.length === 0) where.push('1 = 0');
      else { where.push(`u.id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
    }
    const src = `FROM units u LEFT JOIN properties p ON p.id = u.property_id WHERE ${where.join(' AND ')}`;
    const total = Number(db.get<{ c: number }>(`SELECT COUNT(*) c ${src}`, params)?.c ?? 0);
    // العدد الكلي في النطاق نفسه قبل البحث والمرشِّحات · لسطر «24 من 60»
    const totalAll = Number(db.get<{ c: number }>(
      `SELECT COUNT(*) c FROM units WHERE deleted_at IS NULL AND archived = ?`, [showArchived ? 1 : 0]
    )?.c ?? 0);
    const rows = db.all<UnitRow>(
      `SELECT u.*, ${LINKED_SQL} AS linked_n ${src} ORDER BY COALESCE(u.unit_no_key, u.unit_no), u.unit_no LIMIT ? OFFSET ?`,
      [...params, pager.limit, pager.offset]
    );
    return { rows, total, totalAll };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready, base, q, floorF, typeF, occF, rentF, showArchived, pager.limit, pager.offset]);

  useEffect(() => {
    pager.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, floorF, typeF, occF, rentF, showArchived]);

  const openDetail = useCallback((id: string) => setDetailId(id), []);
  const openEdit = useCallback((id: string) => setFormFor({ unitId: id }), []);
  const onToggleMaintenance = useCallback((id: string) => { toggleUnitMaintenance(db, id); bump(); }, [db, bump]);
  const onToggleArchive = useCallback((id: string, archived: boolean) => {
    setUnitArchived(db, id, !archived);
    bump();
    toast(archived ? 'أُلغيت الأرشفة' : 'أُرشفت الوحدة · تبقى في الدفتر والتقارير كما هي');
  }, [db, bump, toast]);
  const onDelete = useCallback((id: string, name: string) => {
    // لا يصل هنا إلا غير المرتبط · المرتبطة لا يُعرض لها زر حذف أصلاً
    dialog({
      title: 'حذف الوحدة',
      body: `حذف الوحدة "${name}"؟`,
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'حذف', variant: 'danger',
          onPress: () => {
            try { deleteUnit(db, id); bump(); toast('تم الحذف · يمكن استعادته من الإعدادات'); }
            catch (e) { reportFailure({ title: 'تعذّر الحذف', e }); }
          },
        },
      ],
    });
  }, [db, bump, toast, dialog]);

  const renderUnit = useCallback(({ item }: { item: UnitRow }) => {
    const st = base.statuses.get(item.id) ?? VACANT_ST;
    return (
      <UnitCard u={item} propName={base.propNames.get(item.property_id) ?? ''}
        stKey={st.key} stLabel={st.label}
        canManage={perm.manage} canMaint={canMaint} showRent={seesRent}
        onDetail={openDetail} onEdit={openEdit} onToggleMaintenance={onToggleMaintenance}
        onToggleArchive={onToggleArchive} onDelete={onDelete} />
    );
  }, [base, openDetail, openEdit, onToggleMaintenance, onToggleArchive, onDelete, perm.manage, canMaint, seesRent]);

  const clearFilters = useCallback(() => {
    setQ(''); setFloorF(''); setTypeF(''); setOccF('all'); setRentF('all');
  }, []);

  const floorOptions: Array<[string, string]> = [['', 'كل الطوابق'], ...base.floors.map((f): [string, string] => [f, f])];
  const typeOptions: Array<[string, string]> = [['', 'كل الأنواع'], ...base.types.map((t): [string, string] => [t, t])];

  const activeChips: ActiveChip[] = [
    ...(floorF ? [{ key: 'floor', label: `الطابق ${floorF}`, onClear: () => setFloorF('') }] : []),
    ...(typeF ? [{ key: 'type', label: typeF, onClear: () => setTypeF('') }] : []),
    ...(occF !== 'all' ? [{ key: 'occ', label: occF === 'occupied' ? 'مشغولة' : 'شاغرة', onClear: () => setOccF('all') }] : []),
    ...(rentF !== 'all' ? [{ key: 'rent', label: RENT_LABELS[rentF], onClear: () => setRentF('all') }] : []),
  ];

  const header = (
    <View>
      <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <KpiCard label="نسبة التشغيل الإجمالية" tone="pos" value={base.pf.occupancyPct + '٪'} sub={`${base.pf.occupied} من ${base.pf.total} وحدة`} />
        <KpiCard label="الوحدات الشاغرة" tone="neu" value={String(base.pf.vacant)} />
      </Row>
      {seesInvoices || seesPurchases ? (
        <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
          {/* الدخل من الفواتير والصرف من المشتريات · كلٌّ لمن يرى قسمه */}
          {seesInvoices ? <KpiCard label="الوحدة الأعلى دخلاً" tone="pos"
            value={base.topRevenueLabel}
            sub={base.top.topUnitRevenue ? fmt(base.top.topUnitRevenue.amount) : undefined} /> : null}
          {seesPurchases ? <KpiCard label="الوحدة الأكثر صرفاً" tone="neg"
            value={base.topExpenseLabel}
            sub={base.top.topUnitExpense ? fmt(base.top.topUnitExpense.amount) : undefined} /> : null}
        </Row>
      ) : null}
      <FilterBar chips={activeChips} onOpen={fsheet.show} onClearAll={clearFilters}
        resultCount={page.total} total={page.totalAll} filtered={page.total} itemName="وحدة"
        search={<SearchBox value={q} onChange={setQ} />} />
      {base.archivedCount > 0 || showArchived ? (
        <View style={{ marginBottom: 8 }}>
          <ChipGroup options={[[0, 'القائمة'], [1, `المؤرشفة (${base.archivedCount})`]]}
            value={showArchived ? 1 : 0} onChange={(v) => setShowArchived(!!v)} />
        </View>
      ) : null}
    </View>
  );

  return (
    <Screen title="الوحدات" icon="home" scroll={false}
      /* لا عقار فلا وحدة تُضاف · الزر لا يُعرض بدل أن يُعرض ويرفض */
      actions={base.addableProps && perm.add ? <BtnPrimary small title="+ وحدة جديدة" onPress={() => setFormFor({})} /> : undefined}>
      {!ready ? <Skeleton /> : (
        <FlatList
          data={page.rows}
          keyExtractor={(u) => u.id}
          renderItem={renderUnit}
          ListHeaderComponent={header}
          ListFooterComponent={<Pager pager={pager} total={page.total} />}
          ListEmptyComponent={<Card><EmptyState>لا توجد وحدات مطابقة · عدّل البحث أو امسح المرشِّحات</EmptyState></Card>}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
        />
      )}
      {formFor && (
        <UnitFormSheet propertyId={formFor.propertyId} unitId={formFor.unitId}
          onClose={() => setFormFor(null)}
          onSaved={() => { setFormFor(null); bump(); toast('تم الحفظ'); }} />
      )}
      {detailId && (
        <UnitDetailSheet unitId={detailId}
          onClose={() => setDetailId(null)}
          onEdit={() => { setFormFor({ unitId: detailId }); setDetailId(null); }}
          onReserve={() => { setReserveId(detailId); setDetailId(null); }} />
      )}
      {reserveId && (
        <ReservationSheet unitId={reserveId}
          onClose={() => setReserveId(null)}
          onDone={() => { setReserveId(null); bump(); toast('تم حجز الوحدة بنجاح'); }} />
      )}
      <FilterSheet open={fsheet.open} onClose={fsheet.hide} onClearAll={clearFilters} resultCount={page.total}>
        {base.floors.length ? (
          <View style={{ marginBottom: 8 }}>
            <ChipGroup options={floorOptions} value={floorF} onChange={setFloorF} />
          </View>
        ) : null}
        {base.types.length ? (
          <View style={{ marginBottom: 8 }}>
            <ChipGroup options={typeOptions} value={typeF} onChange={setTypeF} />
          </View>
        ) : null}
        <View style={{ marginBottom: 8 }}>
          <ChipGroup<OccFilter>
            options={[['all', 'الكل'], ['occupied', 'مشغولة'], ['vacant', 'شاغرة']]}
            value={occF} onChange={setOccF} />
        </View>
        {/* مرشِّح الإيجار يكشف المبلغ · لمن يرى العقود وحده */}
        {seesRent ? (
          <View style={{ marginBottom: 8 }}>
            <ChipGroup<RentFilter>
              options={[['all', 'كل الإيجارات'], ['upto1000', 'حتى 1000'], ['from1000to3000', 'من 1000 إلى 3000'], ['over3000', 'فوق 3000']]}
              value={rentF} onChange={setRentF} />
          </View>
        ) : null}
      </FilterSheet>
    </Screen>
  );
}

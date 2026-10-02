/**
 * العقارات · القائمة والمؤشرات، عقار جديد/تعديل (نشاط، ملكية، طوابق وفئاتها،
 * موقع GPS، عدادات مشتركة، أقسام ومحتويات)، الوحدات دفعة واحدة، الحجز بعربون،
 * وتفاصيل العقار بوحداته.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Screen } from '../../src/ui/Screen';
import {
  Card, CardTitle, T, Num, Money, EmptyState, Row, Badge, SearchBox, BtnPrimary, BtnGhost, Field, KpiCard,
  ChipGroup,
} from '../../src/ui/components';
import { Sheet, SelectField } from '../../src/ui/Sheet';
import { DateField } from '../../src/ui/DateField';
import { ActionMenuButton } from '../../src/ui/ActionMenu';
import { MetersEditor, SectionsEditor, type SectionData } from '../../src/ui/editors';
import { useApp } from '../../src/ui/store';
import { AttachStrip } from '../../src/ui/AttachStrip';
import { useToast } from '../../src/ui/Toast';
import { C } from '../../src/ui/theme';
import {
  saveProperty, deleteProperty, setPropertyArchived, bulkAddUnits, PROPERTY_ACTIVITIES, RESIDENTIAL_SUBTYPES, floorLabels,
} from '../../src/domain/propertiesService';
import { usePager, Pager } from '../../src/ui/Pager';
import { useDeferredReady } from '../../src/ui/useDeferredReady';
import { Skeleton } from '../../src/ui/Skeleton';
import { allPropertyStats, propertyStats, computeTopPerformers, portfolioStats, occupancySummary } from '../../src/domain/stats';
import { monthBounds } from '../../src/domain/accrual';
import { today } from '../../src/domain/dates';
import { metersOf, METER_ICON, type MeterInput, type LabeledMeter } from '../../src/domain/meters';
import { CYCLE_OPTIONS } from '../../src/domain/contracts/vocab';
import { MeterSheet } from '../../src/ui/MeterSheet';
import { Icon, type IconName } from '../../src/ui/icons';
import { ReservationSheet } from '../../src/ui/ReservationSheet';
import { fmt, toHalalas } from '../../src/domain/money';
import type { PropertyRow } from '../../src/domain/contracts/rules';
import { UnitDetailSheet, UnitFormSheet } from '../../src/ui/unitSheets';
import { attachPicked, pickFile } from '../../src/ui/attach';
import { LeafletMap } from '../../src/ui/LeafletMap';
import { useDialog } from '../../src/ui/AppDialog';
import { reportFailure } from '../../src/ui/failureDialog';

/** أسماء الشهور كاملةً · لتسمية بطاقة «إشغال أغسطس» */
const MONTHS_FULL = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

interface PropRow extends PropertyRow {
  address: string;
  deed_no: string;
  lease_value_halalas: number | null;
  lease_cycle: string | null;
  op_rate: number | null;
  lat: number | null;
  lng: number | null;
  archived: number;
}

export default function Properties() {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [bulkFor, setBulkFor] = useState<{ propertyId: string; count: number } | null>(null);
  const [unitFormFor, setUnitFormFor] = useState<{ propertyId?: string; unitId?: string } | null>(null);
  const [unitDetailId, setUnitDetailId] = useState<string | null>(null);
  const [reserveUnitId, setReserveUnitId] = useState<string | null>(null);

  // القدوم من الخريطة: ?detail=<id> يفتح تفاصيل العقار مباشرة
  const params = useLocalSearchParams<{ detail?: string }>();
  useEffect(() => {
    if (params.detail) setDetailId(String(params.detail));
  }, [params.detail]);

  const [showArchived, setShowArchived] = useState(false);
  const ready = useDeferredReady();
  const pager = usePager('properties');
  const { rows, totalRows } = useMemo(() => {
    if (!ready) return { rows: [] as PropRow[], totalRows: 0 };
    const where: string[] = ['deleted_at IS NULL', 'archived = ?'];
    const args: Array<string | number> = [showArchived ? 1 : 0];
    const needle = q.trim();
    if (needle) {
      where.push(`(name LIKE '%'||?||'%' OR address LIKE '%'||?||'%' OR deed_no LIKE '%'||?||'%' OR ownership LIKE '%'||?||'%')`);
      args.push(needle, needle, needle, needle);
    }
    const w = where.join(' AND ');
    const total = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM properties WHERE ${w}`, args)?.n ?? 0);
    const page = db.all<PropRow>(
      `SELECT * FROM properties WHERE ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...args, pager.limit, pager.offset]);
    return { rows: page, totalRows: total };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready, q, showArchived, pager.limit, pager.offset]);
  useEffect(() => { pager.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, showArchived]);
  const archivedCount = useMemo(
    () => Number(db.get<{ c: number }>(`SELECT COUNT(*) c FROM properties WHERE deleted_at IS NULL AND archived = 1`)?.c ?? 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);

  // إحصاءات كل العقارات دفعة واحدة · لا استعلامات لكل صف
  const statsByProp = useMemo(() => allPropertyStats(db),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);

  const summary = useMemo(() => {
    const pf = portfolioStats(db);
    const top = computeTopPerformers(db);
    // الاسم الغائب يعود خالياً · فتُسقط البطاقة بعنوانها بدل «لا يوجد»
    const nameOf = (id?: string | null) =>
      id ? (db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [id])?.name ?? '') : '';
    // المقياسان معاً: إشغال الشهر بأيام الوحدات، والإشغال اللحظي بعدد الوحدات
    const T0 = today();
    const mb = monthBounds(T0.slice(0, 7));
    const occ = occupancySummary(db, mb.from, mb.to, T0);
    const monthName = MONTHS_FULL[Number(T0.slice(5, 7)) - 1];
    return {
      pf, top, occ, monthName,
      topRevName: top.topPropRevenue ? nameOf(top.topPropRevenue.id) : '',
      topExpName: top.topPropExpense ? nameOf(top.topPropExpense.id) : '',
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version]);

  /**
   * العقارات التي لها مرتبطات · لا يُعرض لها زر حذف إطلاقاً (الأرشفة بديله) ·
   * استعلام واحد لكل الشاشة لا استعلام لكل صف.
   */
  const linkedProps = useMemo(() => new Set(
    db.all<{ id: string }>(
      `SELECT DISTINCT property_id AS id FROM units WHERE deleted_at IS NULL
       UNION SELECT u.property_id FROM contracts c JOIN units u ON u.id = c.unit_id WHERE c.deleted_at IS NULL
       UNION SELECT property_id FROM purchases WHERE deleted_at IS NULL AND property_id IS NOT NULL
       UNION SELECT property_id FROM invoices WHERE deleted_at IS NULL AND property_id IS NOT NULL
       UNION SELECT owner_id FROM meters WHERE owner_type = 'property' AND deleted_at IS NULL
       UNION SELECT entity_id FROM attachments WHERE entity_type = 'property' AND deleted_at IS NULL`
    ).map((r) => r.id)
  ),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, version]);

  return (
    <Screen title="العقارات" noBack
      actions={
        <Row>
          <BtnGhost small icon="map" title="الخريطة" onPress={() => router.push('/propmap')} />
          <BtnPrimary small title="+ عقار جديد" onPress={() => { setEditingId(null); setFormOpen(true); }} />
        </Row>
      }>
      {/* الإشغال بمقياسيه: أيام الشهر أولاً ثم اللحظة · لا نسبة واحدة تخفي الأخرى */}
      <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <KpiCard label={'إشغال ' + summary.monthName} value={summary.occ.period.pct + '٪'}
          sub={`${summary.occ.period.occupiedUnitDays} من ${summary.occ.period.capacityUnitDays} يوم·وحدة`}
          onPress={() => router.push('/units')} />
        <KpiCard label="الإشغال الآن" value={summary.occ.now.pct + '٪'}
          sub={`${summary.occ.now.occupied} من ${summary.occ.now.total} وحدة`}
          onPress={() => router.push('/units?occ=rented')} />
      </Row>
      <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <KpiCard label="إجمالي قيمة عقود الإيجار (المحصَّلة)" tone="pos" value={<Money halalas={summary.pf.income} size={14} bold />}
          onPress={() => router.push('/contracts')} />
        <KpiCard label="عقود ملغية" tone="neu" value={<Money halalas={summary.pf.cancelledValue} size={14} bold />}
          sub={summary.pf.cancelledCount + (summary.pf.cancelledCount === 1 ? ' عقد' : ' عقود')}
          onPress={() => router.push(`/contracts?status=${encodeURIComponent('ملغى')}`)} />
      </Row>
      <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <KpiCard label="العقار الأعلى دخلاً" tone="pos"
          value={summary.topRevName}
          sub={summary.top.topPropRevenue ? fmt(summary.top.topPropRevenue.amount) : undefined}
          onPress={summary.top.topPropRevenue ? () => setDetailId(summary.top.topPropRevenue!.id) : undefined} />
        <KpiCard label="العقار الأكثر صرفاً" tone="neg"
          value={summary.topExpName}
          sub={summary.top.topPropExpense ? fmt(summary.top.topPropExpense.amount) : undefined}
          onPress={summary.top.topPropExpense ? () => setDetailId(summary.top.topPropExpense!.id) : undefined} />
      </Row>

      <View style={{ marginBottom: 8 }}><SearchBox value={q} onChange={setQ} /></View>
      {archivedCount > 0 || showArchived ? (
        <View style={{ marginBottom: 8 }}>
          <ChipGroup options={[[0, 'القائمة'], [1, `المؤرشفة (${archivedCount})`]]}
            value={showArchived ? 1 : 0} onChange={(v) => setShowArchived(!!v)} />
        </View>
      ) : null}
      <Pager pager={pager} total={totalRows} />

      {!ready ? <Skeleton rows={5} /> : rows.length ? rows.map((p) => {
        const st = statsByProp.get(p.id)
          ?? { total: 0, occupied: 0, vacant: 0, occupancyPct: 0, income: 0, cancelledValue: 0, cancelledCount: 0 };
        return (
          <Card key={p.id} style={{ paddingVertical: 10 }}>
            <Pressable onPress={() => setDetailId(p.id)}>
              {/* صف العنوان: الاسم يميناً وشاراته ثم ⋮ في أقصى اليسار بمحاذاته */}
              <Row style={{ justifyContent: 'space-between' }}>
                <T size={13.5} bold style={{ flex: 1 }}>{p.name}</T>
                <Row gap={6}>
                  {p.archived ? <Badge kind="draft" label="مؤرشف" /> : null}
                  <Badge kind={st.occupancyPct === 100 ? 'paid' : st.occupancyPct === 0 ? 'overdue' : 'due'}
                    label={`${st.occupied}/${st.total} مؤجَّرة (${st.occupancyPct}٪)`} />
                  <ActionMenuButton title={p.name} actions={[
                    { icon: 'eye', label: 'عرض التفاصيل', onPress: () => setDetailId(p.id) },
                    { icon: 'edit', label: 'تعديل', onPress: () => { setEditingId(p.id); setFormOpen(true); } },
                    // لا تُضاف وحدة لعقار مؤرشف · الأرشيف خارج التشغيل
                    p.archived ? null : { label: '+ إضافة وحدة', onPress: () => setUnitFormFor({ propertyId: p.id }) },
                    {
                      icon: p.archived ? 'undo' : 'archive',
                      label: p.archived ? 'إلغاء الأرشفة' : 'أرشفة',
                      onPress: () => {
                        setPropertyArchived(db, p.id, !p.archived);
                        bump();
                        toast(p.archived ? 'أُلغيت الأرشفة' : 'أُرشف العقار · يبقى في الدفتر والتقارير كما هو');
                      },
                    },
                    // الحذف لا يُعرض لعقار له مرتبطات · لا يصح فعله فلا يُعرض ثم يُرفض
                    linkedProps.has(p.id) ? null : {
                      icon: 'trash', label: 'حذف', danger: true,
                      onPress: () => dialog({
                        title: 'حذف العقار',
                        body: `حذف "${p.name}"؟`,
                        tone: 'danger',
                        actions: [
                          { label: 'تراجع', variant: 'ghost' },
                          {
                            label: 'حذف', variant: 'danger',
                            onPress: () => {
                              try {
                                deleteProperty(db, p.id);
                                bump();
                                toast('تم الحذف · يمكن استعادته من الإعدادات');
                              } catch (e) { reportFailure({ title: 'تعذّر الحذف', e }); }
                            },
                          },
                        ],
                      }),
                    },
                  ]} />
                </Row>
              </Row>
              <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
                {p.address ? <T size={11.5} color={C.muted}>{p.address}</T> : null}
              </Row>
              <Row style={{ marginTop: 6, justifyContent: 'space-between' }}>
                <Row gap={10}>
                  {p.ownership ? <Badge kind="draft" label={p.ownership} /> : null}
                  {p.activity_type ? <Badge kind="draft" label={p.activity_type} /> : null}
                  {p.activity_subtype ? <Badge kind="draft" label={p.activity_subtype} /> : null}
                </Row>
                <View><T size={10} color={C.muted}>قيمة العقود</T><Money halalas={st.income} size={12} bold /></View>
              </Row>
            </Pressable>
          </Card>
        );
      }) : <Card><EmptyState>لا توجد عقارات مطابقة</EmptyState></Card>}

      {formOpen && (
        <PropertyFormSheet
          propertyId={editingId}
          onClose={() => setFormOpen(false)}
          onSaved={(newId, unitCount) => {
            setFormOpen(false);
            bump();
            toast(editingId ? 'تم تحديث العقار' : 'تمت إضافة العقار');
            if (newId && unitCount > 0) setBulkFor({ propertyId: newId, count: unitCount });
          }}
        />
      )}
      {bulkFor && (
        <BulkUnitsSheet
          propertyId={bulkFor.propertyId}
          count={bulkFor.count}
          onClose={() => setBulkFor(null)}
          onDone={(added, skipped) => {
            setBulkFor(null);
            bump();
            toast(`تمت إضافة ${added} وحدة` + (skipped ? ` (تخطّي ${skipped} برقم مكرر)` : ''));
          }}
        />
      )}
      {detailId && (
        <PropertyDetailSheet
          propertyId={detailId}
          onClose={() => setDetailId(null)}
          // الطبقة السفلى تبقى: الوحدة تُفتح فوق العقار لا بدله · فالخروج منها يعيد إلى العقار
          onAddUnit={() => setUnitFormFor({ propertyId: detailId })}
          onOpenUnit={(uid_) => setUnitDetailId(uid_)}
        />
      )}
      {unitFormFor && (
        <UnitFormSheet
          propertyId={unitFormFor.propertyId}
          unitId={unitFormFor.unitId}
          onClose={() => setUnitFormFor(null)}
          onSaved={() => { setUnitFormFor(null); bump(); toast(unitFormFor.unitId ? 'تم تحديث الوحدة' : 'تمت إضافة الوحدة'); }}
        />
      )}
      {unitDetailId && (
        <UnitDetailSheet
          unitId={unitDetailId}
          onClose={() => setUnitDetailId(null)}
          onEdit={() => setUnitFormFor({ unitId: unitDetailId })}
          onReserve={() => { setReserveUnitId(unitDetailId); setUnitDetailId(null); }}
        />
      )}
      {reserveUnitId && (
        <ReservationSheet
          unitId={reserveUnitId}
          onClose={() => setReserveUnitId(null)}
          onDone={() => { setReserveUnitId(null); bump(); toast('تم حجز الوحدة بنجاح'); }}
        />
      )}
    </Screen>
  );
}

/* ═══════════ نافذة عقار جديد / تعديل ═══════════ */
function PropertyFormSheet({
  propertyId, onClose, onSaved,
}: { propertyId: string | null; onClose: () => void; onSaved: (newId: string | null, unitCount: number) => void }) {
  const { db } = useApp();
  const toast = useToast();
  const existing = propertyId ? db.get<PropRow>(`SELECT * FROM properties WHERE id = ?`, [propertyId]) : undefined;

  const [name, setName] = useState(existing?.name ?? '');
  const [address, setAddress] = useState(existing?.address ?? '');
  const [floors, setFloors] = useState(existing?.floors != null ? String(existing.floors) : '');
  const [unitCount, setUnitCount] = useState('');
  const [activity, setActivity] = useState(existing?.activity_type ?? '');
  const [subtype, setSubtype] = useState(existing?.activity_subtype ?? '');
  const [ownership, setOwnership] = useState<'ملك' | 'إيجار' | 'تشغيل'>((existing?.ownership as 'ملك') ?? 'ملك');
  const [deedNo, setDeedNo] = useState(existing?.deed_no ?? '');
  const [leaseValue, setLeaseValue] = useState(existing?.lease_value_halalas != null ? fmt(Number(existing.lease_value_halalas)).replace(/,/g, '') : '');
  const [leaseCycle, setLeaseCycle] = useState(existing?.lease_cycle ?? 'سنوية');
  const [leaseStart, setLeaseStart] = useState(existing?.lease_start ?? '');
  const [leaseEnd, setLeaseEnd] = useState(existing?.lease_end ?? '');
  const [opRate, setOpRate] = useState(existing?.op_rate != null ? String(existing.op_rate) : '');
  const [lat, setLat] = useState(existing?.lat != null ? String(existing.lat) : '');
  const [lng, setLng] = useState(existing?.lng != null ? String(existing.lng) : '');
  const [geoQuery, setGeoQuery] = useState('');
  const [floorCats, setFloorCats] = useState<Record<string, string>>(() => {
    if (!propertyId) return {};
    const out: Record<string, string> = {};
    for (const r of db.all<{ floor_label: string; category: string }>(
      `SELECT floor_label, category FROM property_floor_categories WHERE property_id = ?`, [propertyId]
    )) out[r.floor_label] = r.category;
    return out;
  });
  const [areas, setAreas] = useState<SectionData[]>(() => {
    if (!propertyId)
      return [{ name: 'المدخل الرئيسي', items: [] }, { name: 'المصعد', items: [] }, { name: 'السطح', items: [] }, { name: 'المواقف', items: [] }];
    return db.all<{ id: string; area_name: string }>(
      `SELECT id, area_name FROM property_areas WHERE property_id = ? ORDER BY sort`, [propertyId]
    ).map((a) => ({
      name: a.area_name,
      items: db.all<{ name: string; descr: string }>(
        `SELECT name, descr FROM property_area_items WHERE area_id = ? ORDER BY sort`, [a.id]
      ),
    }));
  });
  const [meters, setMeters] = useState<MeterInput[]>(() =>
    propertyId
      ? metersOf(db, 'property', propertyId).map((m) => ({ id: m.id, kind: m.kind, number: m.number, supplierId: m.supplier_id }))
      : []
  );
  const [pendingFile, setPendingFile] = useState<{ uri: string; name: string; mime: string } | null>(null);
  const [pendingPhotos, setPendingPhotos] = useState<Array<{ uri: string; name: string; mime: string }>>([]);

  const save = () => {
    try {
      const isNew = !propertyId;
      const id = saveProperty(db, {
        name, address,
        floors: floors.trim() ? parseInt(floors, 10) : null,
        activityType: activity, activitySubtype: subtype,
        ownership, deedNo,
        leaseValueHalalas: ownership === 'إيجار' ? toHalalas(leaseValue) : null,
        leaseCycle: ownership === 'إيجار' ? leaseCycle : null,
        leaseStart: ownership === 'إيجار' ? leaseStart || null : null,
        leaseEnd: ownership === 'إيجار' ? leaseEnd || null : null,
        opRate: ownership === 'تشغيل' && opRate.trim() ? parseFloat(opRate) : null,
        lat: lat.trim() ? parseFloat(lat) : null,
        lng: lng.trim() ? parseFloat(lng) : null,
        floorCategories: floorCats,
        areas, meters,
      }, propertyId ?? undefined);
      if (pendingFile) {
        attachPicked(db, pendingFile, 'property', id, ownership === 'ملك' ? 'deed' : 'lease')
          .catch(() => toast('تعذّر حفظ الملف'));
      }
      for (const ph of pendingPhotos) {
        attachPicked(db, ph, 'property', id, 'photo')
          .catch(() => toast('تعذّر حفظ صورة ' + ph.name));
      }
      onSaved(isNew ? id : null, parseInt(unitCount, 10) || 0);
    } catch (e) { reportFailure({ title: 'تعذّر الحفظ', e }); }
  };

  const fl = floorLabels(floors.trim() ? parseInt(floors, 10) : 0);

  return (
    <Sheet visible onClose={onClose} title={propertyId ? 'تعديل العقار' : 'عقار جديد'} tall
      footer={
        <>
          {/* بلا اسم لا يُحفظ العقار · فلا يُعرض زر الحفظ والحقل مظلَّل بسببه */}
          {name.trim() ? (
            <View style={{ flex: 1 }}><BtnPrimary title={propertyId ? 'حفظ التعديل' : 'إضافة العقار'} onPress={save} /></View>
          ) : null}
        </>
      }>
      <Field label="اسم العقار" value={name} onChange={setName} error={!name.trim()} />
      <Field label="العنوان" value={address} onChange={setAddress} />
      <Row>
        <View style={{ flex: 1 }}><Field label="عدد الطوابق" value={floors} onChange={setFloors} keyboard="numeric" ltr /></View>
        {!propertyId && <View style={{ flex: 1 }}><Field label="عدد الوحدات" value={unitCount} onChange={setUnitCount} keyboard="numeric" ltr /></View>}
      </Row>
      {fl.length > 1 && (
        <View style={{ marginBottom: 10 }}>
          <T size={11.5} color={C.muted} style={{ marginBottom: 6 }}>
            تخصيص فئة لكل طابق · يقيّد عقود ذلك الطابق بالفئة المحدَّدة فقط
          </T>
          {fl.map((f) => (
            <Row key={f} style={{ marginBottom: 4 }}>
              <T size={12} style={{ width: 80 }}>{f}</T>
              <View style={{ flex: 1 }}>
                <Field label="" value={floorCats[f] || ''} onChange={(v) => setFloorCats((p) => ({ ...p, [f]: v }))}
                  placeholder={RESIDENTIAL_SUBTYPES.join(' / ')} />
              </View>
            </Row>
          ))}
        </View>
      )}
      <SelectField label="نوع نشاط العقار" value={activity}
        options={PROPERTY_ACTIVITIES.map((a) => ({
          value: a, label: a === '' ? 'غير محدد (بدون قيد على نوع الوحدات)' : a === 'محل' ? 'محل تجاري' : a,
        }))}
        onPick={setActivity} />
      {activity === 'سكني' && (
        <SelectField label="تخصيص الفئة السكنية · يقيّد العقود على هذا العقار بهذه الفئة فقط"
          value={subtype}
          options={[{ value: '', label: 'بدون تخصيص' }, ...RESIDENTIAL_SUBTYPES.map((s) => ({ value: s, label: s }))]}
          onPick={setSubtype} />
      )}
      <SelectField label="نوع الملكية" value={ownership}
        options={[
          { value: 'ملك', label: 'ملك' },
          { value: 'إيجار', label: 'إيجار (مستأجَر من الغير)' },
          { value: 'تشغيل', label: 'تشغيل فقط (إدارة بدون ملكية أو إيجار)' },
        ]}
        onPick={setOwnership} />
      {ownership === 'ملك' && (
        <>
          <Field label="رقم صك الملكية" value={deedNo} onChange={setDeedNo} ltr />
          <View style={{ marginBottom: 10 }}>
            <BtnGhost small icon="attach" title={pendingFile ? pendingFile.name : 'ملف الصك'}
              onPress={async () => { const f = await pickFile(); if (f) setPendingFile(f); }} />
          </View>
        </>
      )}
      {ownership === 'إيجار' && (
        <>
          <Row>
            <View style={{ flex: 1 }}><Field label="قيمة الإيجار السنوي" value={leaseValue} onChange={setLeaseValue} keyboard="numeric" ltr /></View>
            <View style={{ flex: 1 }}>
              <SelectField label="دورية الدفعات" value={leaseCycle ?? 'سنوية'}
                options={CYCLE_OPTIONS.map((v) => ({ value: v, label: v }))}
                onPick={setLeaseCycle} />
            </View>
          </Row>
          <Row>
            <View style={{ flex: 1 }}><DateField label="بداية عقد الإيجار" value={leaseStart} onChange={setLeaseStart} /></View>
            <View style={{ flex: 1 }}><DateField label="نهاية عقد الإيجار" value={leaseEnd} onChange={setLeaseEnd} /></View>
          </Row>
          <View style={{ marginBottom: 10 }}>
            <BtnGhost small icon="attach" title={pendingFile ? pendingFile.name : 'ملف عقد الإيجار'}
              onPress={async () => { const f = await pickFile(); if (f) setPendingFile(f); }} />
          </View>
        </>
      )}
      {ownership === 'تشغيل' && <Field label="نسبة/عمولة التشغيل ٪" value={opRate} onChange={setOpRate} keyboard="numeric" ltr />}
      <T size={11.5} color={C.muted} style={{ marginBottom: 4 }}>صور العقار ({pendingPhotos.length})</T>
      <View style={{ marginBottom: 6 }}>
        <BtnGhost small icon="attach" title="+ إضافة صورة"
          onPress={async () => { const f = await pickFile(); if (f) setPendingPhotos((prev) => [...prev, f]); }} />
      </View>
      {pendingPhotos.map((ph, pi) => (
        <Row key={pi} style={{ justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 }}>
          <T size={11.5} color={C.muted} style={{ flex: 1 }}>{ph.name}</T>
          <BtnGhost small danger icon="trash" title="إزالة"
            onPress={() => setPendingPhotos((prev) => prev.filter((_, xi) => xi !== pi))} />
        </Row>
      ))}
      <T size={11.5} color={C.muted} style={{ marginBottom: 4 }}>موقع العقار (GPS)</T>
      <Row style={{ marginBottom: 8 }}>
        <View style={{ flex: 1 }}>
          <Field label="ابحث بالعنوان" value={geoQuery} onChange={setGeoQuery} placeholder="الرياض · حي..." />
        </View>
        {/* لا بحث عن عنوان فارغ · فلا يُعرض زره قبل كتابته */}
        {geoQuery.trim() ? <BtnGhost small icon="search" title="بحث" onPress={async () => {
          try {
            const res = await fetch(
              'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(geoQuery),
              { headers: { 'User-Agent': 'AqariApp/1.0' } }
            );
            const results = await res.json();
            if (!results.length) { toast('لم يتم العثور على هذا العنوان'); return; }
            setLat(parseFloat(results[0].lat).toFixed(6));
            setLng(parseFloat(results[0].lon).toFixed(6));
          } catch { toast('تعذّر البحث · تحقق من الاتصال بالإنترنت'); }
        }} /> : null}
      </Row>
      <View style={{ marginBottom: 8 }}>
        <LeafletMap
          height={220}
          pickable
          pin={lat.trim() && lng.trim() ? { lat: parseFloat(lat), lng: parseFloat(lng) } : null}
          center={lat.trim() && lng.trim() ? { lat: parseFloat(lat), lng: parseFloat(lng) } : undefined}
          zoom={lat.trim() ? 15 : 5}
          onPick={(la, ln) => { setLat(la.toFixed(6)); setLng(ln.toFixed(6)); }}
        />
        <T size={10.5} color={C.muted} style={{ marginTop: 4 }}>انقر على الخريطة لتحديد الموقع</T>
      </View>
      <Row>
        <View style={{ flex: 1 }}><Field label="خط العرض (Latitude)" value={lat} onChange={setLat} keyboard="numeric" ltr placeholder="24.7136" /></View>
        <View style={{ flex: 1 }}><Field label="خط الطول (Longitude)" value={lng} onChange={setLng} keyboard="numeric" ltr placeholder="46.6753" /></View>
      </Row>
      <MetersEditor meters={meters} onChange={setMeters} title="عدادات مشتركة" />

      <SectionsEditor sections={areas} onChange={setAreas}
        title="أقسام العقار ومحتوياتها" addSectionLabel="+ إضافة قسم" addItemLabel="+ إضافة تفصيل" namePlaceholder="اسم القسم" />
    </Sheet>
  );
}

/* ═══════════ الوحدات دفعة واحدة ═══════════ */
function BulkUnitsSheet({
  propertyId, count, onClose, onDone,
}: { propertyId: string; count: number; onClose: () => void; onDone: (added: number, skipped: number) => void }) {
  const { db } = useApp();
  const [prefix, setPrefix] = useState('');
  const [start, setStart] = useState('1');
  const [floor, setFloor] = useState('');
  const [type, setType] = useState('سكني');
  const [subtype, setSubtype] = useState('');
  const [rent, setRent] = useState('');
  const p = db.get<{ floors: number | null }>(`SELECT floors FROM properties WHERE id = ?`, [propertyId]);
  return (
    <Sheet visible onClose={onClose} title="إضافة الوحدات دفعة واحدة" tall
      footer={
        <>
          <View style={{ flex: 1 }}><BtnGhost title="تخطّي · أضيفها يدوياً لاحقاً" onPress={onClose} /></View>
          <View style={{ flex: 1 }}>
            <BtnPrimary title="إضافة الوحدات الآن" onPress={() => {
              const r = bulkAddUnits(db, propertyId, count, {
                prefix, start: parseInt(start, 10) || 1, floor, type, subtype, rentHalalas: toHalalas(rent),
              });
              onDone(r.added, r.skipped);
            }} />
          </View>
        </>
      }>
      <T size={12} color={C.muted} style={{ marginBottom: 10 }}>
        ستُضاف {count} وحدة بنفس التفاصيل التالية، ومرقَّمة تلقائياً بالتسلسل. تقدر تعدّل أي وحدة لاحقاً من قائمتها.
      </T>
      <Row>
        <View style={{ flex: 1 }}><Field label="بادئة رقم الوحدة" value={prefix} onChange={setPrefix} ltr /></View>
        <View style={{ flex: 1 }}><Field label="رقم البداية" value={start} onChange={setStart} keyboard="numeric" ltr /></View>
      </Row>
      <SelectField label="الطابق ( · يُترك فارغاً لو تختلف)" value={floor}
        options={[{ value: '', label: 'بدون تحديد' }, ...floorLabels(p?.floors ?? 0).map((f) => ({ value: f, label: f }))]}
        onPick={setFloor} />
      <Row>
        <View style={{ flex: 1 }}>
          <SelectField label="نوع الوحدة" value={type}
            options={['سكني', 'سكن طلاب', 'سكن طالبات', 'محل', 'معرض', 'مكتب', 'مخزن'].map((v) => ({ value: v, label: v }))}
            onPick={setType} />
        </View>
        <View style={{ flex: 1 }}><Field label="الفئة/النشاط" value={subtype} onChange={setSubtype} /></View>
      </Row>
      <Field label="الإيجار الشهري" value={rent} onChange={setRent} keyboard="numeric" ltr />
    </Sheet>
  );
}

/* ═══════════ تفاصيل العقار ═══════════ */
function PropertyDetailSheet({
  propertyId, onClose, onAddUnit, onOpenUnit,
}: { propertyId: string; onClose: () => void; onAddUnit: () => void; onOpenUnit: (unitId: string) => void }) {
  const { db, version } = useApp();
  const [meterOpen, setMeterOpen] = useState<LabeledMeter | null>(null);
  const router = useRouter();
  const p = db.get<PropRow>(`SELECT * FROM properties WHERE id = ?`, [propertyId]);
  const stats = useMemo(() => propertyStats(db, propertyId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, propertyId, version]);
  if (!p) return null;
  const units = db.all<{ id: string; unit_no: string; under_maintenance: number }>(
    `SELECT id, unit_no, under_maintenance FROM units WHERE property_id = ? AND deleted_at IS NULL ORDER BY COALESCE(unit_no_key, unit_no), unit_no`,
    [propertyId]
  );
  const areas = db.all<{ id: string; area_name: string }>(
    `SELECT id, area_name FROM property_areas WHERE property_id = ? ORDER BY sort`, [propertyId]
  );
  const meters = metersOf(db, 'property', propertyId);
  const linkedInvoices = db.all<{ total_halalas: number }>(
    `SELECT total_halalas FROM invoices WHERE deleted_at IS NULL AND (property_id = ? OR unit_id IN (SELECT id FROM units WHERE property_id = ?))`,
    [propertyId, propertyId]
  );
  const linkedPurchases = db.all<{ total_halalas: number }>(
    `SELECT total_halalas FROM purchases WHERE deleted_at IS NULL AND (property_id = ? OR unit_id IN (SELECT id FROM units WHERE property_id = ?))`,
    [propertyId, propertyId]
  );
  const rev = linkedInvoices.reduce((s, v) => s + Number(v.total_halalas), 0);
  const exp = linkedPurchases.reduce((s, v) => s + Number(v.total_halalas), 0);
  const { unitStatusInfo } = require('../../src/domain/stats') as typeof import('../../src/domain/stats');
  return (
    <Sheet visible onClose={onClose} title={p.name} tall>
      {p.address ? (
        <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          {p.address ? <View style={{ flex: 1 }}><T size={11} color={C.muted}>العنوان</T><T size={12.5}>{p.address}</T></View> : null}
        </Row>
      ) : null}
      <Row style={{ flexWrap: 'wrap', marginBottom: 10 }}>
        <KpiCard label="نسبة التشغيل الحالية" tone="pos" value={stats.occupancyPct + '٪'} sub={`${stats.occupied} من ${stats.total} وحدة`} />
        <KpiCard label="الوحدات الشاغرة" tone="neu" value={String(stats.vacant)} />
      </Row>
      <Row style={{ flexWrap: 'wrap', marginBottom: 10 }}>
        <KpiCard label="إجمالي قيمة العقود (المحصَّلة)" tone="pos" value={<Money halalas={stats.income} size={14} bold />} />
        <KpiCard label="عقود ملغية" tone="neu" value={<Money halalas={stats.cancelledValue} size={14} bold />}
          sub={stats.cancelledCount + (stats.cancelledCount === 1 ? ' عقد' : ' عقود')} />
      </Row>

      <AttachStrip entityType="property" entityId={propertyId} kind="deed"
        linked={p?.name ?? 'العقار'} title="الصك وصور العقار" hideAdd />

      {/* المصاريف: المشتركة على العقار مفروقة عن مصاريف الوحدات · بالاشتقاق من نفس الصفوف */}
      {(() => {
        const shared = Number(db.get<{ s: number }>(
          `SELECT COALESCE(SUM(total_halalas),0) AS s FROM purchases
           WHERE deleted_at IS NULL AND property_id = ? AND unit_id IS NULL`, [propertyId]
        )!.s);
        const perUnit = db.all<{ unit_id: string; unit_no: string; s: number }>(
          `SELECT pu.unit_id, u.unit_no, COALESCE(SUM(pu.total_halalas),0) AS s
           FROM purchases pu JOIN units u ON u.id = pu.unit_id
           WHERE pu.deleted_at IS NULL AND u.property_id = ?
           GROUP BY pu.unit_id ORDER BY u.unit_no`, [propertyId]
        );
        const unitsTotal = perUnit.reduce((s, r) => s + Number(r.s), 0);
        if (!shared && !perUnit.length) return null;
        return (
          <View style={{ backgroundColor: C.paper, borderRadius: 9, padding: 11, marginBottom: 10 }}>
            <T size={13} bold color={C.ink} style={{ marginBottom: 6 }}>المصاريف</T>
            {/* الضغط يفتح شاشة فواتير الشراء مفلترة على هذا العقار · لا انسدال داخل الورقة */}
            <Pressable onPress={() => { onClose(); router.push(`/purchases?property=${propertyId}`); }}>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
                <T size={12}>مشتركة على العقار</T>
                <Money halalas={shared} size={12.5} bold color={C.rose} />
              </Row>
            </Pressable>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <T size={12}>على الوحدات ({perUnit.length})</T>
              <Money halalas={unitsTotal} size={12.5} bold color={C.rose} />
            </Row>
            {perUnit.map((r) => (
              <Pressable key={r.unit_id} onPress={() => onOpenUnit(r.unit_id)}>
                <Row style={{ justifyContent: 'space-between', paddingVertical: 5 }}>
                  <T size={12} color={C.emerald}>وحدة {r.unit_no}</T>
                  <Money halalas={Number(r.s)} size={12} />
                </Row>
              </Pressable>
            ))}
            <Row style={{ justifyContent: 'space-between', paddingVertical: 4, borderTopWidth: 1, borderTopColor: C.line }}>
              <T size={12} bold>الإجمالي</T>
              <Money halalas={shared + unitsTotal} size={12.5} bold color={C.rose} />
            </Row>
          </View>
        );
      })()}

      {meters.length ? (
        <>
          <T size={13} bold color={C.ink} style={{ marginBottom: 6 }}>العدادات ({meters.length})</T>
          {meters.map((m) => (
            <Pressable key={m.id} onPress={() => setMeterOpen(m)}>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <Row gap={6}>
                  <Icon name={(METER_ICON[m.kind] ?? 'settings') as IconName} size={15}
                    color={m.kind === 'كهرباء' ? C.gold : m.kind === 'ماء' ? '#2E7CB8' : C.emerald} />
                  <T size={12} color={C.emerald}>{m.label}</T>
                </Row>
                <Num size={11.5} color={C.muted}>{m.number}</Num>
              </Row>
            </Pressable>
          ))}
        </>
      ) : null}
      {meterOpen && <MeterSheet meter={meterOpen} onClose={() => setMeterOpen(null)} />}

      <T size={13} bold color={C.ink} style={{ marginTop: 12, marginBottom: 6 }}>تفاصيل العقار ({areas.length})</T>
      {areas.length ? areas.map((a) => {
        const items = db.all<{ name: string }>(`SELECT name FROM property_area_items WHERE area_id = ? ORDER BY sort`, [a.id]);
        return (
          <View key={a.id} style={{ marginBottom: 6 }}>
            <T size={12.5} bold>{a.area_name}</T>
            <T size={11.5} color={C.muted}>{items.length ? items.map((i) => i.name).join('، ') : 'لا توجد تفاصيل مضافة'}</T>
          </View>
        );
      }) : <T size={12} color={C.muted}>لم تُضَف تفاصيل العقار بعد</T>}

      <Row style={{ justifyContent: 'space-between', marginTop: 12, marginBottom: 8 }}>
        <T size={13} bold color={C.ink}>الوحدات ({units.length})</T>
        {/* العقار المؤرشف خارج التشغيل · لا تُضاف إليه وحدة */}
        {p.archived ? null : <BtnPrimary small title="+ إضافة وحدة" onPress={onAddUnit} />}
      </Row>
      <Row style={{ flexWrap: 'wrap', gap: 8 }}>
        {units.length ? units.map((u) => {
          const st = unitStatusInfo(db, { id: u.id, under_maintenance: Number(u.under_maintenance) });
          return (
            <Pressable key={u.id} onPress={() => onOpenUnit(u.id)}
              style={{
                minWidth: 58, minHeight: 48, borderRadius: 9, borderWidth: 1.5, borderColor: st.color,
                backgroundColor: st.bg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8,
              }}>
              <T size={13} bold color={st.color}>{u.unit_no}</T>
            </Pressable>
          );
        }) : <T size={12} color={C.muted}>لا توجد وحدات بهذا العقار</T>}
      </Row>

      <Row style={{ flexWrap: 'wrap', marginTop: 14 }}>
        <KpiCard label="إجمالي الفواتير (إيرادات)" tone="pos" value={<Money halalas={rev} size={13} bold />}
          onPress={() => { onClose(); router.push('/invoices'); }} />
        <KpiCard label="إجمالي المصاريف المرتبطة" tone="neg" value={<Money halalas={exp} size={13} bold />}
          onPress={() => { onClose(); router.push(`/purchases?property=${propertyId}`); }} />
        <KpiCard label="الصافي" tone={rev - exp >= 0 ? 'pos' : 'neg'} value={<Money halalas={rev - exp} size={13} bold />} />
      </Row>
      <View style={{ height: 14 }} />
    </Sheet>
  );
}

/* ═══════════ الحجز بعربون ═══════════ */
/* نافذة الحجز بعربون صارت مشتركة في src/ui/ReservationSheet.tsx */

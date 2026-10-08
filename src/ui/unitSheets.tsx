/**
 * نافذتا الوحدة: نموذج الإنشاء/التعديل (غرف ومحتويات وعدادات) وتفاصيل الوحدة
 * (الحالة، التشغيل، التقبيل، تاريخ العقود، نماذج الاستلام).
 * وأقسام التفاصيل مطوية: الفارغ لا يُعرض إطلاقاً، والمملوء لا يُجلب محتواه
 * إلا عند فتحه، وداخله تقسيم صفحات · فالوحدة ذات المئات لا تُبطئ الورقة.
 */
import React, { useMemo, useState } from 'react';
import { CashGate, OwnerCashInSheet } from './CashGate';
import { cashShortfall } from '../domain/cashGuard';
import { View, Pressable } from 'react-native';
import { Sheet, SelectField } from './Sheet';
import { useRouter } from 'expo-router';
import { useDialog } from './AppDialog';
import { HandoverSheet } from './HandoverSheet';
import { InstallmentSheet } from './InstallmentSheet';
import { depositState } from '../domain/contracts/vocab';
import { Field, Row, T, Num, Money, BtnGhost, BtnPrimary, BtnIcon, Badge, KpiCard, Note } from './components';
import { DateField } from './DateField';
import { INSTALLMENT_DISCOUNT_SQL, installmentRemaining } from '../domain/contracts/installments';
import { CollapsibleSection } from './Collapsible';
import { MetersEditor, SectionsEditor, type SectionData } from './editors';
import { MeterSheet } from './MeterSheet';
import { Icon, type IconName } from './icons';
import { METER_ICON, type LabeledMeter } from '../domain/meters';
import { useApp } from './store';
import { AttachStrip } from './AttachStrip';
import { attachPicked, pickFile } from './attach';
import { useToast } from './Toast';
import { C, TYPE } from './theme';
import {
  saveUnit, toggleUnitMaintenance, UNIT_TYPE_CONFIG, floorLabels,
} from '../domain/propertiesService';
import { metersOf, type MeterInput } from '../domain/meters';
import { unitStatusInfo, unitOccupancyRate365, contractCancelledValue } from '../domain/stats';
import { cancelReservation, heldExpiredDeposits } from '../domain/reservations';
import { unitActiveReservation, contractStatusKind, contractStatusLabel } from '../domain/contracts/rules';
import { fmt, toHalalas } from '../domain/money';
import { dfmt, today } from '../domain/dates';
import { reportFailure } from './failureDialog';
import { useAccess, usePerm } from './access';
import { hiddenColumns } from '../sync/acl';
import { routeAllowed } from '../domain/access/routes';

import { CostCenterField } from './CostCenters';
import { GENERAL_COST_CENTER, withCostCenter } from '../domain/accounting/dimensions';
import { UnitAssetsSection } from './UnitAssets';
import { contractTotalSql, contractTotalOf } from '../domain/accounting/rentSplit';
import { useLang } from '../i18n';
export function UnitFormSheet({
  propertyId, unitId, onClose, onSaved,
}: { propertyId?: string; unitId?: string; onClose: () => void; onSaved: () => void }) {
  const { db } = useApp();
  const toast = useToast();
  // من يقرأ الوحدة بلا مبالغها لا يرى الإيجار ولا يكتبه: لا يُرفع منه (المراجعة #17 · الزر غير المسموح لا يظهر)
  const access = useAccess();
  const rentHidden = hiddenColumns(access, 'units', { rent_monthly_halalas: 0 }).length > 0;
  const existing = unitId
    ? db.get<{ property_id: string; unit_no: string; floor: string; type: string; subtype: string; rent_monthly_halalas: number }>(
        `SELECT * FROM units WHERE id = ?`, [unitId]
      )
    : undefined;
  const properties = db.all<{ id: string; name: string; floors: number | null }>(
    `SELECT id, name, floors FROM properties WHERE deleted_at IS NULL AND archived = 0 ORDER BY name`
  );
  const [propId, setPropId] = useState(existing?.property_id ?? propertyId ?? properties[0]?.id ?? '');
  const [unitNo, setUnitNo] = useState(existing?.unit_no ?? '');
  const [floor, setFloor] = useState(existing?.floor ?? 'الأرضي');
  const [type, setType] = useState(existing?.type ?? 'سكني');
  const [subtype, setSubtype] = useState(existing?.subtype ?? '');
  const [rent, setRent] = useState(existing ? fmt(Number(existing.rent_monthly_halalas)).replace(/,/g, '') : '');
  const [rooms, setRooms] = useState<SectionData[]>(() => {
    if (!unitId)
      return [{ name: 'الصالة الرئيسية', items: [] }, { name: 'المطبخ', items: [] }, { name: 'غرفة النوم الرئيسية', items: [] }, { name: 'الحمام', items: [] }];
    return db.all<{ id: string; room_name: string }>(
      `SELECT id, room_name FROM unit_rooms WHERE unit_id = ? ORDER BY sort`, [unitId]
    ).map((r) => ({
      name: r.room_name,
      items: db.all<{ name: string; descr: string }>(
        `SELECT name, descr FROM unit_room_items WHERE room_id = ? ORDER BY sort`, [r.id]
      ),
    }));
  });
  const [meters, setMeters] = useState<MeterInput[]>(() =>
    unitId ? metersOf(db, 'unit', unitId).map((m) => ({ id: m.id, kind: m.kind, number: m.number, supplierId: m.supplier_id })) : []
  );
  const selectedProp = properties.find((p) => p.id === propId);
  const cfg = UNIT_TYPE_CONFIG[type];

  const save = () => {
    try {
      saveUnit(db, {
        propertyId: propId, unitNo, floor, type, subtype,
        rentMonthlyHalalas: toHalalas(rent), rooms, meters,
      }, unitId);
      onSaved();
    } catch (e) { reportFailure({ title: 'تعذّر الحفظ', e }); }
  };

  if (!properties.length) {
    return (
      <Sheet visible onClose={onClose} title="وحدة جديدة">
        <T size={TYPE.cardTitle} color={C.muted} center style={{ paddingVertical: 20 }}>أضف عقاراً أولاً</T>
      </Sheet>
    );
  }

  return (
    <Sheet visible onClose={onClose} title={unitId ? 'تعديل الوحدة' : 'وحدة جديدة'} tall
      footer={
        <>
          <View style={{ flex: 1 }}><BtnPrimary title={unitId ? 'حفظ التعديل' : 'إضافة الوحدة'} onPress={save} /></View>
        </>
      }>
      {/* نقل وحدةٍ قائمة إلى عقار آخر للمالك ولذي كل العقارات وحدهما: القواعد ترفضه من المحصور بعقارات
          (رؤية الصف بعد النقل لا تُفحص في حدّ الألف تعبير) · فلا يظهر له (الزر غير المسموح لا يظهر) */}
      {!unitId || access.owner || access.allProps ? (
        <SelectField label="العقار" value={propId}
          options={properties.map((p) => ({ value: p.id, label: p.name }))}
          onPick={setPropId} />
      ) : null}
      <Row>
        <View style={{ flex: 1 }}><Field label="رقم الوحدة" value={unitNo} onChange={setUnitNo} ltr /></View>
        <View style={{ flex: 1 }}>
          <SelectField label="الطابق" value={floor}
            options={[...floorLabels(selectedProp?.floors ?? 0), 'غير محدد'].map((f) => ({ value: f, label: f }))}
            onPick={setFloor} />
        </View>
      </Row>
      <SelectField label="نوع الوحدة المعروضة" value={type}
        options={['سكني', 'سكن طلاب', 'سكن طالبات', 'محل', 'معرض', 'مكتب', 'مخزن'].map((v) => ({ value: v, label: v }))}
        onPick={setType} />
      {cfg ? (
        cfg.kind === 'select' ? (
          <SelectField label={cfg.label} value={subtype}
            options={[{ value: '', label: 'بلا فئة' }, ...(cfg.options ?? []).map((o) => ({ value: o, label: o }))]}
            onPick={setSubtype} />
        ) : (
          <Field label={cfg.label} value={subtype} onChange={setSubtype} />
        )
      ) : null}
      {rentHidden ? null : <Field label="الإيجار الشهري" value={rent} onChange={setRent} keyboard="numeric" ltr />}
      <MetersEditor meters={meters} onChange={setMeters} title="العدادات" />
      <SectionsEditor sections={rooms} onChange={setRooms}
        title="غرف الوحدة ومحتوياتها" addSectionLabel="+ إضافة غرفة" addItemLabel="+ إضافة محتوى" namePlaceholder="اسم الغرفة" />
    </Sheet>
  );
}

export function UnitDetailSheet({
  unitId, onClose, onEdit, onReserve,
}: { unitId: string; onClose: () => void; onEdit: () => void; onReserve: () => void }) {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const router = useRouter();
  const perm = usePerm('props');
  // من يقرأ الوحدة بلا مبالغها: إيجارها عنده افتراضه لا الحقيقي، فلا يُعرض (المراجعة #17)
  const rentHidden = hiddenColumns(useAccess(), 'units', { rent_monthly_halalas: 0 }).length > 0;
  const rsvPerm = usePerm('reservations');
  const seesContracts = usePerm('contracts').view;
  const seesHandover = usePerm('handover').view;
  const access = useAccess();
  const openPurchases = routeAllowed(access, '/purchases');
  const [meterOpen, setMeterOpen] = useState<LabeledMeter | null>(null);
  const [contractFor, setContractFor] = useState<string | null>(null);
  const [handoverFor, setHandoverFor] = useState<string | null>(null);
  const [instFor, setInstFor] = useState<string | null>(null);
  // تسوية عربون حجزٍ انتهى ولم يُسوَّ (المراجعة ٤.٥) · بقرار المالك وتاريخه
  const [settle, setSettle] = useState<{ id: string; name: string; deposit: number } | null>(null);
  const [settleDate, setSettleDate] = useState(today());
  const [cc, setCc] = useState(GENERAL_COST_CENTER);
  // «إيداع المالك» بالناقص حين لا يكفي النقد لردّ عربون (قرار المالك ٢٠٢٦-١٠-٠٥)
  const [depositFor, setDepositFor] = useState<number | null>(null);
  const canDeposit = usePerm('banks').add;
  const u = db.get<{
    id: string; property_id: string; unit_no: string; floor: string; type: string; subtype: string;
    rent_monthly_halalas: number; under_maintenance: number;
  }>(`SELECT * FROM units WHERE id = ?`, [unitId]);

  /**
   * ما يُحسب مسبقاً: الحالة والتشغيل والملغيات وعدّادات الأقسام وحدها ·
   * سطور الأقسام نفسها لا تُجلب إلا عند فتح قسمها.
   */
  const data = useMemo(() => {
    if (!u) return null;
    const st = unitStatusInfo(db, { id: u.id, under_maintenance: Number(u.under_maintenance) });
    const rate = unitOccupancyRate365(db, u.id);
    // الملغيات وحدها للمؤشر · contractCancelledValue تعيد صفراً لغير الملغى فلا داعي لمسح الكل
    const cancelled = db.all<{ id: string; status: string; value_halalas: number }>(
      `SELECT id, status, value_halalas FROM contracts
       WHERE unit_id = ? AND deleted_at IS NULL AND status = 'ملغى'`, [unitId]);
    const cancelledTotal = cancelled.reduce(
      (s, c) => s + contractCancelledValue(db, { id: c.id, status: c.status, value_halalas: Number(c.value_halalas) }), 0);
    const rsv = unitActiveReservation(db, unitId);
    const held = heldExpiredDeposits(db).filter((r) => r.unit_id === unitId);
    const one = (sql: string, args: Array<string | number>) => Number(db.get<{ n: number }>(sql, args)?.n ?? 0);
    const counts = {
      occupants: one(
        `SELECT COUNT(*) AS n FROM occupants o JOIN contracts c ON c.id = o.contract_id
         WHERE o.unit_id = ? AND o.deleted_at IS NULL AND o.moved_out IS NULL
           AND c.deleted_at IS NULL AND c.status NOT IN ('ملغى')`, [unitId]),
      meters: one(`SELECT COUNT(*) AS n FROM meters WHERE owner_type = 'unit' AND owner_id = ? AND deleted_at IS NULL`, [unitId]),
      rooms: one(`SELECT COUNT(*) AS n FROM unit_rooms WHERE unit_id = ?`, [unitId]),
      keyMoney: one(`SELECT COUNT(*) AS n FROM key_money_deals WHERE unit_id = ? AND deleted_at IS NULL`, [unitId]),
      contracts: one(`SELECT COUNT(*) AS n FROM contracts WHERE unit_id = ? AND deleted_at IS NULL`, [unitId]),
      handovers: one(`SELECT COUNT(*) AS n FROM handovers WHERE unit_id = ? AND deleted_at IS NULL`, [unitId]),
      expenses: one(`SELECT COUNT(*) AS n FROM purchases WHERE unit_id = ? AND deleted_at IS NULL`, [unitId]),
      atts: one(`SELECT COUNT(*) AS n FROM attachments WHERE entity_type = 'unit' AND entity_id = ? AND deleted_at IS NULL`, [unitId]),
      cancelledCount: cancelled.length,
    };
    return { st, rate, cancelledTotal, rsv, held, counts };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, unitId, version]);

  const addDoc = async () => {
    const f = await pickFile();
    if (!f) return;
    attachPicked(db, f, 'unit', unitId, 'photo')
      .then(() => { bump(); toast('أُرفق وظهر في المكتبة تحت تصنيفه'); })
      .catch((e) => reportFailure({ title: 'تعذّر الإرفاق', e }));
  };

  if (!u || !data) return null;
  const propName = db.get<{ name: string }>(`SELECT name FROM properties WHERE id = ?`, [u.property_id])?.name ?? '';
  const rsv = data.rsv;
  return (
    <Sheet visible onClose={onClose} title={[propName, u.unit_no].filter(Boolean).join(' · ')} tall
      footer={perm.manage ? (
        <>
          <View style={{ flex: 1 }}><BtnGhost icon="edit" title="تعديل" onPress={onEdit} /></View>
          <View style={{ flex: 1 }}>
            <BtnGhost icon={Number(u.under_maintenance) ? 'check' : 'wrench'}
              title={Number(u.under_maintenance) ? 'إنهاء الصيانة' : 'وضع تحت الصيانة'}
              onPress={() => { toggleUnitMaintenance(db, unitId); bump(); }} />
          </View>
        </>
      ) : undefined}>
      <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        {u.type || u.subtype ? <View><T size={TYPE.caption} color={C.muted}>النوع</T><T size={TYPE.cardTitle}>{[u.type, u.subtype].filter(Boolean).join(' · ')}</T></View> : null}
        {u.floor ? <View><T size={TYPE.caption} color={C.muted}>الطابق</T><T size={TYPE.cardTitle}>{u.floor}</T></View> : null}
        {rentHidden ? null : <View><T size={TYPE.caption} color={C.muted}>الإيجار الشهري</T><Money halalas={Number(u.rent_monthly_halalas)} size={TYPE.cardTitle} bold /></View>}
      </Row>
      {/* الشاغرة وحدها تُحجز، والمحجوزة وحدها يُلغى حجزها · وإرفاق المستندات أيقونة عارية */}
      <Row style={{ marginBottom: 10 }}>
        <Badge kind={data.st.key === 'rented' ? 'paid' : data.st.key === 'reserved' ? 'due' : data.st.key === 'maintenance' ? 'overdue' : 'draft'}
          label={data.st.label} />
        {data.st.key === 'vacant' && rsvPerm.add && <BtnGhost small icon="card" title="حجز بعربون" onPress={onReserve} />}
        {rsv && rsvPerm.manage && (
          <BtnGhost small danger icon="cancel" title="إلغاء الحجز" onPress={() => {
            const dep = Number(rsv.deposit_halalas);
            const short = cashShortfall(db, dep);
            dialog({
              title: 'إلغاء الحجز',
              body: `إلغاء حجز "${rsv.name}"؟` + (short > 0
                ? '\nالنقد في المحفظة لا يكفي لردّ العربون (' + fmt(dep) + ') · ينقصه ' + fmt(short) : ''),
              tone: 'danger',
              actions: [
                { label: 'تراجع', variant: 'ghost' },
                // الرد لا يظهر حين لا يكفي النقد · ومكانه «إيداع المالك» بالناقص
                ...(short > 0 ? (canDeposit ? [{
                  label: 'إيداع المالك · ' + fmt(short), variant: 'primary' as const, onPress: () => setDepositFor(short),
                }] : []) : [{
                  label: Number(rsv.deposit_halalas) > 0 ? `إلغاء وردّ العربون (${fmt(Number(rsv.deposit_halalas))})` : 'إلغاء الحجز',
                  variant: 'primary' as const,
                  onPress: () => {
                    try {
                      cancelReservation(db, rsv.id, false); bump();
                      toast(Number(rsv.deposit_halalas) > 0 ? 'أُلغي الحجز ورُحّل قيد ردّ العربون' : 'أُلغي الحجز');
                    } catch (e) { reportFailure({ title: 'تعذّر الإلغاء', e }); }
                  },
                }]),
                // بلا عربون لا مصادرة · الزر لا يُعرض أصلاً
                ...(Number(rsv.deposit_halalas) > 0 ? [{
                  label: `مصادرة العربون (${fmt(Number(rsv.deposit_halalas))})`,
                  variant: 'danger' as const,
                  onPress: () => { cancelReservation(db, rsv.id, true); bump(); toast('أُلغي الحجز وصودر العربون إيراداً'); },
                }] : []),
              ],
            });
          }} />
        )}
        <View style={{ flex: 1 }} />
        {perm.add ? <BtnIcon icon="attach" accessibilityLabel="إضافة مستند أو صورة" onPress={addDoc} /> : null}
      </Row>
      {rsvPerm.manage && data.held.map((h) => (
        <Note key={h.id}>
          <T size={12.5} bold>عربون محتجز لحجز منتهٍ: «{h.name}» · {fmt(Number(h.deposit_halalas))}</T>
          <T size={12} color={C.muted} style={{ marginVertical: 6 }}>
            انتهى الحجز في {dfmt(h.expiry_date)} وعربونه ما زال التزاماً في الدفتر. إن رددته لصاحبه أو صادرته فسجّل ذلك بتاريخه.
          </T>
          <BtnGhost small title="تسوية العربون" onPress={() => {
            setSettleDate(today());
            setSettle({ id: h.id, name: h.name, deposit: Number(h.deposit_halalas) });
          }} />
        </Note>
      ))}
      {depositFor !== null ? <OwnerCashInSheet amountHalalas={depositFor} onClose={() => setDepositFor(null)} /> : null}
      {settle ? (
        <Sheet visible onClose={() => setSettle(null)} title={'تسوية عربون «' + settle.name + '»'}>
          <DateField label="تاريخ الرد أو المصادرة" value={settleDate} onChange={setSettleDate} />
          <CostCenterField value={cc} onChange={setCc} />
          <View style={{ marginBottom: 8 }}>
            <CashGate needed={settle.deposit} what="ردّ العربون">
              <BtnPrimary title={'ردّ العربون لصاحبه (' + fmt(settle.deposit) + ')'} onPress={() => {
                try { withCostCenter(cc, () => cancelReservation(db, settle.id, false, settleDate)); setSettle(null); bump(); toast('رُحّل قيد ردّ العربون'); }
                catch (e) { reportFailure({ title: 'تعذّرت التسوية', e }); }
              }} />
            </CashGate>
          </View>
          <BtnGhost danger title={'مصادرة العربون إيراداً (' + fmt(settle.deposit) + ')'} onPress={() => {
            try { withCostCenter(cc, () => cancelReservation(db, settle.id, true, settleDate)); setSettle(null); bump(); toast('رُحّل قيد مصادرة العربون'); }
            catch (e) { reportFailure({ title: 'تعذّرت التسوية', e }); }
          }} />
        </Sheet>
      ) : null}
      <Row style={{ flexWrap: 'wrap', marginBottom: 10 }}>
        <KpiCard label="نسبة التشغيل (آخر 365 يوماً)" tone="neu" value={data.rate + '٪'} />
        <KpiCard label="عقود ملغية لهذه الوحدة" tone="neu" value={<Money halalas={data.cancelledTotal} />}
          sub={data.counts.cancelledCount + ' عقد'} />
      </Row>

      <CollapsibleSection title="الساكنون الحاليون" count={data.counts.occupants} icon="collect" pageKey="unitOccupants">
        {(page) => db.all<{ id: string; name: string; relation: string; national_id: string }>(
          `SELECT o.id, o.name, o.relation, o.national_id FROM occupants o JOIN contracts c ON c.id = o.contract_id
           WHERE o.unit_id = ? AND o.deleted_at IS NULL AND o.moved_out IS NULL
             AND c.deleted_at IS NULL AND c.status NOT IN ('ملغى')
           ORDER BY o.created_at LIMIT ? OFFSET ?`, [unitId, page.limit, page.offset]
        ).map((o) => (
          <Row key={o.id} style={{ justifyContent: 'space-between', paddingVertical: 5 }}>
            <T size={TYPE.cardTitle}>{o.name} · {o.relation}</T>
            {o.national_id ? <Num size={TYPE.caption} color={C.muted}>{o.national_id}</Num> : null}
          </Row>
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="العدادات" count={data.counts.meters} icon="bolt" pageKey="unitMeters">
        {(page) => metersOf(db, 'unit', unitId).slice(page.offset, page.offset + page.limit).map((m) => (
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

      <CollapsibleSection title="غرف الوحدة ومحتوياتها" count={data.counts.rooms} icon="home" pageKey="unitRooms">
        {(page) => db.all<{ id: string; room_name: string }>(
          `SELECT id, room_name FROM unit_rooms WHERE unit_id = ? ORDER BY sort LIMIT ? OFFSET ?`,
          [unitId, page.limit, page.offset]
        ).map((r) => {
          const items = db.all<{ name: string }>(`SELECT name FROM unit_room_items WHERE room_id = ? ORDER BY sort`, [r.id]);
          return (
            <View key={r.id} style={{ marginBottom: 6 }}>
              <T size={TYPE.cardTitle} bold>{r.room_name}</T>
              <T size={TYPE.caption} color={C.muted}>{items.length ? items.map((i) => i.name).join('، ') : 'لا توجد محتويات مضافة'}</T>
            </View>
          );
        })}
      </CollapsibleSection>

      {/* أصول الوحدة (الهجرة ٢٩) */}
      <UnitAssetsSection unitId={unitId} />

      <CollapsibleSection title="سجل التقبيل" count={data.counts.keyMoney} icon="swap" pageKey="unitKeyMoney">
        {(page) => db.all<{ id: string; outgoing: string; incoming: string; amount_halalas: number; commission_halalas: number }>(
          `SELECT id, outgoing, incoming, amount_halalas, commission_halalas FROM key_money_deals
           WHERE unit_id = ? AND deleted_at IS NULL ORDER BY date DESC LIMIT ? OFFSET ?`,
          [unitId, page.limit, page.offset]
        ).map((k) => (
          <Row key={k.id} style={{ justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <T size={TYPE.body}>{k.outgoing} إلى {k.incoming}</T>
            <Num size={TYPE.body}>{fmt(Number(k.amount_halalas))}{Number(k.commission_halalas) ? ' · عمولة ' + fmt(Number(k.commission_halalas)) : ''}</Num>
          </Row>
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="تاريخ العقود" count={data.counts.contracts} icon="contract" pageKey="unitContracts">
        {(page) => db.all<{ id: string; tenant_name: string; start: string | null; end: string | null; value_halalas: number; total_halalas: number; status: string }>(
          `SELECT id, tenant_name, start, "end", value_halalas, ${contractTotalSql(db)} AS total_halalas, status FROM contracts
           WHERE unit_id = ? AND deleted_at IS NULL ORDER BY start DESC LIMIT ? OFFSET ?`,
          [unitId, page.limit, page.offset]
        ).map((c) => {
          const row = { ...c, status: c.status as 'مسودة' | 'سارٍ' | 'منتهٍ' | 'ملغى' };
          return (
            <Pressable key={c.id} disabled={!seesContracts} onPress={() => setContractFor(c.id)}
              style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T size={TYPE.cardTitle} med>{c.tenant_name}</T>
                <Badge kind={contractStatusKind(row, today())} label={contractStatusLabel(row, today())} />
              </Row>
              <Row style={{ justifyContent: 'space-between', marginTop: 2 }}>
                <Num size={TYPE.caption} color={C.muted}>{dfmt(c.start)} · {dfmt(c.end)}</Num>
                <Money halalas={Number(c.total_halalas)} size={TYPE.body} />
              </Row>
            </Pressable>
          );
        })}
      </CollapsibleSection>

      {/* النموذج القديم بلا عقد مرتبط يُعرض بلا فتح · لا ضغطة ترفض */}
      <CollapsibleSection title="نماذج الاستلام والتسليم" count={data.counts.handovers} icon="clipboard" pageKey="unitHandovers">
        {(page) => db.all<{ id: string; type: string; tenant_name: string; date: string; contract_id: string | null }>(
          `SELECT id, type, tenant_name, date, contract_id FROM handovers
           WHERE unit_id = ? AND deleted_at IS NULL ORDER BY date DESC LIMIT ? OFFSET ?`,
          [unitId, page.limit, page.offset]
        ).map((h) => {
          const line = (
            <Row style={{ justifyContent: 'space-between', paddingVertical: 5 }}>
              <Row gap={8}>
                <Badge kind={h.type === 'استلام' ? 'paid' : 'due'} label={h.type} />
                <T size={TYPE.body}>{h.tenant_name}</T>
              </Row>
              <Num size={TYPE.caption} color={C.muted}>{dfmt(h.date)}</Num>
            </Row>
          );
          return h.contract_id && seesHandover
            ? <Pressable key={h.id} onPress={() => setHandoverFor(h.contract_id!)}>{line}</Pressable>
            : <View key={h.id}>{line}</View>;
        })}
      </CollapsibleSection>

      <CollapsibleSection title="مصاريف الوحدة" count={data.counts.expenses} icon="wrench" pageKey="unitExpenses">
        {(page) => db.all<{ id: string; no: string; supplier_name: string; date: string; total_halalas: number }>(
          `SELECT id, no, supplier_name, date, total_halalas FROM purchases
           WHERE deleted_at IS NULL AND unit_id = ? ORDER BY date DESC LIMIT ? OFFSET ?`,
          [unitId, page.limit, page.offset]
        ).map((e) => (
          <Pressable key={e.id} disabled={!openPurchases} onPress={() => { onClose(); router.push(`/purchases?detail=${e.id}`); }}>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <T size={TYPE.body}>{e.supplier_name} · {dfmt(e.date)}</T>
              <Money halalas={Number(e.total_halalas)} size={TYPE.body} />
            </Row>
          </Pressable>
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="صور الوحدة ومستنداتها" count={data.counts.atts} icon="attach">
        {() => (
          <AttachStrip entityType="unit" entityId={unitId} kind="photo"
            linked="الوحدة" title="صور الوحدة ومستنداتها" hideAdd canManage={perm.manage} />
        )}
      </CollapsibleSection>

      <View style={{ height: 14 }} />
      {meterOpen && <MeterSheet meter={meterOpen} onClose={() => setMeterOpen(null)} />}

      {/* عقد من السجل يُفتح فوق الوحدة · إغلاقه يعيدك للوحدة كما كنت */}
      {contractFor ? (
        <ContractQuickSheet contractId={contractFor} onClose={() => setContractFor(null)}
          onOpenInstallment={(iid) => setInstFor(iid)}
          onOpenFull={() => { const id2 = contractFor; setContractFor(null); onClose(); router.push(`/contracts?detail=${id2}`); }} />
      ) : null}
      {instFor ? (
        <InstallmentSheet installmentId={instFor}
          onClose={() => setInstFor(null)}
          onCollect={(iid) => { setInstFor(null); setContractFor(null); onClose(); router.push(`/collect?pay=${iid}`); }} />
      ) : null}
      {handoverFor ? (
        <HandoverSheet contractId={handoverFor} onClose={() => setHandoverFor(null)} onSaved={() => { setHandoverFor(null); bump(); }} />
      ) : null}
    </Sheet>
  );
}

/** عقد مختصر فوق ورقة الوحدة: بياناته وتأمينه وأقساطه · وكل قسط يفتح تفاصيله */
function ContractQuickSheet({ contractId, onClose, onOpenInstallment, onOpenFull }: {
  contractId: string;
  onClose: () => void;
  onOpenInstallment: (installmentId: string) => void;
  onOpenFull: () => void;
}) {
  const { db, version } = useApp();
  const openFull = routeAllowed(useAccess(), '/contracts');
  const { t } = useLang();
  const c = db.get<{
    id: string; contract_no: string; tenant_name: string; phone: string; start: string; end: string;
    value_halalas: number; deposit_halalas: number; cycle: string; status: string;
    deposit_holder?: string; deposit_holder_name?: string;
  }>(`SELECT * FROM contracts WHERE id = ?`, [contractId]);
  const instCount = useMemo(() => Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM contract_installments WHERE contract_id = ?`, [contractId])?.n ?? 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, contractId]);
  if (!c) return null;
  const row = { status: c.status, start: c.start, end: c.end } as never;
  return (
    <Sheet visible onClose={onClose} title={'عقد' + (c.contract_no ? ' ' + c.contract_no : '') + ' · ' + c.tenant_name} tall
      footer={openFull ? <View style={{ flex: 1 }}><BtnGhost title="فتح صفحة العقد كاملة" onPress={onOpenFull} /></View> : undefined}>
      <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <Badge kind={contractStatusKind(row, today())} label={contractStatusLabel(row, today())} />
        <Num size={TYPE.caption} color={C.muted}>{dfmt(c.start)} · {dfmt(c.end)}</Num>
      </Row>
      <Row style={{ marginBottom: 8 }}>
        <View style={{ flex: 1 }}><T size={TYPE.caption} color={C.muted}>{t('lease.contractTotal')}</T><Money halalas={contractTotalOf(c)} size={TYPE.cardTitle} bold /></View>
        {c.cycle ? <View style={{ flex: 1 }}><T size={TYPE.caption} color={C.muted}>الدورية</T><T size={TYPE.cardTitle}>{c.cycle}</T></View> : null}
      </Row>
      {Number(c.deposit_halalas) > 0 ? (
        <View style={{ marginBottom: 8 }}>
          <T size={TYPE.caption} color={C.muted}>التأمين</T>
          {/* الرقم ملوّناً وحده · النص في تفاصيل العقد والمطبوعات فقط */}
          <Money halalas={Number(c.deposit_halalas)} size={TYPE.cardTitle} bold
            color={depositState(c.deposit_holder, c.deposit_holder_name,
              !!db.get(
                `SELECT contract_id FROM deposit_settlements WHERE contract_id = ? AND deduction_halalas > 0 AND deduct_destination = 'محفظة إيجار'`,
                [contractId])
            ).fg} />
        </View>
      ) : null}
      <CollapsibleSection title="جدول الدفعات" count={instCount} icon="calendar" pageKey="quickInstallments">
        {(page) => db.all<{ id: string; due_date: string; amount_halalas: number; paid_halalas: number; discount: number; status: string; agreed_date: string | null }>(
          `SELECT i.id, i.due_date, i.amount_halalas, i.paid_halalas, ${INSTALLMENT_DISCOUNT_SQL} AS discount, i.status, i.agreed_date
           FROM contract_installments i
           WHERE i.contract_id = ? ORDER BY i.due_date LIMIT ? OFFSET ?`, [contractId, page.limit, page.offset]
        ).map((i) => {
          // المتبقي يطرح الخصم (المراجعة ٤.١٠)
          const remaining = installmentRemaining(Number(i.amount_halalas), Number(i.paid_halalas), Number(i.discount));
          return (
            <Pressable key={i.id} onPress={() => onOpenInstallment(i.id)}>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <Num size={TYPE.caption} color={i.agreed_date ? '#1D4ED8' : C.muted}>{dfmt(i.agreed_date ?? i.due_date)}</Num>
                <Row gap={8}>
                  <Money halalas={Number(i.amount_halalas)} size={TYPE.body} />
                  <Badge kind={remaining <= 0 ? 'paid' : 'due'} label={remaining <= 0 ? 'مدفوعة' : 'متبقٍ ' + fmt(remaining)} />
                </Row>
              </Row>
            </Pressable>
          );
        })}
      </CollapsibleSection>
      <View style={{ height: 12 }} />
    </Sheet>
  );
}

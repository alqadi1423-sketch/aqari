/**
 * نوافذ الأصول (قرار المالك ٢٠٢٦-١٠-٠٤ على موجز الأصول) · كل نصٍّ بمفتاحه في ملفي الترجمة.
 *  - NewAssetSheet: أصلٌ «بانتظار تكلفة».
 *  - AssetSheet: بيانات الأصل وقيمته الدفترية وجدوله وتاريخه، وأفعاله بحسب الصلاحية والحالة.
 *  - ConvertSheet: تحويل فاتورة شراء قديمة بمعاينةٍ قبل التنفيذ.
 *  - ContentsSheet: محتويات الوحدات إلى أصول.
 */
import React, { useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Sheet, SelectField } from './Sheet';
import { Badge, BtnGhost, BtnPrimary, ChipGroup, EmptyState, Field, Money, Note, Row, SearchBox, T } from './components';
import { DateField } from './DateField';
import { C, TYPE } from './theme';
import { useApp } from './store';
import { useToast } from './Toast';
import { usePerm } from './access';
import { reportFailure } from './failureDialog';
import { useLang } from '../i18n';
import { fmt, toHalalas } from '../domain/money';
import { today, dfmt } from '../domain/dates';
import { ASSET_CATEGORIES, defaultLife } from '../domain/assets/catalog';
import { bookValue, runDepreciation, scheduleByYear } from '../domain/assets/depreciation';
import {
  assetHistory, createPendingAsset, disposeAsset, getAsset, sellAsset, setAssetCost, setAssetStatus, transferAsset, updateAssetInfo, type AssetRow,
} from '../domain/assets/service';
import { convertibleInvoices, convertPurchase, expensedOf, previewConversion, type ConversionPreview } from '../domain/assets/convert';
import { contentsCandidates, convertContents } from '../domain/assets/contents';
import type { PurchaseLineInput } from '../domain/assets/purchaseLines';

/** الوحدات للاختيار: «العقار · الوحدة» */
export function useUnitOptions(): Array<{ value: string; label: string }> {
  const { db, version } = useApp();
  return useMemo(() => db.all<{ id: string; unit_no: string; pname: string }>(
    `SELECT u.id, u.unit_no, p.name AS pname FROM units u JOIN properties p ON p.id = u.property_id
     WHERE u.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY p.name, COALESCE(u.unit_no_key, u.unit_no)`)
    .map((u) => ({ value: u.id, label: u.pname + ' · ' + u.unit_no })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, version]);
}

export function useCategoryOptions(): Array<{ value: string; label: string }> {
  const { t } = useLang();
  return ASSET_CATEGORIES.map((c) => ({ value: c.code, label: t('assets.cat.' + c.code) }));
}

/** حالة الأصل شارةً: بانتظار تكلفة، أو حالته */
export function AssetBadge({ a }: { a: Pick<AssetRow, 'status' | 'cost_halalas'> }) {
  const { t } = useLang();
  if (a.cost_halalas == null && a.status !== 'disposed' && a.status !== 'sold') return <Badge kind="due" label={t('assets.costState.pending')} />;
  const kind = a.status === 'in_service' ? 'paid' : a.status === 'maintenance' ? 'overdue' : 'draft';
  return <Badge kind={kind} label={t('assets.status.' + a.status)} />;
}

const ok = (n: string) => n.trim().length > 0;

/* ═══════════ أصل جديد ═══════════ */

export function NewAssetSheet({ onClose, unitId }: { onClose: () => void; unitId?: string }) {
  const { db, bump } = useApp();
  const { t } = useLang();
  const toast = useToast();
  const units = useUnitOptions();
  const cats = useCategoryOptions();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState(unitId ?? '');
  const [room, setRoom] = useState('');
  const [model, setModel] = useState('');
  const [serial, setSerial] = useState('');
  const [warranty, setWarranty] = useState('');
  const [notes, setNotes] = useState('');
  const save = () => {
    try {
      createPendingAsset(db, { name, category, unitId: unit, room, model, serial, warrantyEnd: warranty || null, notes });
      bump(); toast(t('assets.ui.created')); onClose();
    } catch (e) { reportFailure({ title: t('common.failed'), e }); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('assets.ui.newTitle')} tall
      footer={ok(name) && category && unit ? <View style={{ flex: 1 }}><BtnPrimary title={t('common.save')} onPress={save} /></View> : undefined}>
      <Note>{t('assets.ui.newNote')}</Note>
      <Field label={t('assets.ui.name')} value={name} onChange={setName} />
      <SelectField label={t('assets.ui.category')} value={category} options={cats} onPick={setCategory} />
      <SelectField label={t('common.unit')} value={unit} options={units} onPick={setUnit} />
      <Field label={t('common.room')} value={room} onChange={setRoom} />
      <Row>
        <View style={{ flex: 1 }}><Field label={t('assets.ui.model')} value={model} onChange={setModel} /></View>
        <View style={{ flex: 1 }}><Field label={t('assets.ui.serial')} value={serial} onChange={setSerial} ltr /></View>
      </Row>
      <DateField label={t('assets.ui.warrantyEnd')} value={warranty} onChange={setWarranty} />
      <Field label={t('common.notes')} value={notes} onChange={setNotes} multiline />
    </Sheet>
  );
}

/* ═══════════ الأصل ═══════════ */

type Action = 'cost' | 'transfer' | 'dispose' | 'sell' | 'edit' | null;

function InfoRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
      <T size={TYPE.caption} color={C.muted}>{k}</T>
      {typeof v === 'string' ? <T size={TYPE.body}>{v}</T> : v}
    </Row>
  );
}

export function AssetSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { db, version, bump } = useApp();
  const { t } = useLang();
  const perm = usePerm('assets');
  const [action, setAction] = useState<Action>(null);
  const a = useMemo(() => { try { return getAsset(db, id); } catch { return null; } },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, id, version]);
  const unitLabel = useMemo(() => (a?.unit_id ? db.get<{ l: string }>(
    `SELECT p.name || ' · ' || u.unit_no AS l FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = ?`, [a.unit_id])?.l ?? '' : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, a?.unit_id, version]);
  if (!a) return null;
  const costed = a.cost_halalas != null;
  const ended = a.status === 'disposed' || a.status === 'sold';
  const bv = costed ? bookValue(db, a) : null;
  const years = costed ? scheduleByYear(a) : [];
  const history = assetHistory(db, a.id);
  const toggleStatus = () => {
    try { setAssetStatus(db, a.id, a.status === 'maintenance' ? 'in_service' : 'maintenance'); bump(); }
    catch (e) { reportFailure({ title: t('common.failed'), e }); }
  };
  return (
    <Sheet visible onClose={onClose} title={a.name} tall>
      <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <T size={TYPE.caption} color={C.muted}>{t('assets.cat.' + a.category)}</T>
        <AssetBadge a={a} />
      </Row>
      <InfoRow k={t('common.unit')} v={unitLabel + (a.room ? ' · ' + a.room : '')} />
      {a.model ? <InfoRow k={t('assets.ui.model')} v={a.model} /> : null}
      {a.serial ? <InfoRow k={t('assets.ui.serial')} v={a.serial} /> : null}
      {a.purchase_date ? <InfoRow k={t('assets.ui.purchaseDate')} v={dfmt(a.purchase_date)} /> : null}
      {a.warranty_end ? <InfoRow k={t('assets.ui.warrantyEnd')} v={dfmt(a.warranty_end)} /> : null}
      <InfoRow k={t('assets.ui.source')} v={t('assets.source.' + a.source)} />
      {/* التكلفة والقيمة الدفترية لقسم الأصول وحده · الفني يرى الأصل بلا أرقامه */}
      {perm.view && bv ? (
        <>
          <InfoRow k={t('assets.ui.cost')} v={<Money halalas={bv.cost} />} />
          <InfoRow k={t('assets.ui.accum')} v={<Money halalas={bv.accum} />} />
          <InfoRow k={t('assets.ui.nbv')} v={<Money halalas={bv.nbv} bold />} />
          <InfoRow k={t('assets.ui.life')} v={String(a.life_months)} />
          {years.length ? (
            <View style={{ marginTop: 10 }}>
              <T size={TYPE.body} bold>{t('assets.ui.schedule')}</T>
              {years.map((y) => <InfoRow key={y.year} k={String(y.year)} v={<Money halalas={y.amount} />} />)}
            </View>
          ) : null}
        </>
      ) : null}
      {a.notes ? <Note>{a.notes}</Note> : null}
      <View style={{ marginTop: 12 }}>
        <T size={TYPE.body} bold>{t('assets.ui.history')}</T>
        {history.length ? history.slice(0, 40).map((h, i) => (
          <Row key={i} style={{ justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
            <T size={TYPE.caption}>{(h.kind === 'depreciation' ? t('assets.ui.depreciation') : t('assets.event.' + h.kind)) + (h.entryNo ? ' · ' + t('assets.ui.entry', { no: h.entryNo }) : '')}</T>
            <Row gap={6}>
              {perm.view && h.amount ? <Money halalas={h.amount} size={TYPE.caption} /> : null}
              <T size={TYPE.caption} color={C.muted}>{dfmt(h.date)}</T>
            </Row>
          </Row>
        )) : <T size={TYPE.caption} color={C.muted}>{t('assets.ui.noHistory')}</T>}
      </View>
      {perm.manage && !ended ? (
        <View style={{ marginTop: 14, gap: 8 }}>
          {!costed ? <BtnPrimary title={t('assets.ui.setCost')} onPress={() => setAction('cost')} /> : null}
          <Row gap={8} style={{ flexWrap: 'wrap' }}>
            <BtnGhost small title={t('assets.ui.editInfo')} onPress={() => setAction('edit')} />
            <BtnGhost small title={t('assets.ui.transfer')} onPress={() => setAction('transfer')} />
            <BtnGhost small title={a.status === 'maintenance' ? t('assets.ui.toService') : t('assets.ui.toMaintenance')} onPress={toggleStatus} />
            {costed ? <BtnGhost small title={t('assets.ui.sell')} onPress={() => setAction('sell')} /> : null}
            <BtnGhost small danger title={t('assets.ui.dispose')} onPress={() => setAction('dispose')} />
          </Row>
        </View>
      ) : null}
      {action === 'cost' ? <CostSheet a={a} onClose={() => setAction(null)} /> : null}
      {action === 'transfer' ? <TransferSheet a={a} onClose={() => setAction(null)} /> : null}
      {action === 'dispose' ? <DisposeSheet a={a} onClose={() => setAction(null)} /> : null}
      {action === 'sell' ? <SellSheet a={a} onClose={() => setAction(null)} /> : null}
      {action === 'edit' ? <EditSheet a={a} onClose={() => setAction(null)} /> : null}
    </Sheet>
  );
}

function CostSheet({ a, onClose }: { a: AssetRow; onClose: () => void }) {
  const { db, bump } = useApp();
  const { t } = useLang();
  const toast = useToast();
  const [cost, setCost] = useState('');
  const [date, setDate] = useState(a.purchase_date ?? '');
  const [life, setLife] = useState(String(a.life_months));
  const [salvage, setSalvage] = useState('');
  const save = () => {
    try {
      setAssetCost(db, a.id, { costHalalas: toHalalas(cost), purchaseDate: date, lifeMonths: Number(life), salvageHalalas: salvage ? toHalalas(salvage) : 0 });
      bump(); toast(t('assets.ui.costDone')); onClose();
    } catch (e) { reportFailure({ title: t('common.failed'), e }); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('assets.ui.setCost')}
      footer={toHalalas(cost) > 0 && date ? <View style={{ flex: 1 }}><BtnPrimary title={t('common.confirm')} onPress={save} /></View> : undefined}>
      <Note>{t('assets.ui.setCostNote')}</Note>
      <Field label={t('assets.ui.cost')} value={cost} onChange={setCost} keyboard="numeric" ltr />
      <DateField label={t('assets.ui.purchaseDate')} value={date} onChange={setDate} />
      <Row>
        <View style={{ flex: 1 }}><Field label={t('assets.ui.life')} value={life} onChange={setLife} keyboard="numeric" ltr /></View>
        <View style={{ flex: 1 }}><Field label={t('assets.ui.salvage')} value={salvage} onChange={setSalvage} keyboard="numeric" ltr /></View>
      </Row>
      <T size={TYPE.caption} color={C.muted}>{t('assets.ui.lifeHint', { n: defaultLife(a.category) })}</T>
    </Sheet>
  );
}

function TransferSheet({ a, onClose }: { a: AssetRow; onClose: () => void }) {
  const { db, bump } = useApp();
  const { t } = useLang();
  const toast = useToast();
  const units = useUnitOptions();
  const [unit, setUnit] = useState('');
  const [room, setRoom] = useState('');
  const [date, setDate] = useState(today());
  const save = () => {
    try { transferAsset(db, a.id, { unitId: unit, room, date }); bump(); toast(t('assets.ui.transferDone')); onClose(); }
    catch (e) { reportFailure({ title: t('common.failed'), e }); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('assets.ui.transferTitle')}
      footer={unit && date ? <View style={{ flex: 1 }}><BtnPrimary title={t('common.confirm')} onPress={save} /></View> : undefined}>
      {a.cost_halalas != null ? <Note>{t('assets.ui.transferNote')}</Note> : null}
      <SelectField label={t('assets.ui.toUnit')} value={unit} options={units} onPick={setUnit} />
      <Field label={t('common.room')} value={room} onChange={setRoom} />
      <DateField label={t('common.date')} value={date} onChange={setDate} />
    </Sheet>
  );
}

function DisposeSheet({ a, onClose }: { a: AssetRow; onClose: () => void }) {
  const { db, bump } = useApp();
  const { t } = useLang();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today());
  const save = () => {
    try { disposeAsset(db, a.id, { date, reason }); bump(); toast(t('assets.ui.disposeDone')); onClose(); }
    catch (e) { reportFailure({ title: t('common.failed'), e }); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('assets.ui.disposeTitle')}
      footer={ok(reason) && date ? <View style={{ flex: 1 }}><BtnPrimary danger title={t('assets.ui.dispose')} onPress={save} /></View> : undefined}>
      <Note>{t('assets.ui.disposeNote')}</Note>
      <Field label={t('assets.ui.reason')} value={reason} onChange={setReason} />
      <DateField label={t('common.date')} value={date} onChange={setDate} />
    </Sheet>
  );
}

function SellSheet({ a, onClose }: { a: AssetRow; onClose: () => void }) {
  const { db, bump, version } = useApp();
  const { t } = useLang();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<'cash' | 'bank'>('cash');
  const [bank, setBank] = useState('');
  const banks = useMemo(() => db.all<{ id: string; name: string }>(`SELECT id, name FROM banks WHERE deleted_at IS NULL AND archived = 0 ORDER BY name`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const save = () => {
    try { sellAsset(db, a.id, { date, amountHalalas: toHalalas(amount), method, bankId: method === 'bank' ? bank : null }); bump(); toast(t('assets.ui.sellDone')); onClose(); }
    catch (e) { reportFailure({ title: t('common.failed'), e }); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('assets.ui.sellTitle')}
      footer={amount && date && (method === 'cash' || bank) ? <View style={{ flex: 1 }}><BtnPrimary title={t('common.confirm')} onPress={save} /></View> : undefined}>
      <Note>{t('assets.ui.sellNote')}</Note>
      <Field label={t('assets.ui.saleAmount')} value={amount} onChange={setAmount} keyboard="numeric" ltr />
      <DateField label={t('common.date')} value={date} onChange={setDate} />
      <T size={TYPE.caption} color={C.muted}>{t('assets.ui.method')}</T>
      <ChipGroup<'cash' | 'bank'> options={[['cash', t('common.cash')], ['bank', t('common.bank')]]} value={method} onChange={setMethod} />
      {method === 'bank' ? <SelectField label={t('common.pickBank')} value={bank} options={banks.map((b) => ({ value: b.id, label: b.name }))} onPick={setBank} /> : null}
    </Sheet>
  );
}

function EditSheet({ a, onClose }: { a: AssetRow; onClose: () => void }) {
  const { db, bump } = useApp();
  const { t } = useLang();
  const toast = useToast();
  const cats = useCategoryOptions();
  const [name, setName] = useState(a.name);
  const [category, setCategory] = useState(a.category);
  const [model, setModel] = useState(a.model);
  const [serial, setSerial] = useState(a.serial);
  const [room, setRoom] = useState(a.room);
  const [warranty, setWarranty] = useState(a.warranty_end ?? '');
  const [life, setLife] = useState(String(a.life_months));
  const [notes, setNotes] = useState(a.notes);
  const costed = a.cost_halalas != null;
  const save = () => {
    try {
      updateAssetInfo(db, a.id, {
        name, model, serial, room, warrantyEnd: warranty || null, notes,
        ...(costed ? {} : { category, lifeMonths: Number(life) }),
      });
      bump(); toast(t('assets.ui.saved')); onClose();
    } catch (e) { reportFailure({ title: t('common.failed'), e }); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('assets.ui.editInfo')} tall
      footer={ok(name) ? <View style={{ flex: 1 }}><BtnPrimary title={t('common.save')} onPress={save} /></View> : undefined}>
      <Field label={t('assets.ui.name')} value={name} onChange={setName} />
      {!costed ? <SelectField label={t('assets.ui.category')} value={category} options={cats} onPick={setCategory} /> : null}
      {!costed ? <Field label={t('assets.ui.life')} value={life} onChange={setLife} keyboard="numeric" ltr /> : null}
      <Field label={t('common.room')} value={room} onChange={setRoom} />
      <Row>
        <View style={{ flex: 1 }}><Field label={t('assets.ui.model')} value={model} onChange={setModel} /></View>
        <View style={{ flex: 1 }}><Field label={t('assets.ui.serial')} value={serial} onChange={setSerial} ltr /></View>
      </Row>
      <DateField label={t('assets.ui.warrantyEnd')} value={warranty} onChange={setWarranty} />
      <Field label={t('common.notes')} value={notes} onChange={setNotes} multiline />
    </Sheet>
  );
}

/* ═══════════ بنود الأصول (للتحويل ولفاتورة الشراء) ═══════════ */

export interface LineDraft { descr: string; qty: string; amount: string; isAsset: boolean; category: string; unitId: string; room: string; linkAssetId: string }
export const emptyLine = (): LineDraft => ({ descr: '', qty: '1', amount: '', isAsset: false, category: '', unitId: '', room: '', linkAssetId: '' });
export const toLineInput = (l: LineDraft): PurchaseLineInput => ({
  descr: l.descr, qty: Number(l.qty) || 0, amountHalalas: toHalalas(l.amount), isAsset: l.isAsset,
  category: l.isAsset ? l.category : null, unitId: l.isAsset && !l.linkAssetId ? l.unitId : null, room: l.room, linkAssetId: l.linkAssetId || null,
});

/** محرّر البنود · بند الأصل بفئته ووحدته وغرفته، أو ربطه بأصلٍ قائم بانتظار تكلفة */
export function LinesEditor({ lines, onChange, allowLink }: { lines: LineDraft[]; onChange: (l: LineDraft[]) => void; allowLink?: boolean }) {
  const { db, version } = useApp();
  const { t } = useLang();
  const units = useUnitOptions();
  const cats = useCategoryOptions();
  const pending = useMemo(() => (allowLink ? db.all<{ id: string; name: string; unit_no: string | null }>(
    `SELECT a.id, a.name, u.unit_no FROM assets a LEFT JOIN units u ON u.id = a.unit_id
     WHERE a.deleted_at IS NULL AND a.cost_halalas IS NULL AND a.status NOT IN ('disposed', 'sold') ORDER BY a.name`) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, allowLink]);
  const set = (i: number, p: Partial<LineDraft>) => onChange(lines.map((l, k) => (k === i ? { ...l, ...p } : l)));
  return (
    <View>
      {lines.map((l, i) => (
        <View key={i} style={{ borderWidth: 1, borderColor: C.paperLine, borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <Field label={t('convert.descr')} value={l.descr} onChange={(v) => set(i, { descr: v })} />
          <Row>
            <View style={{ flex: 1 }}><Field label={t('convert.amount')} value={l.amount} onChange={(v) => set(i, { amount: v })} keyboard="numeric" ltr /></View>
            <View style={{ width: 90 }}><Field label={t('convert.qty')} value={l.qty} onChange={(v) => set(i, { qty: v })} keyboard="numeric" ltr /></View>
          </Row>
          <ChipGroup<number> options={[[0, t('convert.expenseLine')], [1, t('convert.isAsset')]]} value={l.isAsset ? 1 : 0} onChange={(v) => set(i, { isAsset: !!v })} />
          {l.isAsset ? (
            <>
              <SelectField label={t('assets.ui.category')} value={l.category} options={cats} onPick={(v) => set(i, { category: v })} />
              {allowLink && pending.length ? (
                <SelectField label={t('lines.link')} value={l.linkAssetId}
                  options={[{ value: '', label: t('lines.newAsset') }, ...pending.map((p) => ({ value: p.id, label: p.name + (p.unit_no ? ' · ' + p.unit_no : '') }))]}
                  onPick={(v) => set(i, { linkAssetId: v, qty: v ? '1' : l.qty })} />
              ) : null}
              {!l.linkAssetId ? (
                <>
                  <SelectField label={t('common.unit')} value={l.unitId} options={units} onPick={(v) => set(i, { unitId: v })} />
                  <Field label={t('common.room')} value={l.room} onChange={(v) => set(i, { room: v })} />
                </>
              ) : null}
            </>
          ) : null}
          {lines.length > 1 ? <BtnGhost small danger title={t('lines.remove')} onPress={() => onChange(lines.filter((_, k) => k !== i))} /> : null}
        </View>
      ))}
      <BtnGhost small icon="plus" title={t('convert.addLine')} onPress={() => onChange([...lines, emptyLine()])} />
    </View>
  );
}

/* ═══════════ تحويل فاتورة قديمة ═══════════ */

export function ConvertSheet({ onClose }: { onClose: () => void }) {
  const { db, version, bump } = useApp();
  const { t } = useLang();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [preview, setPreview] = useState<ConversionPreview | null>(null);
  const list = useMemo(() => convertibleInvoices(db, { q }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, q]);
  const inv = list.find((p) => p.id === picked);
  const doPreview = () => {
    try { setPreview(previewConversion(db, picked!, lines.map(toLineInput), today())); }
    catch (e) { reportFailure({ title: t('common.failed'), e }); }
  };
  const doExecute = () => {
    try { convertPurchase(db, picked!, lines.map(toLineInput), today()); bump(); toast(t('convert.done')); onClose(); }
    catch (e) { reportFailure({ title: t('common.failed'), e }); }
  };
  if (!picked || !inv) {
    return (
      <Sheet visible onClose={onClose} title={t('convert.title')} tall>
        <T size={TYPE.caption} color={C.muted}>{t('convert.pick')}</T>
        <SearchBox value={q} onChange={setQ} placeholder={t('common.search')} />
        {list.length ? list.map((p) => (
          <Pressable key={p.id} onPress={() => { setPicked(p.id); setLines([{ ...emptyLine(), amount: fmt(expensedOf(p)).replace(/,/g, ''), descr: p.incorp_item || p.category }]); setPreview(null); }}>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
              <View style={{ flex: 1 }}>
                <T size={TYPE.body}>{p.no + ' · ' + p.supplier_name}</T>
                <T size={TYPE.caption} color={C.muted}>{dfmt(p.date) + ' · ' + p.category}</T>
              </View>
              <Money halalas={expensedOf(p)} />
            </Row>
          </Pressable>
        )) : <EmptyState>{t('convert.none')}</EmptyState>}
      </Sheet>
    );
  }
  return (
    <Sheet visible onClose={onClose} title={inv.no + ' · ' + inv.supplier_name} tall
      footer={preview
        ? <><View style={{ flex: 1 }}><BtnGhost title={t('common.cancel')} onPress={() => setPreview(null)} /></View><View style={{ flex: 1 }}><BtnPrimary title={t('convert.execute')} onPress={doExecute} /></View></>
        : <View style={{ flex: 1 }}><BtnPrimary title={t('convert.preview')} onPress={doPreview} /></View>}>
      <T size={TYPE.caption} color={C.muted}>{t('convert.expensed', { amount: fmt(expensedOf(inv)) })}</T>
      {!preview ? <LinesEditor lines={lines} onChange={setLines} allowLink /> : (
        <View>
          <Note>{t('convert.previewTitle')}</Note>
          <T size={TYPE.body} bold>{t('convert.willCreate', { n: preview.assets.length })}</T>
          {preview.assets.map((x, i) => <InfoRow key={i} k={x.name + ' · ' + t('assets.cat.' + x.category)} v={<Money halalas={x.cost} />} />)}
          <T size={TYPE.body} bold style={{ marginTop: 10 }}>{t('convert.reclass')}</T>
          {preview.reclass.debit.map((d) => <InfoRow key={d.account} k={d.account + ' ' + t('assets.cat.' + d.account)} v={<Money halalas={d.amount} />} />)}
          <InfoRow k={preview.reclass.credit.account} v={<Money halalas={-preview.reclass.credit.amount} />} />
          <T size={TYPE.body} bold style={{ marginTop: 10 }}>{t('convert.catchup')}</T>
          <InfoRow k={t('convert.current')} v={<Money halalas={preview.catchUp.current} />} />
          <InfoRow k={t('convert.prior')} v={<Money halalas={preview.catchUp.prior} />} />
          <T size={TYPE.body} bold style={{ marginTop: 10 }}>{t('convert.byYear')}</T>
          {preview.byYear.map((y) => <InfoRow key={y.year} k={String(y.year)} v={<Money halalas={y.amount} />} />)}
          <InfoRow k={t('convert.bvToday')} v={<Money halalas={preview.bookValueToday} bold />} />
          <Note>{t('convert.dated')}</Note>
        </View>
      )}
    </Sheet>
  );
}

/* ═══════════ المحتويات إلى أصول ═══════════ */

export function ContentsSheet({ onClose }: { onClose: () => void }) {
  const { db, version, bump } = useApp();
  const { t } = useLang();
  const toast = useToast();
  const cats = useCategoryOptions();
  const items = useMemo(() => contentsCandidates(db),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const key = (i: { unitId: string; room: string; name: string }) => i.unitId + '|' + i.room + '|' + i.name;
  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.filter((i) => !i.converted && i.suggested).map((i) => [key(i), i.suggested!])));
  const selected = items.filter((i) => !i.converted && chosen[key(i)]);
  const run = () => {
    try {
      const n = convertContents(db, selected.map((i) => ({ unitId: i.unitId, room: i.room, name: i.name, descr: i.descr, category: chosen[key(i)] })));
      bump(); toast(t('contents.done', { n })); onClose();
    } catch (e) { reportFailure({ title: t('common.failed'), e }); }
  };
  let lastUnit = '';
  return (
    <Sheet visible onClose={onClose} title={t('contents.title')} tall
      footer={selected.length ? <View style={{ flex: 1 }}><BtnPrimary title={t('contents.execute', { n: selected.length })} onPress={run} /></View> : undefined}>
      <Note>{t('contents.note')}</Note>
      {!items.length ? <EmptyState>{t('contents.none')}</EmptyState> : null}
      {items.map((i) => {
        const head = i.propertyName + ' · ' + i.unitNo;
        const showHead = head !== lastUnit;
        lastUnit = head;
        const k = key(i);
        return (
          <View key={k}>
            {showHead ? <T size={TYPE.body} bold style={{ marginTop: 10 }}>{head}</T> : null}
            <Row style={{ justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
              <View style={{ flex: 1 }}>
                <T size={TYPE.body}>{i.name}</T>
                <T size={TYPE.caption} color={C.muted}>{i.room}</T>
              </View>
              {i.converted ? <Badge kind="paid" label={t('contents.converted')} /> : (
                <View style={{ width: 170 }}>
                  <SelectField label="" value={chosen[k] ?? ''} placeholder={t('contents.noCategory')}
                    options={[{ value: '', label: t('common.none') }, ...cats]} onPick={(v) => setChosen({ ...chosen, [k]: v })} />
                </View>
              )}
            </Row>
          </View>
        );
      })}
    </Sheet>
  );
}

/** ترحيل الإهلاك المستحق يدوياً (والآلي يرحّله على جهاز المالك) */
export function useRunDepreciation(): () => void {
  const { db, bump } = useApp();
  const { t } = useLang();
  const toast = useToast();
  return () => {
    try {
      const n = runDepreciation(db, today());
      bump(); toast(n ? t('assets.ui.runDone', { n }) : t('assets.ui.runNone'));
    } catch (e) { reportFailure({ title: t('common.failed'), e }); }
  };
}


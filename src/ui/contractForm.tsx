/**
 * نموذج بيانات العقد المشترك (إنشاء/تعديل مسودة) مع قراءة العقد تلقائياً من PDF/صورة
 * والحقول الخاصة بنوع الوحدة.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Share, Animated } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Field, Row, T, Num, BtnGhost, BtnPrimary, Note, ChipGroup } from './components';
import { SuggestField } from './editors';
import { SelectField, Sheet } from './Sheet';
import { DateField } from './DateField';
import { useApp } from './store';
import { C } from './theme';
import { fmt, toHalalas } from '../domain/money';
import { contractEndFromDuration, today, dfmt } from '../domain/dates';
import { scanContractFile } from '../services/contractScan';
import { anchorDiagnostics } from '../domain/pdf/parseEjar';
import { FURNISHED_OPTIONS, CYCLE_OPTIONS } from '../domain/contracts/vocab';
import { parseEjarExtras, unitByNumber, revenueSplitOf, type EjarExtras } from '../domain/pdf/ejarExtras';
export { revenueSplitOf };
import type { ContractDraftInput } from '../domain/contracts/service';
import type { ScheduleRow } from '../domain/pdf/parseEjar';
import type { ContractField } from '../domain/contracts/rules';
import { reportFailure } from './failureDialog';
import { useLang } from '../i18n';

/**
 * تاريخ الحقول: ما كتبه المستخدم في العمود نفسه من قبل، الأحدث أولاً ·
 * ولا يُقترح نص لم يكتبه، وبلا تاريخ لا يظهر اقتراح إطلاقاً.
 */
const SERVICES_SQL =
  `SELECT services AS v FROM contracts
   WHERE deleted_at IS NULL AND TRIM(services) != ''
   GROUP BY services ORDER BY MAX(created_at) DESC LIMIT 20`;

/** شريط تقدّم رفيع غير محدَّد المدة · يظهر أثناء قراءة العقد */
function ProgressStripe() {
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(x, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(x, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [x]);
  return (
    <View style={{ height: 3, backgroundColor: C.line, borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
      <Animated.View style={{
        width: '35%', height: 3, borderRadius: 2, backgroundColor: C.emerald,
        transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [-120, 320] }) }],
      }} />
    </View>
  );
}

/** الحقول الخاصة بنوع الوحدة · منقولة من النموذج */
export const CONTRACT_TYPE_FIELDS: Record<string, Array<{ key: string; label: string }>> = {
  'محل': [{ key: 'activity', label: 'النشاط التجاري للمستأجر' }, { key: 'crNo', label: 'رقم السجل التجاري ' }],
  'معرض': [{ key: 'activity', label: 'النشاط التجاري للمستأجر' }, { key: 'crNo', label: 'رقم السجل التجاري ' }],
  'مكتب': [{ key: 'activity', label: 'النشاط المهني للمستأجر' }, { key: 'crNo', label: 'رقم السجل التجاري/الترخيص ' }],
  'مخزن': [{ key: 'activity', label: 'الاستخدام المخصَّص للمخزن' }],
};

export interface ContractFormState {
  tenant: string;
  phone: string;
  idNumber: string;
  unitId: string;
  value: string;
  cycle: string;
  start: string;
  end: string;
  deposit: string;
  /** جهة قبض التأمين: المكتب · منصة إيجار · طرف آخر */
  depositHolder: string;
  depositHolderName: string;
  ejarNo: string;
  services: string;
  furnished: string;
  typeSpecific: Record<string, string>;
  /** ملف العقد الأصلي المُلتقط · يُربط بعد الحفظ */
  pendingFile: { uri: string; name: string; mime: string } | null;
  /** حجز الوحدة المحوَّل لهذا العقد باختيار المستخدم · الربط بالمعرّف لا بالاسم (المراجعة ٤.٤) */
  reservationId: string;
  /** جدول الدفعات من ملف إيجار · null = قُرئ الملف وتعذّر جدوله، undefined = لم يُقرأ ملف */
  schedule?: ScheduleRow[] | null;
  fromEjarFile?: boolean;
  /** بنود العقد التي لها خانة في التطبيق · تُقارن بالقائم في المراجعة (قرارات تفصيل العقد) */
  extras?: EjarExtras | null;
}

export const emptyContractForm = (): ContractFormState => ({
  tenant: '', phone: '', idNumber: '', unitId: '', value: '', cycle: 'شهرية',
  start: '', end: '', deposit: '', depositHolder: 'المكتب', depositHolderName: '',
  ejarNo: '', services: '', furnished: 'غير مؤثثة', typeSpecific: {},
  pendingFile: null,
  reservationId: '',
  schedule: undefined,
  fromEjarFile: undefined,
});

export function formToInput(s: ContractFormState): ContractDraftInput {
  return {
    tenant: s.tenant, phone: s.phone, idNumber: s.idNumber, unitId: s.unitId,
    valueHalalas: toHalalas(s.value), cycle: s.cycle, start: s.start, end: s.end,
    depositHalalas: toHalalas(s.deposit), depositHolder: s.depositHolder, depositHolderName: s.depositHolderName,
    ejarNo: s.ejarNo, services: s.services,
    furnished: s.furnished, typeSpecific: s.typeSpecific,
    reservationId: s.reservationId || null,
    schedule: s.schedule,
    fromEjarFile: s.fromEjarFile,
    ...revenueSplitOf(s.extras),
  };
}


export function useContractForm() {
  const [state, setState] = useState<ContractFormState>(emptyContractForm());
  // الحقل الذي سبّب آخر رفض · يُظلَّل بالأحمر ويُمسح فور تعديله
  const [errorField, setErrorField] = useState<ContractField | null>(null);
  const set = <K extends keyof ContractFormState>(k: K, v: ContractFormState[K]) => {
    setState((p) => ({ ...p, [k]: v }));
    setErrorField((f) => ((f as string) === (k as string) ? null : f));
  };
  const reset = (s: ContractFormState) => { setState(s); setErrorField(null); };
  return { state, set, reset, errorField, setErrorField };
}

export function ContractFormFields({ form }: { form: ReturnType<typeof useContractForm> }) {
  const { db } = useApp();
  const { t } = useLang();
  const { state, set } = form;
  const [scanStatus, setScanStatus] = useState('');
  const [propertyId, setPropertyId] = useState<string>(() => {
    if (!state.unitId) return '';
    const u = db.get<{ property_id: string }>(`SELECT property_id FROM units WHERE id = ?`, [state.unitId]);
    return u?.property_id ?? '';
  });

  const properties = db.all<{ id: string; name: string }>(
    `SELECT id, name FROM properties WHERE deleted_at IS NULL AND archived = 0 ORDER BY name`
  );
  const units = propertyId
    ? db.all<{ id: string; unit_no: string; floor: string }>(
        `SELECT id, unit_no, floor FROM units WHERE property_id = ? AND deleted_at IS NULL AND archived = 0 ORDER BY COALESCE(unit_no_key, unit_no), unit_no`,
        [propertyId]
      )
    : [];
  const selectedUnit = state.unitId
    ? db.get<{ type: string; subtype: string }>(`SELECT type, subtype FROM units WHERE id = ?`, [state.unitId])
    : undefined;
  // حجز الوحدة القائم · قراءة فقط (الانتهاء يُسجَّل عند الحفظ)
  const unitRsv = state.unitId
    ? db.get<{ id: string; name: string; phone: string; deposit_halalas: number; expiry_date: string }>(
        `SELECT id, name, phone, deposit_halalas, expiry_date FROM reservations
         WHERE unit_id = ? AND status = 'نشط' AND deleted_at IS NULL AND expiry_date >= ?`, [state.unitId, today()])
    : undefined;
  // تغيّرت الوحدة: اختيار حجزٍ ليس لها يسقط
  useEffect(() => {
    if (state.reservationId && state.reservationId !== unitRsv?.id) set('reservationId', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.unitId, unitRsv?.id]);
  const typeFields = selectedUnit ? CONTRACT_TYPE_FIELDS[selectedUnit.type] || [] : [];

  const [scanning, setScanning] = useState(false);
  const [rawText, setRawText] = useState('');
  const [rawOpen, setRawOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);

  const scan = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.length) return;
      const asset = res.assets[0];
      setScanning(true);
      setRawText('');
      setScanStatus('جاري قراءة الملف…');
      // مهلة قصيرة حتى تظهر الحالة قبل العمل الثقيل
      await new Promise((r) => setTimeout(r, 50));
      const isPdf = /\.pdf$/i.test(asset.name ?? '') || asset.mimeType === 'application/pdf';
      const bytes = isPdf ? new File(asset.uri).bytesSync() : undefined;
      setScanStatus('جاري التحليل…');
      await new Promise((r) => setTimeout(r, 30));
      const { text, result } = await scanContractFile({
        uri: asset.uri, mimeType: asset.mimeType, name: asset.name, bytes,
      });
      setRawText(text);
      if (result.tenant) set('tenant', result.tenant);
      if (result.phone) set('phone', result.phone);
      if (result.idNumber) set('idNumber', result.idNumber);
      if (result.valueHalalas != null) set('value', fmt(result.valueHalalas).replace(/,/g, ''));
      if (result.depositHalalas != null) set('deposit', fmt(result.depositHalalas).replace(/,/g, ''));
      if (result.start) set('start', result.start);
      if (result.end) set('end', result.end);
      if (result.contractNo) set('ejarNo', result.contractNo);
      if (result.cycle) set('cycle', result.cycle);
      // تواريخ الأقساط من جدول الملف دائماً (قرار المالك ٢٠٢٦-١٠-٠٥) · وإن تعذّر تُحسب وينبَّه عليها
      set('schedule', result.schedule ?? null);
      set('fromEjarFile', true);
      // البنود التي لها خانة: التأثيث في العقد مباشرة، والوحدة برقمها داخل العقار المختار، والباقي يُقارن في المراجعة
      const extras = parseEjarExtras(text);
      set('extras', extras);
      if (extras.unit.furnished) set('furnished', extras.unit.furnished);
      if (propertyId && extras.unit.unitNo) {
        const uidByNo = unitByNumber(db, propertyId, extras.unit.unitNo);
        if (uidByNo) set('unitId', uidByNo);
      }
      const n = result.found.length;
      setScanStatus(n
        ? `قُرئ ${n} حقلاً` + (result.months ? ` · المدة ${result.months} شهراً` : '')
          + (result.schedule ? ` · جدول الدفعات ${result.schedule.length} قسطاً من الملف` : ' · تعذّرت قراءة جدول الدفعات فستُحسب تواريخه')
          + (result.nameNeedsReview ? ' · راجع الاسم · مسافاته لم تُسترجع من الملف' : '')
        : 'لم تُقرأ حقول واضحة · اعرض النص المستخرج لتشخيص السبب');
      // ملف العقد نفسه يُرفق تلقائياً بالعقد عند الحفظ ويظهر في المكتبة
      if (n) set('pendingFile', { uri: asset.uri, name: asset.name ?? 'عقد.pdf', mime: asset.mimeType ?? '' });
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      const msg = code === 'pdf-encrypted' ? 'الملف محمي بتشفير · أزل الحماية أو صدّر نسخة غير محمية من منصة إيجار'
        : code === 'pdf-empty' ? 'الملف بلا طبقة نص قابلة للاستخراج · إن كان صورة ممسوحة فالتقطه كصورة بدل PDF'
        : code === 'pdf' ? 'تعذّر فك بنية الملف · تأكد أنه PDF سليم من منصة إيجار'
        : code === 'ocr' ? 'قارئ الصور غير متاح على هذا البناء · استخدم ملف PDF'
        : '';
      setScanStatus(msg || 'تعذّرت قراءة الملف');
      if (!msg) reportFailure({ title: 'تعذّرت قراءة الملف', where: 'قراءة ملف العقد', e });
    } finally {
      setScanning(false);
    }
  };

  const applyDuration = (months: string) => {
    if (!state.start || !months) return;
    set('end', contractEndFromDuration(state.start, parseInt(months, 10)));
  };

  return (
    <View>
      <View style={{ backgroundColor: C.paper, borderRadius: 8, padding: 10, marginBottom: 12 }}>
        <T size={11.5} color={C.muted} style={{ marginBottom: 6 }}>قراءة العقد تلقائياً</T>
        <BtnGhost small icon="contract" title="اختيار ملف العقد (PDF أو صورة)" onPress={scan} disabled={scanning} />
        {scanning ? <ProgressStripe /> : null}
        {scanStatus ? <T size={11} color={scanStatus.startsWith('قُرئ') ? C.emerald : C.muted} style={{ marginTop: 5 }}>{scanStatus}</T> : null}
        {rawText && !scanning ? (
          <BtnGhost small icon="eye" title="عرض النص المستخرج (للتشخيص)" onPress={() => setRawOpen(true)} />
        ) : null}
      </View>
      {rawOpen && (
        <Sheet visible onClose={() => setRawOpen(false)} title="النص المستخرج من الملف" tall
          footer={
            <>
              {/* الإغلاق بعلامة ✕ في رأس الورقة وحدها */}
              <View style={{ flex: 1 }}>
                <BtnPrimary icon="export" title="مشاركة النص" onPress={() => {
                  Share.share({ message: rawText }).catch(() => {});
                }} />
              </View>
            </>
          }>
          <View style={{ marginBottom: 10 }}>
            <BtnGhost small icon="search" title="فحص الأنكرات الثمانية" onPress={() => setDiagOpen((v) => !v)} />
          </View>
          {diagOpen ? anchorDiagnostics(rawText).map((d) => (
            <Row key={d.label} style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
              <T size={12} color={d.ok ? C.emerald : C.rose}>{d.ok ? 'طابق' : 'لم يطابق'} · {d.label}</T>
              <Num size={11} color={C.muted}>{d.sample}</Num>
            </Row>
          )) : null}
          <T size={11} style={{ lineHeight: 19 }}>{rawText.slice(0, 20000)}</T>
        </Sheet>
      )}
      <Row style={{ alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          {/* بلا اقتراحات من أسماء مستأجرين سابقين (أعطال قراءة العقد ٢٠٢٦-١٠-٠٧) */}
          <Field label="اسم المستأجر" value={state.tenant} onChange={(v) => set('tenant', v)}
            error={form.errorField === 'tenant'} />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="رقم الجوال" value={state.phone} onChange={(v) => set('phone', v)} keyboard="phone-pad" ltr error={form.errorField === 'phone'} />
        </View>
      </Row>
      <Field label="رقم الهوية / السجل" value={state.idNumber} onChange={(v) => set('idNumber', v)} keyboard="numeric" ltr />
      <SelectField
        label="العقار"
        value={propertyId}
        options={properties.map((p) => ({ value: p.id, label: p.name }))}
        onPick={(v) => {
          setPropertyId(v);
          // رقم الوحدة المقروء من العقد يختارها داخل العقار · وإلا أولها
          const byNo = state.extras?.unit.unitNo ? unitByNumber(db, v, state.extras.unit.unitNo) : null;
          const first = db.get<{ id: string }>(
            `SELECT id FROM units WHERE property_id = ? AND deleted_at IS NULL AND archived = 0 ORDER BY COALESCE(unit_no_key, unit_no), unit_no LIMIT 1`, [v]
          );
          form.set('unitId', byNo ?? first?.id ?? '');
        }}
        placeholder="اختر العقار أولاً"
        emptyText="أضف عقاراً أولاً من شاشة العقارات"
      />
      {propertyId ? (
        <SelectField
          label="الوحدة"
          value={state.unitId}
          options={units.map((u) => ({ value: u.id, label: u.unit_no + (u.floor ? ' · ' + u.floor : '') }))}
          onPick={(v) => set('unitId', v)}
          placeholder="أضف وحدة أولاً"
          emptyText="أضف وحدة أولاً من نافذة العقار"
          error={form.errorField === 'unitId'}
        />
      ) : null}
      {unitRsv ? (
        <Note>
          <T size={12.5} bold>الوحدة محجوزة لـ«{unitRsv.name}» حتى {dfmt(unitRsv.expiry_date)}{Number(unitRsv.deposit_halalas) > 0 ? ' · عربون ' + fmt(Number(unitRsv.deposit_halalas)) : ''}</T>
          <T size={12} color={C.muted} style={{ marginVertical: 6 }}>
            العقد على الوحدة المحجوزة لصاحب الحجز وحده. بالتحويل يسدّد العربون الأقساط الأولى بتاريخ العقد.
          </T>
          <ChipGroup<string>
            options={[[unitRsv.id, 'تحويل الحجز إلى هذا العقد'], ['', 'لا']]}
            value={state.reservationId === unitRsv.id ? unitRsv.id : ''}
            onChange={(v) => {
              set('reservationId', v);
              if (v && !state.tenant.trim()) set('tenant', unitRsv.name);
              if (v && !state.phone.trim() && unitRsv.phone) set('phone', unitRsv.phone);
            }} />
        </Note>
      ) : null}
      {typeFields.length ? (
        <View style={{ backgroundColor: C.paper, borderRadius: 9, padding: 10, marginBottom: 12 }}>
          <T size={11.5} color={C.muted} style={{ marginBottom: 8 }}>
            حقول خاصة بنوع الوحدة ({selectedUnit!.type}{selectedUnit!.subtype ? ' · ' + selectedUnit!.subtype : ''})
          </T>
          {typeFields.map((f) => (
            <Field key={f.key} label={f.label} value={state.typeSpecific[f.key] || ''}
              onChange={(v) => set('typeSpecific', { ...state.typeSpecific, [f.key]: v })} />
          ))}
        </View>
      ) : null}
      <Row>
        <View style={{ flex: 1 }}>
          <Field label={t('lease.valueField')} value={state.value} onChange={(v) => set('value', v)} keyboard="numeric" ltr error={form.errorField === 'value'} />
        </View>
        <View style={{ flex: 1 }}>
          <SelectField label="دورية الدفعات" value={state.cycle}
            options={CYCLE_OPTIONS.map((v) => ({ value: v, label: v }))}
            onPick={(v) => set('cycle', v)} />
        </View>
      </Row>
      <Row>
        <View style={{ flex: 1 }}><DateField label="تاريخ البداية" value={state.start} onChange={(v) => set('start', v)} error={form.errorField === 'start'} /></View>
        <View style={{ flex: 1 }}>
          <SelectField label="مدة العقد" value=""
            options={[
              { value: '3', label: '3 أشهر' }, { value: '6', label: '6 أشهر' }, { value: '12', label: 'سنة' },
              { value: '24', label: 'سنتان' }, { value: '36', label: '3 سنوات' },
            ]}
            onPick={applyDuration}
            placeholder="تاريخ نهاية يدوي"
            display="تاريخ نهاية يدوي"
          />
        </View>
      </Row>
      <DateField label="تاريخ النهاية" value={state.end} onChange={(v) => set('end', v)} error={form.errorField === 'end'} />
      <Row>
        <View style={{ flex: 1 }}>
          <Field label="مبلغ التأمين" value={state.deposit} onChange={(v) => set('deposit', v)} keyboard="numeric" ltr />
        </View>
        <View style={{ flex: 1 }}>
          <SelectField label="جهة قبض التأمين" value={state.depositHolder}
            options={['المكتب', 'منصة إيجار', 'طرف آخر'].map((v) => ({ value: v, label: v }))}
            onPick={(v) => set('depositHolder', v)} />
        </View>
      </Row>
      {state.depositHolder === 'طرف آخر' ? (
        <Field label="اسم الطرف القابض للتأمين" value={state.depositHolderName}
          onChange={(v) => set('depositHolderName', v)} />
      ) : null}
      <Field label="رقم العقد في منصة إيجار"
        value={state.ejarNo} onChange={(v) => set('ejarNo', v)} ltr />
      <SuggestField label="الخدمات المشمولة بقيمة الإيجار" value={state.services}
        onChange={(v) => set('services', v)} sql={SERVICES_SQL} />
      <SelectField label="حالة الأثاث" value={state.furnished}
        options={FURNISHED_OPTIONS.map((v) => ({ value: v, label: v }))}
        onPick={(v) => set('furnished', v)} />
      <T size={11.5} color={C.muted} style={{ marginBottom: 5 }}>ملف العقد الأصلي</T>
      <BtnGhost small icon="attach"
        title={state.pendingFile ? state.pendingFile.name : 'إرفاق ملف العقد الأصلي'}
        onPress={async () => {
          const res = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/*'], copyToCacheDirectory: true });
          if (!res.canceled && res.assets?.length) {
            const a = res.assets[0];
            set('pendingFile', { uri: a.uri, name: a.name ?? 'ملف', mime: a.mimeType ?? '' });
          }
        }} />
      <View style={{ height: 8 }} />
    </View>
  );
}

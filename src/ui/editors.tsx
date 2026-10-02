/**
 * محررا العدادات والأقسام/الغرف المشتركان بين نافذتي العقار والوحدة،
 * ومعهما حقل الاقتراح: اقتراحاته من مدخلات المستخدم السابقة في العمود نفسه
 * وحدها · لا قوائم ثابتة ولا نص لم يكتبه المستخدم.
 */
import React from 'react';
import { View } from 'react-native';
import { Field, Row, T, BtnGhost, Chip } from './components';
import { SelectField } from './Sheet';
import { useApp } from './store';
import { C } from './theme';
import { METER_KINDS, METER_ICON, isUtilityKind, utilitySuppliers, type MeterInput } from '../domain/meters';
import type { IconName } from './icons';
import { uid } from '../domain/ids';

/**
 * تاريخ الحقل: قيم العمود نفسه كما كتبها المستخدم، الأحدث استعمالاً أولاً.
 * الجداول بلا عمود تاريخ فترتيبها بـ rowid وهو ترتيب الإدخال نفسه.
 */
const SECTION_NAME_SQL =
  `SELECT v FROM (
     SELECT room_name AS v, MAX(rowid) AS r FROM unit_rooms WHERE TRIM(room_name) != '' GROUP BY room_name
     UNION ALL
     SELECT area_name AS v, MAX(rowid) AS r FROM property_areas WHERE TRIM(area_name) != '' GROUP BY area_name
   ) GROUP BY v ORDER BY MAX(r) DESC LIMIT 40`;

const ITEM_NAME_SQL =
  `SELECT v FROM (
     SELECT name AS v, MAX(rowid) AS r FROM unit_room_items WHERE TRIM(name) != '' GROUP BY name
     UNION ALL
     SELECT name AS v, MAX(rowid) AS r FROM property_area_items WHERE TRIM(name) != '' GROUP BY name
   ) GROUP BY v ORDER BY MAX(r) DESC LIMIT 60`;

const ITEM_DESCR_SQL =
  `SELECT v FROM (
     SELECT descr AS v, MAX(rowid) AS r FROM unit_room_items WHERE TRIM(descr) != '' GROUP BY descr
     UNION ALL
     SELECT descr AS v, MAX(rowid) AS r FROM property_area_items WHERE TRIM(descr) != '' GROUP BY descr
   ) GROUP BY v ORDER BY MAX(r) DESC LIMIT 60`;

/** قراءة تاريخ العمود من القاعدة · وبلا تاريخ تعود بقائمة فارغة فلا يظهر شيء */
export function useFieldHistory(sql: string): string[] {
  const { db, version } = useApp();
  return React.useMemo(() => {
    try {
      return db.all<{ v: string }>(sql).map((r) => String(r.v)).filter((v) => v.trim() !== '');
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, sql]);
}

/**
 * حقل باقتراحات من تاريخ المستخدم في العمود نفسه · تظهر رقائقُ ما يطابق ما يكتبه،
 * وضغط الرقاقة يملأ الحقل · وبلا تاريخ مطابق لا يُعرض شيء إطلاقاً.
 */
export function SuggestField({
  label, value, onChange, sql, ltr, disabled, error, max = 6,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** استعلام تاريخ العمود · يعيد عموداً واحداً باسم v */
  sql: string;
  ltr?: boolean;
  disabled?: boolean;
  /** الحقل سبب رفضاً · يُظلَّل بالأحمر */
  error?: boolean;
  max?: number;
}) {
  const history = useFieldHistory(sql);
  const matches = React.useMemo(() => {
    const t = value.trim();
    return history.filter((h) => h !== t && (t === '' || h.includes(t))).slice(0, max);
  }, [history, value, max]);
  return (
    <View>
      <Field label={label} value={value} onChange={onChange} ltr={ltr} disabled={disabled} error={error} />
      {!disabled && matches.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: -6, marginBottom: 10 }}>
          {matches.map((m) => <Chip key={m} label={m} onPress={() => onChange(m)} />)}
        </View>
      ) : null}
    </View>
  );
}

export function MetersEditor({
  meters, onChange, title,
}: { meters: MeterInput[]; onChange: (m: MeterInput[]) => void; title: string }) {
  const { db } = useApp();
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: C.line, marginTop: 12, paddingTop: 10, marginBottom: 6 }}>
      <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <T size={13} bold color={C.ink}>{title}</T>
        <BtnGhost small title="+ إضافة عداد"
          onPress={() => onChange([...meters, { id: 'MT_' + uid(), kind: 'كهرباء', number: '', supplierId: '' }])} />
      </Row>
      {meters.length ? meters.map((m, i) => {
        const isUtil = isUtilityKind(m.kind);
        const sups = isUtil ? utilitySuppliers(db, m.kind) : [];
        return (
          <View key={m.id ?? i} style={{ borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 9, marginBottom: 7 }}>
            <SelectField
              label="النوع" value={m.kind}
              options={METER_KINDS.map((k) => ({ value: k, icon: METER_ICON[k] as IconName, label: k }))}
              onPick={(v) => onChange(meters.map((x, xi) => (xi === i ? { ...x, kind: v, supplierId: '' } : x)))}
            />
            <Field label="رقم العداد" value={m.number}
              onChange={(v) => onChange(meters.map((x, xi) => (xi === i ? { ...x, number: v } : x)))} ltr />
            {isUtil ? (
              sups.length ? (
                <SelectField
                  label={`مورد ال${m.kind}`} value={m.supplierId ?? ''}
                  options={sups.map((s) => ({ value: s.id, label: s.name }))}
                  onPick={(v) => onChange(meters.map((x, xi) => (xi === i ? { ...x, supplierId: v } : x)))}
                  placeholder={`مورد ${m.kind}`}
                />
              ) : (
                <T size={10.5} color={C.muted}>لا يوجد مورد {m.kind} · أضفه من شاشة الموردين</T>
              )
            ) : null}
            <BtnGhost small danger icon="trash" title="حذف العداد"
              onPress={() => onChange(meters.filter((_, xi) => xi !== i))} />
          </View>
        );
      }) : <T size={11.5} color={C.muted}>لا عدادات</T>}
    </View>
  );
}

export interface SectionData {
  name: string;
  items: Array<{ name: string; descr: string }>;
}

/** محرر أقسام العقار / غرف الوحدة ومحتوياتها */
export function SectionsEditor({
  sections, onChange, title, addSectionLabel, addItemLabel, namePlaceholder,
}: {
  sections: SectionData[];
  onChange: (s: SectionData[]) => void;
  title: string;
  addSectionLabel: string;
  addItemLabel: string;
  namePlaceholder?: string;
}) {
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: C.line, marginTop: 12, paddingTop: 10, marginBottom: 6 }}>
      <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <T size={13} bold color={C.ink}>{title}</T>
        <BtnGhost small title={addSectionLabel} onPress={() => onChange([...sections, { name: '', items: [] }])} />
      </Row>
      {sections.map((s, si) => (
        <View key={si} style={{ borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 9, marginBottom: 7 }}>
          <SuggestField label={namePlaceholder ?? 'الاسم'} value={s.name} sql={SECTION_NAME_SQL}
            onChange={(v) => onChange(sections.map((x, xi) => (xi === si ? { ...x, name: v } : x)))} />
          {s.items.map((it, ii) => (
            <Row key={ii} style={{ marginBottom: 6, alignItems: 'flex-start' }}>
              <View style={{ flex: 2 }}>
                <SuggestField label="البند" value={it.name} sql={ITEM_NAME_SQL}
                  onChange={(v) => onChange(sections.map((x, xi) =>
                    xi !== si ? x : { ...x, items: x.items.map((y, yi) => (yi === ii ? { ...y, name: v } : y)) }))} />
              </View>
              <View style={{ flex: 2 }}>
                <SuggestField label="الوصف" value={it.descr} sql={ITEM_DESCR_SQL}
                  onChange={(v) => onChange(sections.map((x, xi) =>
                    xi !== si ? x : { ...x, items: x.items.map((y, yi) => (yi === ii ? { ...y, descr: v } : y)) }))} />
              </View>
            </Row>
          ))}
          <Row>
            <BtnGhost small title={addItemLabel}
              onPress={() => onChange(sections.map((x, xi) => (xi === si ? { ...x, items: [...x.items, { name: '', descr: '' }] } : x)))} />
            <BtnGhost small danger icon="trash" title="حذف"
              onPress={() => onChange(sections.filter((_, xi) => xi !== si))} />
          </Row>
        </View>
      ))}
    </View>
  );
}

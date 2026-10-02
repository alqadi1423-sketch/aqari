/** إنشاء النماذج · قوالب الاستلام والتسليم: بناء الأقسام والبنود واستخدامها */
import React, { useCallback, useMemo, useState } from 'react';
import { View, FlatList, type ListRenderItem } from 'react-native';
import { Screen } from '../src/ui/Screen';
import { Card, T, EmptyState, Row, Badge, BtnPrimary, BtnGhost, BtnIcon, Field, SearchBox } from '../src/ui/components';
import { Sheet, SelectField } from '../src/ui/Sheet';
import { ActionMenuButton } from '../src/ui/ActionMenu';
import { FilterBar, FilterSheet, useFilterSheet, type ActiveChip } from '../src/ui/FilterSheet';
import { useDialog } from '../src/ui/AppDialog';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { C, TYPE } from '../src/ui/theme';
import { uid } from '../src/domain/ids';
import { logAudit } from '../src/domain/audit';
import { HandoverSheet } from '../src/ui/HandoverSheet';

interface TplSection { section: string; items: string[] }

interface TplRow { id: string; name: string; is_system: number; sections_json: string; sections: TplSection[] }

const KIND_LABELS: Record<string, string> = { system: 'قوالب النظام', mine: 'قوالبي' };

export default function FormTemplates() {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const fsheet = useFilterSheet();
  const [q, setQ] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [builderFor, setBuilderFor] = useState<string | null | false>(false); // false=مغلق، null=جديد
  const [name, setName] = useState('');
  const [sections, setSections] = useState<TplSection[]>([{ section: '', items: [''] }]);
  const [useFor, setUseFor] = useState<{ templateId: string; type: 'استلام' | 'تسليم' } | null>(null);

  const all = useMemo<TplRow[]>(
    () =>
      db.all<Omit<TplRow, 'sections'>>(
        `SELECT * FROM form_templates WHERE deleted_at IS NULL ORDER BY is_system DESC, created_at`
      ).map((t) => ({ ...t, sections: JSON.parse(t.sections_json) as TplSection[] })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]
  );

  const templates = useMemo(() => {
    const needle = q.trim();
    return all.filter((t) => {
      if (kindFilter === 'system' && !Number(t.is_system)) return false;
      if (kindFilter === 'mine' && Number(t.is_system)) return false;
      if (needle && !t.name.includes(needle) && !t.sections.some((s) => s.section.includes(needle))) return false;
      return true;
    });
  }, [all, q, kindFilter]);

  const openBuilder = (templateId: string | null) => {
    if (templateId) {
      const t = all.find((x) => x.id === templateId);
      if (!t) return;
      setName(t.name);
      setSections(t.sections.map((s) => ({ section: s.section, items: [...s.items] })));
    } else {
      setName('');
      setSections([{ section: '', items: [''] }]);
    }
    setBuilderFor(templateId);
  };

  const save = () => {
    if (!name.trim()) { toast('الرجاء إدخال اسم القالب'); return; }
    const clean = sections
      .map((s) => ({ section: s.section.trim(), items: s.items.map((i) => i.trim()).filter(Boolean) }))
      .filter((s) => s.section && s.items.length);
    if (!clean.length) { toast('أضف قسماً واحداً على الأقل ببند واحد على الأقل'); return; }
    db.transaction(() => {
      if (builderFor) {
        db.run(`UPDATE form_templates SET name = ?, sections_json = ? WHERE id = ?`, [
          name.trim(), JSON.stringify(clean), builderFor,
        ]);
      } else {
        db.run(`INSERT INTO form_templates (id, name, is_system, sections_json, created_at) VALUES (?,?,0,?,?)`, [
          uid(), name.trim(), JSON.stringify(clean), new Date().toISOString(),
        ]);
      }
      logAudit(db, 'إنشاء النماذج', builderFor ? 'update' : 'create', 'قالب نموذج', name.trim());
    });
    setBuilderFor(false); bump();
    toast(builderFor ? 'تم تحديث القالب' : `تم إنشاء قالب "${name.trim()}"`);
  };

  const onDelete = (t: TplRow) => {
    dialog({
      title: 'حذف القالب',
      body: `حذف قالب "${t.name}"؟`,
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'حذف', variant: 'danger',
          onPress: () => {
            db.transaction(() => db.run(`UPDATE form_templates SET deleted_at=? WHERE id=?`, [new Date().toISOString(), t.id]));
            bump(); toast('تم حذف القالب');
          },
        },
      ],
    });
  };

  const keyExtractor = useCallback((item: TplRow) => item.id, []);
  const renderItem: ListRenderItem<TplRow> = ({ item: t }) => (
    <Card>
      {/* زر ⋮ أعلى البطاقة يساراً بمحاذاة العنوان · وقالب النظام لا يُعرض له حذف */}
      <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <T size={TYPE.sectionTitle} bold style={{ flex: 1 }}>{t.name}</T>
        <Row gap={8}>
          {Number(t.is_system) ? <Badge kind="draft" label="قالب النظام" /> : null}
          <ActionMenuButton title={t.name} actions={[
            { icon: 'edit', label: 'تعديل البنود', onPress: () => openBuilder(t.id) },
            Number(t.is_system) ? null : { icon: 'trash', label: 'حذف', danger: true, onPress: () => onDelete(t) },
          ]} />
        </Row>
      </Row>
      <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        {t.sections.map((s) => (
          <Badge key={s.section} kind="draft" label={`${s.section} (${s.items.length})`} />
        ))}
      </Row>
      <Row style={{ flexWrap: 'wrap' }}>
        <BtnGhost small title="استخدام · استلام" onPress={() => setUseFor({ templateId: t.id, type: 'استلام' })} />
        <BtnGhost small title="استخدام · تسليم" onPress={() => setUseFor({ templateId: t.id, type: 'تسليم' })} />
      </Row>
    </Card>
  );

  const clearFilters = useCallback(() => { setQ(''); setKindFilter(''); }, []);
  const chips: ActiveChip[] = kindFilter
    ? [{ key: 'kind', label: KIND_LABELS[kindFilter] ?? kindFilter, onClear: () => setKindFilter('') }]
    : [];

  return (
    <Screen title="إنشاء النماذج" scroll={false}
      actions={<BtnPrimary small title="+ قالب نموذج جديد" onPress={() => openBuilder(null)} />}>
      <FlatList
        data={templates}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={5}
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        ListHeaderComponent={
          <FilterBar chips={chips} onOpen={fsheet.show} onClearAll={clearFilters}
            resultCount={templates.length} total={all.length} filtered={templates.length} itemName="قالباً"
            search={<SearchBox value={q} onChange={setQ} />} />
        }
        ListFooterComponent={<View style={{ height: 12 }} />}
        ListEmptyComponent={<Card><EmptyState>لا توجد قوالب نماذج مطابقة</EmptyState></Card>}
      />

      <FilterSheet open={fsheet.open} onClose={fsheet.hide} onClearAll={clearFilters} resultCount={templates.length}>
        <SelectField label="نوع القالب" value={kindFilter}
          options={[{ value: '', label: 'كل القوالب' },
            ...Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))]}
          onPick={setKindFilter} />
      </FilterSheet>

      {/* بانى القالب */}
      <Sheet visible={builderFor !== false} onClose={() => setBuilderFor(false)}
        title={builderFor ? 'تعديل بنود القالب' : 'قالب نموذج جديد'} tall
        footer={
          <>
            <View style={{ flex: 1 }}><BtnPrimary title="حفظ القالب" onPress={save} /></View>
          </>
        }>
        <Field label="اسم القالب" value={name} onChange={setName} />
        {sections.map((s, si) => (
          <View key={si} style={{ backgroundColor: C.paper, borderRadius: 9, padding: 9, marginBottom: 8 }}>
            <Field label="اسم القسم" value={s.section}
              onChange={(v) => setSections((p) => p.map((x, xi) => (xi === si ? { ...x, section: v } : x)))} />
            {s.items.map((it, ii) => (
              <Row key={ii} style={{ marginBottom: 4 }}>
                <View style={{ flex: 1 }}>
                  <Field label={'البند ' + (ii + 1)} value={it}
                    onChange={(v) => setSections((p) => p.map((x, xi) =>
                      xi !== si ? x : { ...x, items: x.items.map((y, yi) => (yi === ii ? v : y)) }))} />
                </View>
                {/* البند الأخير لا تُعرض له إزالة · القسم بلا بند لا يُحفظ */}
                {s.items.length > 1 ? (
                  <BtnIcon icon="x" danger accessibilityLabel="إزالة البند"
                    onPress={() => setSections((p) => p.map((x, xi) =>
                      xi !== si ? x : { ...x, items: x.items.filter((_, yi) => yi !== ii) }))} />
                ) : null}
              </Row>
            ))}
            <Row>
              <BtnGhost small title="+ إضافة بند"
                onPress={() => setSections((p) => p.map((x, xi) => (xi === si ? { ...x, items: [...x.items, ''] } : x)))} />
              {/* القسم الوحيد لا يُحذف · القالب بلا أقسام لا يُحفظ */}
              {sections.length > 1 ? (
                <BtnGhost small danger icon="trash" title="حذف القسم"
                  onPress={() => setSections((p) => p.filter((_, xi) => xi !== si))} />
              ) : null}
            </Row>
          </View>
        ))}
        <BtnGhost small title="+ إضافة قسم"
          onPress={() => setSections((p) => [...p, { section: '', items: [''] }])} />
        <View style={{ height: 10 }} />
      </Sheet>

      {useFor && (
        <HandoverSheet
          contractId={null}
          type={useFor.type}
          templateId={useFor.templateId}
          onClose={() => setUseFor(null)}
          onSaved={() => { setUseFor(null); bump(); toast('تم حفظ النموذج'); }}
        />
      )}
    </Screen>
  );
}

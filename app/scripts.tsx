/** قوالب الرسائل · الفئات والرموز والمعاينة الحية */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, FlatList, type ListRenderItem } from 'react-native';
import { Screen } from '../src/ui/Screen';
import { Card, T, EmptyState, Row, BtnPrimary, BtnGhost, Field, SearchBox, Chip } from '../src/ui/components';
import { Sheet, SelectField } from '../src/ui/Sheet';
import { ActionMenuButton } from '../src/ui/ActionMenu';
import { FilterBar, FilterSheet, useFilterSheet, type ActiveChip } from '../src/ui/FilterSheet';
import { useDialog } from '../src/ui/AppDialog';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { C, TYPE, TYPE_TAG_STYLES } from '../src/ui/theme';
import {
  TEMPLATE_TOKENS, SCRIPT_CATEGORIES, SCRIPT_AUDIENCES, templateContext, resolveTemplateTokens,
} from '../src/domain/templates';
import { uid } from '../src/domain/ids';
import { logAudit } from '../src/domain/audit';

interface ScriptRow { id: string; audience: string; category: string; title: string; body: string }

export default function Scripts() {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const fsheet = useFilterSheet();
  const [q, setQ] = useState('');
  const [fAudience, setFAudience] = useState('');
  const [fCategory, setFCategory] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [audience, setAudience] = useState('مستأجرون');
  const [category, setCategory] = useState('عام');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const filter = useMemo(() => {
    const where: string[] = ['deleted_at IS NULL'];
    const args: string[] = [];
    const needle = q.trim();
    if (needle) {
      where.push(`(title LIKE '%'||?||'%' OR body LIKE '%'||?||'%')`);
      args.push(needle, needle);
    }
    if (fAudience) { where.push('audience = ?'); args.push(fAudience); }
    if (fCategory) { where.push('category = ?'); args.push(fCategory); }
    return { sql: where.join(' AND '), args };
  }, [q, fAudience, fCategory]);

  const rows = useMemo(() => db.all<ScriptRow>(
    `SELECT * FROM message_scripts WHERE ${filter.sql} ORDER BY created_at DESC`, filter.args
  ),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, version, filter]);

  const totalAll = useMemo(() => Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM message_scripts WHERE deleted_at IS NULL`
  )?.n ?? 0),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, version]);

  // معاينة القالب: تُحسب بعد سكون الكتابة (٣٠٠ مللي ثانية) وعند فتح النافذة فقط
  const [previewBody, setPreviewBody] = useState('');
  useEffect(() => {
    if (!formOpen) return;
    const h = setTimeout(() => setPreviewBody(body), 300);
    return () => clearTimeout(h);
  }, [body, formOpen]);
  const preview = useMemo(() => {
    if (!formOpen) return '';
    const c = db.get<{ id: string; tenant_name: string }>(
      `SELECT id, tenant_name FROM contracts WHERE deleted_at IS NULL AND status != 'مسودة' ORDER BY created_at DESC LIMIT 1`
    );
    return resolveTemplateTokens(previewBody, templateContext(db, c?.id ?? null, c?.tenant_name ?? 'محمد العتيبي')) || '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, previewBody, formOpen]);

  const openNew = () => { setEditingId(null); setAudience('مستأجرون'); setCategory('عام'); setTitle(''); setBody(''); setFormOpen(true); };
  const openEdit = (s: ScriptRow) => {
    setEditingId(s.id); setAudience(s.audience); setCategory(s.category); setTitle(s.title); setBody(s.body); setFormOpen(true);
  };
  const save = () => {
    if (!title.trim() || !body.trim()) { toast('الرجاء تعبئة العنوان والنص'); return; }
    db.transaction(() => {
      if (editingId) {
        db.run(`UPDATE message_scripts SET audience=?, category=?, title=?, body=? WHERE id=?`, [audience, category, title.trim(), body.trim(), editingId]);
      } else {
        db.run(`INSERT INTO message_scripts (id, audience, category, title, body, created_at) VALUES (?,?,?,?,?,?)`, [
          uid(), audience, category, title.trim(), body.trim(), new Date().toISOString(),
        ]);
      }
      logAudit(db, 'قوالب الرسائل', editingId ? 'update' : 'create', 'قالب رسالة', title.trim());
    });
    setFormOpen(false); bump();
    toast(editingId ? 'تم تحديث القالب' : 'أُضيف القالب');
  };

  const onDelete = (s: ScriptRow) => {
    dialog({
      title: 'حذف القالب',
      body: 'حذف هذا القالب؟',
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'حذف', variant: 'danger',
          onPress: () => {
            db.transaction(() => db.run(`UPDATE message_scripts SET deleted_at=? WHERE id=?`, [new Date().toISOString(), s.id]));
            bump(); toast('تم الحذف · يمكن استعادته من الإعدادات');
          },
        },
      ],
    });
  };

  const keyExtractor = useCallback((item: ScriptRow) => item.id, []);
  const renderItem: ListRenderItem<ScriptRow> = ({ item: s }) => {
    const tag = TYPE_TAG_STYLES[s.audience === 'مستأجرون' ? 'أصل' : s.audience === 'عملاء' ? 'إيراد' : 'مصروف'];
    return (
      <Card>
        {/* زر ⋮ أعلى البطاقة يساراً بمحاذاة العنوان */}
        <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <T size={TYPE.sectionTitle} bold style={{ flex: 1 }}>{s.title}</T>
          <Row gap={8}>
            <View style={{ backgroundColor: tag.bg, borderRadius: 6, paddingVertical: 3, paddingHorizontal: 8 }}>
              <T size={TYPE.caption} med color={tag.fg}>{s.audience}</T>
            </View>
            <ActionMenuButton title={s.title} actions={[
              { icon: 'edit', label: 'تعديل', onPress: () => openEdit(s) },
              { icon: 'trash', label: 'حذف', danger: true, onPress: () => onDelete(s) },
            ]} />
          </Row>
        </Row>
        <T size={TYPE.cardTitle} style={{ lineHeight: 21 }}>{s.body}</T>
      </Card>
    );
  };

  const clearFilters = useCallback(() => { setQ(''); setFAudience(''); setFCategory(''); }, []);
  const chips: ActiveChip[] = [
    ...(fAudience ? [{ key: 'audience', label: fAudience, onClear: () => setFAudience('') }] : []),
    ...(fCategory ? [{ key: 'category', label: fCategory, onClear: () => setFCategory('') }] : []),
  ];

  return (
    <Screen title="قوالب الرسائل" icon="message" scroll={false}
      actions={<BtnPrimary small title="+ قالب جديد" onPress={openNew} />}>
      <FlatList
        data={rows}
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
            resultCount={rows.length} total={totalAll} filtered={rows.length} itemName="قالباً"
            search={<SearchBox value={q} onChange={setQ} />} />
        }
        ListFooterComponent={<View style={{ height: 12 }} />}
        ListEmptyComponent={<Card><EmptyState>لا توجد قوالب مطابقة</EmptyState></Card>}
      />

      <FilterSheet open={fsheet.open} onClose={fsheet.hide} onClearAll={clearFilters} resultCount={rows.length}>
        <SelectField label="الفئة المستهدفة" value={fAudience}
          options={[{ value: '', label: 'كل الفئات المستهدفة' }, ...SCRIPT_AUDIENCES.map((a) => ({ value: a, label: a }))]}
          onPick={setFAudience} />
        <SelectField label="فئة القالب" value={fCategory}
          options={[{ value: '', label: 'كل الفئات' }, ...SCRIPT_CATEGORIES.map((c) => ({ value: c, label: c }))]}
          onPick={setFCategory} />
      </FilterSheet>

      <Sheet visible={formOpen} onClose={() => setFormOpen(false)}
        title={editingId ? 'تعديل القالب' : 'قالب رسالة جديد'} tall
        footer={
          <>
            <View style={{ flex: 1 }}><BtnPrimary title={editingId ? 'حفظ التعديل' : 'إضافة القالب'} onPress={save} /></View>
          </>
        }>
        <Row>
          <View style={{ flex: 1 }}>
            <SelectField label="الفئة المستهدفة" value={audience}
              options={SCRIPT_AUDIENCES.map((a) => ({ value: a, label: a }))} onPick={setAudience} />
          </View>
          <View style={{ flex: 1 }}><Field label="عنوان القالب" value={title} onChange={setTitle} /></View>
        </Row>
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 5 }}>الفئة</T>
        <Row style={{ flexWrap: 'wrap', marginBottom: 10 }}>
          {SCRIPT_CATEGORIES.map((c) => (
            <Chip key={c} label={c} active={category === c} onPress={() => setCategory(c)} />
          ))}
        </Row>
        <Field label="نص الرسالة" value={body} onChange={setBody} multiline />
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 8 }}>
          رموز تتعبأ تلقائياً عند الإرسال من شاشة التحصيل: {'{الاسم} · {المبلغ} · {التاريخ} · {الوحدة}'}
        </T>
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 5 }}>الرموز المتاحة</T>
        <Row style={{ flexWrap: 'wrap', marginBottom: 10 }}>
          {TEMPLATE_TOKENS.map((t) => (
            <Chip key={t.k} label={t.k} onPress={() => setBody((b) => b + t.k)} />
          ))}
        </Row>
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 5 }}>معاينة</T>
        <View style={{ backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 10, minHeight: 44 }}>
          <T size={TYPE.body}>{preview}</T>
        </View>
      </Sheet>
    </Screen>
  );
}

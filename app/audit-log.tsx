/** سجل العمليات · كل حركة، غير قابلة للتعديل، بمرشحات القسم والنوع والفترة وعرض مبسّط */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, FlatList } from 'react-native';
import { Screen } from '../src/ui/Screen';
import { Card, T, Num, EmptyState, Row, Badge, SearchBox, BtnIcon, Chip } from '../src/ui/components';
import { Sheet, SelectField } from '../src/ui/Sheet';
import { FilterBar, FilterSheet, useFilterSheet, type ActiveChip } from '../src/ui/FilterSheet';
import { usePager, Pager } from '../src/ui/Pager';
import { useDeferredReady } from '../src/ui/useDeferredReady';
import { Skeleton } from '../src/ui/Skeleton';
import { useApp } from '../src/ui/store';
import { C, TYPE } from '../src/ui/theme';
import { dfmt } from '../src/domain/dates';

const ACTION_LABELS: Record<string, string> = { create: 'إنشاء', update: 'تعديل', delete: 'حذف', login: 'تسجيل دخول' };
const ACTION_CLS: Record<string, string> = { create: 'paid', update: 'due', delete: 'overdue', login: 'draft' };

/** الفترة مرشِّح من عمود الوقت نفسه · الحساب في SQL فلا تواريخ تُبنى في الواجهة */
const PERIOD_LABELS: Record<string, string> = {
  month: 'هذا الشهر', '90': 'آخر 90 يوماً', year: 'هذه السنة',
};
const PERIOD_SQL: Record<string, string> = {
  month: `strftime('%Y-%m', ts) = strftime('%Y-%m','now','localtime')`,
  '90': `date(ts) >= date('now','localtime','-90 day')`,
  year: `strftime('%Y', ts) = strftime('%Y','now','localtime')`,
};
const PERIOD_OPTIONS = [{ value: '', label: 'كل الفترات' },
  ...Object.entries(PERIOD_LABELS).map(([value, label]) => ({ value, label }))];

interface AuditRow {
  id: string; ts: string; user_name: string; module: string; action_type: string;
  entity_type: string; entity_name: string;
}

const EMPTY_ROWS: AuditRow[] = [];
const EMPTY_MODULES: string[] = [];

const AuditCard = React.memo(function AuditCard({
  id, ts, userName, module, actionType, entityType, entityName, simplified, onDetail,
}: {
  id: string; ts: string; userName: string; module: string; actionType: string;
  entityType: string; entityName: string; simplified: boolean; onDetail: (id: string) => void;
}) {
  return (
    <Card style={{ paddingVertical: 9 }}>
      {/* زر التفاصيل أعلى البطاقة يساراً بمحاذاة العنوان · والعرض المبسّط لا تفاصيل له */}
      <Row style={{ justifyContent: 'space-between' }}>
        <T size={TYPE.cardTitle} med style={{ flex: 1 }}>
          {simplified
            ? `${ACTION_LABELS[actionType] || actionType} ${entityType}`
            : `${entityType}: ${entityName}`}
        </T>
        <Row gap={6}>
          <Badge kind={ACTION_CLS[actionType] || 'draft'} label={ACTION_LABELS[actionType] || actionType} />
          {simplified ? null : <BtnIcon icon="eye" accessibilityLabel="التفاصيل" onPress={() => onDetail(id)} />}
        </Row>
      </Row>
      <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
        <T size={TYPE.caption} color={C.muted}>{module} · {userName}</T>
        <Num size={TYPE.caption} color={C.muted}>{dfmt(ts.slice(0, 10))} {ts.slice(11, 16)}</Num>
      </Row>
    </Card>
  );
});

export default function AuditLog() {
  const { db, version } = useApp();
  const [q, setQ] = useState('');
  const [moduleFilter, setModuleFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [periodFilter, setPeriodFilter] = useState('');
  const [simplified, setSimplified] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const pager = usePager('audit');
  const fsheet = useFilterSheet();
  const ready = useDeferredReady();

  const needle = q.trim();
  useEffect(() => { pager.reset(); /* البحث أو المرشحات تغيّرت · نعود للصفحة الأولى */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, moduleFilter, actionFilter, periodFilter]);

  const { whereSql, whereParams } = useMemo(() => {
    const conds: string[] = [];
    const params: string[] = [];
    if (moduleFilter) { conds.push(`module = ?`); params.push(moduleFilter); }
    if (actionFilter) { conds.push(`action_type = ?`); params.push(actionFilter); }
    if (periodFilter && PERIOD_SQL[periodFilter]) conds.push(PERIOD_SQL[periodFilter]);
    if (needle) {
      conds.push(`(user_name LIKE '%'||?||'%' OR entity_name LIKE '%'||?||'%')`);
      params.push(needle, needle);
    }
    return { whereSql: conds.length ? ' WHERE ' + conds.join(' AND ') : '', whereParams: params };
  }, [needle, moduleFilter, actionFilter, periodFilter]);

  const modules = useMemo(() => {
    if (!ready) return EMPTY_MODULES;
    return db.all<{ module: string }>(`SELECT DISTINCT module FROM audit_log ORDER BY module`).map((r) => r.module);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready]);

  const rows = useMemo(() => {
    if (!ready) return EMPTY_ROWS;
    return db.all<AuditRow>(
      `SELECT id, ts, user_name, module, action_type, entity_type, entity_name
       FROM audit_log${whereSql} ORDER BY ts DESC LIMIT ? OFFSET ?`,
      [...whereParams, pager.limit, pager.offset]
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, whereSql, whereParams, pager.limit, pager.offset, ready]);

  const total = useMemo(() => {
    if (!ready) return 0;
    return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log${whereSql}`, whereParams)?.n ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, whereSql, whereParams, ready]);

  // العدد الكلي قبل أي تصفية · سطر العدد يقول «24 من 60»
  const totalAll = useMemo(() => {
    if (!ready) return 0;
    return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log`)?.n ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready]);

  const detail = detailId
    ? db.get<{ module: string; entity_type: string; entity_name: string; user_name: string; ts: string; before_json: string | null; after_json: string | null }>(
        `SELECT * FROM audit_log WHERE id = ?`, [detailId]
      )
    : undefined;

  const openDetail = useCallback((id: string) => setDetailId(id), []);

  const renderRow = useCallback(({ item }: { item: AuditRow }) => (
    <AuditCard
      id={item.id} ts={item.ts} userName={item.user_name} module={item.module}
      actionType={item.action_type} entityType={item.entity_type} entityName={item.entity_name}
      simplified={simplified} onDetail={openDetail}
    />
  ), [simplified, openDetail]);

  const clearFilters = useCallback(() => {
    setQ(''); setModuleFilter(''); setActionFilter(''); setPeriodFilter('');
  }, []);

  const chips: ActiveChip[] = [
    ...(moduleFilter ? [{ key: 'module', label: moduleFilter, onClear: () => setModuleFilter('') }] : []),
    ...(actionFilter ? [{ key: 'action', label: ACTION_LABELS[actionFilter] ?? actionFilter, onClear: () => setActionFilter('') }] : []),
    ...(periodFilter ? [{ key: 'period', label: PERIOD_LABELS[periodFilter] ?? periodFilter, onClear: () => setPeriodFilter('') }] : []),
  ];

  const header = (
    <View>
      <FilterBar chips={chips} onOpen={fsheet.show} onClearAll={clearFilters}
        resultCount={total} total={totalAll} filtered={total} itemName="عملية"
        search={<SearchBox value={q} onChange={setQ} />} />
      <Row style={{ marginBottom: 8 }}>
        <Chip label="عرض مبسّط" active={simplified} onPress={() => setSimplified((v) => !v)} />
      </Row>
    </View>
  );

  return (
    <Screen title="سجل العمليات" scroll={false}>
      {!ready ? <Skeleton /> : (
        <FlatList
          data={rows}
          keyExtractor={(a) => a.id}
          renderItem={renderRow}
          ListHeaderComponent={header}
          ListEmptyComponent={<Card><EmptyState>لا توجد عمليات مطابقة</EmptyState></Card>}
          ListFooterComponent={<Pager pager={pager} total={total} />}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
        />
      )}

      <FilterSheet open={fsheet.open} onClose={fsheet.hide} onClearAll={clearFilters} resultCount={total}>
        <SelectField label="القسم" value={moduleFilter}
          options={[{ value: '', label: 'كل الأقسام' }, ...modules.map((m) => ({ value: m, label: m }))]}
          onPick={setModuleFilter} />
        <SelectField label="نوع العملية" value={actionFilter}
          options={[{ value: '', label: 'كل أنواع العمليات' },
            ...Object.entries(ACTION_LABELS).map(([v, l]) => ({ value: v, label: l }))]}
          onPick={setActionFilter} />
        <SelectField label="الفترة" value={periodFilter} options={PERIOD_OPTIONS} onPick={setPeriodFilter} />
      </FilterSheet>

      {detail && (
        <Sheet visible onClose={() => setDetailId(null)} title="تفاصيل العملية" tall>
          {([['القسم', detail.module], ['العنصر', detail.entity_type + ' · ' + detail.entity_name],
            ['المستخدم', detail.user_name], ['التاريخ والوقت', detail.ts]] as Array<[string, string]>).map(([k, v]) => (
            <Row key={k} style={{ justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <T size={TYPE.body} color={C.muted}>{k}</T>
              <T size={TYPE.cardTitle} med style={{ flex: 1, textAlign: 'left' }}>{v}</T>
            </Row>
          ))}
          {detail.before_json ? (
            <>
              <T size={TYPE.caption} color={C.muted} style={{ marginTop: 10, marginBottom: 4 }}>القيمة قبل</T>
              <View style={{ backgroundColor: C.paper, borderRadius: 8, padding: 9 }}>
                <Num size={TYPE.caption}>{detail.before_json}</Num>
              </View>
            </>
          ) : null}
          {detail.after_json ? (
            <>
              <T size={TYPE.caption} color={C.muted} style={{ marginTop: 10, marginBottom: 4 }}>القيمة بعد</T>
              <View style={{ backgroundColor: C.paper, borderRadius: 8, padding: 9, marginBottom: 12 }}>
                <Num size={TYPE.caption}>{detail.after_json}</Num>
              </View>
            </>
          ) : null}
        </Sheet>
      )}
    </Screen>
  );
}

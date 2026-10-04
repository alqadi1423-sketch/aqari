/** الحركات البنكية · وارد وصادر بالحالة والقيد المرتبط والمصدر */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, FlatList } from 'react-native';
import { Screen } from '../src/ui/Screen';
import { Card, T, Money, EmptyState, Row, Badge, SearchBox, BtnPrimary, BtnGhost, Field, ChipGroup } from '../src/ui/components';
import { Sheet, SelectField } from '../src/ui/Sheet';
import { DateField } from '../src/ui/DateField';
import { ActionMenuButton } from '../src/ui/ActionMenu';
import { FilterBar, FilterSheet, useFilterSheet, type ActiveChip } from '../src/ui/FilterSheet';
import { usePager, Pager } from '../src/ui/Pager';
import { useDeferredReady } from '../src/ui/useDeferredReady';
import { Skeleton } from '../src/ui/Skeleton';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { useDialog } from '../src/ui/AppDialog';
import { C, TYPE } from '../src/ui/theme';
import { uid } from '../src/domain/ids';
import { fmt, toHalalas } from '../src/domain/money';
import { today, dfmt } from '../src/domain/dates';
import { logAudit } from '../src/domain/audit';
import { usePerm } from '../src/ui/access';

interface TxRow {
  id: string; bank_id: string; date: string; descr: string; amount_halalas: number;
  matched: number; journal_no: string; source: string;
}

type DirFilter = 'all' | 'in' | 'out';
type MatchFilter = 'all' | 'matched' | 'unmatched';

const EMPTY_TX: TxRow[] = [];
const DIR_OPTIONS: Array<[DirFilter, string]> = [['all', 'الكل'], ['in', 'وارد'], ['out', 'صادر']];
const MATCH_OPTIONS: Array<[MatchFilter, string]> = [['all', 'الكل'], ['matched', 'مطابقة'], ['unmatched', 'غير مطابقة']];

/** الفترة تُحسب في SQL من عمود التاريخ نفسه */
const PERIOD_LABELS: Record<string, string> = { month: 'هذا الشهر', '90': 'آخر 90 يوماً', year: 'هذه السنة' };
const PERIOD_SQL: Record<string, string> = {
  month: `strftime('%Y-%m', date) = strftime('%Y-%m','now','localtime')`,
  '90': `date >= date('now','localtime','-90 day')`,
  year: `strftime('%Y', date) = strftime('%Y','now','localtime')`,
};
const PERIOD_OPTIONS = [{ value: '', label: 'كل الفترات' },
  ...Object.entries(PERIOD_LABELS).map(([value, label]) => ({ value, label }))];

const TxCard = React.memo(function TxCard({
  id, bankId, date, descr, amountHalalas, matched, journalNo, source, bankName, canManage, onEdit, onDelete,
}: {
  id: string; bankId: string; date: string; descr: string; amountHalalas: number;
  matched: number; journalNo: string; source: string; bankName: string;
  /** «البنوك والنقد: كامل» · التعديل والحذف */
  canManage: boolean;
  onEdit: (id: string, bankId: string, date: string, amountHalalas: number, descr: string, source: string) => void;
  onDelete: (id: string) => void;
}) {
  // الحركة المولَّدة من مستند مرحَّل (لها رقم قيد) لا تُعدَّل ولا تُحذف يدوياً ·
  // تصحيحها من مستندها، فلا يُعرض لها زر تعديل ولا حذف إطلاقاً
  const generated = !!journalNo;
  return (
    <Card style={{ paddingVertical: 10 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T size={TYPE.cardTitle} bold style={{ flex: 1 }}>{descr}</T>
        <Row gap={8}>
          <Money halalas={amountHalalas} size={TYPE.number} bold
            color={amountHalalas < 0 ? C.rose : C.emerald} />
          <ActionMenuButton title={descr} actions={generated || !canManage ? [] : [
            { icon: 'edit', label: 'تعديل', onPress: () => onEdit(id, bankId, date, amountHalalas, descr, source) },
            { icon: 'trash', label: 'حذف', danger: true, onPress: () => onDelete(id) },
          ]} />
        </Row>
      </Row>
      <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
        <T size={TYPE.caption} color={C.muted}>{bankName} · {dfmt(date)}</T>
        <Badge kind={matched ? 'paid' : 'due'} label={matched ? 'مطابقة' : 'غير مطابقة'} />
      </Row>
      <Row style={{ marginTop: 4 }}>
        {journalNo || source
          ? <T size={TYPE.caption} color={C.muted}>{[journalNo ? 'القيد: ' + journalNo : '', source ? 'المصدر: ' + source : ''].filter(Boolean).join(' · ')}</T>
          : null}
      </Row>
    </Card>
  );
});

export default function Transactions() {
  const { db, version, bump } = useApp();
  const perm = usePerm('banks');
  const toast = useToast();
  const dialog = useDialog();
  const [q, setQ] = useState('');
  const [bankFilter, setBankFilter] = useState('all');
  const [dirFilter, setDirFilter] = useState<DirFilter>('all');
  const [matchFilter, setMatchFilter] = useState<MatchFilter>('all');
  const [periodFilter, setPeriodFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [bankId, setBankId] = useState('');
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [descr, setDescr] = useState('');
  const [source, setSource] = useState('');
  const pager = usePager('transactions');
  const fsheet = useFilterSheet();
  const ready = useDeferredReady();

  const banks = useMemo(() =>
    db.all<{ id: string; name: string }>(`SELECT id, name FROM banks WHERE deleted_at IS NULL AND archived = 0 ORDER BY created_at`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const bankName = useCallback((id: string) => banks.find((b) => b.id === id)?.name ?? '', [banks]);

  const needle = q.trim();
  useEffect(() => { pager.reset(); /* البحث أو المرشِّح تغيّر · نعود للصفحة الأولى */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, bankFilter, dirFilter, matchFilter, periodFilter]);

  const filterSql = useMemo(() => {
    let where = `deleted_at IS NULL`;
    const params: string[] = [];
    if (bankFilter !== 'all') { where += ` AND bank_id = ?`; params.push(bankFilter); }
    if (dirFilter === 'in') where += ` AND amount_halalas >= 0`;
    if (dirFilter === 'out') where += ` AND amount_halalas < 0`;
    if (matchFilter === 'matched') where += ` AND matched = 1`;
    if (matchFilter === 'unmatched') where += ` AND matched = 0`;
    if (periodFilter && PERIOD_SQL[periodFilter]) where += ` AND ` + PERIOD_SQL[periodFilter];
    if (needle) {
      where += ` AND (descr LIKE '%'||?||'%' OR journal_no LIKE '%'||?||'%' OR date LIKE '%'||?||'%')`;
      params.push(needle, needle, needle);
    }
    return { where, params };
  }, [bankFilter, dirFilter, matchFilter, periodFilter, needle]);

  const rows = useMemo(() => {
    if (!ready) return EMPTY_TX;
    return db.all<TxRow>(
      `SELECT * FROM bank_tx WHERE ${filterSql.where} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`,
      [...filterSql.params, pager.limit, pager.offset]
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, filterSql, pager.limit, pager.offset, ready]);

  const total = useMemo(() => {
    if (!ready) return 0;
    return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_tx WHERE ${filterSql.where}`, filterSql.params)?.n ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, filterSql, ready]);

  // العدد الكلي قبل التصفية · لسطر «24 من 60»
  const totalAll = useMemo(() => {
    if (!ready) return 0;
    return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bank_tx WHERE deleted_at IS NULL`)?.n ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready]);

  const openNew = () => {
    setEditingId(null); setBankId(banks[0].id); setDate(today()); setAmount(''); setDescr(''); setSource('');
    setFormOpen(true);
  };
  const openEdit = useCallback((id: string, txBankId: string, txDate: string, amountHalalas: number, txDescr: string, txSource: string) => {
    setEditingId(id); setBankId(txBankId); setDate(txDate);
    setAmount(fmt(amountHalalas).replace(/,/g, ''));
    setDescr(txDescr); setSource(txSource); setFormOpen(true);
  }, []);
  const save = () => {
    if (!descr.trim() || !toHalalas(amount)) { toast('الرجاء إدخال البيان والمبلغ'); return; }
    db.transaction(() => {
      if (editingId) {
        db.run(`UPDATE bank_tx SET bank_id=?, date=?, descr=?, amount_halalas=?, source=? WHERE id=?`, [
          bankId, date, descr.trim(), toHalalas(amount), source.trim(), editingId,
        ]);
      } else {
        db.run(
          `INSERT INTO bank_tx (id, bank_id, date, descr, amount_halalas, matched, source, created_at)
           VALUES (?,?,?,?,?,0,?,?)`,
          [uid(), bankId, date, descr.trim(), toHalalas(amount), source.trim(), new Date().toISOString()]
        );
      }
      logAudit(db, 'الحركات البنكية', editingId ? 'update' : 'create', 'حركة بنكية', descr.trim());
    });
    setFormOpen(false); bump();
    toast(editingId ? 'تم تحديث الحركة' : 'أُضيفت الحركة');
  };

  const deleteTx = useCallback((id: string) => {
    dialog({
      title: 'حذف الحركة البنكية',
      body: 'حذف هذه الحركة؟',
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'حذف', variant: 'danger',
          onPress: () => {
            db.transaction(() => db.run(`UPDATE bank_tx SET deleted_at=? WHERE id=?`, [new Date().toISOString(), id]));
            bump(); toast('تم الحذف · يمكن استعادته من الإعدادات');
          },
        },
      ],
    });
  }, [db, bump, toast, dialog]);

  const renderTx = useCallback(({ item }: { item: TxRow }) => (
    <TxCard
      id={item.id} bankId={item.bank_id} date={item.date} descr={item.descr}
      amountHalalas={Number(item.amount_halalas)} matched={Number(item.matched)}
      journalNo={item.journal_no} source={item.source} bankName={bankName(item.bank_id)}
      canManage={perm.manage} onEdit={openEdit} onDelete={deleteTx}
    />
  ), [bankName, openEdit, deleteTx, perm.manage]);

  const clearFilters = useCallback(() => {
    setQ(''); setBankFilter('all'); setDirFilter('all'); setMatchFilter('all'); setPeriodFilter('');
  }, []);

  const chips: ActiveChip[] = [
    ...(bankFilter !== 'all' ? [{ key: 'bank', label: bankName(bankFilter), onClear: () => setBankFilter('all') }] : []),
    ...(dirFilter !== 'all' ? [{ key: 'dir', label: dirFilter === 'in' ? 'وارد' : 'صادر', onClear: () => setDirFilter('all') }] : []),
    ...(matchFilter !== 'all' ? [{ key: 'match', label: matchFilter === 'matched' ? 'مطابقة' : 'غير مطابقة', onClear: () => setMatchFilter('all') }] : []),
    ...(periodFilter ? [{ key: 'period', label: PERIOD_LABELS[periodFilter] ?? periodFilter, onClear: () => setPeriodFilter('') }] : []),
  ];

  const bankOptions = useMemo(
    () => [{ value: 'all', label: 'كل البنوك' }, ...banks.map((b) => ({ value: b.id, label: b.name }))],
    [banks]);

  return (
    <Screen title="الحركات البنكية" icon="tx" scroll={false}
      /* لا حساب بنكياً فلا حركة تُضاف · الزر لا يُعرض بدل أن يُعرض ويرفض */
      actions={banks.length && perm.add ? <BtnPrimary small title="+ حركة جديدة" onPress={openNew} /> : undefined}>
      {!ready ? <Skeleton /> : (
        <FlatList
          data={rows}
          keyExtractor={(x) => x.id}
          renderItem={renderTx}
          ListHeaderComponent={
            <FilterBar chips={chips} onOpen={fsheet.show} onClearAll={clearFilters}
              resultCount={total} total={totalAll} filtered={total} itemName="حركة"
              search={<SearchBox value={q} onChange={setQ} />} />
          }
          ListFooterComponent={<Pager pager={pager} total={total} />}
          ListEmptyComponent={<Card><EmptyState>لا توجد حركات بنكية مطابقة</EmptyState></Card>}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
        />
      )}

      <FilterSheet open={fsheet.open} onClose={fsheet.hide} onClearAll={clearFilters} resultCount={total}>
        <SelectField label="الحساب البنكي" value={bankFilter} options={bankOptions} onPick={setBankFilter} />
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 5 }}>الاتجاه</T>
        <View style={{ marginBottom: 10 }}>
          <ChipGroup<DirFilter> options={DIR_OPTIONS} value={dirFilter} onChange={setDirFilter} />
        </View>
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 5 }}>المطابقة</T>
        <View style={{ marginBottom: 10 }}>
          <ChipGroup<MatchFilter> options={MATCH_OPTIONS} value={matchFilter} onChange={setMatchFilter} />
        </View>
        <SelectField label="الفترة" value={periodFilter} options={PERIOD_OPTIONS} onPick={setPeriodFilter} />
      </FilterSheet>

      <Sheet visible={formOpen} onClose={() => setFormOpen(false)}
        title={editingId ? 'تعديل الحركة البنكية' : 'حركة بنكية جديدة'}
        footer={
          <>
            <View style={{ flex: 1 }}><BtnPrimary title={editingId ? 'حفظ التعديل' : 'إضافة الحركة'} onPress={save} /></View>
          </>
        }>
        <SelectField label="الحساب البنكي" value={bankId}
          options={banks.map((b) => ({ value: b.id, label: b.name }))} onPick={setBankId} />
        <Row>
          <View style={{ flex: 1 }}><DateField label="التاريخ" value={date} onChange={setDate} /></View>
          <View style={{ flex: 1 }}><Field label="المبلغ (سالب للصادر)" value={amount} onChange={setAmount} keyboard="numeric" ltr /></View>
        </Row>
        <Field label="البيان" value={descr} onChange={setDescr} />
        <Field label="المصدر" value={source} onChange={setSource} />
      </Sheet>
    </Screen>
  );
}

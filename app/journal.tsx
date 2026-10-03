/** القيود اليومية · القائمة وبناء قيد جديد بميزان حي وترحيله */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, FlatList, Pressable } from 'react-native';
import { Screen } from '../src/ui/Screen';
import { EntrySheet, srcTypeLabel } from '../src/ui/EntrySheet';
import { Card, T, Num, EmptyState, Row, Badge, SearchBox, BtnPrimary, BtnGhost, Field } from '../src/ui/components';
import { Sheet, SelectField } from '../src/ui/Sheet';
import { DateField } from '../src/ui/DateField';
import { ActionMenuButton } from '../src/ui/ActionMenu';
import { usePager, Pager } from '../src/ui/Pager';
import { useDeferredReady } from '../src/ui/useDeferredReady';
import { Skeleton } from '../src/ui/Skeleton';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { useDialog } from '../src/ui/AppDialog';
import { C } from '../src/ui/theme';
import { postEntry, nextJournalNo, voidEntryById } from '../src/domain/accounting/post';
import { reverseFromJournal, journalReversalBlock } from '../src/domain/accounting/journalReversal';
import { allAccounts } from '../src/domain/accounting/ledger';
import { today, dfmt } from '../src/domain/dates';
import { fmt, toHalalas } from '../src/domain/money';
import { reportFailure } from '../src/ui/failureDialog';

interface JeLine { account: string; debit: string; credit: string }

interface EntryRow {
  id: string; no: string; date: string; memo: string; status: string; auto: number;
  src_type: string | null; src_id: string | null; d: number; c: number;
}

const EMPTY_ENTRIES: EntryRow[] = [];

const EntryCard = React.memo(function EntryCard({
  id, no, date, memo, status, srcType, auto, d, c, onOpen, onReverse, onDeleteDraft,
}: {
  id: string; no: string; date: string; memo: string; status: string; auto: boolean;
  srcType: string | null; d: number; c: number;
  /** الضغط على القيد يفتح ورقة تفاصيله */
  onOpen: (id: string) => void;
  onReverse: (id: string, no: string) => void;
  onDeleteDraft: (id: string) => void;
}) {
  return (
    <Card style={{ paddingVertical: 10 }}>
      <Pressable onPress={() => onOpen(id)}>
        <Row style={{ justifyContent: 'space-between' }}>
          {memo ? <T size={12.5} bold style={{ flex: 1, minWidth: 90 }} numberOfLines={2}>{memo}</T> : <View style={{ flex: 1, minWidth: 90 }} />}
          <Badge kind="paid" label={status} />
        </Row>
        <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
          <Num size={11.5} color={C.muted}>{no} · {dfmt(date)}</Num>
          <Row gap={10}>
            <Num size={12}>مدين {fmt(d)}</Num>
            <Num size={12}>دائن {fmt(c)}</Num>
          </Row>
        </Row>
        <T size={10.5} color={C.muted} numberOfLines={1} style={{ marginTop: 3 }}>{srcTypeLabel(srcType)}</T>
      </Pressable>
      {/* القيد الآلي يُلغى من مستنده لا من الدفتر (journalReversal.ts) · فلا يُعرض له زرّ لا يصح فعله */}
      {status === 'مرحّل' && auto && srcType ? null : (
        <Row style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <ActionMenuButton title={no} actions={[
            status === 'مرحّل'
              ? {
                  // قيد مرحّل لا يُحذف أبداً · يُعكَس بقيد مرآة والاثنان يبقيان في الدفتر
                  icon: 'undo', label: 'عكس القيد',
                  onPress: () => onReverse(id, no),
                }
              : {
                  icon: 'trash', label: 'حذف', danger: true,
                  onPress: () => onDeleteDraft(id),
                },
          ]} />
        </Row>
      )}
    </Card>
  );
});

export default function Journal() {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const [q, setQ] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<JeLine[]>([
    { account: '', debit: '', credit: '' },
    { account: '', debit: '', credit: '' },
  ]);
  const pager = usePager('journal');
  const ready = useDeferredReady();

  const needle = q.trim();
  useEffect(() => { pager.reset(); /* البحث تغيّر · نعود للصفحة الأولى */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle]);

  const searchSql = needle
    ? ` AND (e.memo LIKE '%'||?||'%' OR e.no LIKE '%'||?||'%' OR e.date LIKE '%'||?||'%')`
    : '';
  const searchParams = useMemo<string[]>(() => (needle ? [needle, needle, needle] : []), [needle]);

  const rows = useMemo(() => {
    if (!ready) return EMPTY_ENTRIES;
    return db.all<EntryRow>(
      `SELECT e.id, e.no, e.date, e.memo, e.status, e.auto, e.src_type, e.src_id,
              COALESCE(SUM(l.debit_halalas),0) AS d, COALESCE(SUM(l.credit_halalas),0) AS c
       FROM journal_entries e LEFT JOIN journal_lines l ON l.entry_id = e.id
       WHERE e.deleted_at IS NULL${searchSql}
       GROUP BY e.id ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,
      [...searchParams, pager.limit, pager.offset]
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, searchSql, searchParams, pager.limit, pager.offset, ready]);

  const total = useMemo(() => {
    if (!ready) return 0;
    return db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM journal_entries e WHERE e.deleted_at IS NULL${searchSql}`,
      searchParams
    )?.n ?? 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, searchSql, searchParams, ready]);

  const accounts = useMemo(() => allAccounts(db),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const accountOpts = useMemo(() => accounts.map((a) => ({ value: a.code, label: a.code + ' · ' + a.name })), [accounts]);

  const totalDebit = lines.reduce((s, l) => s + toHalalas(l.debit), 0);
  const totalCredit = lines.reduce((s, l) => s + toHalalas(l.credit), 0);
  const balanced = totalDebit > 0 && totalDebit === totalCredit;

  const openBuilder = () => {
    setDate(today()); setMemo('');
    setLines([{ account: '', debit: '', credit: '' }, { account: '', debit: '', credit: '' }]);
    setBuilderOpen(true);
  };

  const post = () => {
    if (!balanced) { toast('لا يمكن ترحيل قيد غير متوازن'); return; }
    const validLines = lines
      .filter((l) => l.account && (toHalalas(l.debit) || toHalalas(l.credit)))
      .map((l) => ({ account: l.account, debit: toHalalas(l.debit), credit: toHalalas(l.credit) }));
    if (!validLines.length) { toast('أضف سطراً واحداً على الأقل بحساب صحيح'); return; }
    try {
      postEntry(db, { date, memo: memo.trim() || 'بدون بيان', lines: validLines, auto: false });
      setBuilderOpen(false); bump();
      toast('تم ترحيل القيد بنجاح · تحدَّثت أرصدة الحسابات فعلياً');
    } catch (e) { reportFailure({ title: 'تعذّر الترحيل', e }); }
  };

  // كل قيد يفتح ورقة تفاصيله · ومنها وحدها يُفتح مستنده المصدر
  const openDetail = useCallback((id: string) => setDetailId(id), []);

  const reverseEntry = useCallback((id: string, no: string) => {
    // القيد الآلي يُلغى من مستنده · يُقال السبب قبل أي تأكيد
    const why = journalReversalBlock(db, id);
    if (why) {
      dialog({ title: 'لا يُعكس القيد ' + no + ' من الدفتر', body: why + '.', tone: 'normal', actions: [{ label: 'حسناً', variant: 'ghost' }] });
      return;
    }
    dialog({
      title: 'عكس القيد ' + no,
      body: 'سيُرحَّل قيد عاكس بتاريخ اليوم يلغي أثره على الأرصدة، ويبقى القيدان معاً في الدفتر.',
      tone: 'normal',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'عكس القيد', variant: 'primary',
          onPress: () => {
            try {
              const rev = reverseFromJournal(db, id);
              bump();
              toast(rev ? 'رُحّل القيد العاكس ' + rev.no : 'هذا القيد معكوس من قبل');
            } catch (e) { reportFailure({ title: 'تعذّر عكس القيد', e }); }
          },
        },
      ],
    });
  }, [db, bump, toast, dialog]);

  const deleteDraft = useCallback((id: string) => {
    dialog({
      title: 'حذف المسودة',
      body: 'حذف هذه المسودة؟',
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'حذف', variant: 'danger',
          onPress: () => {
            voidEntryById(db, id);
            bump(); toast('حُذفت المسودة · يمكن استعادتها من سلة المحذوفات');
          },
        },
      ],
    });
  }, [db, bump, toast, dialog]);

  const renderEntry = useCallback(({ item }: { item: EntryRow }) => (
    <EntryCard
      id={item.id} no={item.no} date={item.date} memo={item.memo} status={item.status}
      srcType={item.src_type} auto={Number(item.auto) === 1} d={Number(item.d)} c={Number(item.c)}
      onOpen={openDetail} onReverse={reverseEntry} onDeleteDraft={deleteDraft}
    />
  ), [openDetail, reverseEntry, deleteDraft]);

  return (
    <Screen title="القيود اليومية" scroll={false}
      actions={<BtnPrimary small title="+ قيد جديد" onPress={openBuilder} />}>
      {!ready ? <Skeleton /> : (
        <FlatList
          data={rows}
          keyExtractor={(j) => j.id}
          renderItem={renderEntry}
          ListHeaderComponent={
            <View style={{ marginBottom: 8 }}>
              <SearchBox value={q} onChange={setQ} />
            </View>
          }
          ListFooterComponent={<Pager pager={pager} total={total} />}
          ListEmptyComponent={<Card><EmptyState>لا توجد قيود مطابقة</EmptyState></Card>}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
        />
      )}

      {/* ورقة تفاصيل القيد · تُفتح بالضغط على أي قيد */}
      {detailId ? <EntrySheet entryId={detailId} onClose={() => setDetailId(null)} /> : null}

      <Sheet visible={builderOpen} onClose={() => setBuilderOpen(false)} title="قيد يومية جديد" tall
        footer={
          <>
            <View style={{ flex: 1 }}><BtnPrimary title="ترحيل القيد" onPress={post} disabled={!balanced} /></View>
          </>
        }>
        <Row>
          <View style={{ flex: 1 }}><Field label="رقم القيد" value={nextJournalNo(db)} disabled ltr /></View>
          <View style={{ flex: 1 }}><DateField label="التاريخ" value={date} onChange={setDate} /></View>
        </Row>
        <Field label="البيان" value={memo} onChange={setMemo} />
        {lines.map((l, i) => (
          <View key={i} style={{ borderWidth: 1, borderColor: C.line, borderRadius: 9, padding: 9, marginBottom: 8 }}>
            <SelectField label="الحساب" value={l.account} options={accountOpts}
              onPick={(v) => setLines((p) => p.map((x, xi) => (xi === i ? { ...x, account: v } : x)))}
              placeholder="اختر الحساب…" />
            <Row>
              <View style={{ flex: 1 }}>
                <Field label="مدين" value={l.debit} keyboard="numeric" ltr
                  onChange={(v) => setLines((p) => p.map((x, xi) => (xi === i ? { ...x, debit: v, credit: v ? '' : x.credit } : x)))} />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="دائن" value={l.credit} keyboard="numeric" ltr
                  onChange={(v) => setLines((p) => p.map((x, xi) => (xi === i ? { ...x, credit: v, debit: v ? '' : x.debit } : x)))} />
              </View>
            </Row>
            {lines.length > 2 && (
              <BtnGhost small danger icon="trash" title="حذف السطر"
                onPress={() => setLines((p) => p.filter((_, xi) => xi !== i))} />
            )}
          </View>
        ))}
        <BtnGhost small title="+ إضافة سطر"
          onPress={() => setLines((p) => [...p, { account: '', debit: '', credit: '' }])} />
        <View style={{
          marginTop: 12, borderRadius: 8, padding: 11,
          backgroundColor: balanced ? C.emeraldSoft : C.roseSoft, alignItems: 'center',
        }}>
          <T size={12.5} bold color={balanced ? C.emerald : C.rose}>
            {balanced
              ? `القيد متوازن · ${fmt(totalDebit)} = ${fmt(totalCredit)}`
              : `غير متوازن · المدين ${fmt(totalDebit)} / الدائن ${fmt(totalCredit)}`}
          </T>
        </View>
      </Sheet>
    </Screen>
  );
}

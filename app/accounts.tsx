/** دليل الحسابات · مجموعات الأنواع الخمسة بأرصدتها وحركة الفترة وكشف لكل حساب */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { saveAccount, deleteAccount, deleteBlocker } from '../src/domain/accounting/chart';
import { View, Pressable, FlatList, type ListRenderItem } from 'react-native';
import { Screen } from '../src/ui/Screen';
import { EntrySheet, srcTypeLabel } from '../src/ui/EntrySheet';
import { Card, T, Num, EmptyState, Row, SearchBox, BtnPrimary, BtnGhost, Field, ChipGroup } from '../src/ui/components';
import { Sheet, SelectField } from '../src/ui/Sheet';
import { ActionMenuButton } from '../src/ui/ActionMenu';
import { useDialog } from '../src/ui/AppDialog';
import { usePager, Pager } from '../src/ui/Pager';
import { useDeferredReady } from '../src/ui/useDeferredReady';
import { Skeleton } from '../src/ui/Skeleton';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { C, RADIUS, TYPE_TAG_STYLES } from '../src/ui/theme';
import { allAccounts, allAccountBalances, allAccountMovements } from '../src/domain/accounting/ledger';
import { fmt, toHalalas } from '../src/domain/money';
import { today, dfmt } from '../src/domain/dates';
import { logAudit } from '../src/domain/audit';
import { reportFailure } from '../src/ui/failureDialog';
import { usePerm } from '../src/ui/access';

const GROUPS = ['أصل', 'خصم', 'حقوق ملكية', 'إيراد', 'مصروف'];
const GROUP_LABEL: Record<string, string> = {
  'أصل': 'الأصول', 'خصم': 'الخصوم', 'حقوق ملكية': 'حقوق الملكية', 'إيراد': 'الإيرادات', 'مصروف': 'المصروفات',
};

type PeriodKey = 'month' | 'quarter' | 'year' | 'all';

interface AccountItem {
  code: string; name: string; type: string; grp: string | null;
  opening: number; balance: number; debit: number; credit: number;
}

interface StmtLine {
  entry_id: string; date: string; memo: string;
  src_type: string | null; src_id: string | null; d: number; c: number;
}

const EMPTY_ACCOUNTS: AccountItem[] = [];
const EMPTY_STMT: StmtLine[] = [];

/** القائمة المسطّحة: رأس كل مجموعة عنصر مستقل يليه حساباتها */
type AccListItem =
  | { kind: 'header'; key: string; g: string; totalBal: number }
  | { kind: 'row'; key: string; a: AccountItem; last: boolean };

const AccountRowItem = React.memo(function AccountRowItem({
  code, name, type, opening, debit, credit, balance, tagBg, tagFg, canManage, onOpen, onEdit, onDelete, isSystem,
}: {
  code: string; name: string; type: string; opening: number; debit: number; credit: number;
  balance: number; tagBg: string; tagFg: string;
  /** التعديل والحذف · كامل في الدفتر */
  canManage: boolean;
  onOpen: (code: string, name: string) => void;
  onEdit: (code: string) => void;
  onDelete: (code: string) => void;
  /** حساب نظامي: لا حذف ولا تغيير نوع */
  isSystem: boolean;
}) {
  return (
    <Row style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.paperLine, alignItems: 'flex-start' }}>
      <Pressable style={{ flex: 1 }} onPress={() => onOpen(code, name)}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T size={12.5} med numberOfLines={2} style={{ flex: 1, minWidth: 90 }}>{name}</T>
          <Row gap={6}>
            <Num size={10.5} color={C.muted}>{code}</Num>
            <View style={{ backgroundColor: tagBg, borderRadius: 5, paddingVertical: 1, paddingHorizontal: 6 }}>
              <T size={9.5} med color={tagFg} numberOfLines={1}>{type}</T>
            </View>
          </Row>
        </Row>
        {/* أربعة أعمدة متساوية · كل تسمية سطر واحد فلا تنزل كلمة حرفاً تحت حرف */}
        <Row style={{ justifyContent: 'space-between', marginTop: 5 }}>
          <View style={{ flex: 1 }}>
            <T size={9.5} color={C.muted} numberOfLines={1}>الافتتاحي</T>
            <Num size={11}>{fmt(opening)}</Num>
          </View>
          <View style={{ flex: 1 }}>
            <T size={9.5} color={C.muted} numberOfLines={1}>مدين الفترة</T>
            <Num size={11}>{fmt(debit)}</Num>
          </View>
          <View style={{ flex: 1 }}>
            <T size={9.5} color={C.muted} numberOfLines={1}>دائن الفترة</T>
            <Num size={11}>{fmt(credit)}</Num>
          </View>
          <View style={{ flex: 1 }}>
            <T size={9.5} color={C.muted} numberOfLines={1}>الختامي</T>
            <Num size={11.5} bold>{fmt(balance)}</Num>
          </View>
        </Row>
      </Pressable>
      <ActionMenuButton title={name} actions={canManage ? [
        { icon: 'edit', label: 'تعديل', onPress: () => onEdit(code) },
        // الحساب النظامي لا يُحذف فلا يظهر زره (دراسة القائم)
        ...(isSystem ? [] : [{ icon: 'trash' as const, label: 'حذف', danger: true, onPress: () => onDelete(code) }]),
      ] : []} />
    </Row>
  );
});

export default function Accounts() {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  const perm = usePerm('ledger');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [period, setPeriod] = useState<PeriodKey>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [type, setType] = useState('أصل');
  const [opening, setOpening] = useState('');
  const [stmt, setStmt] = useState<{ code: string; name: string } | null>(null);
  const [stmtEntry, setStmtEntry] = useState<string | null>(null);
  const stmtPager = usePager('accountStmt');
  const ready = useDeferredReady();

  const needle = q.trim();

  const { from, to } = useMemo<{ from: string | null; to: string | null }>(() => {
    const T_ = today();
    const y = Number(T_.slice(0, 4));
    const m = Number(T_.slice(5, 7));
    const pad = (n: number) => String(n).padStart(2, '0');
    const endOfMonth = (yy: number, mm: number) => `${yy}-${pad(mm)}-${pad(new Date(yy, mm, 0).getDate())}`;
    if (period === 'month') return { from: `${y}-${pad(m)}-01`, to: endOfMonth(y, m) };
    if (period === 'quarter') {
      const qs = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: `${y}-${pad(qs)}-01`, to: endOfMonth(y, qs + 2) };
    }
    if (period === 'year') return { from: `${y}-01-01`, to: `${y}-12-31` };
    return { from: null, to: null };
  }, [period]);

  useEffect(() => { stmtPager.reset(); /* الحساب أو الفترة تغيّرا · نعود للصفحة الأولى */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stmt?.code, from, to]);

  // الأساس الثقيل: كل الحسابات بأرصدتها وحركة الفترة · ثلاثة استعلامات تجميعية فقط
  const systemCodes = useMemo(() => new Set(db.all<{ code: string }>(`SELECT code FROM accounts WHERE is_system = 1`).map((r) => r.code)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const base = useMemo<AccountItem[]>(() => {
    if (!ready) return EMPTY_ACCOUNTS;
    const balances = allAccountBalances(db);
    const moves = allAccountMovements(db, from, to);
    return allAccounts(db).map((a) => {
      const m = moves.get(a.code) ?? { debit: 0, credit: 0 };
      return {
        code: a.code, name: a.name, type: a.type, grp: a.grp,
        opening: Number(a.opening_halalas || 0),
        balance: balances.get(a.code) ?? 0,
        debit: m.debit, credit: m.credit,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ready, from, to]);

  // الترشيح فقط · البحث في SQL على جدول الحسابات لقائمة الرموز
  const rows = useMemo(() => {
    let list = base;
    if (needle) {
      const codes = new Set(
        db.all<{ code: string }>(
          `SELECT code FROM accounts WHERE deleted_at IS NULL
             AND (name LIKE '%'||?||'%' OR code LIKE '%'||?||'%' OR type LIKE '%'||?||'%' OR COALESCE(grp,'') LIKE '%'||?||'%')`,
          [needle, needle, needle, needle]
        ).map((r) => r.code)
      );
      list = list.filter((a) => codes.has(a.code));
    }
    if (filter !== 'all') list = list.filter((a) => a.type === filter);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, needle, filter]);

  // كشف الحساب · صفحة واحدة بترتيب ثابت + رصيد جارٍ يبدأ من مجموع ما قبل الصفحة
  const { stmtSql, stmtParams } = useMemo(() => {
    const conds = [`l.account_code = ?`, `e.status = 'مرحّل'`, `e.deleted_at IS NULL`];
    const params: string[] = [stmt ? stmt.code : ''];
    if (from) { conds.push(`e.date >= ?`); params.push(from); }
    if (to) { conds.push(`e.date <= ?`); params.push(to); }
    return { stmtSql: conds.join(' AND '), stmtParams: params };
  }, [stmt, from, to]);

  const stmtRows = useMemo(() => {
    if (!ready || !stmt) return EMPTY_STMT;
    return db.all<StmtLine>(
      `SELECT e.id AS entry_id, e.date, e.memo, e.src_type, e.src_id,
              l.debit_halalas AS d, l.credit_halalas AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE ${stmtSql} ORDER BY e.date, e.created_at, l.id LIMIT ? OFFSET ?`,
      [...stmtParams, stmtPager.limit, stmtPager.offset]
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, stmtSql, stmtParams, stmtPager.limit, stmtPager.offset, ready, stmt]);

  const stmtTotal = useMemo(() => {
    if (!ready || !stmt) return 0;
    return db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE ${stmtSql}`, stmtParams
    )?.n ?? 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, stmtSql, stmtParams, ready, stmt]);

  const stmtCarry = useMemo(() => {
    if (!ready || !stmt || stmtPager.offset === 0) return 0;
    return Number(db.get<{ s: number }>(
      `SELECT COALESCE(SUM(d - c),0) AS s FROM (
         SELECT l.debit_halalas AS d, l.credit_halalas AS c
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE ${stmtSql} ORDER BY e.date, e.created_at, l.id LIMIT ?)`,
      [...stmtParams, stmtPager.offset]
    )?.s ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, stmtSql, stmtParams, stmtPager.offset, ready, stmt]);

  // الضغط على سطر الكشف يفتح ورقة تفاصيل قيده · ومنها يُفتح المستند المصدر
  const openEntry = useCallback((entryId: string) => setStmtEntry(entryId), []);

  const openNew = () => { setEditingCode(null); setName(''); setCode(''); setType('أصل'); setOpening(''); setFormOpen(true); };
  const openEdit = useCallback((accCode: string) => {
    const a = base.find((x) => x.code === accCode);
    if (!a) return;
    setEditingCode(a.code); setName(a.name); setCode(a.code); setType(a.type);
    setOpening(fmt(a.opening).replace(/,/g, '')); setFormOpen(true);
  }, [base]);
  const save = () => {
    if (!name.trim() || !code.trim()) { toast('الرجاء تعبئة اسم ورمز الحساب'); return; }
    try {
      // الحساب النظامي لا يتغيّر نوعه ولا يُحذف (دراسة القائم) · الخدمة تحرسه
      saveAccount(db, { code, name, type, openingHalalas: toHalalas(opening) }, editingCode ?? undefined);
      setFormOpen(false); bump();
      toast(editingCode ? 'تم تحديث الحساب' : `تمت إضافة الحساب "${name.trim()}" بنجاح`);
    } catch (e) { reportFailure({ title: 'تعذّر الحفظ', e }); }
  };
  const doDelete = useCallback((accCode: string) => {
    const a = base.find((x) => x.code === accCode);
    if (!a) return;
    const why = deleteBlocker(db, a.code);
    if (why) { toast(why); return; }
    dialog({
      title: 'حذف الحساب',
      body: `حذف الحساب "${a.name}"؟`,
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'حذف', variant: 'danger',
          onPress: () => {
            try { deleteAccount(db, a.code); bump(); toast(`تم حذف الحساب "${a.name}" · يمكن استعادته من الإعدادات`); }
            catch (e) { reportFailure({ title: 'تعذّر الحذف', e }); }
          },
        },
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, db, bump, toast, dialog]);

  const openStmt = useCallback((accCode: string, accName: string) => setStmt({ code: accCode, name: accName }), []);

  // تسطيح المجموعات: رأس المجموعة عنصر ثم حساباتها · البنية والأرصدة كما هي
  const listData = useMemo<AccListItem[]>(() => {
    const out: AccListItem[] = [];
    for (const g of GROUPS) {
      const groupRows = rows.filter((a) => a.type === g);
      if (!groupRows.length) continue;
      out.push({ kind: 'header', key: 'h:' + g, g, totalBal: groupRows.reduce((s, a) => s + a.balance, 0) });
      groupRows.forEach((a, i) => out.push({ kind: 'row', key: a.code, a, last: i === groupRows.length - 1 }));
    }
    return out;
  }, [rows]);

  const keyExtractor = useCallback((item: AccListItem) => item.key, []);
  const renderItem: ListRenderItem<AccListItem> = useCallback(({ item }) => {
    if (item.kind === 'header') {
      return (
        <View style={{
          backgroundColor: C.card, borderColor: C.line, borderWidth: 1, borderBottomWidth: 0,
          borderTopLeftRadius: RADIUS, borderTopRightRadius: RADIUS, paddingHorizontal: 14, paddingTop: 8,
        }}>
          <Row style={{ justifyContent: 'space-between', paddingVertical: 6, backgroundColor: '#FAF9F5', borderRadius: 8, paddingHorizontal: 8 }}>
            <T size={13.5} bold color={C.ink} numberOfLines={1}>{GROUP_LABEL[item.g]}</T>
            <Num size={13} bold>{fmt(item.totalBal)}</Num>
          </Row>
        </View>
      );
    }
    const tag = TYPE_TAG_STYLES[item.a.type];
    return (
      <View style={[
        { backgroundColor: C.card, borderColor: C.line, borderLeftWidth: 1, borderRightWidth: 1, paddingHorizontal: 14 },
        item.last && {
          borderBottomWidth: 1, borderBottomLeftRadius: RADIUS, borderBottomRightRadius: RADIUS,
          paddingBottom: 8, marginBottom: 11,
        },
      ]}>
        <AccountRowItem
          code={item.a.code} name={item.a.name} type={item.a.type}
          opening={item.a.opening} debit={item.a.debit} credit={item.a.credit} balance={item.a.balance}
          tagBg={tag.bg} tagFg={tag.fg} canManage={perm.manage} isSystem={systemCodes.has(item.a.code)}
          onOpen={openStmt} onEdit={openEdit} onDelete={doDelete} />
      </View>
    );
  }, [openStmt, openEdit, doDelete, perm.manage, systemCodes]);

  let running = stmtCarry;

  const listHeader = (
    <>
      <View style={{ marginBottom: 8 }}><SearchBox value={q} onChange={setQ} /></View>
      <ChipGroup
        options={[['all', 'الكل'], ['أصل', 'أصول'], ['خصم', 'خصوم'], ['حقوق ملكية', 'حقوق ملكية'], ['إيراد', 'إيرادات'], ['مصروف', 'مصروفات']]}
        value={filter} onChange={setFilter} />
      <View style={{ marginTop: 8 }} />
      <ChipGroup
        options={[['month', 'هذا الشهر'], ['quarter', 'هذا الربع'], ['year', 'هذه السنة'], ['all', 'الكل']]}
        value={period} onChange={setPeriod} />
      <View style={{ marginTop: 8 }} />
    </>
  );

  return (
    <Screen title="دليل الحسابات" scroll={false}
      actions={perm.add ? <BtnPrimary small title="+ حساب جديد" onPress={openNew} /> : null}>
      {!ready ? (
        /* هيكل فقط · الرأس فيه حقل بحث أصلي وتركيبه يؤخر أول إيداع للشاشة */
        <Skeleton rows={8} />
      ) : (
        <FlatList
          data={listData}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          initialNumToRender={8}
          maxToRenderPerBatch={10}
          windowSize={7}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 12 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={<Card><EmptyState>لا توجد حسابات مطابقة لبحثك</EmptyState></Card>}
        />
      )}

      <Sheet visible={formOpen} onClose={() => setFormOpen(false)}
        title={editingCode ? 'تعديل الحساب' : 'حساب جديد'}
        footer={
          <>
            <View style={{ flex: 1 }}><BtnPrimary title={editingCode ? 'حفظ التعديل' : 'إضافة الحساب'} onPress={save} /></View>
          </>
        }>
        <Field label="اسم الحساب" value={name} onChange={setName} />
        <Row>
          <View style={{ flex: 1 }}>
            <Field label="رمز الحساب" value={code} onChange={setCode} keyboard="numeric" ltr disabled={!!editingCode} />
          </View>
          <View style={{ flex: 1 }}>
            {/* نوع الحساب النظامي ثابت (دراسة القائم) */}
            {editingCode && systemCodes.has(editingCode)
              ? <Field label="النوع" value={type} onChange={() => {}} disabled />
              : <SelectField label="النوع" value={type} options={GROUPS.map((g) => ({ value: g, label: g }))} onPick={setType} />}
          </View>
        </Row>
        <Field label="الرصيد الافتتاحي" value={opening} onChange={setOpening} keyboard="numeric" ltr />
      </Sheet>

      {/* كشف حركة الحساب · كل سطر يفتح ورقة تفاصيل قيده */}
      {stmt && (
        <Sheet visible onClose={() => setStmt(null)} title={stmt.code + ' · ' + stmt.name} tall>
          {stmtRows.length ? stmtRows.map((l, i) => {
            running += Number(l.d) - Number(l.c);
            const bal = running;
            return (
              <Pressable key={l.entry_id + ':' + i} onPress={() => openEntry(l.entry_id)}>
                <View style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <T size={12} numberOfLines={2} style={{ flex: 1, minWidth: 90 }}>{l.memo}</T>
                    <Num size={11.5} bold color={Number(l.d) ? C.emerald : C.rose}>
                      {Number(l.d) ? fmt(Number(l.d)) : fmt(Number(l.c))}
                    </Num>
                  </Row>
                  <Row style={{ justifyContent: 'space-between', marginTop: 2 }}>
                    <Num size={10.5} color={C.muted}>{dfmt(l.date)}</Num>
                    <Num size={10.5} color={C.muted}>الجاري: {fmt(bal)}</Num>
                  </Row>
                  <T size={10} color={C.muted} numberOfLines={1} style={{ marginTop: 2 }}>{srcTypeLabel(l.src_type)}</T>
                </View>
              </Pressable>
            );
          }) : <EmptyState>لا حركة على الحساب خلال المدة</EmptyState>}
          <Pager pager={stmtPager} total={stmtTotal} />
          <View style={{ height: 10 }} />
        </Sheet>
      )}

      {/* ورقة تفاصيل القيد · فوق الكشف · وفتح المستند المصدر يغلقهما معاً */}
      {stmtEntry ? (
        <EntrySheet entryId={stmtEntry} onClose={() => setStmtEntry(null)} onLeave={() => setStmt(null)} />
      ) : null}
    </Screen>
  );
}

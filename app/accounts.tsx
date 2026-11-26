/** دليل الحسابات · مجموعات الأنواع الخمسة بأرصدتها وحركة الفترة وكشف لكل حساب */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '../src/i18n';
import { saveAccount, deleteAccount, deleteBlocker, openingDifference } from '../src/domain/accounting/chart';
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
import { allAccounts, accountPeriodBalances, accountStatement, type AccountStatement } from '../src/domain/accounting/ledger';
import { fmt, toHalalas } from '../src/domain/money';
import { today, dfmt } from '../src/domain/dates';
import { logAudit } from '../src/domain/audit';
import { reportFailure } from '../src/ui/failureDialog';
import { usePerm, useAccess } from '../src/ui/access';

const GROUPS = ['أصل', 'خصم', 'حقوق ملكية', 'إيراد', 'مصروف'];
const GROUP_LABEL: Record<string, string> = {
  'أصل': 'الأصول', 'خصم': 'الخصوم', 'حقوق ملكية': 'حقوق الملكية', 'إيراد': 'الإيرادات', 'مصروف': 'المصروفات',
};

type PeriodKey = 'month' | 'quarter' | 'year' | 'all';

interface AccountItem {
  code: string; name: string; type: string; grp: string | null;
  opening: number; balance: number; debit: number; credit: number;
  /** الافتتاحي المزروع في الدليل · يعدّله النموذج (opening معه افتتاحيات البنوك في 1100 و3300 · المراجعة الشاملة 2026-11-13 · A2.4) */
  seeded: number;
  /** افتتاحيات البنوك في 1100 و3300 (A2.4) · تلميح النموذج */
  banks: number;
}

const EMPTY_ACCOUNTS: AccountItem[] = [];
const EMPTY_STMT: AccountStatement = { opening: 0, carried: 0, closing: 0, total: 0, lines: [] };

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
  // الرصيد الافتتاحي يضعه المالك وحده (القاعدة ٩٩ · المدقق الخارجي M٧): جهاز المالك يرفض تعديل العضو له
  const owner = useAccess().owner;
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

  // الأساس الثقيل: كل الحسابات برصيد أول الفترة وحركتها ورصيد آخرها باتجاه طبيعتها، من ميزان المراجعة (A2.7) · استعلامان تجميعيان
  const systemCodes = useMemo(() => new Set(db.all<{ code: string }>(`SELECT code FROM accounts WHERE is_system = 1`).map((r) => r.code)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const base = useMemo<AccountItem[]>(() => {
    if (!ready) return EMPTY_ACCOUNTS;
    const pb = accountPeriodBalances(db, from, to);
    return allAccounts(db).map((a) => {
      const m = pb.get(a.code) ?? { opening: Number(a.opening_halalas || 0), debit: 0, credit: 0, closing: Number(a.opening_halalas || 0) };
      return {
        code: a.code, name: a.name, type: a.type, grp: a.grp,
        opening: m.opening,
        seeded: Number(a.seeded_halalas || 0),
        banks: Math.abs(Number(a.opening_halalas || 0) - Number(a.seeded_halalas || 0)),
        balance: m.closing,
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

  // كشف الحساب · صفحة واحدة بترتيب ثابت + رصيد جارٍ يبدأ من «رصيد منقول» (الافتتاحي + ما قبل الفترة + ما قبل الصفحة) ويُجمع
  // باتجاه طبيعة الحساب، فآخر «جاري» في الصفحة الأخيرة يساوي «الختامي» في صف الحساب (المراجعة الشاملة 2026-11-13 · A2.7)
  const stmtData = useMemo(() => {
    if (!ready || !stmt) return EMPTY_STMT;
    return accountStatement(db, stmt.code, from, to, { limit: stmtPager.limit, offset: stmtPager.offset });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, stmt, from, to, stmtPager.limit, stmtPager.offset, ready]);

  // الضغط على سطر الكشف يفتح ورقة تفاصيل قيده · ومنها يُفتح المستند المصدر
  const openEntry = useCallback((entryId: string) => setStmtEntry(entryId), []);

  const openNew = () => { setEditingCode(null); setName(''); setCode(''); setType('أصل'); setOpening(''); setFormOpen(true); };
  const openEdit = useCallback((accCode: string) => {
    const a = base.find((x) => x.code === accCode);
    if (!a) return;
    setEditingCode(a.code); setName(a.name); setCode(a.code); setType(a.type);
    setOpening(fmt(a.seeded).replace(/,/g, '')); setFormOpen(true);
  }, [base]);
  const editingBanks = useMemo(() => {
    const a = editingCode ? base.find((x) => x.code === editingCode) : undefined;
    return a ? a.banks : 0;
  }, [base, editingCode]);
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

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const openingDiff = useMemo(() => openingDifference(db), [db, version]);
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
      {/* الأرصدة الافتتاحية تُحفظ ويظهر فرقها (مراجعة التثبيت #60 · قرار المالك) */}
      {openingDiff !== 0 ? (
        <Card><T size={12} color={C.rose}>{t('accounts.openingDiff', { amount: fmt(Math.abs(openingDiff)), side: t(openingDiff > 0 ? 'accounts.openingDebit' : 'accounts.openingCredit') })}</T></Card>
      ) : null}
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
        <Field label="الرصيد الافتتاحي" value={opening} onChange={setOpening} keyboard="numeric" ltr disabled={!owner} />
        {/* افتتاحيات البنوك تُضاف إلى 1100 و3300 ولا تُكتب هنا، فلا يُعاد إدخالها فتتضاعف (المراجعة الشاملة 2026-11-13 · A2.4) */}
        {editingBanks ? <T size={11} color={C.muted}>{t('accounts.bankOpeningHint', { amount: fmt(editingBanks) })}</T> : null}
      </Sheet>

      {/* كشف حركة الحساب · كل سطر يفتح ورقة تفاصيل قيده */}
      {stmt && (
        <Sheet visible onClose={() => setStmt(null)} title={stmt.code + ' · ' + stmt.name} tall>
          {stmtData.total ? (
            <Row style={{ justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
              <T size={12} med>{t(stmtPager.offset ? 'accounts.stmtCarriedPage' : 'accounts.stmtCarried')}</T>
              <Num size={11.5} bold>{fmt(stmtData.carried)}</Num>
            </Row>
          ) : null}
          {stmtData.lines.length ? stmtData.lines.map((l, i) => {
            const bal = l.running;
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
          <Row style={{ justifyContent: 'space-between', paddingVertical: 7 }}>
            <T size={12} med>{t('accounts.stmtClosing')}</T>
            <Num size={11.5} bold>{fmt(stmtData.closing)}</Num>
          </Row>
          <Pager pager={stmtPager} total={stmtData.total} />
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

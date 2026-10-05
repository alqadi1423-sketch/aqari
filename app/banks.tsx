/**
 * الحسابات البنكية والمحفظة النقدية · الأرصدة كلها مشتقة.
 * الضغط على أي حساب يفتح بياناته وكل عملياته بأنواعها، والمحفظة تُحصي الكاش الحاضر.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { CashShortNote } from '../src/ui/CashGate';
import { cashShortfall } from '../src/domain/cashGuard';
import { View, Pressable, FlatList, type ListRenderItem } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen, BackButton } from '../src/ui/Screen';
import {
  Card, T, Num, Money, EmptyState, Row, SearchBox, BtnPrimary, BtnGhost, BtnIcon, Field, Badge, KpiCard,
} from '../src/ui/components';
import { Sheet, SelectField } from '../src/ui/Sheet';
import { DateField } from '../src/ui/DateField';
import { ActionMenuButton } from '../src/ui/ActionMenu';
import { CollapsibleSection } from '../src/ui/Collapsible';
import { FilterBar, FilterSheet, useFilterSheet, type ActiveChip } from '../src/ui/FilterSheet';
import { useDialog } from '../src/ui/AppDialog';
import { Icon, type IconName } from '../src/ui/icons';
import {
  depositCashToBank, withdrawCashFromBank, transferBetweenBanks,
  pettyCashExpense, ownerCashIn, ownerCashOut,
} from '../src/domain/cashOps';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { C, TYPE } from '../src/ui/theme';
import { bankBalance, walletCashBalance } from '../src/domain/accounting/ledger';
import { uid } from '../src/domain/ids';
import { fmt, toHalalas } from '../src/domain/money';
import { today, dfmt } from '../src/domain/dates';
import { logAudit } from '../src/domain/audit';
import { reportFailure } from '../src/ui/failureDialog';
import { useAccess, usePerm } from '../src/ui/access';
import { routeAllowed } from '../src/domain/access/routes';

interface BankRow {
  id: string; name: string; iban: string; opening_halalas: number; opening_date: string | null;
  archived: number; linked_n: number; balance: number;
}

/** ارتباط حيّ بالحساب · حركة بنكية أو سطر دفع · به يُقرَّر عرض زر الحذف قبل الضغط */
const LINKED_SQL = `(EXISTS(SELECT 1 FROM bank_tx WHERE bank_id = b.id AND deleted_at IS NULL)
  OR EXISTS(SELECT 1 FROM payment_lines WHERE bank_id = b.id))`;

const STATE_OPTIONS = [{ value: 'active', label: 'الحسابات النشطة' }, { value: 'archived', label: 'الأرشيف' }];
const BALANCE_LABELS: Record<string, string> = { pos: 'رصيد موجب', neg: 'رصيد سالب', zero: 'رصيد صفر' };
const BALANCE_OPTIONS = [{ value: '', label: 'كل الأرصدة' },
  ...Object.entries(BALANCE_LABELS).map(([value, label]) => ({ value, label }))];

export default function Banks() {
  const { db, version, bump } = useApp();
  const perm = usePerm('banks');
  const toast = useToast();
  const dialog = useDialog();
  const fsheet = useFilterSheet();
  const [q, setQ] = useState('');
  const [fState, setFState] = useState('active');
  const [fBalance, setFBalance] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [iban, setIban] = useState('');
  const [opening, setOpening] = useState('');
  const [openingDate, setOpeningDate] = useState(today());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const wallet = useMemo(() => walletCashBalance(db),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);

  const scope = useMemo<BankRow[]>(() => db.all<Omit<BankRow, 'balance'>>(
    `SELECT b.id, b.name, b.iban, b.opening_halalas, b.opening_date, b.archived, ${LINKED_SQL} AS linked_n
     FROM banks b WHERE b.deleted_at IS NULL AND b.archived = ? ORDER BY b.created_at`,
    [fState === 'archived' ? 1 : 0]
  ).map((b) => ({ ...b, balance: bankBalance(db, b.id) })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, version, fState]);

  const rows = useMemo<BankRow[]>(() => {
    const needle = q.trim().toLowerCase();
    return scope.filter((b) => {
      if (needle && ![b.name, b.iban].some((v) => v && v.toLowerCase().includes(needle))) return false;
      if (fBalance === 'pos' && !(b.balance > 0)) return false;
      if (fBalance === 'neg' && !(b.balance < 0)) return false;
      if (fBalance === 'zero' && b.balance !== 0) return false;
      return true;
    });
  }, [scope, q, fBalance]);

  const openNew = () => { setEditingId(null); setName(''); setIban(''); setOpening(''); setOpeningDate(today()); setFormOpen(true); };
  const openEdit = (b: Pick<BankRow, 'id' | 'name' | 'iban' | 'opening_halalas' | 'opening_date'>) => {
    setEditingId(b.id); setName(b.name); setIban(b.iban);
    setOpening(fmt(Number(b.opening_halalas)).replace(/,/g, ''));
    setOpeningDate(b.opening_date ?? today()); setFormOpen(true);
  };
  const openEditById = (id: string) => {
    const b = db.get<Pick<BankRow, 'id' | 'name' | 'iban' | 'opening_halalas' | 'opening_date'>>(
      `SELECT id, name, iban, opening_halalas, opening_date FROM banks WHERE id = ?`, [id]);
    if (b) openEdit(b);
  };
  const save = () => {
    if (!name.trim()) { toast('الرجاء إدخال اسم الحساب'); return; }
    db.transaction(() => {
      if (editingId) {
        db.run(`UPDATE banks SET name=?, iban=?, opening_halalas=?, opening_date=? WHERE id=?`, [
          name.trim(), iban.trim(), toHalalas(opening), openingDate, editingId,
        ]);
      } else {
        db.run(`INSERT INTO banks (id, name, iban, opening_halalas, opening_date, created_at) VALUES (?,?,?,?,?,?)`, [
          uid(), name.trim(), iban.trim(), toHalalas(opening), openingDate, new Date().toISOString(),
        ]);
      }
      logAudit(db, 'البنوك', editingId ? 'update' : 'create', 'حساب بنكي', name.trim());
    });
    setFormOpen(false); bump();
    toast(editingId ? 'تم تحديث الحساب البنكي' : `تمت إضافة "${name.trim()}"`);
  };

  const onDelete = (b: BankRow) => {
    // لا يصل هنا إلا حساب بلا حركة · ذو الحركات لا يُعرض له زر حذف أصلاً
    dialog({
      title: 'حذف الحساب البنكي',
      body: `حذف "${b.name}"؟`,
      tone: 'danger',
      actions: [
        { label: 'تراجع', variant: 'ghost' },
        {
          label: 'حذف', variant: 'danger',
          onPress: () => {
            db.transaction(() => db.run(`UPDATE banks SET deleted_at=? WHERE id=?`, [new Date().toISOString(), b.id]));
            bump(); toast('تم الحذف · يمكن استعادته من الإعدادات');
          },
        },
      ],
    });
  };

  const keyExtractor = useCallback((item: BankRow) => item.id, []);
  const renderItem: ListRenderItem<BankRow> = ({ item: b }) => (
    <Card style={{ paddingVertical: 10 }}>
      {/* زر ⋮ أعلى البطاقة يساراً بمحاذاة العنوان ·
          والحساب ذو الحركات لا يُعرض له «حذف» · الأرشفة بديلها */}
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={() => setDetailId(b.id)} style={{ flex: 1 }}>
          <Row gap={8}>
            <Icon name="bank" size={17} color={C.emerald} />
            <T size={TYPE.sectionTitle} bold>{b.name}</T>
            {Number(b.archived) ? <Badge kind="draft" label="مؤرشف" /> : null}
          </Row>
        </Pressable>
        <Row gap={8}>
          <Money halalas={b.balance} size={TYPE.number} bold color={b.balance >= 0 ? C.emerald : C.rose} />
          <ActionMenuButton title={b.name} actions={[
            { icon: 'eye', label: 'البيانات وكل العمليات', onPress: () => setDetailId(b.id) },
            perm.manage ? { icon: 'edit', label: 'تعديل', onPress: () => openEdit(b) } : null,
            !perm.manage ? null : {
              icon: Number(b.archived) ? 'undo' : 'archive',
              label: Number(b.archived) ? 'إلغاء الأرشفة' : 'أرشفة',
              onPress: () => {
                db.transaction(() => db.run(`UPDATE banks SET archived=? WHERE id=?`, [Number(b.archived) ? 0 : 1, b.id]));
                bump(); toast(Number(b.archived) ? 'أُلغيت الأرشفة' : 'أُرشف الحساب · حركاته وأرصدته باقية كما هي');
              },
            },
            Number(b.linked_n) || !perm.manage ? null : { icon: 'trash' as const, label: 'حذف', danger: true, onPress: () => onDelete(b) },
          ]} />
        </Row>
      </Row>
      <Pressable onPress={() => setDetailId(b.id)}>
        <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
          {b.iban ? <Num size={TYPE.caption} color={C.muted}>{b.iban}</Num> : null}
          <T size={TYPE.caption} color={C.muted}>
            {['الافتتاحي: ' + fmt(Number(b.opening_halalas)), b.opening_date ? dfmt(b.opening_date) : ''].filter(Boolean).join(' · ')}
          </T>
        </Row>
      </Pressable>
    </Card>
  );

  const clearFilters = useCallback(() => { setQ(''); setFState('active'); setFBalance(''); }, []);
  const chips: ActiveChip[] = [
    ...(fState === 'archived' ? [{ key: 'state', label: 'الأرشيف', onClear: () => setFState('active') }] : []),
    ...(fBalance ? [{ key: 'balance', label: BALANCE_LABELS[fBalance] ?? fBalance, onClear: () => setFBalance('') }] : []),
  ];

  return (
    <Screen title="الحسابات البنكية" icon="bank" scroll={false}
      actions={perm.add ? <BtnPrimary small title="+ حساب بنكي" onPress={openNew} /> : undefined}>
      <FlatList
        data={rows}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={5}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 12 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        ListHeaderComponent={
          <>
            <FilterBar chips={chips} onOpen={fsheet.show} onClearAll={clearFilters}
              resultCount={rows.length} total={scope.length} filtered={rows.length} itemName="حساباً"
              search={<SearchBox value={q} onChange={setQ} />} />
            {/* المحفظة النقدية · الكاش الحاضر = النقدية المشتقة - ما استقر في البنوك */}
            <Pressable onPress={() => setWalletOpen(true)}>
              <Card style={{ paddingVertical: 12, borderColor: C.gold, borderWidth: 1 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Row gap={8}>
                    <Icon name="cash" size={19} color={C.gold} />
                    <T size={TYPE.sectionTitle} bold>المحفظة النقدية</T>
                  </Row>
                  <Money halalas={wallet} size={TYPE.number} bold color={wallet >= 0 ? C.emerald : C.rose} />
                </Row>
              </Card>
            </Pressable>
          </>
        }
        ListEmptyComponent={<Card><EmptyState>لا توجد حسابات بنكية مطابقة</EmptyState></Card>}
      />

      <FilterSheet open={fsheet.open} onClose={fsheet.hide} onClearAll={clearFilters} resultCount={rows.length}>
        <SelectField label="الحالة" value={fState} options={STATE_OPTIONS} onPick={setFState} />
        <SelectField label="الرصيد" value={fBalance} options={BALANCE_OPTIONS} onPick={setFBalance} />
      </FilterSheet>

      <Sheet visible={formOpen} onClose={() => setFormOpen(false)}
        title={editingId ? 'تعديل الحساب البنكي' : 'حساب بنكي جديد'}
        footer={
          <>
            <View style={{ flex: 1 }}><BtnPrimary title={editingId ? 'حفظ التعديل' : 'إضافة الحساب'} onPress={save} /></View>
          </>
        }>
        <Field label="اسم الحساب" value={name} onChange={setName} />
        <Field label="رقم الآيبان" value={iban} onChange={setIban} ltr placeholder="SA0000000000000000000000" />
        <Row>
          <View style={{ flex: 1 }}><Field label="الرصيد الافتتاحي" value={opening} onChange={setOpening} keyboard="numeric" ltr /></View>
          <View style={{ flex: 1 }}><DateField label="تاريخ الافتتاح" value={openingDate} onChange={setOpeningDate} /></View>
        </Row>
      </Sheet>

      {detailId && (
        <BankDetailSheet bankId={detailId} onClose={() => setDetailId(null)}
          onEdit={perm.manage ? () => { const id = detailId; setDetailId(null); openEditById(id); } : undefined} />
      )}
      {walletOpen && <WalletSheet onClose={() => setWalletOpen(false)} />}
    </Screen>
  );
}

/* ═══════════ صفحة البنك · بياناته ورصيده المشتق ثم قسماه المطويان ═══════════ */
/**
 * القسمان «الوارد» و«الصادر»: عدّاد كل قسم استعلام COUNT خفيف، والفارغ لا يُعرض،
 * والمملوء مطويّ لا تُجلب سطوره إلا عند فتحه، وداخله تقسيم صفحات ·
 * وكل حركة تفتح مستندها المصدر، ومن لا مستند له يُفتح قيده داخل الورقة.
 */
function BankDetailSheet({ bankId, onClose, onEdit }: { bankId: string; onClose: () => void; onEdit?: () => void }) {
  const { db, version } = useApp();
  const router = useRouter();
  const toast = useToast();
  const access = useAccess();
  const seesLedger = usePerm('ledger').view;
  const [entryFor, setEntryFor] = useState<string | null>(null);
  const b = useMemo(() => db.get<{ name: string; iban: string; opening_halalas: number; opening_date: string | null }>(
    `SELECT name, iban, opening_halalas, opening_date FROM banks WHERE id = ?`, [bankId]
  ),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, version, bankId]);
  const sums = useMemo(() => db.get<{ inflow: number; outflow: number; in_n: number; out_n: number }>(
    `SELECT COALESCE(SUM(CASE WHEN amount_halalas > 0 THEN amount_halalas ELSE 0 END), 0) AS inflow,
            COALESCE(SUM(CASE WHEN amount_halalas < 0 THEN amount_halalas ELSE 0 END), 0) AS outflow,
            COALESCE(SUM(CASE WHEN amount_halalas > 0 THEN 1 ELSE 0 END), 0) AS in_n,
            COALESCE(SUM(CASE WHEN amount_halalas < 0 THEN 1 ELSE 0 END), 0) AS out_n
     FROM bank_tx WHERE bank_id = ? AND deleted_at IS NULL`, [bankId]
  ),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, version, bankId]);

  // سطور القيد داخل الورقة · للحركة التي لا مستند مصدراً لقيدها
  const entry = useMemo(() => {
    if (!entryFor) return null;
    const e = db.get<{ id: string; no: string; date: string; memo: string }>(
      `SELECT id, no, date, memo FROM journal_entries WHERE id = ?`, [entryFor]);
    if (!e) return null;
    const lines = db.all<{ account_code: string; name: string; debit_halalas: number; credit_halalas: number }>(
      `SELECT l.account_code, a.name, l.debit_halalas, l.credit_halalas
       FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE l.entry_id = ?`, [entryFor]);
    return { ...e, lines };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, entryFor]);

  // نسج على نمط openSource في دليل الحسابات: استعلام القيد بمصدره ثم التوجيه لمستنده ·
  // المستند يُفتح إن سُمح مساره، وإلا فالقيد داخل الورقة لمن له الدفتر، وإلا فلا وجهة (null)
  const txDest = useCallback((journalNo: string): (() => void) | 'nojournal' | null => {
    const e = journalNo ? db.get<{ id: string; src_type: string | null; src_id: string | null }>(
      `SELECT id, src_type, src_id FROM journal_entries WHERE no = ? AND deleted_at IS NULL`, [journalNo]
    ) : undefined;
    if (!e) return 'nojournal';
    const srcType = e.src_type;
    const srcId = e.src_id;
    if (srcType && srcId) {
      if (['purchase', 'purchase_pay', 'vat_refund'].includes(srcType) && routeAllowed(access, '/purchases')) {
        return () => { onClose(); router.push(`/purchases?detail=${srcId}`); };
      }
      if (srcType === 'invoice' && routeAllowed(access, '/invoices')) {
        return () => { onClose(); router.push(`/invoices?detail=${srcId}`); };
      }
      if (srcType === 'rent' && routeAllowed(access, '/contracts')) {
        const cRow = db.get<{ contract_id: string }>(`SELECT contract_id FROM contract_payments WHERE id = ?`, [srcId]);
        if (cRow) return () => { onClose(); router.push(`/contracts?detail=${cRow.contract_id}`); };
      }
      if (['contract_deposit', 'deposit_refund', 'deposit_carry', 'deposit_deduct', 'key_money'].includes(srcType)
        && routeAllowed(access, '/contracts')) {
        const cRow = db.get<{ id: string }>(`SELECT id FROM contracts WHERE id = ?`, [srcId]);
        if (cRow) return () => { onClose(); router.push(`/contracts?detail=${srcId}`); };
      }
      if (['claim', 'claim_collect'].includes(srcType) && routeAllowed(access, '/claims')) {
        return () => { onClose(); router.push(`/claims?detail=${srcId}`); };
      }
    }
    return seesLedger ? () => setEntryFor((cur) => (cur === e.id ? null : e.id)) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, router, onClose, access, seesLedger]);
  const openTx = useCallback((journalNo: string) => {
    const d = txDest(journalNo);
    if (d === 'nojournal') toast('حركة بلا قيد مرتبط');
    else if (d) d();
  }, [txDest, toast]);

  const txRow = useCallback((t: { id: string; date: string; descr: string; amount_halalas: number; source: string; journal_no: string }) => (
    <View key={t.id}>
      {/* من له الدفتر يفتح كل حركة · وغيره ما سُمح مسار مستندها وحده */}
      <Pressable disabled={!seesLedger && !txDest(t.journal_no)} onPress={() => openTx(t.journal_no)}>
        <View style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={TYPE.cardTitle} bold style={{ flex: 1 }}>{t.descr}</T>
            <Money halalas={Number(t.amount_halalas)} size={TYPE.number} bold
              color={Number(t.amount_halalas) >= 0 ? C.emerald : C.rose} />
          </Row>
          <Row style={{ justifyContent: 'space-between', marginTop: 3 }}>
            {t.source ? <T size={TYPE.caption} color={C.muted}>{t.source}</T> : <View />}
            <Num size={TYPE.caption} color={C.muted}>{dfmt(t.date)}{t.journal_no ? ' · ' + t.journal_no : ''}</Num>
          </Row>
        </View>
      </Pressable>
      {/* سطور القيد تحت الحركة المضغوطة مباشرةً · لا يفصل بينهما عنصر */}
      {entry && entry.no === t.journal_no ? (
        <View style={{ backgroundColor: C.paper, borderRadius: 10, padding: 12, marginTop: 4, marginBottom: 8, borderWidth: 1, borderColor: C.line }}>
          <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <T size={TYPE.cardTitle} bold>{entry.no} · {dfmt(entry.date)}</T>
            <BtnIcon icon="x" accessibilityLabel="إغلاق القيد" onPress={() => setEntryFor(null)} />
          </Row>
          <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 6 }}>{entry.memo}</T>
          {entry.lines.map((l, li) => (
            <Row key={li} style={{ justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
              <T size={TYPE.caption} style={{ flex: 1 }}>{l.account_code} · {l.name}</T>
              <Num size={TYPE.caption}>{Number(l.debit_halalas) ? 'مدين ' + fmt(Number(l.debit_halalas)) : 'دائن ' + fmt(Number(l.credit_halalas))}</Num>
            </Row>
          ))}
        </View>
      ) : null}
    </View>
  ), [openTx, entry, seesLedger, txDest]);

  if (!b) return null;
  const inflow = Number(sums?.inflow ?? 0);
  const outflow = Number(sums?.outflow ?? 0);
  const balance = Number(b.opening_halalas) + inflow + outflow;
  const txSql = (sign: '>' | '<') =>
    `SELECT id, date, descr, amount_halalas, source, journal_no FROM bank_tx
     WHERE bank_id = ? AND deleted_at IS NULL AND amount_halalas ${sign} 0
     ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`;
  return (
    <Sheet visible onClose={onClose} title={b.name} tall
      footer={onEdit ? (
        <>
          {/* الإغلاق بعلامة ✕ في رأس الورقة وحدها · لا زرّ نصّي مؤطَّر يكرّرها */}
          <View style={{ flex: 1 }}><BtnPrimary title="تعديل" onPress={onEdit} /></View>
        </>
      ) : undefined}>
      {b.iban ? <Num size={TYPE.caption} color={C.muted}>{b.iban}</Num> : null}
      <Row style={{ flexWrap: 'wrap', marginVertical: 8 }}>
        <KpiCard label="الرصيد المشتق" tone={balance >= 0 ? 'pos' : 'neg'} value={<Money halalas={balance} />} />
        <KpiCard label="الافتتاحي" tone="neu" value={<Money halalas={Number(b.opening_halalas)} />}
          sub={b.opening_date ? dfmt(b.opening_date) : undefined} />
      </Row>
      <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <KpiCard label="الوارد" tone="pos" value={<Money halalas={inflow} />} />
        <KpiCard label="الصادر" tone="neg" value={<Money halalas={-outflow} />} />
      </Row>

      <CollapsibleSection title="الوارد" count={Number(sums?.in_n ?? 0)} icon="wallet" pageKey="bankIn">
        {(page) => db.all<{ id: string; date: string; descr: string; amount_halalas: number; source: string; journal_no: string }>(
          txSql('>'), [bankId, page.limit, page.offset]).map(txRow)}
      </CollapsibleSection>
      <CollapsibleSection title="الصادر" count={Number(sums?.out_n ?? 0)} icon="export" pageKey="bankOut">
        {(page) => db.all<{ id: string; date: string; descr: string; amount_halalas: number; source: string; journal_no: string }>(
          txSql('<'), [bankId, page.limit, page.offset]).map(txRow)}
      </CollapsibleSection>
      <View style={{ height: 10 }} />
    </Sheet>
  );
}

/* ═══════════ المحفظة النقدية · إحصاء الكاش والتصرف به ═══════════ */
type CashOp = 'deposit' | 'withdraw' | 'transfer' | 'petty' | 'ownerIn' | 'ownerOut';
const CASH_OPS: Array<{ key: CashOp; label: string; icon: IconName; needBanks: number }> = [
  { key: 'deposit', label: 'إيداع في بنك', icon: 'bank', needBanks: 1 },
  { key: 'withdraw', label: 'سحب من بنك', icon: 'cash', needBanks: 1 },
  { key: 'transfer', label: 'تحويل بين البنوك', icon: 'swap', needBanks: 2 },
  { key: 'petty', label: 'مصروف نثري', icon: 'invoice', needBanks: 0 },
  { key: 'ownerIn', label: 'إيداع المالك', icon: 'plus', needBanks: 0 },
  { key: 'ownerOut', label: 'مسحوبات المالك', icon: 'export', needBanks: 0 },
];

function WalletSheet({ onClose }: { onClose: () => void }) {
  const { db, version, bump } = useApp();
  const canAdd = usePerm('banks').add;
  const toast = useToast();
  const dialog = useDialog();
  const [op, setOp] = useState<CashOp | null>(null);
  const [amount, setAmount] = useState('');
  const [bankA, setBankA] = useState('');
  const [bankB, setBankB] = useState('');
  const [descr, setDescr] = useState('');
  const [opDate, setOpDate] = useState(today());
  const balance = useMemo(() => walletCashBalance(db),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const banksList = useMemo(
    () => db.all<{ id: string; name: string }>(`SELECT id, name FROM banks WHERE deleted_at IS NULL AND archived = 0 ORDER BY created_at`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version]);
  const bankOptions = useMemo(
    () => banksList.map((b) => ({ value: b.id, label: b.name, icon: 'bank' as IconName })),
    [banksList]);
  const bankABalance = useMemo(() => (bankA ? bankBalance(db, bankA) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, bankA]);

  /** عدّادا القسمين · استعلاما COUNT خفيفان قبل الفتح */
  const counts = useMemo(() => ({
    cashIn: Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM payment_lines pl
       JOIN contract_payments p ON p.id = pl.payment_id
       JOIN contracts c ON c.id = p.contract_id
       WHERE pl.method = 'cash' AND p.cancelled_at IS NULL`)?.n ?? 0),
    cashOut: Number(db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM purchases
       WHERE deleted_at IS NULL AND paid = 1 AND (payment_method = 'cash' OR payment_method LIKE '%نقد%')`)?.n ?? 0),
  }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, version]);

  const startOp = (k: CashOp) => {
    setAmount(''); setBankA(''); setBankB(''); setDescr(''); setOpDate(today());
    setOp(k);
  };

  const confirmOp = () => {
    if (!op) return;
    const amountHalalas = toHalalas(amount);
    try {
      if (op === 'deposit') {
        if (!bankA) throw new Error('اختر الحساب البنكي الذي سيستقبل الإيداع');
        depositCashToBank(db, { bankId: bankA, amountHalalas, date: opDate, notes: descr });
      } else if (op === 'withdraw') {
        if (!bankA) throw new Error('اختر الحساب البنكي الذي سيُسحب منه');
        withdrawCashFromBank(db, { bankId: bankA, amountHalalas, date: opDate, notes: descr });
      } else if (op === 'transfer') {
        if (!bankA) throw new Error('اختر الحساب البنكي المحوَّل منه');
        if (!bankB) throw new Error('اختر الحساب البنكي المحوَّل إليه');
        transferBetweenBanks(db, { fromBankId: bankA, toBankId: bankB, amountHalalas, date: opDate, notes: descr });
      } else if (op === 'petty') {
        pettyCashExpense(db, { amountHalalas, descr, date: opDate });
      } else if (op === 'ownerIn') {
        ownerCashIn(db, { amountHalalas, date: opDate, notes: descr });
      } else {
        ownerCashOut(db, { amountHalalas, date: opDate, notes: descr });
      }
      bump();
      toast('تم تنفيذ العملية: ' + CASH_OPS.find((o) => o.key === op)!.label + ' · ' + fmt(amountHalalas));
      setOp(null);
    } catch (e) {
      reportFailure({ title: 'تعذّر تنفيذ العملية', e });
    }
  };

  if (op) {
    const meta = CASH_OPS.find((o) => o.key === op)!;
    const needsOneBank = op === 'deposit' || op === 'withdraw';
    const ready = toHalalas(amount) > 0;
    // ما يُخرج نقداً من المحفظة · كفاية النقد (قرار المالك ٢٠٢٦-١٠-٠٥)
    const cashOut = op === 'deposit' || op === 'petty' || op === 'ownerOut' ? toHalalas(amount) : 0;
    const cashOk = cashShortfall(db, cashOut) <= 0;
    return (
      <Sheet visible onClose={() => setOp(null)} title={meta.label}
        footer={
          <>
            <View style={{ flex: 1, justifyContent: 'center' }}><BackButton onPress={() => setOp(null)} /></View>
            {/* بلا مبلغ لا تنفيذ · الزر لا يُعرض بدل أن يُعرض معطَّلاً */}
            {ready && cashOk ? (
              <View style={{ flex: 1 }}><BtnPrimary title="تنفيذ العملية" onPress={confirmOp} /></View>
            ) : null}
          </>
        }>
        <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
          <KpiCard label="رصيد المحفظة الآن" tone={balance >= 0 ? 'pos' : 'neg'} value={<Money halalas={balance} />} />
          {bankA ? (
            <KpiCard label={'رصيد ' + (banksList.find((b) => b.id === bankA)?.name ?? '')} tone="neu"
              value={<Money halalas={bankABalance} />} />
          ) : null}
        </Row>
        {needsOneBank && (
          <SelectField label={op === 'deposit' ? 'الحساب البنكي المستقبِل' : 'الحساب البنكي المسحوب منه'}
            value={bankA || null} options={bankOptions} onPick={setBankA} placeholder="اختر الحساب" />
        )}
        {op === 'transfer' && (
          <>
            <SelectField label="من حساب" value={bankA || null} options={bankOptions} onPick={setBankA} placeholder="اختر الحساب المحوَّل منه" />
            <SelectField label="إلى حساب" value={bankB || null}
              options={bankOptions.filter((o) => o.value !== bankA)} onPick={setBankB} placeholder="اختر الحساب المحوَّل إليه" />
          </>
        )}
        <Row>
          <View style={{ flex: 1 }}><Field label="المبلغ" value={amount} onChange={setAmount} keyboard="numeric" ltr /></View>
          <View style={{ flex: 1 }}><DateField label="التاريخ" value={opDate} onChange={setOpDate} /></View>
        </Row>
        <Field label={op === 'petty' ? 'بيان المصروف' : 'البيان'} value={descr} onChange={setDescr} />
        <CashShortNote needed={cashOut} what={meta.label} />
      </Sheet>
    );
  }

  return (
    <Sheet visible onClose={onClose} title="المحفظة النقدية" tall>
      <Row style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <KpiCard label="الكاش الحاضر" tone={balance >= 0 ? 'pos' : 'neg'} value={<Money halalas={balance} />} />
      </Row>

      {/* التصرف بالنقد · ما لا يصلح تنفيذه اليوم لا يُعرض:
          الإيداع والسحب يحتاجان حساباً، والتحويل حسابين */}
      {canAdd ? <T size={TYPE.sectionTitle} bold color={C.ink} style={{ marginBottom: 6 }}>التصرف بالنقد</T> : null}
      {canAdd ? <View style={{ flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 7, marginBottom: 12 }}>
        {CASH_OPS.filter((o) => banksList.length >= o.needBanks).map((o) => (
          <Pressable key={o.key} onPress={() => startOp(o.key)}
            style={{
              width: '48%', flexGrow: 1, borderWidth: 1, borderColor: C.line, borderRadius: 9,
              paddingVertical: 9, paddingHorizontal: 10, backgroundColor: '#FAFAF7',
            }}>
            <Row gap={7}>
              <Icon name={o.icon} size={15} color={C.emerald} />
              <T size={TYPE.cardTitle} bold>{o.label}</T>
            </Row>
          </Pressable>
        ))}
      </View> : null}

      <CollapsibleSection title="مقبوضات نقدية" count={counts.cashIn} icon="collect" pageKey="walletCashIn">
        {(page) => db.all<{ id: string; date: string; tenant_name: string; period: string; amount_halalas: number }>(
          `SELECT pl.id, p.date, c.tenant_name, p.period, pl.amount_halalas
           FROM payment_lines pl
           JOIN contract_payments p ON p.id = pl.payment_id
           JOIN contracts c ON c.id = p.contract_id
           WHERE pl.method = 'cash' AND p.cancelled_at IS NULL ORDER BY p.date DESC, p.created_at DESC LIMIT ? OFFSET ?`,
          [page.limit, page.offset]
        ).map((r) => (
          <Row key={r.id} style={{ justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <T size={TYPE.body} style={{ flex: 1 }}>{r.tenant_name}{r.period ? ' · ' + r.period : ''} · {dfmt(r.date)}</T>
            <Money halalas={Number(r.amount_halalas)} size={TYPE.cardTitle} bold color={C.emerald} />
          </Row>
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="مدفوعات نقدية" count={counts.cashOut} icon="cash" pageKey="walletCashOut">
        {(page) => db.all<{ id: string; paid_date: string; supplier_name: string; category: string; total_halalas: number }>(
          `SELECT id, paid_date, supplier_name, category, total_halalas FROM purchases
           WHERE deleted_at IS NULL AND paid = 1 AND (payment_method = 'cash' OR payment_method LIKE '%نقد%')
           ORDER BY paid_date DESC LIMIT ? OFFSET ?`,
          [page.limit, page.offset]
        ).map((r) => (
          <Row key={r.id} style={{ justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <T size={TYPE.body} style={{ flex: 1 }}>{r.supplier_name} · {r.category}{r.paid_date ? ' · ' + dfmt(r.paid_date) : ''}</T>
            <Money halalas={Number(r.total_halalas)} size={TYPE.cardTitle} bold color={C.rose} />
          </Row>
        ))}
      </CollapsibleSection>
      <View style={{ height: 10 }} />
    </Sheet>
  );
}

/**
 * كشف الحساب والمطابقة لبنكٍ واحد (التوجيه الرابع ٦ · ٢ · DESIGN §١٣.٢٢): قراءة الكشف من ملفه (PDF بنص أو Excel أو CSV أو MT940) بالقارئ
 * العام وربطه المحفوظ، والحفظ بلا تكرار، والمطابقة المقترحة بدرجة ثقة تُعتمد بموافقة، وسطور الكشف غير المطابقة تُسجَّل من مسار التطبيق
 * المعتاد أو تُستبعد بسبب، وتقرير المطابقة للشهر بالفروق، والكشوف المحفوظة · الصلاحيات: القراءة لمن يرى البنوك، والحفظ والتسجيل لمن
 * يسجّل حركة، والاعتماد والاستبعاد والحذف لمن يطابق.
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { t } from '../src/i18n';
import { Screen } from '../src/ui/Screen';
import { Card, T, Num, Money, Row, BtnPrimary, BtnGhost, BtnIcon, Field, ChipGroup, EmptyState, Note, KpiCard } from '../src/ui/components';
import { Sheet } from '../src/ui/Sheet';
import { CollapsibleSection } from '../src/ui/Collapsible';
import { useDialog } from '../src/ui/AppDialog';
import { useApp } from '../src/ui/store';
import { useToast } from '../src/ui/Toast';
import { usePerm } from '../src/ui/access';
import { C, TYPE } from '../src/ui/theme';
import { pickFile } from '../src/ui/attach';
import { reportFailure } from '../src/ui/failureDialog';
import { fmt, toHalalas } from '../src/domain/money';
import { today, dfmt } from '../src/domain/dates';
import { recordManualBankTx, transferBetweenBanks, type ManualBankKind } from '../src/domain/cashOps';
import { collectionSuggestions, approveCollection, collectPermission, type CollectSuggestion } from '../src/domain/bankStatement/collect';
import { statementSource, type StatementSource } from '../src/services/bankStatement';
import { unverifiedResult, type StatementResult, type StatementOk, type ColumnMapping, type ReadOpts } from '../src/domain/bankStatement/read';
import type { Role } from '../src/domain/bankStatement/columns';
import type { DateOrder } from '../src/domain/bankStatement/normalize';
import {
  saveStatement, statementMapping, matchSuggestions, approveMatch, unmatchLine, excludeLine, reconciliation, deleteStatement,
  type LineView,
} from '../src/domain/bankStatement/store';
import { RuleViolation } from '../src/domain/contracts/service';

// والصورة تُقرأ أرقامها وتواريخها (U١٢ · سجل القرارات ٥٦)
const FILE_TYPES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/plain', 'image/*', '*/*'];
const ROLE_OPTIONS: Array<Role | 'none'> = ['date', 'valueDate', 'descr', 'debit', 'credit', 'amount', 'balance', 'ref', 'type', 'none'];
/** مبلغٌ بالهللة نصاً للحقل (بلا فواصل) */
const plain = (h: number) => (h / 100).toFixed(2);
const shiftMonth = (m: string, by: number) => {
  const [y, mo] = m.split('-').map(Number);
  const n = y * 12 + (mo - 1) + by;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
};

export default function BankStatementScreen() {
  const { bank: bankId = '' } = useLocalSearchParams<{ bank?: string }>();
  const { db, version, bump } = useApp();
  const perm = usePerm('banks');
  // اعتماد التحصيل من الكشف: تسجيله بصلاحية قسمه ومطابقته بصلاحية البنوك (سجل القرارات ٥٩)
  const collectPerm = usePerm('collect');
  const claimsPerm = usePerm('claims');
  const invoicesPerm = usePerm('invoices');
  const purchasesPerm = usePerm('purchases');
  const router = useRouter();
  const dialog = useDialog();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [month, setMonth] = useState(today().slice(0, 7));
  // كشفٌ بلا أرصدة: يُطلب الافتتاحي والختامي من رأسه (معبّأين بما اشتُق منه) ثم تُعاد القراءة
  const [ask, setAsk] = useState<{ src: StatementSource; mapping?: ColumnMapping; confirmed: boolean; opening: string; closing: string } | null>(null);
  // الأعمدة المخمَّنة يؤكدها المستخدم أو يصححها أول مرةٍ للبنك أو لشكلٍ جديد (قرار المالك 2026-10-09 أ.٣ · U٩)
  // (وأعمدةٌ لم تُعرف أصلاً: صفّ العناوين المرجَّح بلا قراءة · r = null)
  const [mapEdit, setMapEdit] = useState<{
    src: StatementSource; base: ColumnMapping; r: StatementOk | null; hash: string; roles: Array<Role | null>; order: DateOrder;
  } | null>(null);
  // وغير المطابق (قرار المالك ج.٤): رسوم أو وارد أو سحب أو إيداع أو تحويلٌ بين حسابين بنكيين، أو مصروفٌ أو تحصيلٌ من شاشته، أو يبقى معلّقاً
  const [record, setRecord] = useState<{ line: LineView; kind: ManualBankKind | 'transfer'; other: string; amount: string; date: string; descr: string } | null>(null);
  const [exclude, setExclude] = useState<{ line: LineView; note: string } | null>(null);

  const bank = useMemo(() => db.get<{ name: string }>(`SELECT name FROM banks WHERE id = ? AND deleted_at IS NULL`, [bankId]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, bankId, version]);
  const suggestions = useMemo(() => (bank ? matchSuggestions(db, bankId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, bankId, version, bank]);
  const collects = useMemo(() => (bank ? collectionSuggestions(db, bankId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, bankId, version, bank]);
  const otherBanks = useMemo(() => db.all<{ id: string; name: string }>(`SELECT id, name FROM banks WHERE id != ? AND deleted_at IS NULL ORDER BY name`, [bankId]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, bankId, version]);
  const openLines = useMemo(() => db.all<{ id: string; date: string; descr: string; amount: number; status: string; note: string }>(
    `SELECT id, date, descr, amount_halalas AS amount, status, note FROM bank_statement_lines
     WHERE bank_id = ? AND deleted_at IS NULL AND status != 'matched' ORDER BY date DESC, rowid DESC LIMIT 200`, [bankId]),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, bankId, version]);
  // والمطابَق يُلغى من هنا (المدقق الخارجي D٢-٣: لم يكن في الشاشة طريقٌ لإلغاء مطابقةٍ خاطئة، ولا لحذف كشفٍ فيه مطابَق)
  const matchedLines = useMemo(() => db.all<{ id: string; date: string; descr: string; amount: number; status: string; no: string; txDate: string }>(
    `SELECT l.id, l.date, l.descr, l.amount_halalas AS amount, l.status, COALESCE(t.journal_no, '') AS no, COALESCE(t.date, '') AS txDate
     FROM bank_statement_lines l LEFT JOIN bank_tx t ON t.id = l.bank_tx_id
     WHERE l.bank_id = ? AND l.deleted_at IS NULL AND l.status = 'matched' ORDER BY l.date DESC, l.rowid DESC LIMIT 200`, [bankId]),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, bankId, version]);
  const statements = useMemo(() => db.all<{ id: string; from: string; to: string; n: number; name: string }>(
    `SELECT id, period_from AS "from", period_to AS "to", line_count AS n, file_name AS name FROM bank_statements
     WHERE bank_id = ? AND deleted_at IS NULL ORDER BY period_from DESC`, [bankId]),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [db, bankId, version]);
  const rep = useMemo(() => (bank ? reconciliation(db, bankId, month) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, bankId, version, month, bank]);

  if (!bank) return <Screen title={t('bankStatement.title')} icon="bank"><EmptyState>{t('bankStatement.noBank')}</EmptyState></Screen>;

  const fail = (e: unknown) => {
    if (e instanceof RuleViolation) toast((e as Error).message);
    else reportFailure({ title: t('common.failed'), where: t('bankStatement.title', { lng: 'ar' }), db, e });
  };

  const save = (src: StatementSource, r: StatementOk, hash: string) => {
    try {
      const saved = saveStatement(db, bankId, r, { name: src.name, hash });
      bump();
      toast(saved.skipped ? t('bankStatement.savedSkipped', { added: saved.added, skipped: saved.skipped }) : t('bankStatement.saved', { added: saved.added }));
    } catch (e) { fail(e); }
  };

  const showResult = (src: StatementSource, r: StatementResult, hash: string, opts: ReadOpts, confirmed: boolean) => {
    if (!r.ok) {
      if (r.error === 'needBalances') {
        setAsk({
          src, mapping: opts.mapping, confirmed,
          // والختامي يُكتب من رأس الكشف لا من مجموع السطور: المعبّأ منها يجعل الفحص تحصيل حاصل (ملاحظة المدقق الخارجي V)
          opening: r.partial?.opening != null ? plain(r.partial.opening) : '', closing: '',
        });
        return;
      }
      // والأعمدة المخمَّنة تُعرض لتُصحَّح إن لم تُعرف، أو لم يُقرأ بها شيء أو قُرئ مبلغٌ نصاً، ما لم يؤكدها المستخدم للتو (قرار المالك أ.٣)
      const fixable = r.error === 'columns' || (!confirmed && (r.error === 'empty' || r.error === 'format'));
      const guess = fixable && !src.photo ? r.partial?.mapping : undefined;
      if (guess?.labels) {
        setMapEdit({ src, base: guess, r: null, hash, roles: [...guess.roles], order: guess.dateOrder });
        return;
      }
      // والفحص الذي لم يثبت: يُنبَّه، ويُحفظ «غير متحقَّق» بتأكيدٍ صريح إن عُرفت إشارات حركاته (قرار المالك 2026-10-09 أ.٤)
      const loose = r.error === 'balance' ? unverifiedResult(r.partial) : null;
      dialog({
        title: t('bankStatement.notRead'),
        body: t('bankStatement.err.' + r.error) + (loose ? '\n\n' + t('bankStatement.unverifiedOffer', {
          n: loose.lines.length, opening: fmt(loose.opening), closing: fmt(loose.closing),
        }) : ''),
        actions: loose
          ? [{ label: t('bankStatement.saveUnverified'), variant: 'danger', onPress: () => save(src, loose, hash) }, { label: t('common.cancel'), variant: 'ghost' }]
          : [{ label: t('common.ok'), variant: 'primary' }],
      });
      return;
    }
    const saved = statementMapping(db, bankId);
    if (!src.photo && !confirmed && r.mapping.labels && (!saved || saved.headerKey !== r.mapping.headerKey)) {
      setMapEdit({ src, base: r.mapping, r, hash, roles: [...r.mapping.roles], order: r.mapping.dateOrder });
      return;
    }
    const notes = [
      t('bankStatement.preview', { n: r.lines.length, from: dfmt(r.from ?? ''), to: dfmt(r.to ?? ''), opening: fmt(r.opening), closing: fmt(r.closing) }),
      ...(saved && !src.photo && saved.headerKey !== r.mapping.headerKey ? [t('bankStatement.shapeChanged')] : []),
      ...r.warnings.map((w) => t('bankStatement.warn.' + w)),
    ];
    dialog({
      title: t('bankStatement.read'), body: notes.join('\n'),
      actions: [
        { label: t('bankStatement.save'), variant: 'primary', onPress: () => save(src, r, hash) },
        { label: t('common.cancel'), variant: 'ghost' },
      ],
    });
  };

  const readFile = async () => {
    const f = await pickFile(FILE_TYPES);
    if (!f) return;
    setBusy(true);
    try {
      const src = await statementSource(f);
      const opts: ReadOpts = { mapping: src.photo ? undefined : statementMapping(db, bankId) ?? undefined };
      const { result, hash } = src.read(opts);
      showResult(src, result, hash, opts, false);
    } catch (e) {
      if (e instanceof Error && e.message === 'ocr') toast(t('bankStatement.err.ocr'));
      else fail(e);
    } finally { setBusy(false); }
  };

  /** تأكيد الأعمدة أو تصحيحها: ما لم يتغيّر يُعرض كما قُرئ، والمصحَّح يُعاد به القرار */
  const confirmMapping = () => {
    if (!mapEdit) return;
    const { src, base, r, hash, roles, order } = mapEdit;
    setMapEdit(null);
    const changed = order !== base.dateOrder || roles.some((x, i) => x !== base.roles[i]);
    if (r && !changed) { showResult(src, r, hash, { mapping: r.mapping }, true); return; }
    try {
      const mapping: ColumnMapping = { ...base, roles, dateOrder: order };
      const again = src.read({ mapping });
      showResult(src, again.result, again.hash, { mapping }, true);
    } catch (e) { fail(e); }
  };

  const approveAll = () => {
    const ready = suggestions.filter((s) => s.level === 'ready');
    dialog({
      title: t('bankStatement.approveAll', { n: ready.length }), body: t('bankStatement.approveAllBody', { n: ready.length }),
      actions: [
        { label: t('bankStatement.approve'), variant: 'primary', onPress: () => {
          try { for (const s of ready) approveMatch(db, s.line.id, s.tx.id); bump(); toast(t('bankStatement.approved')); } catch (e) { fail(e); }
        } },
        { label: t('common.cancel'), variant: 'ghost' },
      ],
    });
  };

  const canCollect = (s: CollectSuggestion) => {
    const need = collectPermission(s.target);
    const p = need.section === 'collect' ? collectPerm : need.section === 'claims' ? claimsPerm : invoicesPerm;
    return perm.manage && (need.level === 3 ? p.manage : p.add);
  };
  // كل اعتمادٍ وحده: ما يُرفض لا يوقف ما بعده، ويُذكر عدده بسبب أولها (المدقق الخارجي W٦)
  const approveCollect = (list: CollectSuggestion[]) => {
    let first: unknown = null;
    let failed = 0;
    for (const s of list) {
      try { approveCollection(db, s.line.id, s.target); } catch (e) { failed++; first = first ?? e; }
    }
    bump();
    if (!failed) toast(t('bankStatement.collect.approved'));
    else if (list.length === 1) fail(first);
    else toast(t('bankStatement.collect.someFailed', { n: failed, of: list.length, why: (first as Error)?.message ?? '' }));
  };
  const approveCollectAll = () => {
    const ready = collects.filter((s) => s.level === 'ready' && canCollect(s));
    dialog({
      title: t('bankStatement.collect.approveAll', { n: ready.length }), body: t('bankStatement.collect.approveAllBody', { n: ready.length }),
      actions: [
        { label: t('bankStatement.collect.approve'), variant: 'primary', onPress: () => approveCollect(ready) },
        { label: t('common.cancel'), variant: 'ghost' },
      ],
    });
  };

  const amountColor = (a: number) => (a >= 0 ? C.emerald : C.rose);
  const lineHead = (l: { date: string; descr: string; amount: number }) => (
    <Row style={{ justifyContent: 'space-between' }}>
      <View style={{ flex: 1 }}>
        <T size={TYPE.cardTitle} bold>{l.descr || '—'}</T>
        <Num size={TYPE.caption} color={C.muted}>{dfmt(l.date)}</Num>
      </View>
      <Money halalas={l.amount} size={TYPE.number} bold color={amountColor(l.amount)} />
    </Row>
  );

  return (
    <Screen title={t('bankStatement.title')} icon="bank"
      actions={perm.add ? <BtnPrimary small title={busy ? t('bankStatement.reading') : t('bankStatement.read')} onPress={busy ? () => undefined : readFile} /> : undefined}>
      <T size={TYPE.cardTitle} bold style={{ marginBottom: 8 }}>{bank.name}</T>

      <CollapsibleSection title={t('bankStatement.suggestions')} count={suggestions.length} icon="swap" pageKey="stmtSuggest">
        {() => (
          <>
            {perm.manage && suggestions.some((s) => s.level === 'ready') ? (
              <BtnGhost small title={t('bankStatement.approveAll', { n: suggestions.filter((s) => s.level === 'ready').length })} onPress={approveAll} />
            ) : null}
            {suggestions.map((s) => (
              <Card key={s.line.id}>
                {lineHead(s.line)}
                <T size={TYPE.caption} color={C.muted} style={{ marginTop: 4 }}>
                  {t('bankStatement.withTx', { descr: s.tx.descr, date: dfmt(s.tx.date), no: s.tx.no || '—' })}
                </T>
                <Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
                  <T size={TYPE.caption} color={s.level === 'ready' ? C.emerald : C.gold}>
                    {t('bankStatement.' + s.level)} · {s.score} · {s.reasons.map((r) => t('bankStatement.why.' + r)).join(' · ')}
                  </T>
                  {perm.manage ? <BtnPrimary small title={t('bankStatement.approve')} onPress={() => {
                    try { approveMatch(db, s.line.id, s.tx.id); bump(); toast(t('bankStatement.approved')); } catch (e) { fail(e); }
                  }} /> : null}
                </Row>
              </Card>
            ))}
          </>
        )}
      </CollapsibleSection>

      <CollapsibleSection title={t('bankStatement.collect.title')} count={collects.length} icon="collect" pageKey="stmtCollect">
        {() => (
          <>
            {collects.some((s) => s.level === 'ready' && canCollect(s)) ? (
              <BtnGhost small title={t('bankStatement.collect.approveAll', { n: collects.filter((s) => s.level === 'ready' && canCollect(s)).length })} onPress={approveCollectAll} />
            ) : null}
            {collects.map((s) => (
              <Card key={s.line.id}>
                {lineHead(s.line)}
                <T size={TYPE.caption} color={C.muted} style={{ marginTop: 4 }}>{s.label}</T>
                <Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
                  <T size={TYPE.caption} color={s.level === 'ready' ? C.emerald : C.gold} style={{ flex: 1 }}>
                    {t('bankStatement.' + s.level)} · {s.score} · {s.reasons.map((r) => t('bankStatement.why.' + r)).join(' · ')}
                  </T>
                  {canCollect(s) ? <BtnPrimary small title={t('bankStatement.collect.approve')} onPress={() => approveCollect([s])} />
                    : <T size={TYPE.caption} color={C.muted}>{t('bankStatement.collect.needPerm')}</T>}
                </Row>
              </Card>
            ))}
          </>
        )}
      </CollapsibleSection>

      <CollapsibleSection title={t('bankStatement.openLines')} count={openLines.length} icon="invoice" pageKey="stmtOpen">
        {() => openLines.map((l) => (
          <Card key={l.id}>
            {lineHead(l)}
            {l.status === 'excluded' ? <T size={TYPE.caption} color={C.muted}>{t('bankStatement.excludedAs', { note: l.note })}</T> : null}
            <Row style={{ marginTop: 6 }}>
              {l.status === 'open' && perm.add ? <BtnGhost small title={t('bankStatement.record')} onPress={() => setRecord({
                line: l, kind: l.amount < 0 ? 'fee' : 'income', other: otherBanks[0]?.id ?? '', amount: fmt(Math.abs(l.amount)).replace(/,/g, ''), date: l.date, descr: l.descr,
              })} /> : null}
              {/* والمصروف بفاتورة شراءٍ من شاشتها، والتحصيل الجديد من شاشة التحصيل، ثم يُطابَق السطر بحركته */}
              {l.status === 'open' && l.amount < 0 && purchasesPerm.add ? <BtnGhost small title={t('bankStatement.asExpense')} onPress={() => router.push('/purchases')} /> : null}
              {l.status === 'open' && l.amount > 0 && collectPerm.add ? <BtnGhost small title={t('bankStatement.asCollection')} onPress={() => router.push('/collect')} /> : null}
              {l.status === 'open' && perm.manage ? <BtnGhost small title={t('bankStatement.exclude')} onPress={() => setExclude({ line: l, note: '' })} /> : null}
              {l.status === 'excluded' && perm.manage ? <BtnGhost small title={t('bankStatement.reopen')} onPress={() => {
                try { unmatchLine(db, l.id); bump(); } catch (e) { fail(e); }
              }} /> : null}
            </Row>
          </Card>
        ))}
      </CollapsibleSection>

      <CollapsibleSection title={t('bankStatement.matchedLines')} count={matchedLines.length} icon="swap" pageKey="stmtMatched">
        {() => matchedLines.map((l) => (
          <Card key={l.id}>
            {lineHead(l)}
            <T size={TYPE.caption} color={C.muted}>{t('bankStatement.matchedWith', { no: l.no || '—', date: l.txDate ? dfmt(l.txDate) : '—' })}</T>
            <Row style={{ marginTop: 6 }}>
              {l.status === 'matched' && perm.manage ? <BtnGhost small title={t('bankStatement.unmatch')} onPress={() => {
                try { unmatchLine(db, l.id); bump(); toast(t('bankStatement.unmatched')); } catch (e) { fail(e); }
              }} /> : null}
            </Row>
          </Card>
        ))}
      </CollapsibleSection>

      <CollapsibleSection title={t('bankStatement.report')} count={rep?.matched ?? 0} icon="chart" pageKey="stmtReport">
        {() => (rep ? (
          <>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <BtnGhost small title={t('bankStatement.prevMonth')} onPress={() => setMonth(shiftMonth(month, -1))} />
              <Num size={TYPE.cardTitle} bold>{month}</Num>
              <BtnGhost small title={t('bankStatement.nextMonth')} onPress={() => setMonth(shiftMonth(month, 1))} />
            </Row>
            {!rep.covered ? <Note>{t('bankStatement.notCovered')}</Note> : (
              <>
                <Row style={{ flexWrap: 'wrap' }}>
                  <KpiCard label={t('bankStatement.stmtOpening')} tone="neu" value={<Money halalas={rep.statementOpening ?? 0} />} />
                  <KpiCard label={t('bankStatement.booksOpening')} tone="neu" value={<Money halalas={rep.booksOpening} />} />
                  <KpiCard label={t('bankStatement.stmtClosing')} tone="neu" value={<Money halalas={rep.statementClosing ?? 0} />} />
                  <KpiCard label={t('bankStatement.booksClosing')} tone="neu" value={<Money halalas={rep.booksClosing} />} />
                </Row>
                <T size={TYPE.caption} color={C.muted} style={{ marginVertical: 6 }}>{t('bankStatement.matchedN', { n: rep.matched })}</T>
                {rep.gaps.map((g, i) => <Note key={i} tone="danger">{t('bankStatement.gap', { after: dfmt(g.after), closing: fmt(g.closing), next: fmt(g.nextOpening) })}</Note>)}
                {rep.unverified ? <Note tone="danger">{t('bankStatement.unverifiedMonth')}</Note> : null}
                {rep.unexplained ? <Note tone="danger">{t('bankStatement.unexplained', { amount: fmt(rep.unexplained) })}</Note> : null}
                {([['onlyStatement', rep.onlyInStatement], ['onlyBooks', rep.onlyInBooks], ['inTransitBooks', rep.inTransitBooks],
                  ['inTransitStatement', rep.inTransitStatement], ['excludedLines', rep.excluded]] as const).map(([k, xs]) => (
                  <View key={k} style={{ marginTop: 8 }}>
                    <T size={TYPE.cardTitle} bold>{t('bankStatement.' + k)} ({xs.length})</T>
                    {xs.length ? xs.map((x) => <View key={x.id} style={{ paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>{lineHead(x)}</View>)
                      : <T size={TYPE.caption} color={C.muted}>{t('bankStatement.none')}</T>}
                  </View>
                ))}
              </>
            )}
          </>
        ) : null)}
      </CollapsibleSection>

      <CollapsibleSection title={t('bankStatement.statements')} count={statements.length} icon="archive" pageKey="stmtList">
        {() => statements.map((s) => (
          <Row key={s.id} style={{ justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <View style={{ flex: 1 }}>
              <T size={TYPE.cardTitle}>{t('bankStatement.stmtRow', { from: dfmt(s.from), to: dfmt(s.to), n: s.n })}</T>
              {s.name ? <T size={TYPE.caption} color={C.muted}>{s.name}</T> : null}
            </View>
            {perm.manage ? <BtnIcon icon="trash" accessibilityLabel={t('bankStatement.deleteStmt')} onPress={() => dialog({
              title: t('bankStatement.deleteStmt'), body: t('bankStatement.deleteStmtBody'),
              actions: [
                { label: t('bankStatement.deleteStmt'), variant: 'danger', onPress: () => { try { deleteStatement(db, s.id); bump(); } catch (e) { fail(e); } } },
                { label: t('common.cancel'), variant: 'ghost' },
              ],
            })} /> : null}
          </Row>
        ))}
      </CollapsibleSection>

      {/* الافتتاحي والختامي من رأس كشفٍ بلا أرصدة · الافتتاحي معبّأ بما اشتُق من القراءة، والختامي يكتبه المستخدم */}
      <Sheet visible={!!ask} onClose={() => setAsk(null)} title={t('bankStatement.needTitle')}
        footer={<View style={{ flex: 1 }}><BtnPrimary title={t('bankStatement.read')} onPress={() => {
          if (!ask) return;
          const opts: ReadOpts = {
            mapping: ask.mapping ?? (ask.src.photo ? undefined : statementMapping(db, bankId) ?? undefined),
            // والفارغ «لم يُكتب» لا صفر (المدقق الخارجي X٨): كشفٌ يشهد لختاميه آخر رصيدٍ مطبوع لا يحتاج ختامياً
            opening: ask.opening.trim() ? toHalalas(ask.opening) : undefined, closing: ask.closing.trim() ? toHalalas(ask.closing) : undefined,
          };
          const { src, confirmed } = ask;
          setAsk(null);
          try {
            const { result, hash } = src.read(opts);
            showResult(src, result.ok || result.error !== 'needBalances' ? result : { ok: false, error: 'balance', partial: result.partial }, hash, opts, confirmed);
          } catch (e) { fail(e); }
        }} /></View>}>
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 8 }}>{t('bankStatement.err.needBalances')}</T>
        {ask ? (
          <>
            <Field label={t('bankStatement.opening')} value={ask.opening} keyboard="numeric" ltr onChange={(v) => setAsk({ ...ask, opening: v })} />
            <Field label={t('bankStatement.closing')} value={ask.closing} keyboard="numeric" ltr onChange={(v) => setAsk({ ...ask, closing: v })} />
          </>
        ) : null}
      </Sheet>

      {/* أعمدة الكشف المخمَّنة: يؤكدها المستخدم أو يصححها، ويُحفظ الربط مع الكشف لهذا البنك (mapping.roles) */}
      <Sheet visible={!!mapEdit} onClose={() => setMapEdit(null)} title={t('bankStatement.mapTitle')}
        footer={<View style={{ flex: 1 }}><BtnPrimary title={t('bankStatement.mapConfirm')} onPress={confirmMapping} /></View>}>
        <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 8 }}>{t('bankStatement.mapHint')}</T>
        {mapEdit ? (
          <>
            {(mapEdit.base.labels ?? []).map((label, i) => (
              <View key={i} style={{ marginBottom: 10 }}>
                <T size={TYPE.cardTitle} bold>{label || '—'}</T>
                <ChipGroup<string> value={mapEdit.roles[i] ?? 'none'} onChange={(v) => {
                  const role = v === 'none' ? null : (v as Role);
                  // الدور الواحد لعمودٍ واحد: اختياره هنا يرفعه عن غيره
                  setMapEdit({ ...mapEdit, roles: mapEdit.roles.map((x, k) => (k === i ? role : x === role ? null : x)) });
                }} options={ROLE_OPTIONS.map((k) => [k, t('bankStatement.role.' + k)] as [string, string])} />
              </View>
            ))}
            <T size={TYPE.cardTitle} bold>{t('bankStatement.dateOrder')}</T>
            <ChipGroup<DateOrder> value={mapEdit.order} onChange={(o) => setMapEdit({ ...mapEdit, order: o })}
              options={[['dmy', t('bankStatement.order.dmy')], ['mdy', t('bankStatement.order.mdy')]]} />
          </>
        ) : null}
      </Sheet>

      {/* تسجيل حركةٍ لسطرٍ غير مطابق: مسار التطبيق المعتاد (recordManualBankTx بكفايته) معبأً من السطر */}
      <Sheet visible={!!record} onClose={() => setRecord(null)} title={t('bankStatement.recordTitle')}
        footer={<View style={{ flex: 1 }}><BtnPrimary title={t('common.save')} onPress={() => {
          if (!record) return;
          try {
            const amountHalalas = toHalalas(record.amount);
            if (record.kind === 'transfer') {
              // التحويل بين حسابين: الخارج من هذا البنك إلى الآخر، والوارد من الآخر إليه
              const [fromBankId, toBankId] = record.line.amount < 0 ? [bankId, record.other] : [record.other, bankId];
              transferBetweenBanks(db, { fromBankId, toBankId, amountHalalas, date: record.date, notes: record.descr });
            } else recordManualBankTx(db, { kind: record.kind, bankId, amountHalalas, date: record.date, descr: record.descr });
            setRecord(null); bump();
          } catch (e) { fail(e); }
        }} /></View>}>
        {record ? (
          <>
            {lineHead(record.line)}
            <ChipGroup<ManualBankKind | 'transfer'> value={record.kind} onChange={(k) => setRecord({ ...record, kind: k })}
              options={[...(record.line.amount < 0 ? ['fee', 'withdraw'] : ['income', 'deposit']), ...(otherBanks.length ? ['transfer'] : [])]
                .map((k) => [k as ManualBankKind | 'transfer', t('bankStatement.kind.' + k)])} />
            {record.kind === 'transfer' ? (
              <>
                <T size={TYPE.caption} color={C.muted}>{t(record.line.amount < 0 ? 'bankStatement.transferTo' : 'bankStatement.transferFrom')}</T>
                <ChipGroup<string> value={record.other} onChange={(v) => setRecord({ ...record, other: v })}
                  options={otherBanks.map((b) => [b.id, b.name] as [string, string])} />
              </>
            ) : null}
            <Field label={t('bankStatement.amount')} value={record.amount} keyboard="numeric" ltr onChange={(v) => setRecord({ ...record, amount: v })} />
            <Field label={t('bankStatement.descr')} value={record.descr} onChange={(v) => setRecord({ ...record, descr: v })} />
          </>
        ) : null}
      </Sheet>

      <Sheet visible={!!exclude} onClose={() => setExclude(null)} title={t('bankStatement.exclude')}
        footer={<View style={{ flex: 1 }}><BtnPrimary title={t('bankStatement.exclude')} onPress={() => {
          if (!exclude) return;
          try { excludeLine(db, exclude.line.id, exclude.note); setExclude(null); bump(); } catch (e) { fail(e); }
        }} /></View>}>
        {exclude ? (
          <>
            {lineHead(exclude.line)}
            <Field label={t('bankStatement.excludeReason')} value={exclude.note} multiline onChange={(v) => setExclude({ ...exclude, note: v })} />
          </>
        ) : null}
      </Sheet>
    </Screen>
  );
}

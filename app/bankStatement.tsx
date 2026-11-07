/**
 * كشف الحساب والمطابقة لبنكٍ واحد (التوجيه الرابع ٦ · ٢ · DESIGN §١٣.٢٢): قراءة الكشف من ملفه (PDF بنص أو Excel أو CSV أو MT940) بالقارئ
 * العام وربطه المحفوظ، والحفظ بلا تكرار، والمطابقة المقترحة بدرجة ثقة تُعتمد بموافقة، وسطور الكشف غير المطابقة تُسجَّل من مسار التطبيق
 * المعتاد أو تُستبعد بسبب، وتقرير المطابقة للشهر بالفروق، والكشوف المحفوظة · الصلاحيات: القراءة لمن يرى البنوك، والحفظ والتسجيل لمن
 * يسجّل حركة، والاعتماد والاستبعاد والحذف لمن يطابق.
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
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
import { recordManualBankTx, type ManualBankKind } from '../src/domain/cashOps';
import { readStatementFromFile } from '../src/services/bankStatement';
import type { StatementResult } from '../src/domain/bankStatement/read';
import {
  saveStatement, statementMapping, matchSuggestions, approveMatch, unmatchLine, excludeLine, reconciliation, deleteStatement,
  type LineView,
} from '../src/domain/bankStatement/store';
import { RuleViolation } from '../src/domain/contracts/service';

const FILE_TYPES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/plain', '*/*'];
const shiftMonth = (m: string, by: number) => {
  const [y, mo] = m.split('-').map(Number);
  const n = y * 12 + (mo - 1) + by;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
};

export default function BankStatementScreen() {
  const { bank: bankId = '' } = useLocalSearchParams<{ bank?: string }>();
  const { db, version, bump } = useApp();
  const perm = usePerm('banks');
  const dialog = useDialog();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [month, setMonth] = useState(today().slice(0, 7));
  // كشفٌ بلا أرصدة: يُطلب الافتتاحي والختامي من رأسه ثم تُعاد القراءة
  const [ask, setAsk] = useState<{ file: { uri: string; name: string }; opening: string; closing: string } | null>(null);
  const [record, setRecord] = useState<{ line: LineView; kind: ManualBankKind; amount: string; date: string; descr: string } | null>(null);
  const [exclude, setExclude] = useState<{ line: LineView; note: string } | null>(null);

  const bank = useMemo(() => db.get<{ name: string }>(`SELECT name FROM banks WHERE id = ? AND deleted_at IS NULL`, [bankId]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, bankId, version]);
  const suggestions = useMemo(() => (bank ? matchSuggestions(db, bankId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, bankId, version, bank]);
  const openLines = useMemo(() => db.all<{ id: string; date: string; descr: string; amount: number; status: string; note: string }>(
    `SELECT id, date, descr, amount_halalas AS amount, status, note FROM bank_statement_lines
     WHERE bank_id = ? AND deleted_at IS NULL AND status != 'matched' ORDER BY date DESC, rowid DESC LIMIT 200`, [bankId]),
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

  const showResult = (file: { uri: string; name: string }, r: StatementResult, hash: string) => {
    if (!r.ok) {
      if (r.error === 'needBalances') { setAsk({ file, opening: '', closing: '' }); return; }
      dialog({ title: t('bankStatement.notRead'), body: t('bankStatement.err.' + r.error), actions: [{ label: t('common.ok'), variant: 'primary' }] });
      return;
    }
    const saved = statementMapping(db, bankId);
    const notes = [
      t('bankStatement.preview', { n: r.lines.length, from: dfmt(r.from ?? ''), to: dfmt(r.to ?? ''), opening: fmt(r.opening), closing: fmt(r.closing) }),
      ...(saved && saved.headerKey !== r.mapping.headerKey ? [t('bankStatement.shapeChanged')] : []),
      ...r.warnings.map((w) => t('bankStatement.warn.' + w)),
    ];
    dialog({
      title: t('bankStatement.read'), body: notes.join('\n'),
      actions: [
        { label: t('bankStatement.save'), variant: 'primary', onPress: () => {
          try {
            const s = saveStatement(db, bankId, r, { name: file.name, hash });
            bump();
            toast(s.skipped ? t('bankStatement.savedSkipped', { added: s.added, skipped: s.skipped }) : t('bankStatement.saved', { added: s.added }));
          } catch (e) { fail(e); }
        } },
        { label: t('common.cancel'), variant: 'ghost' },
      ],
    });
  };

  const readFile = async () => {
    const f = await pickFile(FILE_TYPES);
    if (!f) return;
    setBusy(true);
    try {
      const { result, hash } = readStatementFromFile(f, { mapping: statementMapping(db, bankId) ?? undefined });
      showResult(f, result, hash);
    } catch (e) { fail(e); } finally { setBusy(false); }
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

      <CollapsibleSection title={t('bankStatement.openLines')} count={openLines.length} icon="invoice" pageKey="stmtOpen">
        {() => openLines.map((l) => (
          <Card key={l.id}>
            {lineHead(l)}
            {l.status === 'excluded' ? <T size={TYPE.caption} color={C.muted}>{t('bankStatement.excludedAs', { note: l.note })}</T> : null}
            <Row style={{ marginTop: 6 }}>
              {l.status === 'open' && perm.add ? <BtnGhost small title={t('bankStatement.record')} onPress={() => setRecord({
                line: l, kind: l.amount < 0 ? 'fee' : 'income', amount: fmt(Math.abs(l.amount)).replace(/,/g, ''), date: l.date, descr: l.descr,
              })} /> : null}
              {l.status === 'open' && perm.manage ? <BtnGhost small title={t('bankStatement.exclude')} onPress={() => setExclude({ line: l, note: '' })} /> : null}
              {l.status === 'excluded' && perm.manage ? <BtnGhost small title={t('bankStatement.reopen')} onPress={() => {
                try { unmatchLine(db, l.id); bump(); } catch (e) { fail(e); }
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
                {rep.unexplained ? <Note tone="danger">{t('bankStatement.unexplained', { amount: fmt(rep.unexplained) })}</Note> : null}
                {([['onlyStatement', rep.onlyInStatement], ['onlyBooks', rep.onlyInBooks], ['excludedLines', rep.excluded]] as const).map(([k, xs]) => (
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

      {/* الافتتاحي والختامي من رأس كشفٍ بلا أرصدة */}
      <Sheet visible={!!ask} onClose={() => setAsk(null)} title={t('bankStatement.needTitle')}
        footer={<View style={{ flex: 1 }}><BtnPrimary title={t('bankStatement.read')} onPress={() => {
          if (!ask) return;
          const opening = toHalalas(ask.opening);
          const closing = toHalalas(ask.closing);
          const file = ask.file;
          setAsk(null);
          try {
            const { result, hash } = readStatementFromFile(file, { mapping: statementMapping(db, bankId) ?? undefined, opening, closing });
            showResult(file, result.ok || result.error !== 'needBalances' ? result : { ok: false, error: 'balance' }, hash);
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

      {/* تسجيل حركةٍ لسطرٍ غير مطابق: مسار التطبيق المعتاد (recordManualBankTx بكفايته) معبأً من السطر */}
      <Sheet visible={!!record} onClose={() => setRecord(null)} title={t('bankStatement.recordTitle')}
        footer={<View style={{ flex: 1 }}><BtnPrimary title={t('common.save')} onPress={() => {
          if (!record) return;
          try {
            recordManualBankTx(db, { kind: record.kind, bankId, amountHalalas: toHalalas(record.amount), date: record.date, descr: record.descr });
            setRecord(null); bump();
          } catch (e) { fail(e); }
        }} /></View>}>
        {record ? (
          <>
            {lineHead(record.line)}
            <ChipGroup<ManualBankKind> value={record.kind} onChange={(k) => setRecord({ ...record, kind: k })}
              options={(record.line.amount < 0 ? ['fee', 'withdraw'] : ['income', 'deposit']).map((k) => [k as ManualBankKind, t('bankStatement.kind.' + k)])} />
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

/**
 * تفاصيل القسط بالضغط على صفّه: الاستحقاق والموعد المتفق عليه والمهلة والمسدَّد
 * والمتبقي والحالة ودفعاته (كلٌّ بسندها) والقيود، مع [تحصيل] و[تعديل] و[عرض القيد].
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Sheet } from './Sheet';
import { ErrorBoundary } from './ErrorBoundary';
import { Row, T, Num, Money, Badge, BtnGhost, BtnIcon, BtnPrimary, Field, KV } from './components';
import { DateField } from './DateField';
import { useApp } from './store';
import { useToast } from './Toast';
import { useDialog, confirmDiscard } from './AppDialog';
import { C } from './theme';
import { setInstallmentSchedule, paymentForInstallment } from '../domain/contracts/service';
import { installmentRemaining } from '../domain/contracts/installments';
import { printReceipt } from '../services/print';
import { dfmt, today, daysBetween, periodLabel } from '../domain/dates';
import { fmt } from '../domain/money';
import { reportFailure } from './failureDialog';
import { CancelPaymentSheet } from './CancelPaymentPanel';
import { usePerm } from './access';
import { useSaveAttempt } from './formAttempt';

export function InstallmentSheet(props: {
  installmentId: string;
  onClose: () => void;
  onCollect: (installmentId: string) => void;
}) {
  return (
    <Sheet visible onClose={props.onClose} title="تفاصيل القسط" tall>
      <ErrorBoundary where="تفاصيل القسط" onClose={props.onClose}>
        <InstallmentBody {...props} />
      </ErrorBoundary>
    </Sheet>
  );
}

function InstallmentBody({ installmentId, onClose, onCollect }: {
  installmentId: string;
  onClose: () => void;
  /** يقفل الأوراق ويفتح السداد على هذا القسط */
  onCollect: (installmentId: string) => void;
}) {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const dialog = useDialog();
  // التحصيل إضافة · وإلغاء الدفعة وتعديل الموعد تعديلٌ في التحصيل (كامل)
  const perm = usePerm('collect');
  const [editOpen, setEditOpen] = useState(false);
  const [agreed, setAgreed] = useState('');
  const [grace, setGrace] = useState('');
  const [reason, setReason] = useState('');
  const [entryFor, setEntryFor] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<string | null>(null);

  const data = useMemo(() => {
    const i = db.get<{
      id: string; contract_id: string; due_date: string; amount_halalas: number; paid_halalas: number;
      status: string; agreed_date: string | null; grace_until: string | null;
    }>(`SELECT * FROM contract_installments WHERE id = ?`, [installmentId]);
    if (!i) return null;
    // الدفعات التي سدّدت هذا القسط · مصدر واحد بلا ازدواج: التخصيصات أولاً بمبلغها
    // المخصَّص، والمباشرة عبر installment_id تُحسب فقط إن لم يكن لها أي صف تخصيص
    const pays = db.all<{
      id: string; date: string; net_halalas: number; discount_halalas: number; method_label: string; journal_entry_id: string | null; alloc: number | null;
      cancelled_at: string | null; cancel_reason: string;
    }>(
      `SELECT p.id, p.date, p.net_halalas, p.discount_halalas, p.method_label, p.journal_entry_id, a.amount_halalas AS alloc, p.cancelled_at, p.cancel_reason
       FROM payment_allocations a JOIN contract_payments p ON p.id = a.payment_id
       WHERE a.installment_id = ?
       UNION ALL
       SELECT p.id, p.date, p.net_halalas, p.discount_halalas, p.method_label, p.journal_entry_id, NULL AS alloc, p.cancelled_at, p.cancel_reason
       FROM contract_payments p WHERE p.installment_id = ?
         AND NOT EXISTS (SELECT 1 FROM payment_allocations x WHERE x.payment_id = p.id)
       ORDER BY date`,
      [installmentId, installmentId]
    );
    // خصم القسط · من دفعاته المباشرة وحدها (التخصيصات الجماعية بلا خصم)
    const discount = pays.reduce((s, p) => s + (p.alloc == null && !p.cancelled_at ? Number(p.discount_halalas) : 0), 0);
    const T_ = today();
    // العقد الملغى لا يُحصَّل عليه · الخدمة ترفض السداد فلا يُعرض زر التحصيل أصلاً
    const contractCancelled = db.get<{ status: string }>(
      `SELECT status FROM contracts WHERE id = ?`, [i.contract_id]
    )?.status === 'ملغى';
    // سند القبض بلا دفعة في القائمة: يُعرض فقط إن وُجد سند فعلاً
    const fallbackPayment = pays.length ? null : paymentForInstallment(db, i.id);
    const remaining = installmentRemaining(Number(i.amount_halalas), Number(i.paid_halalas), discount);
    const effectiveDue = i.agreed_date || i.due_date;
    let daysLate = effectiveDue ? daysBetween(T_, effectiveDue) : 0;
    if (i.grace_until && T_ <= i.grace_until) daysLate = Math.min(daysLate, 0);
    let status: string;
    let kind: string;
    if (i.status === 'ملغية') { status = 'ملغاة'; kind = 'draft'; }
    else if (remaining <= 0) { status = 'مدفوعة'; kind = 'paid'; }
    else if (Number(i.paid_halalas) > 0 && daysLate > 0) { status = `مدفوعة جزئياً · متأخرة ${daysLate} يوماً`; kind = 'overdue'; }
    else if (Number(i.paid_halalas) > 0) { status = 'مدفوعة جزئياً'; kind = 'due'; }
    else if (daysLate > 0) { status = `متأخرة ${daysLate} يوماً`; kind = 'overdue'; }
    else { status = 'مستحقة'; kind = 'due'; }
    return { i, pays, discount, remaining, status, kind, contractCancelled, fallbackPayment };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, installmentId]);

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

  const attempt = useSaveAttempt();

  if (!data) return null;
  const { i, pays, discount, remaining, status, kind, contractCancelled, fallbackPayment } = data;
  // القسط المسدَّد كلياً أو الملغي لا موعد له يُعدَّل · والعقد الملغى لا يُحصَّل
  const scheduleEditable = remaining > 0 && i.status !== 'ملغية' && perm.manage;
  const collectable = remaining > 0 && i.status !== 'ملغية' && !contractCancelled && perm.add;

  const saveSchedule = () => {
    try {
      setInstallmentSchedule(db, i.id, {
        agreedDate: agreed || null,
        graceUntil: grace || null,
        reason,
      });
      bump();
      setEditOpen(false);
      toast('حُفظ الموعد وسُجّل السبب في سجل العمليات');
    } catch (e) { reportFailure({ title: 'تعذّر الحفظ', e }); }
  };

  // الخانة الواحدة لكل بطاقة تفاصيل · تغيب بعنوانها إن غابت قيمتها
  const cell = (label: string, v: React.ReactNode) => <KV label={label} v={v} flex />;

  return (
    <View>
      <T size={13.5} bold color={C.ink} style={{ marginBottom: 8 }}>{'قسط ' + periodLabel(i.due_date)}</T>
      <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <Badge kind={kind} label={status} />
        {i.agreed_date ? <Badge kind="due" label="موعد متفق عليه" /> : null}
      </Row>
      <Row style={{ marginBottom: 8 }}>
        {cell('الاستحقاق', <Num size={12.5} bold>{dfmt(i.due_date)}</Num>)}
        {cell('المبلغ', <Money halalas={Number(i.amount_halalas)} size={12.5} bold />)}
      </Row>
      <Row style={{ marginBottom: 8 }}>
        {cell('المسدَّد', <Money halalas={Number(i.paid_halalas)} size={12.5} bold color={C.emerald} />)}
        {/* الخصم بندٌ ظاهر لا يُطوى في المسدَّد · ويغيب مع عنوانه إن لم يكن */}
        {discount > 0 ? cell('الخصم', <Money halalas={discount} size={12.5} bold color={C.gold} />) : null}
        {cell('المتبقي', <Money halalas={remaining} size={12.5} bold color={remaining > 0 ? C.rose : C.emerald} />)}
      </Row>
      {(i.agreed_date || i.grace_until) ? (
        <Row style={{ marginBottom: 8 }}>
          {i.agreed_date ? cell('الموعد المتفق عليه', <Num size={12.5} bold color={'#1D4ED8'}>{dfmt(i.agreed_date)}</Num>) : <View style={{ flex: 1 }} />}
          {i.grace_until ? cell('مهلة سداد حتى', <Num size={12.5} bold>{dfmt(i.grace_until)}</Num>) : <View style={{ flex: 1 }} />}
        </Row>
      ) : null}

      {/* تعديل الموعد في ورقته الخاصة فوق ورقة القسط (قرار المالك 2026-10-07) · السبب إلزامي ويُسجَّل */}
      {editOpen ? (
        <Sheet visible onClose={() => setEditOpen(false)} title="تعديل الموعد"
          footer={<View style={{ flex: 1 }}><BtnPrimary title="حفظ" onPress={() => attempt.attempt(!!reason.trim(), saveSchedule)} /></View>}>
          <DateField label="موعد سداد متفق عليه" value={agreed} onChange={setAgreed} />
          <DateField label="مهلة سداد حتى" value={grace} onChange={setGrace} />
          <Field label="السبب" value={reason} onChange={setReason} error={attempt.missing(reason)} />
          {/* لا اتفاق قائم فلا شيء يُزال */}
          {i.agreed_date || i.grace_until ? (
            <BtnGhost small danger title="إزالة الاتفاق" onPress={() => {
              try {
                setInstallmentSchedule(db, i.id, { agreedDate: null, graceUntil: null, reason: reason || 'إزالة الاتفاق' });
                bump(); setEditOpen(false); toast('أُزيل الاتفاق ورجع القسط لاستحقاقه الأصلي');
              } catch (e) { reportFailure({ title: 'تعذّر إزالة الاتفاق', e }); }
            }} />
          ) : null}
        </Sheet>
      ) : null}

      {/* قائمة الدفعات */}
      {true ? (
        <>
          <T size={13} bold color={C.ink} style={{ marginTop: 6, marginBottom: 6 }}>الدفعات ({pays.length})</T>
          {pays.length ? pays.map((p, idx) => (
            <View key={p.id + ':' + idx} style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Num size={11.5} color={C.muted}>{dfmt(p.date)}</Num>
                <Row gap={8}>
                  <Money halalas={Number(p.alloc ?? p.net_halalas)} size={12} bold color={p.cancelled_at ? C.muted : undefined} />
                  <T size={11.5} color={C.muted}>{p.method_label}</T>
                </Row>
              </Row>
              {p.cancelled_at ? (
                <T size={11.5} color={C.rose} style={{ marginTop: 2 }}>ملغاة {dfmt(p.cancelled_at)} · {p.cancel_reason}</T>
              ) : null}
              <Row style={{ justifyContent: 'flex-end', marginTop: 4 }}>
                {!p.cancelled_at && perm.manage ? (
                  <BtnGhost small danger title="إلغاء الدفعة" onPress={() => setCancelFor((c) => (c === p.id ? null : p.id))} />
                ) : null}
                {!p.cancelled_at ? (
                  <BtnGhost small icon="print" title="سند القبض"
                    onPress={() => printReceipt(db, p.id, 'tenant').catch(() => toast('تعذّرت الطباعة'))} />
                ) : null}
                {p.journal_entry_id ? (
                  <BtnGhost small title="عرض القيد" onPress={() => setEntryFor((c) => (c === p.journal_entry_id ? null : p.journal_entry_id))} />
                ) : null}
              </Row>
              {cancelFor === p.id ? <CancelPaymentSheet paymentId={p.id} onClose={() => setCancelFor(null)} /> : null}
            </View>
          )) : <T size={12} color={C.muted}>لا دفعات على هذا القسط بعد</T>}

          {remaining <= 0 && i.status !== 'ملغية' && fallbackPayment ? (
            <BtnGhost small icon="print" title="سند القبض"
              onPress={() => printReceipt(db, fallbackPayment, 'tenant').catch(() => toast('تعذّرت الطباعة'))} />
          ) : null}
        </>
      ) : null}

      {/* القيد داخل الورقة نفسها · الرجوع يعيدك من حيث أتيت */}
      {entry ? (
        <View style={{ backgroundColor: C.paper, borderRadius: 10, padding: 12, marginTop: 10, borderWidth: 1, borderColor: C.line }}>
          <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <T size={12.5} bold>{entry.no} · {dfmt(entry.date)}</T>
            <BtnIcon icon="x" accessibilityLabel="إغلاق القيد" onPress={() => setEntryFor(null)} />
          </Row>
          <T size={11.5} color={C.muted} style={{ marginBottom: 6 }}>{entry.memo}</T>
          {entry.lines.map((l, li) => (
            <Row key={li} style={{ justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
              <T size={11.5} style={{ flex: 1 }}>{l.account_code} · {l.name}</T>
              <Num size={11.5}>{Number(l.debit_halalas) ? 'مدين ' + fmt(Number(l.debit_halalas)) : 'دائن ' + fmt(Number(l.credit_halalas))}</Num>
            </Row>
          ))}
        </View>
      ) : null}
      {/* لا صفَّ أزرار لقسط لا يقبل تحصيلاً ولا تعديل موعد */}
      {collectable || scheduleEditable ? (
        <Row style={{ marginTop: 12 }}>
          {collectable ? (
            <View style={{ flex: 1 }}><BtnPrimary title="تحصيل" onPress={() => onCollect(i.id)} /></View>
          ) : null}
          {scheduleEditable ? (
            <View style={{ flex: 1 }}>
              {/* الضغط ثانيةً يطوي اللوحة · وما كُتب فيها لا يُمحى بلا تأكيد */}
              <BtnGhost title="تعديل الموعد" onPress={() => {
                if (editOpen) {
                  const dirty = reason.trim() !== '' || agreed !== (i.agreed_date ?? '') || grace !== (i.grace_until ?? '');
                  if (dirty) confirmDiscard(dialog, () => setEditOpen(false)); else setEditOpen(false);
                  return;
                }
                setAgreed(i.agreed_date ?? '');
                setGrace(i.grace_until ?? '');
                setReason('');
                setEditOpen(true);
              }} />
            </View>
          ) : null}
        </Row>
      ) : null}
      <View style={{ height: 12 }} />
    </View>
  );
}

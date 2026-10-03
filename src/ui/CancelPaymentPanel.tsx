/**
 * «إلغاء الدفعة» · لوحة المعاينة والتأكيد (قرار المالك ٢٠٢٦-١٠-٠٣ · cancelPayment.ts).
 * تعرض قبل التنفيذ: القيود التي تُعكس برقمها ومبلغها، وكل قسط بمسدَّده قبل وبعد، وحركة البنك،
 * وما يُطرح من الرصيد الدائن، ورجوع التنزيل إلى مبلغ القسط · ثم التاريخ والسبب والتأكيد.
 * وما يمنع الإلغاء يُعرض بسببه ولا يظهر زر التأكيد (القاعدة ٧).
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Row, T, Money, BtnGhost, BtnPrimary, Field } from './components';
import { DateField } from './DateField';
import { useApp } from './store';
import { useToast } from './Toast';
import { C } from './theme';
import { planCancelPayment, cancelPayment } from '../domain/contracts/cancelPayment';
import { dfmt, today } from '../domain/dates';
import { fmt } from '../domain/money';
import { reportFailure } from './failureDialog';

export function CancelPaymentPanel({ paymentId, onClose, onDone }: {
  paymentId: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const plan = useMemo(() => {
    try { return planCancelPayment(db, paymentId, date || today()); } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, paymentId, date]);
  if (!plan) return null;

  const line = (label: string, v: React.ReactNode, key?: string) => (
    <Row key={key ?? label} style={{ justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.paperLine }}>
      <T size={12} style={{ flex: 1 }}>{label}</T>
      {v}
    </Row>
  );

  const confirm = () => {
    try {
      cancelPayment(db, paymentId, { date, reason });
      bump();
      toast('أُلغيت الدفعة · عُكس قيدها ورجع مسدَّد القسط');
      onDone?.();
      onClose();
    } catch (e) { reportFailure({ title: 'تعذّر إلغاء الدفعة', where: 'إلغاء دفعة', db, e }); }
  };

  return (
    <View style={{ backgroundColor: C.paper, borderRadius: 10, padding: 12, marginTop: 6, borderWidth: 1, borderColor: C.line }}>
      <T size={13} bold color={C.ink} style={{ marginBottom: 6 }}>إلغاء الدفعة · {plan.tenant}</T>
      {plan.entries.map((e) => line('عكس القيد ' + e.no, <Money halalas={e.amount} size={12} bold />, e.id))}
      {plan.installments.map((i) => line('قسط ' + dfmt(i.due),
        <T size={12} bold>{fmt(i.fromPaid)} ← {fmt(i.toPaid)}</T>, i.id))}
      {plan.restoreAmount ? line('يرجع مبلغ القسط بالتنزيل', <Money halalas={plan.restoreAmount.by} size={12} bold />) : null}
      {plan.bank.map((b, k) => line('حركة سالبة في ' + (b.bankName || 'البنك'), <Money halalas={-b.amount} size={12} bold color={C.rose} />, 'b' + k))}
      {plan.creditReversal > 0 ? line('يُطرح من رصيد المستأجر الدائن', <Money halalas={plan.creditReversal} size={12} bold />) : null}

      {plan.blockers.length ? (
        <>
          {plan.blockers.map((b, k) => <T key={k} size={12} color={C.rose} style={{ marginTop: 6 }}>{b}</T>)}
          <View style={{ marginTop: 10 }}><BtnGhost small title="رجوع" onPress={onClose} /></View>
        </>
      ) : (
        <>
          <View style={{ marginTop: 8 }}>
            <DateField label="تاريخ الإلغاء" value={date} onChange={setDate} />
            <Field label="السبب" value={reason} onChange={setReason} error={!reason.trim()} />
          </View>
          <Row>
            <View style={{ flex: 1 }}><BtnGhost small title="رجوع" onPress={onClose} /></View>
            {reason.trim() ? (
              <View style={{ flex: 1 }}><BtnPrimary small danger title="تأكيد الإلغاء" onPress={confirm} /></View>
            ) : null}
          </Row>
        </>
      )}
    </View>
  );
}

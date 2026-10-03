/**
 * إلغاء القيد التلقائي من عمليته الأصلية · يُفتح من «عكس القيد» في الدفتر (sourceCancel.ts):
 * قيد دفعة ← لوحة «إلغاء الدفعة» نفسها · وعملية لها إلغاؤها ← آثارها ثم التاريخ والسبب والتأكيد ·
 * وما له شاشة مستند ← زرّ يفتح المستند ليُلغى منه. وما يمنع يُعرض بسببه ولا يظهر التأكيد.
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Sheet } from './Sheet';
import { T, Row, BtnGhost, BtnPrimary, Field } from './components';
import { DateField } from './DateField';
import { useApp } from './store';
import { useToast } from './Toast';
import { C } from './theme';
import { CancelPaymentPanel } from './CancelPaymentPanel';
import { entrySourceRoute } from './EntrySheet';
import { entrySourceAction } from '../domain/accounting/sourceCancel';
import { today } from '../domain/dates';
import { reportFailure } from './failureDialog';

export function SourceCancelSheet({ entryId, entryNo, onClose }: { entryId: string; entryNo: string; onClose: () => void }) {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const router = useRouter();
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const action = useMemo(() => entrySourceAction(db, entryId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, entryId]);
  const src = useMemo(() => db.get<{ t: string | null; s: string | null }>(
    `SELECT src_type AS t, src_id AS s FROM journal_entries WHERE id = ?`, [entryId]), [db, entryId]);

  return (
    <Sheet visible onClose={onClose} title={'إلغاء القيد ' + entryNo + ' من مصدره'}>
      {!action ? (
        <T size={12.5} color={C.muted}>لا عملية إلغاء لهذا القيد</T>
      ) : action.kind === 'payment' ? (
        <CancelPaymentPanel paymentId={action.paymentId} onClose={onClose} />
      ) : action.kind === 'document' ? (
        <View>
          <T size={12.5} style={{ marginBottom: 10 }}>يُلغى هذا القيد من مستنده · يُفتح المستند وفيه عملية الإلغاء أو التعديل.</T>
          {entrySourceRoute(db, src?.t ?? null, src?.s ?? null) ? (
            <BtnPrimary title="فتح المستند" onPress={() => {
              const r = entrySourceRoute(db, src?.t ?? null, src?.s ?? null);
              onClose();
              if (r) router.push(r as never);
            }} />
          ) : null}
        </View>
      ) : (
        <View>
          <T size={13} bold style={{ marginBottom: 6 }}>{action.label}</T>
          {action.effects.map((x, k) => <T key={k} size={12} style={{ marginBottom: 3 }}>· {x}</T>)}
          {action.blockers.length ? (
            action.blockers.map((b, k) => <T key={'b' + k} size={12} color={C.rose} style={{ marginTop: 6 }}>{b}</T>)
          ) : (
            <>
              <View style={{ marginTop: 8 }}>
                <DateField label="تاريخ الإلغاء" value={date} onChange={setDate} />
                <Field label="السبب" value={reason} onChange={setReason} error={!reason.trim()} />
              </View>
              <Row>
                <View style={{ flex: 1 }}><BtnGhost small title="رجوع" onPress={onClose} /></View>
                {reason.trim() ? (
                  <View style={{ flex: 1 }}>
                    <BtnPrimary small danger title={'تأكيد ' + action.label} onPress={() => {
                      try { action.run(date, reason); bump(); toast('تمّ: ' + action.label); onClose(); }
                      catch (e) { reportFailure({ title: 'تعذّر ' + action.label, where: action.label, db, e }); }
                    }} />
                  </View>
                ) : null}
              </Row>
            </>
          )}
        </View>
      )}
    </Sheet>
  );
}

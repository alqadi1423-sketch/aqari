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
import { useAccess } from './access';
import { entrySourceAction } from '../domain/accounting/sourceCancel';
import { isOrphanEntry } from '../domain/accounting/orphans';
import { DISCOUNT_ENTRY_SRC } from '../domain/contracts/installments';
import { canManage } from '../domain/access/access';
import { routeAllowed } from '../domain/access/routes';
import type { SectionKey } from '../domain/access/sections';
import { today } from '../domain/dates';
import { reportFailure } from './failureDialog';

/** قسم العملية التي يُلغى منها القيد · الإلغاء كامل فيه وفي الدفتر معاً */
const SOURCE_SECTION: Record<string, SectionKey> = {
  [DISCOUNT_ENTRY_SRC]: 'collect',
  surplus_refund: 'collect',
  surplus_credit: 'collect',
  cash_op: 'banks',
  key_money: 'reservations',
  vat_refund: 'purchases',
};

export function SourceCancelSheet({ entryId, entryNo, onClose }: { entryId: string; entryNo: string; onClose: () => void }) {
  const { db, version, bump } = useApp();
  const toast = useToast();
  const router = useRouter();
  const access = useAccess();
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const action = useMemo(() => entrySourceAction(db, entryId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, entryId]);
  const src = useMemo(() => db.get<{ t: string | null; s: string | null }>(
    `SELECT src_type AS t, src_id AS s FROM journal_entries WHERE id = ?`, [entryId]), [db, entryId]);
  // القيد بلا مستند يُعكس في الدفتر وحده · وغيره يحتاج كاملاً في قسم عمليته أيضاً
  const srcSection: SectionKey = action?.kind === 'op' && !isOrphanEntry(db, entryId)
    ? SOURCE_SECTION[src?.t ?? ''] ?? 'ledger'
    : 'ledger';
  const canRun = canManage(access, 'ledger') && canManage(access, srcSection);
  const docRoute = action?.kind === 'document' ? entrySourceRoute(db, src?.t ?? null, src?.s ?? null) : null;
  const openDoc = docRoute && routeAllowed(access, docRoute.split('?')[0]) ? docRoute : null;

  return (
    <Sheet visible onClose={onClose} title={'إلغاء القيد ' + entryNo + ' من مصدره'}>
      {!action ? (
        <T size={12.5} color={C.muted}>لا عملية إلغاء لهذا القيد</T>
      ) : action.kind === 'payment' ? (
        <CancelPaymentPanel paymentId={action.paymentId} onClose={onClose} />
      ) : action.kind === 'document' ? (
        <View>
          <T size={12.5} style={{ marginBottom: 10 }}>يُلغى هذا القيد من مستنده · يُفتح المستند وفيه عملية الإلغاء أو التعديل.</T>
          {openDoc ? (
            <BtnPrimary title="فتح المستند" onPress={() => {
              onClose();
              router.push(openDoc as never);
            }} />
          ) : null}
        </View>
      ) : (
        <View>
          <T size={13} bold style={{ marginBottom: 6 }}>{action.label}</T>
          {action.effects.map((x, k) => <T key={k} size={12} style={{ marginBottom: 3 }}>· {x}</T>)}
          {action.blockers.length ? (
            action.blockers.map((b, k) => <T key={'b' + k} size={12} color={C.rose} style={{ marginTop: 6 }}>{b}</T>)
          ) : canRun ? (
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
          ) : null}
        </View>
      )}
    </Sheet>
  );
}

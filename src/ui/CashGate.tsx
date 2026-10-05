/**
 * كفاية النقد في الواجهة (قرار المالك ٢٠٢٦-١٠-٠٥) · عند عدم الكفاية لا يظهر زر الصرف، ومكانه السبب ورابط
 * «إيداع المالك» بالمبلغ الناقص يفتح نافذته معبّأةً. والرابط لمن له إضافة في «البنوك والنقد» وحده.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { BtnGhost, BtnPrimary, Field, Note, T } from './components';
import { Sheet } from './Sheet';
import { DateField } from './DateField';
import { C, TYPE } from './theme';
import { useApp } from './store';
import { useToast } from './Toast';
import { usePerm } from './access';
import { reportFailure } from './failureDialog';
import { cashShortfall } from '../domain/cashGuard';
import { walletCashBalance } from '../domain/accounting/ledger';
import { ownerCashIn } from '../domain/cashOps';
import { fmt, toHalalas } from '../domain/money';
import { today } from '../domain/dates';

/** نافذة «إيداع المالك» معبّأة بمبلغ */
export function OwnerCashInSheet({ amountHalalas, onClose }: { amountHalalas: number; onClose: () => void }) {
  const { db, bump } = useApp();
  const toast = useToast();
  const [amount, setAmount] = useState(fmt(amountHalalas).replace(/,/g, ''));
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState('');
  const v = toHalalas(amount);
  return (
    <Sheet visible onClose={onClose} title="إيداع المالك"
      footer={v > 0 ? <BtnPrimary title={'إيداع ' + fmt(v)} onPress={() => {
        try { ownerCashIn(db, { amountHalalas: v, date, notes }); bump(); toast('أُودع ' + fmt(v) + ' في المحفظة'); onClose(); }
        catch (e) { reportFailure({ title: 'تعذّر الإيداع', e }); }
      }} /> : null}>
      <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 8 }}>
        يُقيَّد نقداً في المحفظة من رأس المال · فيكفي النقد للصرف الذي طلبته
      </T>
      <Field label="المبلغ" value={amount} onChange={setAmount} keyboard="numeric" ltr />
      <DateField label="التاريخ" value={date} onChange={setDate} />
      <Field label="ملاحظة" value={notes} onChange={setNotes} />
    </Sheet>
  );
}

/** سبب عدم الكفاية ورابط الإيداع · null إن كفى النقد */
export function CashShortNote({ needed, what }: { needed: number; what: string }) {
  const { db, version } = useApp();
  const canDeposit = usePerm('banks').add;
  const [open, setOpen] = useState(false);
  void version; // تُعاد القراءة بعد كل كتابة
  const short = cashShortfall(db, needed);
  if (short <= 0) return null;
  const have = Math.max(0, walletCashBalance(db));
  return (
    <View style={{ marginBottom: 8 }}>
      <Note tone="danger">{'النقد في المحفظة ' + fmt(have) + ' لا يكفي: ' + what + ' بمبلغ ' + fmt(needed) + ' · ينقصه ' + fmt(short)}</Note>
      {canDeposit ? <BtnGhost small icon="plus" title={'إيداع المالك · ' + fmt(short)} onPress={() => setOpen(true)} /> : null}
      {open ? <OwnerCashInSheet amountHalalas={short} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}

/** رابط «إيداع المالك» بالناقص وحده · لمن تُعرض له موانع بسببٍ نقدي */
export function DepositLink({ amountHalalas }: { amountHalalas: number }) {
  const canDeposit = usePerm('banks').add;
  const [open, setOpen] = useState(false);
  if (!(amountHalalas > 0) || !canDeposit) return null;
  return (
    <View style={{ marginTop: 8 }}>
      <BtnGhost small icon="plus" title={'إيداع المالك · ' + fmt(amountHalalas)} onPress={() => setOpen(true)} />
      {open ? <OwnerCashInSheet amountHalalas={amountHalalas} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}

/** الزر حين يكفي النقد · وإلا السبب ورابط الإيداع مكانه */
export function CashGate({ needed, what, children }: { needed: number; what: string; children: React.ReactNode }) {
  const { db, version } = useApp();
  void version;
  return cashShortfall(db, needed) > 0 ? <CashShortNote needed={needed} what={what} /> : <>{children}</>;
}

/** هل يكفي النقد · لما يُبنى زرّه في قائمة (حوار أو قائمة إجراءات) */
export function useCashOk(needed: number): boolean {
  const { db, version } = useApp();
  void version;
  return cashShortfall(db, needed) <= 0;
}

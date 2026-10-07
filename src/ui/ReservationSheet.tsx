/**
 * حجز الوحدة بعربون · نافذة مشتركة تفتحها شاشتا العقارات والوحدات.
 * الرفض يظهر في مربع تنبيه ثابت بسببه الكامل، لا في إشعار عابر.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { Sheet } from './Sheet';
import { Field, Row, BtnGhost, BtnPrimary } from './components';
import { DateField } from './DateField';
import { useApp } from './store';
import { createReservation } from '../domain/reservations';
import { toHalalas } from '../domain/money';
import { reportFailure } from './failureDialog';

import { CostCenterField } from './CostCenters';
import { GENERAL_COST_CENTER, withCostCenter } from '../domain/accounting/dimensions';
export function ReservationSheet({
  unitId, onClose, onDone,
}: { unitId: string; onClose: () => void; onDone: () => void }) {
  const { db } = useApp();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [deposit, setDeposit] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cc, setCc] = useState(GENERAL_COST_CENTER);
  return (
    <Sheet visible onClose={onClose} title="حجز الوحدة بعربون"
      footer={
        <>
          <View style={{ flex: 1 }}>
            <BtnPrimary title="تأكيد الحجز" onPress={() => {
              try {
                withCostCenter(cc, () => createReservation(db, { unitId, name, phone, depositHalalas: toHalalas(deposit), expiryDate: expiry }));
                onDone();
              } catch (e) {
                reportFailure({ title: 'تعذّر الحجز', e });
              }
            }} />
          </View>
        </>
      }>
      <Field label="اسم صاحب الحجز" value={name} onChange={setName} />
      <Field label="رقم الجوال" value={phone} onChange={setPhone} keyboard="phone-pad" ltr />
      <Row>
        <View style={{ flex: 1 }}><Field label="مبلغ العربون" value={deposit} onChange={setDeposit} keyboard="numeric" ltr /></View>
        <View style={{ flex: 1 }}><DateField label="الحجز ساري حتى تاريخ" value={expiry} onChange={setExpiry} /></View>
      </Row>
      <CostCenterField value={cc} onChange={setCc} />
    </Sheet>
  );
}

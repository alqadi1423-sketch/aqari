/**
 * فواتير العداد وقراءاته · تُفتح بالضغط على أي عداد في تفاصيل الوحدة أو العقار.
 * كل صف: التاريخ والقراءة والمبلغ ومرجع الفاتورة.
 */
import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Sheet } from './Sheet';
import { T, Num, Money, Row, EmptyState } from './components';
import { Icon, type IconName } from './icons';
import { useApp } from './store';
import { C } from './theme';
import { meterReadings, METER_ICON, type LabeledMeter } from '../domain/meters';
import { dfmt } from '../domain/dates';

export function MeterSheet({ meter, onClose }: { meter: LabeledMeter; onClose: () => void }) {
  const { db, version } = useApp();
  // الاستعلامان محفوظان: كانا في جسد التصيير فيتكرران مع كل إعادة تصيير
  // (قيست الورقة بستين استعلاماً لفتحة واحدة) · الآن مرة لكل بيانات
  const rows = useMemo(() => meterReadings(db, meter.id), [db, version, meter.id]);
  const supplier = useMemo(
    () => (meter.supplier_id
      ? db.get<{ name: string }>(`SELECT name FROM suppliers WHERE id = ?`, [meter.supplier_id])?.name
      : null),
    [db, version, meter.supplier_id]
  );
  const total = rows.reduce((s, r) => s + Number(r.amount_halalas), 0);
  return (
    <Sheet visible onClose={onClose} title={'عداد ' + meter.kind} tall>
      <Row style={{ justifyContent: 'space-between', marginBottom: 4 }}>
        <Row gap={7}>
          <Icon name={(METER_ICON[meter.kind] ?? 'settings') as IconName} size={18}
            color={meter.kind === 'كهرباء' ? C.gold : meter.kind === 'ماء' ? '#2E7CB8' : C.emerald} />
          <T size={13} bold>{meter.label}</T>
        </Row>
      </Row>
      <Row style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        {meter.number ? <View><T size={11} color={C.muted}>رقم العداد</T><Num size={12.5}>{meter.number}</Num></View> : null}
        {supplier ? <View><T size={11} color={C.muted}>المورد</T><T size={12.5}>{supplier}</T></View> : null}
        <View><T size={11} color={C.muted}>إجمالي الفواتير</T><Money halalas={total} size={12.5} bold /></View>
      </Row>

      {rows.length ? rows.map((r, i) => (
        <View key={i} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Num size={12} bold>{dfmt(r.date)}</Num>
            <Money halalas={Number(r.amount_halalas)} size={12.5} bold color={C.rose} />
          </Row>
          <Row style={{ justifyContent: 'space-between', marginTop: 3 }}>
            <T size={11.5} color={C.muted}>{r.ref ? 'فاتورة ' + r.ref : 'بلا مرجع'}</T>
            {r.reading != null ? <Num size={11.5} color={C.muted}>القراءة {String(r.reading)}</Num> : null}
          </Row>
        </View>
      )) : <EmptyState>لا فواتير مسجَّلة على هذا العداد بعد · تُسجَّل تلقائياً عند ربطه في فاتورة شراء</EmptyState>}
    </Sheet>
  );
}

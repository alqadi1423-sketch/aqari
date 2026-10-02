/** فحص المطابقة · الفحوص الستة تربط الدفتر بالعمليات */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Screen } from '../src/ui/Screen';
import { Card, T, Num, Row, BtnPrimary } from '../src/ui/components';
import { useApp } from '../src/ui/store';
import { C } from '../src/ui/theme';
import { Icon } from '../src/ui/icons';
import { integrityChecks } from '../src/domain/accounting/integrity';

export default function Integrity() {
  const { db, version } = useApp();
  const [tick, setTick] = useState(0);
  const checks = useMemo(() => integrityChecks(db),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, version, tick]);
  const ok = checks.every((c) => c.ok);
  return (
    <Screen title="فحص المطابقة"
      actions={<BtnPrimary small title="أعد الفحص" onPress={() => setTick((t) => t + 1)} />}>
      <Card>
        <View style={{
          borderRadius: 8, padding: 11, alignItems: 'center', marginBottom: 10,
          backgroundColor: ok ? C.emeraldSoft : C.roseSoft,
        }}>
          <T size={13} bold color={ok ? C.emerald : C.rose}>
            {ok ? 'الدفتر يطابق العمليات' : 'يوجد انفصال بين الدفتر والعمليات'}
          </T>
        </View>
        {/* سطران لكل فحص: الاسم يلتف كاملاً والرقم تحته كاملاً · لا يُقصّ رقم في أي شاشة */}
        {checks.map((c) => (
          <View key={c.name} style={{ paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <Row gap={6} style={{ alignItems: 'flex-start' }}>
              <Icon name={c.ok ? 'check' : 'cancel'} size={14} color={c.ok ? C.emerald : C.rose} />
              <T size={12.5} style={{ flex: 1 }}>{c.name}</T>
            </Row>
            <Num size={12.5} bold color={c.ok ? C.emerald : C.rose}
              style={{ marginTop: 4, marginStart: 20, textAlign: 'left' }}>
              {c.value}
            </Num>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

/**
 * هيكل تحميل يظهر لحظة فتح الشاشة قبل اكتمال بياناتها · صناديق باهتة بلا نص.
 */
import React from 'react';
import { View } from 'react-native';
import { C } from './theme';

export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <View>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{
          height: i === 0 ? 84 : 64, borderRadius: 12, backgroundColor: C.paper,
          borderWidth: 1, borderColor: C.paperLine, marginBottom: 10,
        }} />
      ))}
    </View>
  );
}

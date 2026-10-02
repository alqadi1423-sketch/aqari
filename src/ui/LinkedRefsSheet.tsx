/**
 * قائمة المرتبطات التي منعت الحذف · كل صف يُفتح على شاشة نوعه.
 * تُعرض من زر [عرض المرتبطات] في رسالة الرفض.
 */
import React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Sheet } from './Sheet';
import { Row, T, Num } from './components';
import { Icon } from './icons';
import { C } from './theme';
import type { LinkedRef } from '../domain/refs';

export function LinkedRefsSheet({ visible, onClose, title, refs }: {
  visible: boolean;
  onClose: () => void;
  title: string;
  refs: LinkedRef[];
}) {
  const router = useRouter();
  return (
    <Sheet visible={visible} onClose={onClose} title={'المرتبطات بـ' + title}>
      {refs.map((r, i) => (
        <Pressable
          key={i}
          disabled={!r.route}
          onPress={() => {
            onClose();
            if (r.route) router.push(r.route as never);
          }}
        >
          <Row style={{
            justifyContent: 'space-between', paddingVertical: 12,
            borderBottomWidth: 1, borderBottomColor: C.paperLine, minHeight: 46,
          }}>
            <T size={13}>{r.label}</T>
            <Row gap={8}>
              <Num size={13} bold>{r.count}</Num>
              {r.route ? <Icon name="eye" size={13} color={C.muted} /> : null}
            </Row>
          </Row>
        </Pressable>
      ))}
      <View style={{ height: 10 }} />
    </Sheet>
  );
}

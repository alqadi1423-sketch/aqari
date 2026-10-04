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
import { useAccess } from './access';
import { routeAllowed } from '../domain/access/routes';

export function LinkedRefsSheet({ visible, onClose, title, refs }: {
  visible: boolean;
  onClose: () => void;
  title: string;
  refs: LinkedRef[];
}) {
  const router = useRouter();
  const access = useAccess();
  return (
    <Sheet visible={visible} onClose={onClose} title={'المرتبطات بـ' + title}>
      {refs.map((r, i) => {
        // شاشة قسمٍ لا يراه المستخدم لا تُفتح من هنا · ويبقى العدد ظاهراً
        const route = r.route && routeAllowed(access, r.route.split('?')[0]) ? r.route : null;
        return (
          <Pressable
            key={i}
            disabled={!route}
            onPress={() => {
              onClose();
              if (route) router.push(route as never);
            }}
          >
            <Row style={{
              justifyContent: 'space-between', paddingVertical: 12,
              borderBottomWidth: 1, borderBottomColor: C.paperLine, minHeight: 46,
            }}>
              <T size={13}>{r.label}</T>
              <Row gap={8}>
                <Num size={13} bold>{r.count}</Num>
                {route ? <Icon name="eye" size={13} color={C.muted} /> : null}
              </Row>
            </Row>
          </Pressable>
        );
      })}
      <View style={{ height: 10 }} />
    </Sheet>
  );
}

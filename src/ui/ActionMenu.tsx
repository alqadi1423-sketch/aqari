/**
 * قائمة إجراءات الصف الموحّدة (زر ⋮) · نافذة سفلية بأزرار الإجراء.
 */
import React, { useState } from 'react';
import { Pressable, Text, StyleSheet, View } from 'react-native';
import { Sheet } from './Sheet';
import { BtnIcon } from './components';
import { C, FONT_MED } from './theme';
import { useFs } from './store';
import { Icon, type IconName } from './icons';

export interface MenuAction {
  label: string;
  onPress: () => void;
  danger?: boolean;
  icon?: IconName;
}

export function ActionMenuButton({ actions, title }: { actions: Array<MenuAction | null>; title?: string }) {
  const [open, setOpen] = useState(false);
  const fs = useFs();
  const list = actions.filter((a): a is MenuAction => !!a);
  if (!list.length) return null;
  return (
    <>
      <BtnIcon icon="dots" onPress={() => setOpen(true)} accessibilityLabel={title ?? 'خيارات'} />
      {/* الورقة لا تُركَّب إلا عند فتحها · كل بطاقة صف تحمل هذا الزر فتركيبها الدائم يثقل رسم القوائم */}
      {open ? <Sheet visible onClose={() => setOpen(false)} title={title ?? 'خيارات'}>
        {list.map((a, i) => (
          <Pressable
            key={i}
            onPress={() => { setOpen(false); setTimeout(a.onPress, 120); }}
            style={({ pressed }) => [st.row, pressed && { backgroundColor: C.paper }]}
          >
            {a.icon ? <Icon name={a.icon} size={fs(16)} color={a.danger ? C.rose : C.charcoal} /> : null}
            <Text style={{ fontFamily: FONT_MED, fontSize: fs(13), color: a.danger ? C.rose : C.charcoal, textAlign: 'right', flex: 1 }}>
              {a.label}
            </Text>
          </Pressable>
        ))}
        <View style={{ height: 8 }} />
      </Sheet> : null}
    </>
  );
}

const st = StyleSheet.create({
  row: {
    paddingVertical: 14, paddingHorizontal: 10, borderRadius: 9, minHeight: 48,
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
});

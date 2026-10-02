/**
 * المرشِّحات أداة تُستدعى لا متن شاشة: زر مربع يسار شريط البحث يفتح ورقة سفلية،
 * وحين يُفعَّل مرشِّح امتلأ الزر بالأخضر وحمل عدّاداً أحمر بعدد المرشحات،
 * وظهرت تحته رقاقات خضراء تُغلق بعلامة إغلاق ومعها «مسح الكل» ·
 * وسطر العدد تحت الشريط دائماً: «60 عقداً» بلا مرشحات و«24 من 60» معها.
 */
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Sheet } from './Sheet';
import { Row, T, Num, BtnGhost, BtnPrimary } from './components';
import { Icon } from './icons';
import { C, TYPE } from './theme';

export interface ActiveChip {
  key: string;
  label: string;
  onClear: () => void;
}

/** مقاييس زر التصفية · مربع بحد رفيع، وممتلئ بالأخضر حين يكون مفعَّلاً */
const BTN = { side: 42, radius: 12, icon: 18, badge: 18 } as const;

export function FilterBar({
  chips, onOpen, onClearAll, resultCount, total, filtered, itemName, search,
}: {
  chips: ActiveChip[];
  onOpen: () => void;
  onClearAll: () => void;
  resultCount: number;
  /** العدد الكلي قبل التصفية · «60 عقداً» */
  total?: number;
  /** العدد بعد التصفية · «24 من 60» */
  filtered?: number;
  /** اسم العنصر المعدود بصيغته المنصوبة: عقداً · وحدة · فاتورة */
  itemName?: string;
  /** شريط البحث · يُعرض يمين الزر فيبقى الزر على يساره */
  search?: React.ReactNode;
}) {
  const on = chips.length;
  const all = total ?? resultCount;
  const shown = filtered ?? resultCount;
  const line = on && shown !== all ? `${shown} من ${all}` : `${all} ${itemName ?? 'نتيجة'}`;
  return (
    <View style={{ marginBottom: 8 }}>
      <Row style={{ alignItems: 'center' }}>
        {search ? <View style={{ flex: 1 }}>{search}</View> : null}
        <Pressable onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel="التصفية"
          style={({ pressed }) => [{
            width: BTN.side, height: BTN.side, borderRadius: BTN.radius, borderWidth: 1,
            borderColor: on ? C.emerald : C.line, backgroundColor: on ? C.emerald : '#FAFAF7',
            alignItems: 'center', justifyContent: 'center',
          }, pressed && { opacity: 0.6 }]}>
          <Icon name="filter" size={BTN.icon} color={on ? '#fff' : C.muted} />
          {on ? (
            <View style={{
              position: 'absolute', top: -5, left: -5, minWidth: BTN.badge, height: BTN.badge,
              borderRadius: BTN.badge / 2, backgroundColor: C.rose, paddingHorizontal: 4,
              alignItems: 'center', justifyContent: 'center',
            }}>
              <Num size={TYPE.caption} bold color="#fff">{String(on)}</Num>
            </View>
          ) : null}
        </Pressable>
      </Row>
      {on ? (
        <Row style={{ flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
          {chips.map((c) => (
            <Pressable key={c.key} onPress={c.onClear}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.emeraldSoft,
                borderWidth: 1, borderColor: C.emerald, borderRadius: 16, paddingHorizontal: 10, minHeight: 30,
              }}>
              <Icon name="x" size={11} color={C.emerald} />
              <T size={TYPE.caption} color={C.emerald}>{c.label}</T>
            </Pressable>
          ))}
          <BtnGhost small title="مسح الكل" onPress={onClearAll} />
        </Row>
      ) : null}
      <T size={TYPE.caption} color={C.muted} style={{ marginTop: 6 }}>{line}</T>
    </View>
  );
}

/** ورقة المرشحات نفسها · تحتضن ما تمرره الشاشة من حقول */
export function FilterSheet({ open, onClose, children, onClearAll, resultCount }: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  onClearAll: () => void;
  /** عدد نتائج المرشحات الحالية · يظهر على زر التطبيق «عرض 24 نتيجة» */
  resultCount?: number;
}) {
  if (!open) return null;
  return (
    <Sheet visible onClose={onClose} title="التصفية" tall
      footer={
        <>
          <View style={{ flex: 1 }}><BtnGhost title="مسح الكل" onPress={onClearAll} /></View>
          <View style={{ flex: 1 }}>
            <BtnPrimary title={resultCount == null ? 'عرض النتائج' : `عرض ${resultCount} نتيجة`} onPress={onClose} />
          </View>
        </>
      }>
      {children}
      <View style={{ height: 10 }} />
    </Sheet>
  );
}

/** حالة فتح الورقة · اختصار مشترك */
export function useFilterSheet(): { open: boolean; show: () => void; hide: () => void } {
  const [open, setOpen] = useState(false);
  return { open, show: () => setOpen(true), hide: () => setOpen(false) };
}

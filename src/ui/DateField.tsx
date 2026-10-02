/**
 * حقل تاريخ: النقر يفتح منتقي التاريخ الأصلي، مع خيار الكتابة اليدوية.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, TextInput } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { C, FONT, FONT_MED } from './theme';
import { Icon } from './icons';
import { useFs } from './store';
import { useMarkSheetDirty } from './sheetDirty';
import { dfmt, toLocalISODate } from '../domain/dates';

export function DateField({
  label, value, onChange, error,
}: { label: string; value: string; onChange: (v: string) => void; error?: boolean }) {
  const fs = useFs();
  // أي تغيير في التاريخ يُعلّم الورقة الحاوية بأن فيها إدخالاً
  const markDirty = useMarkSheetDirty();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const dateValue = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T12:00:00') : new Date();

  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ fontFamily: FONT_MED, fontSize: fs(11.5), color: error ? C.rose : C.muted, marginBottom: 5, textAlign: 'right' }}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        {manual ? (
          <TextInput
            value={value}
            onChangeText={(v) => { markDirty(); onChange(v.replace(/[^\d-]/g, '').slice(0, 10)); }}
            placeholder="2026-01-01"
            placeholderTextColor="#B9BFC9"
            keyboardType="numbers-and-punctuation"
            autoFocus
            style={{
              flex: 1, borderWidth: 1, borderColor: C.emerald, borderRadius: 8, minHeight: 44,
              paddingHorizontal: 11, backgroundColor: '#fff', color: C.charcoal,
              fontFamily: FONT, fontSize: fs(13), writingDirection: 'ltr', textAlign: 'left',
            }}
          />
        ) : (
          <Pressable
            onPress={() => setPickerOpen(true)}
            style={{
              flex: 1, borderWidth: error ? 1.6 : 1, borderColor: error ? C.rose : C.line, borderRadius: 8, minHeight: 44,
              paddingHorizontal: 11, justifyContent: 'center', backgroundColor: error ? C.roseSoft : '#FAFAF7',
            }}
          >
            <Text style={{
              fontFamily: FONT_MED, fontSize: fs(13),
              color: value ? C.charcoal : '#B9BFC9',
              writingDirection: 'ltr', textAlign: 'left', fontVariant: ['tabular-nums'],
            }}>
              {value ? dfmt(value) : 'اختر التاريخ'}
            </Text>
          </Pressable>
        )}
        <Pressable
          onPress={() => setManual((m) => !m)}
          hitSlop={6}
          style={{
            width: 44, height: 44, borderRadius: 8, borderWidth: 1, borderColor: C.line,
            backgroundColor: manual ? C.emeraldSoft : '#fff', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Icon name={manual ? 'calendar' : 'edit'} size={16} color={manual ? C.emerald : C.muted} />
        </Pressable>
      </View>
      {pickerOpen && (
        <DateTimePicker
          value={dateValue}
          mode="date"
          display="calendar"
          onChange={(event, selected) => {
            setPickerOpen(false);
            if (event.type === 'set' && selected) { markDirty(); onChange(toLocalISODate(selected)); }
          }}
        />
      )}
    </View>
  );
}

export function isValidISODate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00');
  return !isNaN(d.getTime());
}

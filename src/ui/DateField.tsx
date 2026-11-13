/**
 * حقل تاريخ: النقر يفتح منتقي التاريخ الأصلي، مع خيار الكتابة اليدوية.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, TextInput } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { C, FONT, FONT_MED } from './theme';
import { Icon } from './icons';
import { useFs } from './store';
import { useMarkSheetDirty } from './sheetDirty';
import { useLang } from '../i18n';
import { dfmt, isISODate, toLocalISODate } from '../domain/dates';

export function DateField({
  label, value, onChange, error,
}: { label: string; value: string; onChange: (v: string) => void; error?: boolean }) {
  const fs = useFs();
  const { t } = useLang();
  // أي تغيير في التاريخ يُعلّم الورقة الحاوية بأن فيها إدخالاً
  const markDirty = useMarkSheetDirty();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manual, setManual] = useState(false);
  // المكتوب يدوياً يبقى هنا حتى يكتمل تاريخاً صحيحاً فلا يصل النموذجَ قبله (المراجعة الشاملة 2026-11-13 · D-2) · ويتبع القيمة متى
  // تغيّرت من خارج الحقل (المنتقي أو تفريغ النموذج)
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  const bad = manual && text !== '' && !isISODate(text);
  const dateValue = isISODate(value) ? new Date(value + 'T12:00:00') : new Date();

  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ fontFamily: FONT_MED, fontSize: fs(11.5), color: error || bad ? C.rose : C.muted, marginBottom: 5, textAlign: 'right' }}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        {manual ? (
          <TextInput
            value={text}
            onChangeText={(v) => {
              markDirty();
              const s = v.replace(/[^\d-]/g, '').slice(0, 10);
              setText(s);
              // لا يُمرَّر إلا تاريخٌ صحيح بيومٍ قائم في شهره، أو الفراغ إن مُسح الحقل (D-2: «2026-1-15» كان يصل الدفتر كما كُتب)
              if (s === '' || isISODate(s)) onChange(s);
            }}
            placeholderTextColor="#B9BFC9"
            keyboardType="numbers-and-punctuation"
            autoFocus
            style={{
              flex: 1, borderWidth: error || bad ? 1.6 : 1, borderColor: error || bad ? C.rose : C.emerald, borderRadius: 8, minHeight: 44,
              paddingHorizontal: 11, backgroundColor: error || bad ? C.roseSoft : '#fff', color: C.charcoal,
              fontFamily: FONT, fontSize: fs(13), writingDirection: 'ltr', textAlign: 'left',
            }}
          />
        ) : (
          <Pressable
            onPress={() => setPickerOpen(true)}
            // معرّف الحقل باسمه لاختبار الجوال الافتراضي (التوجيه الرابع ٤ · ١) · لا يظهر
            testID={'date-' + label}
            accessibilityLabel={label}
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
          // الكتابة تبدأ من القيمة المعتمدة لا من نصٍّ ناقصٍ سابق (D-2)
          onPress={() => { setText(value); setManual((m) => !m); }}
          hitSlop={6}
          style={{
            width: 44, height: 44, borderRadius: 8, borderWidth: 1, borderColor: C.line,
            backgroundColor: manual ? C.emeraldSoft : '#fff', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Icon name={manual ? 'calendar' : 'edit'} size={16} color={manual ? C.emerald : C.muted} />
        </Pressable>
      </View>
      {bad && (
        <Text style={{ fontFamily: FONT, fontSize: fs(11), color: C.rose, marginTop: 4, textAlign: 'right' }}>
          {/* والنموذج يحفظ المعتمد لا المكتوب، فيُذكر هنا فلا يُحفظ غير ما يراه المستخدم بلا علمه (المراجعة الشاملة 2026-11-13 · D2-R11-5) */}
          {isISODate(value) ? t('dates.invalidKeeps', { date: dfmt(value) }) : t('dates.invalid')}
        </Text>
      )}
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

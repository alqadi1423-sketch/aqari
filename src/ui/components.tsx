/**
 * مكوّنات التصميم الأصلية · بطاقات وشارات وحقول وأزرار ورقائق،
 * بأهداف لمس ≥ ٤٤ نقطة وبهوية النموذج البصرية.
 */
import React from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, ViewStyle, TextStyle,
  StyleProp, ActivityIndicator, Image,
} from 'react-native';
import { C, FONT, FONT_BOLD, FONT_MED, RADIUS, TYPE, BADGE_STYLES } from './theme';
import { useFs } from './store';
import { fmt } from '../domain/money';
import { Icon, Riyal, type IconName } from './icons';
import { useMarkSheetDirty } from './sheetDirty';

/**
 * مقاييس الأزرار الثلاثة معلنة في مكان واحد ومنه وحده تقرأ كل الأزرار:
 * normal للأفعال في النوافذ والأقسام · small لأزرار الصفوف ·
 * icon أيقونة عارية بلا إطار ولا خلفية للنقاط الثلاث والإغلاق والطباعة ونحوها.
 */
export const BTN_SIZES = {
  normal: { minHeight: 40, padV: 5, padH: 12, radius: 8, font: TYPE.body, icon: 13 },
  small: { minHeight: 30, padV: 3, padH: 10, radius: 7, font: TYPE.caption, icon: 12 },
  // ٣٤ نقطة مرئية + ٥ من كل جهة = هدف لمس ٤٤ نقطة تماماً
  icon: { minHeight: 34, minWidth: 34, hitSlop: 5, icon: 17 },
} as const;

/** مقاييس بطاقة الرقم · واحدة لا تتغيّر بين الشاشات */
export const KPI_SIZES = { height: 76, padV: 8, padH: 10, gap: 4, minWidth: 140 } as const;

/**
 * رمز الريال الرسمي بمقاس نص · للاستعمال داخل النصوص بدل الاختصار النصي.
 * داخل النص: صورة مصبوغة (الصور داخل النص تحجز عرضها بشكل صحيح على أندرويد
 * بعكس المتجهات التي تتراكب مع الأرقام) · وخارج النص: المتجهة عبر Money.
 */
const RIYAL_PNG = require('../../assets/riyal.png');
export function Sar({ size = TYPE.body, color = C.ink }: { size?: number; color?: string }) {
  const fs = useFs();
  const h = Math.round(fs(size));
  return (
    <Image
      source={RIYAL_PNG}
      style={{ width: Math.round(h * 0.9), height: h, tintColor: color, resizeMode: 'contain' }}
    />
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[st.card, style]}>{children}</View>;
}

export function CardTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  const fs = useFs();
  return (
    <View style={st.cardHead}>
      <Text style={[st.cardTitle, { fontSize: fs(TYPE.sectionTitle) }]}>{children}</Text>
      {action}
    </View>
  );
}

export function T({
  children, size = TYPE.body, bold, med, color = C.charcoal, style, center, numberOfLines,
}: {
  children: React.ReactNode; size?: number; bold?: boolean; med?: boolean;
  color?: string; style?: StyleProp<TextStyle>; center?: boolean; numberOfLines?: number;
}) {
  const fs = useFs();
  return (
    <Text
      ellipsizeMode="tail"
      numberOfLines={numberOfLines}
      style={[
        { fontFamily: bold ? FONT_BOLD : med ? FONT_MED : FONT, fontSize: fs(size), color,
          textAlign: center ? 'center' : undefined, writingDirection: 'rtl', flexShrink: 1 },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/** أرقام tabular باتجاه ltr */
export function Num({
  children, size = TYPE.number, bold, color = C.ink, style,
}: {
  children: React.ReactNode; size?: number; bold?: boolean; color?: string; style?: StyleProp<TextStyle>;
}) {
  const fs = useFs();
  return (
    <Text
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.55}
      style={[
        { fontFamily: bold ? FONT_BOLD : FONT_MED, fontSize: fs(size), color,
          fontVariant: ['tabular-nums'], writingDirection: 'ltr', textAlign: 'left', flexShrink: 1 },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/** مبلغ بالهللات معروضاً بالريال */
/**
 * دالة عرض المبالغ الواحدة للتطبيق كله: الرقم بمحاذاة القاعدة
 * وبجانبه رمز الريال الرسمي متجهةً (SVG) · لا محرف نصي ولا اعتماد على خط الجهاز.
 */
export function Money({ halalas, size = TYPE.number, bold, color }: { halalas: number; size?: number; bold?: boolean; color?: string }) {
  const fs = useFs();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 0 }}>
      <Num size={size} bold={bold} color={color}>{fmt(halalas)}</Num>
      <Riyal size={Math.round(fs(size) * 0.8)} color={color ?? C.ink} />
    </View>
  );
}

export function Badge({ kind, label }: { kind: keyof typeof BADGE_STYLES | string; label: string }) {
  const s = BADGE_STYLES[kind] || BADGE_STYLES.draft;
  const fs = useFs();
  return (
    <View style={[st.badge, { backgroundColor: s.bg }]}>
      <Text style={{ fontFamily: FONT_MED, fontSize: fs(TYPE.caption), color: s.fg }}>{label}</Text>
    </View>
  );
}

export function BtnPrimary({
  title, onPress, disabled, small, danger, loading, icon,
}: {
  title: string; onPress: () => void; disabled?: boolean; small?: boolean;
  danger?: boolean; loading?: boolean; icon?: IconName;
}) {
  const fs = useFs();
  const S = BTN_SIZES[small ? 'small' : 'normal'];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        st.btn, { backgroundColor: danger ? C.rose : C.emerald },
        small && st.btnSm, (disabled || loading) && { opacity: 0.45 }, pressed && { opacity: 0.85 },
      ]}
    >
      {loading ? <ActivityIndicator color="#fff" size="small" /> : (
        <>
          {icon ? <Icon name={icon} size={fs(S.icon)} color="#fff" /> : null}
          <Text style={{ fontFamily: FONT_BOLD, color: '#fff', fontSize: fs(S.font) }}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function BtnGhost({
  title, onPress, small, danger, disabled, icon,
}: {
  title: string; onPress: () => void; small?: boolean; danger?: boolean;
  disabled?: boolean; icon?: IconName;
}) {
  const fs = useFs();
  const S = BTN_SIZES[small ? 'small' : 'normal'];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        st.btn, st.btnGhost, danger && { borderColor: C.roseSoft },
        small && st.btnSm, disabled && { opacity: 0.45 }, pressed && { backgroundColor: '#FAF9F5' },
      ]}
    >
      {icon ? <Icon name={icon} size={fs(S.icon)} color={danger ? C.rose : C.charcoal} /> : null}
      <Text style={{ fontFamily: FONT_BOLD, color: danger ? C.rose : C.charcoal, fontSize: fs(S.font) }}>
        {title}
      </Text>
    </Pressable>
  );
}

/** الحجم الثالث: أيقونة عارية بلا إطار ولا خلفية · ملمس الضغط شفافية */
export function BtnIcon({
  icon, onPress, danger, accessibilityLabel,
}: {
  icon: IconName; onPress: () => void; danger?: boolean; accessibilityLabel?: string;
}) {
  const fs = useFs();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={BTN_SIZES.icon.hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [st.btnIcon, pressed && { opacity: 0.5 }]}
    >
      <Icon name={icon} size={fs(BTN_SIZES.icon.icon)} color={danger ? C.rose : C.charcoal} />
    </Pressable>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  const fs = useFs();
  return (
    <Pressable
      onPress={onPress}
      style={[st.chip, active && { backgroundColor: C.ink, borderColor: C.ink }]}
    >
      <Text style={{ fontFamily: FONT_MED, fontSize: fs(TYPE.caption), color: active ? '#fff' : C.muted }}>{label}</Text>
    </Pressable>
  );
}

export function ChipGroup<Tv extends string | number>({
  options, value, onChange,
}: { options: Array<[Tv, string]>; value: Tv; onChange: (v: Tv) => void }) {
  return (
    <View style={st.chipRow}>
      {options.map(([v, label]) => (
        <Chip key={String(v)} label={label} active={value === v} onPress={() => onChange(v)} />
      ))}
    </View>
  );
}

export function Field({
  label, value, onChange, placeholder, keyboard, multiline, disabled, ltr, error, secure,
}: {
  label: string; value: string; onChange?: (v: string) => void; placeholder?: string;
  keyboard?: 'numeric' | 'default' | 'phone-pad'; multiline?: boolean; disabled?: boolean; ltr?: boolean;
  /** الحقل سبب رفضاً · يُظلَّل بالأحمر */
  error?: boolean;
  /** كلمة مرور · تُخفى ولا تُقترح ولا تُحفظ في لوحة المفاتيح */
  secure?: boolean;
}) {
  const fs = useFs();
  // أول تغيير يُعلّم الورقة الحاوية بأن فيها إدخالاً · فلا تُغلق بإيماءة بلا استئذان
  const markDirty = useMarkSheetDirty();
  return (
    <View style={st.field}>
      <Text style={{ fontFamily: FONT_MED, fontSize: fs(TYPE.caption), color: error ? C.rose : C.muted, marginBottom: 5 }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={(v) => { markDirty(); onChange?.(v); }}
        placeholder={placeholder}
        placeholderTextColor="#B9BFC9"
        keyboardType={keyboard === 'numeric' ? 'decimal-pad' : keyboard === 'phone-pad' ? 'phone-pad' : 'default'}
        multiline={multiline}
        editable={!disabled}
        secureTextEntry={secure}
        autoCorrect={secure ? false : undefined}
        autoCapitalize={secure ? 'none' : undefined}
        autoComplete={secure ? 'off' : undefined}
        style={[
          st.input, { fontSize: fs(TYPE.body) },
          multiline && { minHeight: 74, textAlignVertical: 'top' },
          disabled && { opacity: 0.6 },
          error && { borderColor: C.rose, borderWidth: 1.6, backgroundColor: C.roseSoft },
          ltr ? { writingDirection: 'ltr', textAlign: 'left' } : { writingDirection: 'rtl', textAlign: 'right' },
        ]}
      />
    </View>
  );
}

/**
 * عنوانٌ وقيمته · الخانة الواحدة لكل بطاقة تفاصيل في التطبيق.
 * القاعدة: إن غابت القيمة (NULL أو نصّ خالٍ) غاب البند كلّه بعنوانه · لا «لا يوجد» ولا شرطة ولا فراغ.
 * والصفر ليس غياباً: المبلغ صفر معلومة تُعرض، فالمكوّن يستقبل عنصراً جاهزاً لا رقماً خاماً.
 */
export function KV({ label, v, flex, style }: {
  label: string; v: React.ReactNode; flex?: boolean; style?: object;
}) {
  const fs = useFs();
  if (v == null || v === false || v === '' || v === 'لا يوجد') return null;
  return (
    <View style={[flex ? { flex: 1 } : null, style]}>
      <Text style={{ fontFamily: FONT_MED, fontSize: fs(TYPE.caption), color: C.muted }}>{label}</Text>
      {typeof v === 'string' || typeof v === 'number'
        ? <Text style={{ fontFamily: FONT_MED, fontSize: fs(TYPE.cardTitle), color: C.ink }}>{v}</Text>
        : v}
    </View>
  );
}

export function KpiCard({
  label, value, sub, tone, onPress,
}: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'pos' | 'neg' | 'neu';
  /** الرقم المجمّع يُفتح بالضغط على مكوِّناته */
  onPress?: () => void;
}) {
  const fs = useFs();
  // بطاقة نموذج المالك: حد رفيع فاتح بلا ظل ولا شريط جانبي وبخلفية الشاشة نفسها ·
  // السطر الفرعي يلتحق بالتسمية سطراً واحداً معها («النقد في 2 حسابات») ·
  // الرقم أسود دائماً إلا السالب neg بالأحمر · و«لا يوجد» بخط التسمية فليست رقماً ·
  // المقاييس كلها من KPI_SIZES وTYPE فلا تختلف بطاقة عن أختها في أي شاشة
  const numColor = tone === 'neg' ? C.rose : C.ink;
  const el = React.isValidElement(value) ? (value as React.ReactElement<{ children?: React.ReactNode }>) : null;
  const isNone = value === 'لا يوجد' || el?.props?.children === 'لا يوجد';
  // القيمة الغائبة تُسقط البطاقة بعنوانها · الصفر قيمةٌ فيُعرض
  if (value == null || value === '' || isNone) return null;
  // الرقم الممرَّر عنصراً (مبلغ أو نسبة) يُعاد تقييسه هنا فلا تفرض الشاشة مقاساً خاصاً
  const sized = el && (el.type === Money || el.type === Num)
    ? React.cloneElement(el as React.ReactElement<{ size?: number; bold?: boolean; color?: string }>, {
      size: isNone ? TYPE.caption : TYPE.number,
      bold: !isNone,
      color: isNone ? C.muted : numColor,
    })
    : value;
  const fixed = { height: fs(KPI_SIZES.height), justifyContent: 'center' as const };
  const body = (
    <>
      <Text numberOfLines={2} style={{
        fontFamily: FONT_MED, fontSize: fs(TYPE.caption), color: C.muted,
        marginBottom: KPI_SIZES.gap, textAlign: 'center',
      }}>
        {label}{sub != null && sub !== '' ? ' ' : ''}{sub}
      </Text>
      {typeof value === 'string' || typeof value === 'number'
        ? (
          <Text numberOfLines={1} style={{
            fontFamily: isNone ? FONT_MED : FONT_BOLD,
            fontSize: fs(isNone ? TYPE.caption : TYPE.number),
            color: isNone ? C.muted : numColor,
            textAlign: 'center',
          }}>{value}</Text>
        )
        : sized}
    </>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress}
        style={({ pressed }) => [st.kpi, fixed, pressed && { backgroundColor: C.paperLine }]}>
        {body}
      </Pressable>
    );
  }
  return <View style={[st.kpi, fixed]}>{body}</View>;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  const fs = useFs();
  return (
    <View style={{ paddingVertical: 34, paddingHorizontal: 16 }}>
      <Text style={{ fontFamily: FONT, fontSize: fs(TYPE.body), color: C.muted, textAlign: 'center' }}>{children}</Text>
    </View>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const fs = useFs();
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder ?? 'بحث…'}
      placeholderTextColor="#B9BFC9"
      style={[st.input, { fontSize: fs(TYPE.body), backgroundColor: '#FAFAF7', writingDirection: 'rtl', textAlign: 'right' }]}
    />
  );
}

/** صف إعداد قابل للنقر (كما في شاشة الإعدادات) */
export function SetRow({ title, sub, onPress, trailing, icon }: {
  title: string; sub?: string; onPress?: () => void; trailing?: React.ReactNode; icon?: IconName;
}) {
  const fs = useFs();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.setRow, pressed && onPress && { backgroundColor: C.paper }]}>
      {icon ? <Icon name={icon} size={18} color={C.emerald} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: FONT_BOLD, fontSize: fs(TYPE.cardTitle), color: C.charcoal }}>{title}</Text>
        {sub ? <Text style={{ fontFamily: FONT, fontSize: fs(TYPE.caption), color: C.muted, marginTop: 2 }}>{sub}</Text> : null}
      </View>
      {trailing ?? (onPress ? <View style={{ transform: [{ scaleX: -1 }] }}><Icon name="back" size={14} color={C.muted} /></View> : null)}
    </Pressable>
  );
}

/** شريط نسبة أفقي (توزيعات وأعمار الذمم) · يقبل الضغط ليفتح مكوِّناته */
export function BarRow({ label, value, pct, color, onPress }: {
  label: string; value: React.ReactNode; pct: number; color?: string; onPress?: () => void;
}) {
  const body = (
    <>
      <T size={TYPE.body} style={{ width: 86 }}>{label}</T>
      <View style={st.barTrack}>
        <View style={[st.barFill, { width: `${Math.min(100, Math.max(0, pct))}%`, backgroundColor: color ?? C.emerald }]} />
      </View>
      {typeof value === 'string' || typeof value === 'number' ? <Num size={TYPE.number}>{value}</Num> : value}
    </>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [st.barRow, pressed && { backgroundColor: C.paper }]}>
        {body}
      </Pressable>
    );
  }
  return <View style={st.barRow}>{body}</View>;
}

export function Divider() {
  return <View style={{ height: 1, backgroundColor: C.paperLine }} />;
}

export function Row({ children, style, gap = 8 }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

/** ملاحظة ملوّنة (set-note) */
export function Note({ children, tone = 'gold' }: { children: React.ReactNode; tone?: 'gold' | 'ok' | 'danger' }) {
  const bg = tone === 'ok' ? C.emeraldSoft : tone === 'danger' ? '#FBEBE9' : C.goldSoft;
  const fg = tone === 'danger' ? C.rose : C.charcoal;
  const fs = useFs();
  return (
    <View style={{ backgroundColor: bg, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 11, marginBottom: 8 }}>
      <Text style={{ fontFamily: FONT, fontSize: fs(TYPE.body), color: fg, lineHeight: Math.round(fs(TYPE.body) * 1.6), textAlign: 'right' }}>
        {children}
      </Text>
    </View>
  );
}

const st = StyleSheet.create({
  card: {
    backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: RADIUS,
    paddingVertical: 13, paddingHorizontal: 14, marginBottom: 11,
  },
  cardHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 12, flexWrap: 'wrap', gap: 8,
  },
  cardTitle: { fontFamily: FONT_BOLD, color: C.ink },
  badge: { paddingVertical: 3, paddingHorizontal: 9, borderRadius: 20, alignSelf: 'flex-start' },
  btn: {
    minHeight: BTN_SIZES.normal.minHeight, borderRadius: BTN_SIZES.normal.radius,
    paddingVertical: BTN_SIZES.normal.padV, paddingHorizontal: BTN_SIZES.normal.padH,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6,
  },
  btnSm: {
    minHeight: BTN_SIZES.small.minHeight, paddingVertical: BTN_SIZES.small.padV,
    paddingHorizontal: BTN_SIZES.small.padH, borderRadius: BTN_SIZES.small.radius,
  },
  btnGhost: { backgroundColor: '#fff', borderWidth: 1, borderColor: C.line },
  // أيقونة عارية: لا حدود ولا خلفية · الأبعاد الدنيا تحفظ هدف اللمس ومكان الأيقونة في الصف
  btnIcon: {
    minWidth: BTN_SIZES.icon.minWidth, minHeight: BTN_SIZES.icon.minHeight,
    alignItems: 'center', justifyContent: 'center',
  },
  chip: {
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1,
    borderColor: C.line, backgroundColor: '#fff', minHeight: 34, justifyContent: 'center',
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  field: { marginBottom: 12 },
  input: {
    borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 10,
    paddingHorizontal: 11, backgroundColor: '#FAFAF7', color: C.charcoal,
    fontFamily: FONT, minHeight: 44,
  },
  kpi: {
    flex: 1, minWidth: KPI_SIZES.minWidth, backgroundColor: C.paper, borderWidth: 1, borderColor: C.line,
    borderRadius: RADIUS, paddingVertical: KPI_SIZES.padV, paddingHorizontal: KPI_SIZES.padH,
    alignItems: 'center',
  },
  setRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12,
    paddingHorizontal: 2, borderBottomWidth: 1, borderBottomColor: C.line, minHeight: 48,
  },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5 },
  barTrack: { flex: 1, height: 9, borderRadius: 99, backgroundColor: C.paper, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 99 },
});

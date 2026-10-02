/**
 * النافذة السفلية الأصلية · مقبض سحب، تذييل ثابت، وتستجيب لزر الرجوع في أندرويد.
 * وهي أمّ كل الأوراق: ترفع نفسها فوق لوحة المفاتيح وتمرّر الحقل المركَّز إلى الرؤية.
 */
import React, { useEffect } from 'react';
import {
  Modal, View, Text, Pressable, StyleSheet, ScrollView, Keyboard, LayoutAnimation,
  Platform, BackHandler, TextInput, type KeyboardEvent, type LayoutChangeEvent,
} from 'react-native';
import { C, FONT_BOLD } from './theme';
import { useApp, useFs } from './store';
import { UiScaleView, useScaledInsets } from './UiScale';
import { Icon, type IconName } from './icons';
import { perfMarkNavRender, perfNow, perfScreenShown, perfTouch, perfTouchUp } from '../perf/perf';
import { useDialog, confirmDiscard } from './AppDialog';
import { SheetDirtyCtx } from './sheetDirty';

/**
 * قفل تمرير النافذة السفلية أثناء لمس عنصر يملك إيماءاته (كالخريطة) ·
 * فلا تنسحب الصفحة تحت الإصبع وهو يحدد الموقع.
 */
export const SheetScrollCtx = React.createContext<{ lock(): void; unlock(): void } | null>(null);

/**
 * ارتفاع لوحة المفاتيح الظاهر بوحدات النظام (لا بوحدات اللوح المكبَّر) ·
 * iOS يبلّغ قبل حركتها فترتفع الورقة معها بالحركة نفسها، وأندرويد بعد استقرارها.
 * لا يشترك في الأحداث إلا وهو مُمكَّن، فالأوراق المخفية لا تُعاد رسمتها لكل لوحة تظهر.
 */
export function useKeyboardHeight(enabled: boolean = true): number {
  const [height, setHeight] = React.useState(0);
  useEffect(() => {
    if (!enabled) { setHeight(0); return; }
    // قد تكون اللوحة مفتوحة قبل فتح الورقة (بحث الشاشة مثلاً) فلا يأتي حدث بعدها
    setHeight(Keyboard.isVisible() ? Math.max(0, Keyboard.metrics()?.height ?? 0) : 0);
    const onShow = (e: KeyboardEvent) => {
      // iOS يعطي مدة الحركة ومنحناها · تُطابقهما الورقة فترتفع معها لا بعدها
      if (Platform.OS === 'ios' && e.duration) {
        const d = Math.max(10, e.duration);
        LayoutAnimation.configureNext({
          duration: d,
          update: { duration: d, type: (e.easing && LayoutAnimation.Types[e.easing]) || 'keyboard' },
        });
      }
      setHeight(Math.max(0, e.endCoordinates.height));
    };
    const onHide = () => setHeight(0);
    const subs = Platform.OS === 'ios'
      ? [Keyboard.addListener('keyboardWillShow', onShow), Keyboard.addListener('keyboardWillHide', onHide)]
      : [Keyboard.addListener('keyboardDidShow', onShow), Keyboard.addListener('keyboardDidHide', onHide)];
    return () => subs.forEach((s) => s.remove());
  }, [enabled]);
  return height;
}

/** ما يكفي من واجهة العقدة الأصلية لقياس موضعها نسبةً إلى عقدة أخرى */
type Measurable = {
  measureLayout(
    relativeTo: unknown,
    onSuccess: (x: number, y: number, width: number, height: number) => void,
    onFail?: () => void,
  ): void;
};

export function Sheet({
  visible, onClose, title, children, footer, tall,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** التذييل الثابت (أزرار الإجراء) */
  footer?: React.ReactNode;
  tall?: boolean;
}) {
  const insets = useScaledInsets();
  const fs = useFs();
  const { uiScale } = useApp();
  // الحشو الأفقي لمحتوى الورقة = الأكبر من 18 ومن الحافتين الآمنتين (الشاشات المنحنية)
  const padH = Math.max(18, insets.left, insets.right);
  const [scrollOn, setScrollOn] = React.useState(true);
  const scrollCtl = React.useMemo(
    () => ({ lock: () => setScrollOn(false), unlock: () => setScrollOn(true) }),
    []
  );

  // ===== لوحة المفاتيح لا تغطي الحقل ولا زر الحفظ =====
  // اللوحة تُقاس بوحدات النظام والورقة تُرسم داخل لوح مكبَّر، فتُقسم على معامل التكبير
  const kbRaw = useKeyboardHeight(visible);
  const kb = kbRaw > 0 ? kbRaw / uiScale : 0;
  const [overlayH, setOverlayH] = React.useState(0);
  // ارتفاع الغطاء واللوحة مغلقة · إن كانت النافذة نفسها تنكمش للوحة (adjustResize
  // حيث ما زال يُنفَّذ) فالنقص مقيس هنا ولا يُضاف حشو مكرر فوقه
  const baseH = React.useRef(0);
  useEffect(() => { baseH.current = 0; }, [uiScale]);
  const onOverlayLayout = React.useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    setOverlayH(h);
    if (kbRaw === 0) baseH.current = Math.max(baseH.current, h);
  }, [kbRaw]);
  const shrunk = baseH.current > 0 ? Math.max(0, baseH.current - overlayH) : 0;
  /** ما تغطيه اللوحة فعلاً من الغطاء بعد خصم ما انكمشته النافذة وحدها */
  const covered = Math.max(0, kb - shrunk);
  /** المساحة المرئية فوق اللوحة · سقف الورقة كي يبقى التذييل داخلها */
  const availH = overlayH > 0 ? Math.max(220, overlayH - covered) : 0;
  const sheetMax = availH > 0
    ? (tall ? availH * 0.94 : availH)
    : (tall ? ('94%' as const) : undefined);

  const scrollRef = React.useRef<ScrollView>(null);
  const innerRef = React.useRef<Measurable | null>(null);
  const viewportH = React.useRef(0);
  const revealTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  /** تمرير الحقل المركَّز إلى داخل المساحة المرئية · بأقل حركة تكفي لإظهاره */
  const reveal = React.useCallback(() => {
    const sv = scrollRef.current;
    const inner = innerRef.current;
    const port = sv?.getNativeScrollRef();
    const input = TextInput.State.currentlyFocusedInput() as unknown as Measurable | null;
    const view = viewportH.current;
    if (!sv || !inner || !port || !input || view <= 0) return;
    const pad = 14;
    // القياس مرتان: نسبةً إلى المحتوى (موضع ثابت) ونسبةً إلى النافذة (موضع مرئي)
    // والفرق بينهما هو مقدار التمرير الحالي · فلا حاجة لمتابعة كل إطار تمرير
    input.measureLayout(inner, (_x, yContent, _w, hField) => {
      input.measureLayout(port, (_x2, yPort) => {
        const at = yContent - yPort;
        let next = at;
        if (yPort + hField + pad > view) next = yContent + hField + pad - view;
        else if (yPort < pad) next = yContent - pad;
        next = Math.max(0, next);
        if (Math.abs(next - at) > 1) sv.scrollTo({ y: next, animated: true });
      }, () => { /* الحقل خارج هذه الورقة · لا تمرير */ });
    }, () => { /* الحقل خارج هذه الورقة · لا تمرير */ });
  }, []);

  const revealSoon = React.useCallback(() => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    // مهلة قصيرة يستقر فيها ارتفاع الورقة بعد حركة اللوحة ثم يُقاس الحقل
    revealTimer.current = setTimeout(() => { revealTimer.current = null; reveal(); }, 90);
  }, [reveal]);
  useEffect(() => () => { if (revealTimer.current) clearTimeout(revealTimer.current); }, []);
  useEffect(() => { if (visible && kbRaw > 0) revealSoon(); }, [visible, kbRaw, revealSoon]);
  // المحتوى يُركَّب بعد إطار من الفتح: النافذة تنزلق فوراً وحركة الانزلاق
  // تغطي تركيب الحقول والقوائم الثقيلة · فالضغطة تستجيب في الحال
  const prevVisible = React.useRef(false);
  if (visible && !prevVisible.current) perfMarkNavRender();
  prevVisible.current = visible;
  const [contentIn, setContentIn] = React.useState(false);
  useEffect(() => {
    if (!visible) { setContentIn(false); return; }
    let live = true;
    requestAnimationFrame(() => { if (live) setContentIn(true); });
    return () => { live = false; };
  }, [visible]);

  /**
   * الإغلاق بالإيماءة (الخلفية · ✕ · زر الرجوع في أندرويد) يمرّ من هنا وحده:
   * إن كان في الورقة إدخالٌ لم يُحفظ استأذن أولاً، وإلا أغلق. وأزرار الورقة نفسها
   * (حفظ · إلغاء) تستدعي onClose مباشرةً لأن فعلها مقصود.
   */
  const dialog = useDialog();
  const dirtyRef = React.useRef(false);
  useEffect(() => { if (visible) dirtyRef.current = false; }, [visible]);
  const dirtyCtx = React.useMemo(() => ({ mark: () => { dirtyRef.current = true; } }), []);
  const requestClose = React.useCallback(() => {
    if (dirtyRef.current) { confirmDiscard(dialog, onClose); return; }
    onClose();
  }, [dialog, onClose]);

  // زر الرجوع في أندرويد يغلق النافذة أولاً · ويستأذن إن كان فيها إدخال
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      requestClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, requestClose]);

  // قياس زمن فتح النافذة من اللمسة حتى ظهورها
  useEffect(() => {
    if (!visible) return;
    let live = true;
    const focusAt = perfNow();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (live) perfScreenShown('ورقة «' + title + '»', focusAt);
    }));
    return () => { live = false; };
  }, [visible, title]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={requestClose}>
      {/* النوافذ تُرسم خارج شجرة التكبير الرئيسية فتحتاج مكبّرها الخاص */}
      <UiScaleView>
      {/* لمسات النافذة لا تمر بجذر التطبيق · تُلتقط هنا لقياس ما تفتحه */}
      <View
        style={st.overlay}
        onLayout={onOverlayLayout}
        onStartShouldSetResponderCapture={() => { perfTouch(); return false; }}
        onTouchEnd={perfTouchUp}
      >
        <Pressable style={{ flex: 1 }} onPress={requestClose} />
        {/* حشو بقدر ما تغطيه اللوحة · فالورقة كلها وتذييلها فوقها لا تحتها */}
        <View style={{ paddingBottom: covered }}>
          <View style={[st.sheet, { maxHeight: sheetMax, paddingBottom: covered > 0 ? 10 : insets.bottom + 10 }]}>
            <View style={st.handle} />
            <View style={[st.head, { paddingHorizontal: padH }]}>
              <Text style={{ fontFamily: FONT_BOLD, fontSize: fs(15), color: C.ink, flex: 1, textAlign: 'right' }}>
                {title}
              </Text>
              <Pressable onPress={requestClose} style={st.close} hitSlop={8}>
                <Icon name="x" size={16} color={C.charcoal} />
              </Pressable>
            </View>
            <ScrollView
              ref={scrollRef}
              innerViewRef={innerRef as unknown as React.RefObject<View>}
              onLayout={(e) => { viewportH.current = e.nativeEvent.layout.height; }}
              // تركيز أي حقل في الورقة يصعد إلى هنا (حدث فقاعي) فيُمرَّر إلى الرؤية
              onFocus={revealSoon}
              style={{ maxHeight: tall ? undefined : 520 }}
              contentContainerStyle={{ paddingHorizontal: padH, paddingBottom: 8 }}
              keyboardShouldPersistTaps="handled"
              // الورقة كلها مرفوعة فوق اللوحة أصلاً · فحشو iOS التلقائي يضاعف الإزاحة
              automaticallyAdjustKeyboardInsets={false}
              scrollEnabled={scrollOn}
            >
              <SheetScrollCtx.Provider value={scrollCtl}>
                <SheetDirtyCtx.Provider value={dirtyCtx}>
                  {contentIn ? children : <View style={{ height: 160 }} />}
                </SheetDirtyCtx.Provider>
              </SheetScrollCtx.Provider>
            </ScrollView>
            {footer && contentIn ? <View style={[st.foot, { paddingHorizontal: padH }]}>{footer}</View> : null}
          </View>
        </View>
      </View>
      </UiScaleView>
    </Modal>
  );
}

const st = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(16,25,46,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff', borderTopStartRadius: 16, borderTopEndRadius: 16,
    paddingTop: 8,
  },
  handle: {
    alignSelf: 'center', width: 44, height: 5, borderRadius: 3,
    backgroundColor: C.line, marginBottom: 8,
  },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingBottom: 12,
  },
  // علامة ✕ عارية: لا إطار ولا خلفية ولا حدّ · المقاس ومنطقة الضغط كما كانا
  close: {
    width: 32, height: 32,
    alignItems: 'center', justifyContent: 'center',
  },
  foot: {
    flexDirection: 'row', gap: 9, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: C.line,
  },
});

/** اختيار من قائمة (بديل select) داخل نافذة سفلية */
export function PickerSheet<Tv extends string>({
  visible, onClose, title, options, value, onPick, emptyText,
}: {
  visible: boolean; onClose: () => void; title: string;
  options: Array<{ value: Tv; label: string; sub?: string; icon?: IconName }>;
  value?: Tv | null;
  onPick: (v: Tv) => void;
  /** رسالة الفراغ تقول ماذا أفعل · لا قائمة فارغة صامتة */
  emptyText?: string;
}) {
  const fs = useFs();
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => { onPick(o.value); onClose(); }}
          style={({ pressed }) => [pk.row, pressed && { backgroundColor: C.paper },
            value === o.value && { backgroundColor: C.emeraldSoft }]}
        >
          {o.icon ? <Icon name={o.icon} size={17} color={C.charcoal} /> : null}
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: FONT_BOLD, fontSize: fs(13), color: C.charcoal, textAlign: 'right' }}>
              {o.label}
            </Text>
            {o.sub ? (
              <Text style={{ fontSize: fs(11), color: C.muted, textAlign: 'right', marginTop: 2 }}>{o.sub}</Text>
            ) : null}
          </View>
          {value === o.value ? <Icon name="check" size={15} color={C.emerald} /> : null}
        </Pressable>
      ))}
      {!options.length ? (
        <Text style={{ fontSize: fs(12.5), color: C.muted, textAlign: 'center', paddingVertical: 24 }}>
          {emptyText ?? 'لا خيارات متاحة'}
        </Text>
      ) : null}
    </Sheet>
  );
}

const pk = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13,
    paddingHorizontal: 10, borderRadius: 9, minHeight: 48,
  },
});

/** حقل اختيار يفتح PickerSheet */
export function SelectField<Tv extends string>({
  label, value, display, options, onPick, placeholder, error, emptyText,
}: {
  label: string; value: Tv | null | undefined; display?: string;
  options: Array<{ value: Tv; label: string; sub?: string; icon?: IconName }>;
  onPick: (v: Tv) => void; placeholder?: string;
  /** الحقل سبب رفضاً · يُظلَّل بالأحمر */
  error?: boolean;
  /** رسالة الفراغ داخل نافذة الاختيار · تقول ماذا أفعل */
  emptyText?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const fs = useFs();
  const current = options.find((o) => o.value === value);
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ fontSize: fs(11.5), color: error ? C.rose : C.muted, marginBottom: 5, textAlign: 'right' }}>{label}</Text>
      <Pressable
        onPress={() => setOpen(true)}
        style={{
          borderWidth: error ? 1.6 : 1, borderColor: error ? C.rose : C.line, borderRadius: 8, minHeight: 44,
          paddingHorizontal: 11, justifyContent: 'center', backgroundColor: error ? C.roseSoft : '#FAFAF7',
        }}
      >
        <Text style={{ fontSize: fs(13), color: current || display ? C.charcoal : '#B9BFC9', textAlign: 'right' }}>
          {display ?? current?.label ?? placeholder ?? 'اختر'}
        </Text>
      </Pressable>
      <PickerSheet
        visible={open}
        onClose={() => setOpen(false)}
        title={label}
        options={options}
        value={value ?? undefined}
        onPick={onPick}
        emptyText={emptyText ?? placeholder}
      />
    </View>
  );
}

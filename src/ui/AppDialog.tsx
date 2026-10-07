/**
 * الحوار الموحد للتطبيق كله: أزرار حقيقية بحدود وخلفية، الخطر أحمر واللغو رمادي،
 * حشو وارتفاع موحدان، وعربي صرف · بديل Alert.alert البدائي في كل المواضع.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Modal, Pressable, View, ScrollView } from 'react-native';
import { DirView } from './DirView';
import { T } from './components';
import { C, FONT_BOLD } from './theme';
import { Text } from 'react-native';
import { useFs } from './store';
import { useKeyboardHeight } from './Sheet';

export interface DialogAction {
  label: string;
  variant?: 'primary' | 'danger' | 'ghost';
  onPress?: () => void | Promise<void>;
}

export interface DialogSpec {
  title: string;
  body?: string;
  tone?: 'normal' | 'danger';
  actions: DialogAction[];
  /** true = لا يُغلق بالنقر خارجه (تأكيدات الأفعال التي لا رجعة فيها) */
  locked?: boolean;
}

const Ctx = createContext<{ show: (spec: DialogSpec) => void } | null>(null);

export function useDialog(): (spec: DialogSpec) => void {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('DialogProvider مفقود من جذر التطبيق');
  return ctx.show;
}

/**
 * الجسر الأمري: المزوّد يسجّل نفسه هنا حين يُركَّب، فتستطيع الخدمات التي لا تعيش داخل
 * شجرة React (الطباعة · الإرفاق · معالج الأخطاء العام) أن تعرض حوار التطبيق نفسه
 * بدل حوار النظام الخام. وقبل تركيب المزوّد تُحفظ الطلبات وتُعرض حين يُركَّب.
 */
let imperativeShow: ((spec: DialogSpec) => void) | null = null;
const pending: DialogSpec[] = [];
export function showDialog(spec: DialogSpec): void {
  if (imperativeShow) imperativeShow(spec); else pending.push(spec);
}
function registerImperative(show: ((spec: DialogSpec) => void) | null): void {
  imperativeShow = show;
  if (show) while (pending.length) show(pending.shift()!);
}

/**
 * إغلاق نموذج فيه إدخال لم يُحفظ · نموذج واحد لكل مواضع التطبيق:
 * الطيّ بالضغط ثانيةً لا يمحو ما كتبه المستخدم إلا بتأكيده.
 */
export function confirmDiscard(dialog: (spec: DialogSpec) => void, close: () => void) {
  dialog({
    title: 'إغلاق بلا حفظ',
    body: 'أدخلتَ بيانات لم تُحفظ · إغلاق النموذج يمحوها.',
    tone: 'danger',
    actions: [
      { label: 'تراجع', variant: 'ghost' },
      { label: 'إغلاق ومحو ما كُتب', variant: 'danger', onPress: close },
    ],
  });
}

/** يطوي اللوحة بالضغط ثانيةً · ويستأذن إن كان فيها إدخال */
export function toggleClose(
  dialog: (spec: DialogSpec) => void, open: boolean, dirty: boolean, set: (v: boolean) => void,
) {
  if (!open) { set(true); return; }
  if (dirty) { confirmDiscard(dialog, () => set(false)); return; }
  set(false);
}
/** ثلاثة خيارات فأكثر لا تسع صفاً واحداً بعرض الهاتف فتُرصّ عمودياً بعرض كامل */
const STACK_FROM = 3;

function DialogButton({ a, onDone, fs, vertical }: {
  a: DialogAction; onDone: () => void; fs: (n: number) => number; vertical: boolean;
}) {
  const bg = a.variant === 'danger' ? '#C0392B' : a.variant === 'primary' ? C.emerald : '#F1F2F4';
  const fg = a.variant === 'danger' || a.variant === 'primary' ? '#fff' : C.charcoal;
  const border = a.variant === 'ghost' || !a.variant ? C.line : bg;
  return (
    <Pressable
      onPress={() => { onDone(); Promise.resolve(a.onPress?.()).catch(() => {}); }}
      style={({ pressed }) => ({
        // عمودياً: سطر مستقل بعرض الحوار · أفقياً: يكبر ليملأ الصف وأساسه عرض نصه
        // لا صفر، فلا ينضغط الزر إلى ما دون كلمته
        alignSelf: vertical ? 'stretch' : 'auto',
        flexGrow: vertical ? 0 : 1,
        flexShrink: vertical ? 0 : 1,
        flexBasis: 'auto',
        minHeight: 46, borderRadius: 10, borderWidth: 1.2, borderColor: border,
        backgroundColor: pressed ? (a.variant === 'ghost' || !a.variant ? '#E7E9EC' : bg + 'DD') : bg,
        alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12,
      })}
    >
      <Text
        numberOfLines={1}
        ellipsizeMode="tail"
        adjustsFontSizeToFit
        minimumFontScale={0.8}
        textBreakStrategy="simple"
        style={{ fontFamily: FONT_BOLD, fontSize: fs(13), color: fg, textAlign: 'center', flexShrink: 1 }}
      >
        {a.label}
      </Text>
    </Pressable>
  );
}

function DialogActions({ actions, onDone, fs }: {
  actions: DialogAction[]; onDone: () => void; fs: (n: number) => number;
}) {
  const vertical = actions.length >= STACK_FROM;
  return (
    <View style={{
      flexDirection: vertical ? 'column' : 'row',
      alignItems: vertical ? 'stretch' : 'center',
      gap: 8,
    }}>
      {actions.map((a, i) => (
        <DialogButton key={i} a={a} onDone={onDone} fs={fs} vertical={vertical} />
      ))}
    </View>
  );
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [spec, setSpec] = useState<DialogSpec | null>(null);
  const fs = useFs();
  const show = useCallback((s: DialogSpec) => setSpec(s), []);
  const close = useCallback(() => setSpec(null), []);
  useEffect(() => { registerImperative(show); return () => registerImperative(null); }, [show]);
  // الحوار يُرسم خارج لوح التكبير فارتفاع اللوحة يُطبَّق بوحدات النظام كما هو ·
  // الحشو السفلي يجعل التوسيط في المساحة المرئية فوق اللوحة: لا الحقل تحتها ولا الأزرار
  const kb = useKeyboardHeight(spec != null);
  return (
    <Ctx.Provider value={{ show }}>
      {children}
      {spec ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => { if (!spec.locked) close(); }}>
          <DirView>
          <Pressable
            style={{
              flex: 1, backgroundColor: 'rgba(20,23,29,0.55)', alignItems: 'center',
              justifyContent: 'center', padding: 26, paddingBottom: 26 + kb,
            }}
            onPress={() => { if (!spec.locked) close(); }}
          >
            <Pressable onPress={() => {}} style={{ width: '100%', maxWidth: 420 }}>
              <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 18 }}>
                <T size={14.5} bold color={spec.tone === 'danger' ? '#C0392B' : C.ink} style={{ marginBottom: spec.body ? 8 : 14 }}>
                  {spec.title}
                </T>
                {spec.body ? (
                  <ScrollView style={{ maxHeight: 300 }} keyboardShouldPersistTaps="handled">
                    <T size={12.5} color={C.charcoal} style={{ marginBottom: 14, lineHeight: fs(20) }}>{spec.body}</T>
                  </ScrollView>
                ) : null}
                <DialogActions actions={spec.actions} onDone={close} fs={fs} />
              </View>
            </Pressable>
          </Pressable>
          </DirView>
        </Modal>
      ) : null}
    </Ctx.Provider>
  );
}

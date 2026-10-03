/**
 * بوابة الترقية · قاعدةٌ أقدم من التطبيق فيها بيانات لا تُرقّى قبل نسخة كاملة منها.
 *
 * تقرأ الإصدار من القاعدة مفتوحةً بلا هجرة، فإن لزمت نسخة عرضت تقدّمها وحفظتها بالتحقق الكامل
 * ثم أذنت بالهجرة ورسمت التطبيق · وإن فشلت النسخة لم تُرقِّ شيئاً، وعرضت السبب بالعربية
 * وزرّاً لإعادة المحاولة. وقاعدة جديدة أو بلا بيانات تمرّ بلا نسخة ولا شاشة.
 *
 * تُرسم قبل مزوّد الحالة (فهو يفتح القاعدة ويرقّيها) · فلا تستعمل مكوّنات تقرأ منه (T والأزرار
 * تقرأ مقياس الخط)، بل Text وPressable بخطوط السمة مباشرة. وجده الفحص على المحاكي: انهار
 * التطبيق عند أول فتح لقاعدة قديمة بـ«AppStateProvider مفقود».
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, Share, type TextStyle } from 'react-native';
import { C, FONT, FONT_BOLD } from './theme';
import { rawAppDb, clearUpgrade } from '../db/expoAdapter';
import { upgradeState, makePreUpgradeBackup } from '../domain/backup/upgrade';
import { appBackupEnv } from '../services/backupService';

type Phase = 'ready' | 'backup' | 'failed';

function initialPhase(): Phase {
  try { return upgradeState(rawAppDb()).needsBackup ? 'backup' : 'ready'; }
  // تعذّر فتح القاعدة أصلاً · يتولاه مسار الفتح المعتاد بعدها برسالته
  catch { return 'ready'; }
}

const txt = (size: number, color: string, bold = false): TextStyle => ({
  fontFamily: bold ? FONT_BOLD : FONT, fontSize: size, color, textAlign: 'center', writingDirection: 'rtl',
});

function Btn({ title, primary, onPress }: { title: string; primary?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button"
      style={{ borderRadius: 10, paddingVertical: 12, alignItems: 'center',
        backgroundColor: primary ? C.emerald : 'transparent', borderWidth: primary ? 0 : 1, borderColor: C.line }}>
      <Text style={txt(14, primary ? '#fff' : C.ink, true)}>{title}</Text>
    </Pressable>
  );
}

export function UpgradeGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [msg, setMsg] = useState('جاري التحضير');
  const [reason, setReason] = useState('');

  const run = useCallback(async () => {
    setPhase('backup');
    setMsg('جاري التحضير');
    try {
      await makePreUpgradeBackup(appBackupEnv(rawAppDb()), setMsg);
      clearUpgrade();
      setPhase('ready');
    } catch (e) {
      setReason(e instanceof Error ? e.message : 'لم تُرقَّ بياناتك لأن حفظ نسخة منها قبل الترقية لم يكتمل.');
      setPhase('failed');
    }
  }, []);

  useEffect(() => {
    if (phase === 'backup') run();
    // مرة عند الفتح · وإعادة المحاولة بزرّها
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'ready') return <>{children}</>;

  return (
    <View style={{ flex: 1, backgroundColor: C.paper, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      {phase === 'backup' ? (
        <>
          <ActivityIndicator color={C.emerald} size="large" />
          <Text style={[txt(15, C.ink, true), { marginTop: 18 }]}>نسخة كاملة من بياناتك قبل ترقيتها</Text>
          <Text style={[txt(12.5, C.muted), { marginTop: 8 }]}>{msg}</Text>
          <Text style={[txt(12, C.muted), { marginTop: 14 }]}>لا تُغلق التطبيق · الترقية تبدأ بعد أن تُحفظ النسخة ويُتحقَّق منها</Text>
        </>
      ) : (
        <View style={{ width: '100%', maxWidth: 420 }}>
          <Text style={txt(15, C.rose, true)}>تعذّرت ترقية البيانات</Text>
          <Text style={[txt(13, C.ink), { marginTop: 12, lineHeight: 22 }]}>{reason}</Text>
          <View style={{ marginTop: 18, gap: 10 }}>
            <Btn primary title="إعادة المحاولة" onPress={run} />
            <Btn title="مشاركة السبب" onPress={() => { Share.share({ message: reason }).catch(() => {}); }} />
          </View>
        </View>
      )}
    </View>
  );
}

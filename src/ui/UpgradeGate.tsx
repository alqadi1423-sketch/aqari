/**
 * بوابة الترقية · قاعدةٌ أقدم من التطبيق فيها بيانات لا تُرقّى قبل نسخة كاملة منها.
 *
 * تقرأ الإصدار من القاعدة مفتوحةً بلا هجرة، فإن لزمت نسخة عرضت تقدّمها وحفظتها بالتحقق الكامل
 * ثم أذنت بالهجرة ورسمت التطبيق · وإن فشلت النسخة لم تُرقِّ شيئاً، وعرضت السبب بالعربية
 * وزرّاً لإعادة المحاولة. وقاعدة جديدة أو بلا بيانات تمرّ بلا نسخة ولا شاشة.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, ActivityIndicator, Share } from 'react-native';
import { T, BtnGhost, BtnPrimary } from './components';
import { C } from './theme';
import { rawAppDb, clearUpgrade } from '../db/expoAdapter';
import { upgradeState, makePreUpgradeBackup } from '../domain/backup/upgrade';
import { appBackupEnv } from '../services/backupService';

type Phase = 'ready' | 'backup' | 'failed';

function initialPhase(): Phase {
  try { return upgradeState(rawAppDb()).needsBackup ? 'backup' : 'ready'; }
  // تعذّر فتح القاعدة أصلاً · يتولاه مسار الفتح المعتاد بعدها برسالته
  catch { return 'ready'; }
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
          <T size={15} bold center style={{ marginTop: 18 }}>نسخة كاملة من بياناتك قبل ترقيتها</T>
          <T size={12.5} center color={C.muted} style={{ marginTop: 8 }}>{msg}</T>
          <T size={12} center color={C.muted} style={{ marginTop: 14 }}>
            لا تُغلق التطبيق · الترقية تبدأ بعد أن تُحفظ النسخة ويُتحقَّق منها
          </T>
        </>
      ) : (
        <View style={{ width: '100%', maxWidth: 420 }}>
          <T size={15} bold color={C.rose} center>تعذّرت ترقية البيانات</T>
          <T size={13} center style={{ marginTop: 12, lineHeight: 22 }}>{reason}</T>
          <View style={{ marginTop: 18, gap: 10 }}>
            <BtnPrimary title="إعادة المحاولة" onPress={run} />
            <BtnGhost title="مشاركة السبب" onPress={() => { Share.share({ message: reason }).catch(() => {}); }} />
          </View>
        </View>
      )}
    </View>
  );
}

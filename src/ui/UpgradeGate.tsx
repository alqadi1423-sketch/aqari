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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, Share, type TextStyle } from 'react-native';
import { C, FONT, FONT_BOLD } from './theme';
import { rawAppDb, clearUpgrade, appDb } from '../db/expoAdapter';
import { applyScreenSecureFrom } from '../services/screenSecure';
import { rescheduleAllNotifications } from '../services/notifications';
import { upgradeState, makePreUpgradeBackup } from '../domain/backup/upgrade';
import { missingFileLabels } from '../domain/backup/create';
import { t } from '../i18n';
import { appBackupEnv } from '../services/backupService';
import { redactForReport } from '../domain/redact';
import { cancelSource, isCancelled, progressView, progressLabel, progressLine, StallWatch, type ProgressInfo } from '../domain/progress';

type Phase = 'ready' | 'backup' | 'missing' | 'failed';

/** ما يُسمّى من الملفات المفقودة على الشاشة · والباقي عددٌ */
const SHOWN_MISSING = 8;

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
  const [info, setInfo] = useState<ProgressInfo | null>(null);
  const [stalled, setStalled] = useState(false);
  const [reason, setReason] = useState('');
  // ألغاها المستخدم بنفسه · فلا تُعرض عطلاً
  const [cancelled, setCancelled] = useState(false);
  // النسبة والحجم والإلغاء، ودقيقة بلا تقدّم تظهر مع إعادة المحاولة (توجيه المالك ٢٠٢٦-١٠-٠٧)
  const watch = useRef(new StallWatch());
  const cancelRef = useRef<{ cancel: () => void; retry: boolean } | null>(null);

  const [missing, setMissing] = useState<string[]>([]);

  /** الترقية نفسها بعد أن حُفظت النسخة وتُحقّق منها */
  const finish = useCallback(() => {
    clearUpgrade();
    // ما أجّله الإقلاع لأن القاعدة كانت تنتظر الترقية (المراجعة الشاملة · البند ٢٢): منع لقطة الشاشة الآن، والتنبيهات بعد مهلة
    // الإقلاع نفسها
    try { applyScreenSecureFrom(appDb()); } catch { /* يُطبَّق عند الإقلاع التالي */ }
    setTimeout(() => { try { rescheduleAllNotifications(appDb()).catch(() => {}); } catch { /* الإقلاع التالي */ } }, 6000);
    setPhase('ready');
  }, []);

  const run = useCallback(async () => {
    const src = cancelSource();
    cancelRef.current = { cancel: src.cancel, retry: false };
    watch.current.reset();
    setPhase('backup'); setStalled(false); setInfo(null);
    setMsg('جاري التحضير');
    try {
      const { manifest } = await makePreUpgradeBackup(appBackupEnv(rawAppDb()), (m, i) => {
        if (watch.current.tick(m, i)) setStalled(false);
        setMsg(m); setInfo(i ?? null);
      }, new Date(), src.signal);
      // مرفقٌ مفقود أو تالف لا يحبس المستخدم، ويُسمّى له قبل الترقية (القرارات المعلّقة البند ٣ · الخيار أ) · والترقية بعد «متابعة»
      const lost = manifest.missing_files ?? [];
      if (lost.length) {
        let names: string[] = [];
        try { names = missingFileLabels(rawAppDb(), lost); } catch { names = lost.map((f) => f.slice(0, 12)); }
        setMissing(names);
        setPhase('missing');
        return;
      }
      finish();
    } catch (e) {
      if (isCancelled(e) && cancelRef.current?.retry) { run(); return; }
      setCancelled(isCancelled(e));
      setReason(isCancelled(e)
        ? 'بياناتك كما هي، والترقية تنتظر نسخة كاملة منها.'
        : e instanceof Error ? e.message : 'لم تُرقَّ بياناتك لأن حفظ نسخة منها قبل الترقية لم يكتمل.');
      setPhase('failed');
    }
  }, [finish]);

  useEffect(() => {
    if (phase !== 'backup') return;
    const t = setInterval(() => { if (watch.current.stalled()) setStalled(true); }, 2000);
    return () => clearInterval(t);
  }, [phase]);

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
          <Text style={[txt(12.5, C.muted), { marginTop: 8 }]}>{progressLabel(msg)}</Text>
          {(() => {
            const v = progressView(msg, info);
            return v.pct !== null ? (
              <>
                <View style={{ alignSelf: 'stretch', height: 8, borderRadius: 4, backgroundColor: C.paperLine, overflow: 'hidden', marginTop: 12 }}>
                  <View style={{ height: 8, borderRadius: 4, backgroundColor: C.emerald, width: `${v.pct}%` }} />
                </View>
                <Text style={[txt(12.5, C.muted), { marginTop: 6 }]}>{progressLine(v)}</Text>
              </>
            ) : null;
          })()}
          {stalled ? <Text style={[txt(12.5, C.rose), { marginTop: 10 }]}>لم تتقدم النسخة منذ دقيقة</Text> : null}
          <View style={{ marginTop: 14, gap: 10, alignSelf: 'stretch' }}>
            {stalled ? <Btn primary title="إعادة المحاولة" onPress={() => { if (cancelRef.current) { cancelRef.current.retry = true; cancelRef.current.cancel(); } }} /> : null}
            <Btn title="إلغاء" onPress={() => cancelRef.current?.cancel()} />
          </View>
          <Text style={[txt(12, C.muted), { marginTop: 14 }]}>لا تُغلق التطبيق · الترقية تبدأ بعد أن تُحفظ النسخة ويُتحقَّق منها</Text>
        </>
      ) : phase === 'missing' ? (
        <View style={{ width: '100%', maxWidth: 420 }}>
          <Text style={txt(15, C.ink, true)}>{t('upgrade.missingTitle')}</Text>
          <Text style={[txt(13, C.ink), { marginTop: 12, lineHeight: 22 }]}>{t('upgrade.missingBody', { count: missing.length })}</Text>
          {missing.slice(0, SHOWN_MISSING).map((n, i) => (
            <Text key={i} style={[txt(13, C.ink, true), { marginTop: 6 }]}>{'«' + n + '»'}</Text>
          ))}
          {missing.length > SHOWN_MISSING
            ? <Text style={[txt(12.5, C.muted), { marginTop: 6 }]}>{t('upgrade.missingMore', { count: missing.length - SHOWN_MISSING })}</Text> : null}
          <Text style={[txt(12.5, C.muted), { marginTop: 12, lineHeight: 20 }]}>{t('upgrade.missingNote')}</Text>
          <View style={{ marginTop: 18, gap: 10 }}>
            <Btn primary title={t('upgrade.continue')} onPress={finish} />
          </View>
        </View>
      ) : (
        <View style={{ width: '100%', maxWidth: 420 }}>
          <Text style={txt(15, cancelled ? C.ink : C.rose, true)}>{cancelled ? 'أُلغي حفظ النسخة' : 'تعذّرت ترقية البيانات'}</Text>
          <Text style={[txt(13, C.ink), { marginTop: 12, lineHeight: 22 }]}>{reason}</Text>
          <View style={{ marginTop: 18, gap: 10 }}>
            <Btn primary title="إعادة المحاولة" onPress={run} />
            {/* ما يُشارك خارج الجهاز محجوبةٌ بياناته كتقرير الخطأ (المراجعة الشاملة · البند ١٨) */}
            {cancelled ? null : <Btn title="مشاركة السبب" onPress={() => { Share.share({ message: redactForReport(reason) }).catch(() => {}); }} />}
          </View>
        </View>
      )}
    </View>
  );
}

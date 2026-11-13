/**
 * ما ينتظر قرار المستخدم ولا يُنفَّذ بدونه (قاعدة المالك ٢٠٢٦-١٠-٠٥): لا يُمسح شيء من الجهاز إلا بأمره في تلك اللحظة.
 *  - مُسحت بيانات المنشأة من جهاز آخر وعلى هذا الجهاز بيانات: يبقيها ويرفعها، أو يفرّغ الجهاز (بنسخة أمان).
 *  - أُزيلت عضويته أو غادر: لا قرار فيه (المراجعة الشاملة 2026-11-13 · B-4 · قرارا المالك س٩ وس١٠): فُرّغ الجهاز عند أول اتصال بلا
 *    نسخةٍ كاملة ولا «أبقِ بياناتي»، وما يبقى إشعارٌ بذلك وملفُّ ما لم يُرفع من عمله يرسله إلى صاحب المنشأة، ثم «تم» يحذفه بأمره.
 * المزامنة متوقفة حتى يقرر، والتطبيق يعمل بما على الجهاز.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { Sheet } from './Sheet';
import { BtnGhost, BtnPrimary, Note, T } from './components';
import { C, TYPE } from './theme';
import { reportFailure } from './failureDialog';
import { useApp } from './store';
import { resolveDecision, shareUnsyncedNow, type CloudState } from '../services/cloud';
import { useAccess } from './access';
import { ErrorBoundary } from './ErrorBoundary';
import { t } from '../i18n';

export function DecisionSheet({ decision }: { decision: NonNullable<CloudState['decision']> }) {
  const { db, bump } = useApp();
  const [busy, setBusy] = useState(false);
  const [later, setLater] = useState(false);
  // «أبقِ بياناتي» للمالك وحده (المراجعة الخارجية ٧ · النتيجة ٩ · قرار المالك «رابعاً ٦»)
  // الخطّاف قبل العودة المبكرة: بعدها كان «لاحقاً» يُسقط التطبيق (المراجعة الشاملة 2026-11-13 · G-2)
  const owner = useAccess().owner;
  if (later) return null;
  const fail = (e: unknown) => reportFailure({ title: 'تعذّر التنفيذ', where: 'قرار المزامنة', db, e });
  const run = async (choice: 'keep' | 'wipe' | 'done') => {
    setBusy(true);
    try { await resolveDecision(choice); bump(); }
    catch (e) { await fail(e); }
    setBusy(false);
  };
  if (decision.kind === 'removed') {
    // الإزالة والمغادرة (B-4): الجهاز فُرّغ · إرسال ملفّ ما لم يُرفع لا يغلق الورقة، و«تم» يمحو الإشعار ويحذف الملف بأمره
    const share = async () => {
      setBusy(true);
      try { await shareUnsyncedNow(); }
      catch (e) { await fail(e); }
      setBusy(false);
    };
    const saved = decision.pending > 0;
    return (
      <Sheet visible onClose={() => setLater(true)} title={t(decision.left ? 'org.exit.leftTitle' : 'org.exit.removedTitle')}>
        <T size={TYPE.body} style={{ marginBottom: 8 }}>{t('org.exit.wiped')}</T>
        {saved ? <Note>{t('org.exit.saved', { n: decision.pending })}</Note> : null}
        {saved ? (
          <View style={{ marginBottom: 8 }}>
            <BtnPrimary title={t('org.exit.share')} loading={busy} onPress={share} />
          </View>
        ) : null}
        <View style={{ marginBottom: 8 }}>
          <BtnGhost title={t(saved ? 'org.exit.done' : 'org.exit.ok')} onPress={() => run('done')} />
        </View>
        <BtnGhost title={t('org.exit.later')} onPress={() => setLater(true)} />
      </Sheet>
    );
  }
  return (
    <Sheet visible onClose={() => setLater(true)} title="مُسحت بيانات المنشأة من جهاز آخر">
      <T size={TYPE.body} style={{ marginBottom: 8 }}>
        مُسحت بيانات المنشأة في السحابة من جهاز آخر، وعلى هذا الجهاز بيانات. لن يُمسح شيء منها إلا بأمرك.
      </T>
      {decision.pending > 0 ? <Note>{'في الطابور ' + decision.pending + ' تغييراً لم يُرفع.'}</Note> : null}
      <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 10 }}>
        المزامنة متوقفة حتى تقرر · والتطبيق يعمل بما على الجهاز.
      </T>
      {owner ? (
        <View style={{ marginBottom: 8 }}>
          <BtnPrimary title="أبقِ بياناتي وارفعها إلى المنشأة" loading={busy} onPress={() => run('keep')} />
        </View>
      ) : null}
      <View style={{ marginBottom: 8 }}>
        <BtnGhost danger title="فرّغ هذا الجهاز (بعد نسخة أمان)" onPress={() => run('wipe')} />
      </View>
      <BtnGhost title="لاحقاً" onPress={() => setLater(true)} />
    </Sheet>
  );
}

/**
 * الورقة داخل حاجز أخطاء (G-2): عطلٌ فيها لا يُسقط التطبيق، وبطاقة الحاجز تُغلق بعلامتها كـ«لاحقاً» فلا تبقى تحت الشاشة
 * (مدقق المرحلة ٠ · P0-13) · وتعود مع الفتح التالي كالورقة نفسها.
 */
export function DecisionGate({ decision }: { decision: NonNullable<CloudState['decision']> }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <ErrorBoundary where={t('sync.pendingDecision')} onClose={() => setHidden(true)}>
      <DecisionSheet decision={decision} />
    </ErrorBoundary>
  );
}

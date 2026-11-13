/**
 * ما ينتظر قرار المستخدم ولا يُنفَّذ بدونه (قاعدة المالك ٢٠٢٦-١٠-٠٥): لا يُمسح شيء من الجهاز إلا بأمره في تلك اللحظة.
 *  - مُسحت بيانات المنشأة من جهاز آخر وعلى هذا الجهاز بيانات: يبقيها ويرفعها، أو يفرّغ الجهاز (بنسخة أمان).
 *  - أُزيلت عضويته وفي طابوره ما لم يُرفع: يفرّغ (بنسخة أمان)، أو يؤجّل والمزامنة متوقفة.
 * المزامنة متوقفة حتى يقرر، والتطبيق يعمل بما على الجهاز.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { Sheet } from './Sheet';
import { BtnGhost, BtnPrimary, Note, T } from './components';
import { C, TYPE } from './theme';
import { reportFailure } from './failureDialog';
import { useApp } from './store';
import { resolveDecision, type CloudState } from '../services/cloud';
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
  const run = async (choice: 'keep' | 'wipe') => {
    setBusy(true);
    try { await resolveDecision(choice); bump(); }
    catch (e) { await reportFailure({ title: 'تعذّر التنفيذ', where: 'قرار المزامنة', db, e }); }
    setBusy(false);
  };
  const epoch = decision.kind === 'epoch';
  return (
    <Sheet visible onClose={() => setLater(true)} title={epoch ? 'مُسحت بيانات المنشأة من جهاز آخر' : 'أُزيلت عضويتك من المنشأة'}>
      <T size={TYPE.body} style={{ marginBottom: 8 }}>
        {epoch
          ? 'مُسحت بيانات المنشأة في السحابة من جهاز آخر، وعلى هذا الجهاز بيانات. لن يُمسح شيء منها إلا بأمرك.'
          : 'أُزيلت عضويتك، وعلى هذا الجهاز ' + decision.pending + ' تغييراً لم يُرفع ولن يُقبل بعد الإزالة.'}
      </T>
      {decision.pending > 0 ? <Note>{'في الطابور ' + decision.pending + ' تغييراً لم يُرفع.'}</Note> : null}
      <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 10 }}>
        المزامنة متوقفة حتى تقرر · والتطبيق يعمل بما على الجهاز.
      </T>
      {epoch && owner ? (
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

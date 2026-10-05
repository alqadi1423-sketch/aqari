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

export function DecisionSheet({ decision }: { decision: NonNullable<CloudState['decision']> }) {
  const { db, bump } = useApp();
  const [busy, setBusy] = useState(false);
  const [later, setLater] = useState(false);
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
      {epoch ? (
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

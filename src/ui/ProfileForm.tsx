/**
 * بيانات العضو من جهازه (توجيه المالك ٢٠٢٦-١٠-٠٥ · ثانياً) · نموذج واحد لشاشة الإكمال بعد قبول الدعوة
 * ولنافذة «بياناتي» في الإعدادات. الاسم والجوال إلزاميان، والهوية والمسمى اختياريان، والحفظ إلى مستند
 * العضوية في السحابة (يحتاج اتصالاً) ويُسجَّل في سجل العمليات باسمه.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { BtnPrimary, Field, Note, T } from './components';
import { C, TYPE } from './theme';
import { Sheet } from './Sheet';
import { useApp } from './store';
import { useToast } from './Toast';
import { reportFailure } from './failureDialog';
import { validateProfile, EMPTY_PROFILE, type MemberProfile } from '../domain/access/profile';
import { updateMyProfileNow } from '../services/cloud';
import { readMembership } from '../services/access';

export function ProfileFields({ value, onChange, error }: {
  value: MemberProfile; onChange: (p: MemberProfile) => void; error: keyof MemberProfile | null;
}) {
  return (
    <>
      <Field label="الاسم الكامل" value={value.name} onChange={(v) => onChange({ ...value, name: v })} error={error === 'name'} />
      <Field label="الجوال" value={value.phone} onChange={(v) => onChange({ ...value, phone: v })} keyboard="phone-pad" ltr
        placeholder="05XXXXXXXX" error={error === 'phone'} />
      <Field label="الهوية أو الإقامة (اختياري)" value={value.nid} onChange={(v) => onChange({ ...value, nid: v })} keyboard="numeric" ltr
        error={error === 'nid'} />
      <Field label="المسمى الوظيفي (اختياري)" value={value.title} onChange={(v) => onChange({ ...value, title: v })} error={error === 'title'} />
    </>
  );
}

/** النموذج بحفظه · required: الاسم والجوال إلزاميان */
export function MyProfileForm({ onSaved, submitTitle }: { onSaved?: () => void; submitTitle: string }) {
  const { db, bump } = useApp();
  const toast = useToast();
  const [p, setP] = useState<MemberProfile>(() => readMembership(db)?.profile ?? EMPTY_PROFILE);
  const [saving, setSaving] = useState(false);
  const v = validateProfile(p, true);
  return (
    <>
      <ProfileFields value={p} onChange={setP} error={null} />
      <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 8 }}>
        هويتك لا يراها إلا صاحب المنشأة · واسمك يظهر منفّذاً في سجل العمليات
      </T>
      {!v.ok ? <Note>{v.error}</Note> : (
        <BtnPrimary title={submitTitle} loading={saving} onPress={async () => {
          setSaving(true);
          try { await updateMyProfileNow(db, v.profile); bump(); toast('حُفظت بياناتك'); onSaved?.(); }
          catch (e) { await reportFailure({ title: 'تعذّر حفظ بياناتك', where: 'بياناتي', db, e }); }
          setSaving(false);
        }} />
      )}
      <View style={{ height: 10 }} />
    </>
  );
}

/** «بياناتي» في الإعدادات · للعضو وحده */
export function MyProfileSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Sheet visible={visible} onClose={onClose} title="بياناتي" tall>
      <MyProfileForm submitTitle="حفظ" onSaved={onClose} />
    </Sheet>
  );
}

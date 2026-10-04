/**
 * الأعضاء والصلاحيات (الدراسة ب المعتمدة · docs/PERMISSIONS.md) · للمالك وحده:
 * الأعضاء والدعوات المعلّقة، ودعوة عضو بإيميل قوقل، وصلاحيته قسماً قسماً بأربعة مستويات
 * (والقوالب تعبّئها ثم تُعدَّل)، وعقاراته (الكل أو تحديد)، والتعديل والإزالة.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Sheet } from './Sheet';
import { BtnGhost, BtnPrimary, Chip, EmptyState, Field, Note, Row, T } from './components';
import { C, TYPE } from './theme';
import { useApp } from './store';
import { useDialog } from './AppDialog';
import { useToast } from './Toast';
import { reportFailure } from './failureDialog';
import { GRANTABLE, LEVEL_LABEL, LEVEL_MEANING, TEMPLATES, type Level, type Perms } from '../domain/access/sections';
import type { MemberDoc, MemberSpec } from '../services/org';
import { inviteMemberNow, listTeamNow, removeMemberNow, revokeInviteNow, updateMemberNow } from '../services/cloud';

type Team = Awaited<ReturnType<typeof listTeamNow>>;

/** ملخص الصلاحية بسطر: الأقسام المفتوحة بمستوياتها */
export function permSummary(perm: Perms): string {
  const parts = GRANTABLE.filter((s) => (perm[s.key] ?? 0) > 0).map((s) => s.label + ': ' + LEVEL_LABEL[perm[s.key] as Level]);
  return parts.length ? parts.join(' · ') : 'لا أقسام';
}

export function TeamSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { db } = useApp();
  const dialog = useDialog();
  const toast = useToast();
  const [team, setTeam] = useState<Team | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ uid: string | null; doc: MemberDoc | null } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try { setTeam(await listTeamNow()); }
    catch (e) { await reportFailure({ title: 'تعذّر قراءة الأعضاء', where: 'الأعضاء', db, e }); }
    setBusy(false);
  }, [db]);
  useEffect(() => { if (visible) load(); }, [visible, load]);

  const props = (doc: MemberDoc) => (doc.all ? 'كل العقارات' : doc.props.length + ' عقار');

  return (
    <>
      <Sheet visible={visible && !edit} onClose={onClose} title="الأعضاء والصلاحيات" tall
        footer={<BtnPrimary title="+ دعوة عضو" onPress={() => setEdit({ uid: null, doc: null })} />}>
        {!team ? <EmptyState>{busy ? 'جاري القراءة' : 'لا اتصال'}</EmptyState> : (
          <>
            {team.members.length || team.invites.length ? null : <EmptyState>لا أعضاء بعد · ادعُ عضواً بإيميل قوقل الخاص به</EmptyState>}
            {team.members.map((m) => (
              <View key={m.uid} style={{ paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <T size={TYPE.body} bold>{m.doc.email}</T>
                <T size={TYPE.caption} color={C.muted} style={{ marginTop: 2 }}>{props(m.doc) + ' · ' + permSummary(m.doc.perm)}</T>
                <Row style={{ marginTop: 6 }}>
                  <BtnGhost small title="تعديل الصلاحية" onPress={() => setEdit({ uid: m.uid, doc: m.doc })} />
                  <BtnGhost small danger title="إزالة" onPress={() => dialog({
                    title: 'إزالة العضو',
                    body: 'تُلغى عضوية ' + m.doc.email + ' فوراً، ويُفرَّغ جهازه من بيانات المنشأة عند أول اتصال.',
                    tone: 'danger',
                    actions: [
                      { label: 'تراجع', variant: 'ghost' },
                      { label: 'أزِل', variant: 'danger', onPress: async () => {
                        try { await removeMemberNow(m.uid); toast('أُزيل العضو'); load(); }
                        catch (e) { await reportFailure({ title: 'تعذّرت الإزالة', where: 'الأعضاء', db, e }); }
                      } },
                    ],
                  })} />
                </Row>
              </View>
            ))}
            {team.invites.map((inv) => (
              <View key={inv.email} style={{ paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <T size={TYPE.body} bold>{inv.email}</T>
                <T size={TYPE.caption} color={C.gold} style={{ marginTop: 2 }}>بانتظار القبول</T>
                <T size={TYPE.caption} color={C.muted}>{props(inv) + ' · ' + permSummary(inv.perm)}</T>
                <Row style={{ marginTop: 6 }}>
                  <BtnGhost small title="إرسال بالواتساب" onPress={() => shareInvite(inv)} />
                  <BtnGhost small danger title="إلغاء الدعوة" onPress={async () => {
                    try { await revokeInviteNow(inv.email); toast('أُلغيت الدعوة'); load(); }
                    catch (e) { await reportFailure({ title: 'تعذّر الإلغاء', where: 'الأعضاء', db, e }); }
                  }} />
                </Row>
              </View>
            ))}
          </>
        )}
      </Sheet>
      {edit ? (
        <MemberEditor
          initial={edit.doc}
          isNew={!edit.uid}
          onClose={() => setEdit(null)}
          onSave={async (spec) => {
            try {
              if (edit.uid) { await updateMemberNow(db, edit.uid, spec); toast('حُفظت الصلاحية · تسري على جهازه عند أول اتصال'); }
              else { const doc = await inviteMemberNow(db, spec); shareInvite(doc); }
              setEdit(null);
              load();
            } catch (e) { await reportFailure({ title: 'تعذّر الحفظ', where: 'الأعضاء', db, e }); }
          }}
        />
      ) : null}
    </>
  );
}

/** رسالة الدعوة بالواتساب · بلا رقم: يختار المالك المحادثة */
function shareInvite(doc: MemberDoc): void {
  const text = 'دعوتك للانضمام إلى «' + (doc.orgName || 'منشأتنا') + '» في تطبيق عقاري.\n'
    + 'ثبّت التطبيق وادخل بحساب قوقل هذا: ' + doc.email;
  Linking.openURL('whatsapp://send?text=' + encodeURIComponent(text)).catch(() => {});
}

function MemberEditor({ initial, isNew, onClose, onSave }: {
  initial: MemberDoc | null; isNew: boolean; onClose: () => void; onSave: (spec: MemberSpec) => Promise<void>;
}) {
  const { db } = useApp();
  const [email, setEmail] = useState(initial?.email ?? '');
  const [perms, setPerms] = useState<Perms>(initial?.perm ?? {});
  const [allProps, setAllProps] = useState(initial?.all ?? true);
  const [props, setProps] = useState<string[]>(initial?.props ?? []);
  const [saving, setSaving] = useState(false);
  const properties = useMemo(() => db.all<{ id: string; name: string }>(
    `SELECT id, name FROM properties WHERE deleted_at IS NULL ORDER BY name`), [db]);
  const any = GRANTABLE.some((s) => (perms[s.key] ?? 0) > 0);
  const ready = (!isNew || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) && any && (allProps || props.length > 0);

  return (
    <Sheet visible onClose={onClose} title={isNew ? 'دعوة عضو' : 'صلاحية ' + (initial?.email ?? '')} tall
      footer={ready ? (
        <BtnPrimary title={isNew ? 'إرسال الدعوة' : 'حفظ الصلاحية'} loading={saving} onPress={async () => {
          setSaving(true);
          await onSave({ email: isNew ? email : initial!.email, perms, allProps, props });
          setSaving(false);
        }} />
      ) : null}>
      {isNew ? <Field label="إيميل قوقل للعضو" value={email} onChange={setEmail} ltr placeholder="name@gmail.com" /> : null}

      <T size={TYPE.cardTitle} bold style={{ marginTop: 6, marginBottom: 4 }}>قالب سريع</T>
      <Row style={{ flexWrap: 'wrap', marginBottom: 6 }}>
        {TEMPLATES.map((t) => <Chip key={t.key} label={t.label} onPress={() => setPerms({ ...t.perms })} />)}
      </Row>

      <T size={TYPE.cardTitle} bold style={{ marginTop: 8, marginBottom: 2 }}>الأقسام</T>
      <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 6 }}>
        {([0, 1, 2, 3] as Level[]).map((l) => LEVEL_LABEL[l] + ': ' + LEVEL_MEANING[l]).join(' · ')}
      </T>
      {GRANTABLE.map((s) => (
        <View key={s.key} style={{ paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <T size={TYPE.body} bold>{s.label}</T>
          <T size={TYPE.caption} color={C.muted}>{s.covers}</T>
          <Row style={{ marginTop: 5, flexWrap: 'wrap' }} gap={6}>
            {([0, 1, 2, 3] as Level[]).filter((l) => l <= s.max).map((l) => (
              <Chip key={l} label={LEVEL_LABEL[l]} active={(perms[s.key] ?? 0) === l}
                onPress={() => setPerms((p) => ({ ...p, [s.key]: l }))} />
            ))}
          </Row>
        </View>
      ))}

      <T size={TYPE.cardTitle} bold style={{ marginTop: 12, marginBottom: 4 }}>العقارات</T>
      <Row style={{ marginBottom: 6 }}>
        <Chip label="كل العقارات" active={allProps} onPress={() => setAllProps(true)} />
        <Chip label="تحديد" active={!allProps} onPress={() => setAllProps(false)} />
      </Row>
      {!allProps ? properties.map((p) => {
        const on = props.includes(p.id);
        return (
          <Pressable key={p.id} onPress={() => setProps((xs) => (on ? xs.filter((x) => x !== p.id) : [...xs, p.id]))}>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 8 }}>
              <T size={TYPE.body}>{p.name}</T>
              <T size={TYPE.body} bold color={on ? C.emerald : C.muted}>{on ? '✓' : ''}</T>
            </Row>
          </Pressable>
        );
      }) : null}
      {!ready ? <Note>{!any ? 'اختر قسماً واحداً على الأقل' : !allProps && !props.length ? 'اختر عقاراً واحداً على الأقل' : 'اكتب إيميل قوقل صحيحاً'}</Note> : null}
      <View style={{ height: 14 }} />
    </Sheet>
  );
}

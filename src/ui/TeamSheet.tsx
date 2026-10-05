/**
 * الأعضاء والصلاحيات (الدراسة ب المعتمدة · docs/PERMISSIONS.md) · للمالك وحده:
 * الأعضاء والدعوات المعلّقة، ودعوة عضو بإيميل قوقل، وصلاحيته قسماً قسماً بأربعة مستويات
 * (والقوالب تعبّئها ثم تُعدَّل)، وعقاراته (الكل أو تحديد)، والتعديل والإزالة.
 * وبيانات العضو (الاسم والجوال والهوية والمسمى) يملؤها المالك عند الدعوة أو بعدها، ويكملها العضو.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Sheet } from './Sheet';
import { Badge, BtnGhost, BtnPrimary, Chip, EmptyState, Field, Note, Row, T } from './components';
import { C, TYPE } from './theme';
import { useApp } from './store';
import { useDialog } from './AppDialog';
import { useToast } from './Toast';
import { reportFailure } from './failureDialog';
import { GRANTABLE, LEVEL_DOES, LEVEL_LABEL, SECTION_GROUPS, TEMPLATES, levelsOf, sectionDef, type Level, type Perms, type SectionKey } from '../domain/access/sections';
import { canView, level, type Access } from '../domain/access/access';
import { routeAllowed } from '../domain/access/routes';
import { MONEY_SECTIONS } from '../domain/access/readSections';
import { MORE_SCREENS } from './moreScreens';
import { profileOf, type MemberDoc, type MemberSpec } from '../services/org';
import { inviteMemberNow, listTeamNow, removeMemberNow, revokeInviteNow, updateMemberNow, updateMemberProfileNow } from '../services/cloud';
import { validateProfile, type MemberProfile } from '../domain/access/profile';

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
  // القائمة بالاسم والمسمى · والإيميل سطراً ثانياً، وبلا اسم يُعرض الإيميل وحده
  const who = (doc: MemberDoc) => (doc.name ? doc.name + (doc.title ? ' · ' + doc.title : '') : doc.email);

  return (
    <>
      <Sheet visible={visible && !edit} onClose={onClose} title="الأعضاء والصلاحيات" tall
        footer={<BtnPrimary title="+ دعوة عضو" onPress={() => setEdit({ uid: null, doc: null })} />}>
        {!team ? <EmptyState>{busy ? 'جاري القراءة' : 'لا اتصال'}</EmptyState> : (
          <>
            {team.members.length || team.invites.length ? null : <EmptyState>لا أعضاء بعد · ادعُ عضواً بإيميل قوقل الخاص به</EmptyState>}
            {team.members.map((m) => (
              <View key={m.uid} style={{ paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <T size={TYPE.body} bold>{who(m.doc)}</T>
                {m.doc.name ? <T size={TYPE.caption} color={C.muted}>{m.doc.email}</T> : <T size={TYPE.caption} color={C.gold}>لم يكمل بياناته بعد</T>}
                <T size={TYPE.caption} color={C.muted} style={{ marginTop: 2 }}>{props(m.doc) + ' · ' + permSummary(m.doc.perm)}</T>
                <Row style={{ marginTop: 6 }}>
                  <BtnGhost small title="البيانات والصلاحية" onPress={() => setEdit({ uid: m.uid, doc: m.doc })} />
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
                <T size={TYPE.body} bold>{who(inv)}</T>
                {inv.name ? <T size={TYPE.caption} color={C.muted}>{inv.email}</T> : null}
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
              if (edit.uid) {
                // البيانات أولاً بسجلها، ثم الصلاحية بالمستند كاملاً ومعه البيانات نفسها
                const before = edit.doc ? profileOf(edit.doc) : null;
                if (spec.profile && JSON.stringify(spec.profile) !== JSON.stringify(before)) {
                  await updateMemberProfileNow(db, edit.uid, edit.doc?.email ?? '', spec.profile);
                }
                await updateMemberNow(db, edit.uid, spec);
                toast('حُفظت · تسري على جهازه عند أول اتصال');
              }
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

/** رابط تنزيل التطبيق للمدعوّ · من إعداد البناء، وغيابه يُسقط سطره من الرسالة */
const DOWNLOAD_URL = process.env.EXPO_PUBLIC_APP_DOWNLOAD_URL ?? '';

/** رسالة الدعوة بالواتساب: اسم المنشأة من بياناتها ورابط التنزيل والإيميل المدعوّ · بلا رقم: يختار المالك المحادثة */
function shareInvite(doc: MemberDoc): void {
  const text = 'دعوتك للانضمام إلى «' + (doc.orgName || 'منشأتنا') + '» في تطبيق عقاري.\n'
    + (DOWNLOAD_URL ? 'نزّل التطبيق: ' + DOWNLOAD_URL + '\n' : '')
    + 'ثم ادخل بحساب قوقل هذا: ' + doc.email;
  Linking.openURL('whatsapp://send?text=' + encodeURIComponent(text)).catch(() => {});
}

function MemberEditor({ initial, isNew, onClose, onSave }: {
  initial: MemberDoc | null; isNew: boolean; onClose: () => void; onSave: (spec: MemberSpec) => Promise<void>;
}) {
  const { db } = useApp();
  const [email, setEmail] = useState(initial?.email ?? '');
  const [perms, setPermsRaw] = useState<Perms>(initial?.perm ?? {});
  const [allProps, setAllPropsRaw] = useState(initial?.all ?? true);
  const [props, setPropsRaw] = useState<string[]>(initial?.props ?? []);
  const [profile, setProfile] = useState<MemberProfile>(initial ? profileOf(initial) : { name: '', phone: '', nid: '', title: '' });
  // القالب المختار يبقى مظلَّلاً حتى يتغيّر أي اختيار بعده (توجيه المالك ٢٠٢٦-١٠-٠٥)
  const [tpl, setTpl] = useState<string | null>(null);
  const setPerms: typeof setPermsRaw = (v) => { setTpl(null); setPermsRaw(v); };
  const setAllProps: typeof setAllPropsRaw = (v) => { setTpl(null); setAllPropsRaw(v); };
  const setProps: typeof setPropsRaw = (v) => { setTpl(null); setPropsRaw(v); };
  const pv = validateProfile(profile, false);
  const [saving, setSaving] = useState(false);
  const [openKey, setOpenKey] = useState<SectionKey | null>(null);
  const properties = useMemo(() => db.all<{ id: string; name: string }>(
    `SELECT id, name FROM properties WHERE deleted_at IS NULL ORDER BY name`), [db]);
  const any = GRANTABLE.some((s) => (perms[s.key] ?? 0) > 0);
  const ready = (!isNew || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) && any && (allProps || props.length > 0) && pv.ok;

  return (
    <Sheet visible onClose={onClose} title={isNew ? 'دعوة عضو' : (initial?.name || initial?.email || 'عضو')} tall
      footer={ready ? (
        <BtnPrimary title={isNew ? 'إرسال الدعوة' : 'حفظ الصلاحية'} loading={saving} onPress={async () => {
          setSaving(true);
          await onSave({ email: isNew ? email : initial!.email, perms, allProps, props, profile: pv.ok ? pv.profile : undefined });
          setSaving(false);
        }} />
      ) : null}>
      {isNew ? <Field label="إيميل قوقل للعضو" value={email} onChange={setEmail} ltr placeholder="name@gmail.com" /> : null}

      <T size={TYPE.cardTitle} bold style={{ marginTop: 6, marginBottom: 2 }}>بيانات العضو</T>
      <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 6 }}>
        الاسم والجوال يلزمانه ويكملهما بنفسه إن تركتهما · والهوية لا يراها غيرك وغيره
      </T>
      <Field label="الاسم الكامل" value={profile.name} onChange={(v) => setProfile((p) => ({ ...p, name: v }))}
        error={!pv.ok && pv.field === 'name'} />
      <Field label="الجوال" value={profile.phone} onChange={(v) => setProfile((p) => ({ ...p, phone: v }))} keyboard="phone-pad" ltr
        placeholder="05XXXXXXXX" error={!pv.ok && pv.field === 'phone'} />
      <Field label="الهوية أو الإقامة (اختياري)" value={profile.nid} onChange={(v) => setProfile((p) => ({ ...p, nid: v }))} keyboard="numeric" ltr
        error={!pv.ok && pv.field === 'nid'} />
      <Field label="المسمى الوظيفي (اختياري)" value={profile.title} onChange={(v) => setProfile((p) => ({ ...p, title: v }))}
        error={!pv.ok && pv.field === 'title'} />
      {!pv.ok ? <Note tone="danger">{pv.error}</Note> : null}

      <T size={TYPE.cardTitle} bold style={{ marginTop: 6, marginBottom: 4 }}>قالب سريع</T>
      <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 6 }}>يعبّئ الاختيارات أدناه ثم تعدّلها · والعضو الجديد يبدأ بلا شيء</T>
      <Row style={{ flexWrap: 'wrap', marginBottom: 6 }}>
        {TEMPLATES.map((t) => <Chip key={t.key} label={t.label} active={tpl === t.key} onPress={() => { setPermsRaw({ ...t.perms }); setTpl(t.key); }} />)}
      </Row>

      {SECTION_GROUPS.map((g) => (
        <View key={g.title} style={{ marginTop: 12 }}>
          <T size={TYPE.cardTitle} bold style={{ marginBottom: 2 }}>{g.title}</T>
          {g.keys.map((k) => {
            const def = sectionDef(k);
            const cur = (perms[k] ?? 0) as Level;
            const open = openKey === k;
            return (
              <View key={k} style={{ borderBottomWidth: 1, borderBottomColor: C.line }}>
                <Pressable onPress={() => setOpenKey(open ? null : k)}>
                  <Row style={{ justifyContent: 'space-between', paddingVertical: 8 }}>
                    <View style={{ flex: 1 }}>
                      <T size={TYPE.body} bold>{def.label}</T>
                      <T size={TYPE.caption} color={cur ? C.charcoal : C.muted}>{cur ? doesUpTo(k, cur) : 'لا يظهر له'}</T>
                    </View>
                    <Badge kind={cur === 0 ? 'draft' : cur === 3 ? 'paid' : 'due'} label={LEVEL_LABEL[cur]} />
                  </Row>
                </Pressable>
                {open ? levelsOf(k).map((l) => (
                  <Pressable key={l} onPress={() => { setPerms((p) => ({ ...p, [k]: l })); setOpenKey(null); }}>
                    <Row style={{ paddingVertical: 7, paddingHorizontal: 8, marginBottom: 4, borderRadius: 8,
                      backgroundColor: l === cur ? C.emeraldSoft : C.paper }}>
                      <View style={{ flex: 1 }}>
                        <T size={TYPE.body} bold color={l === cur ? C.emerald : C.ink}>{LEVEL_LABEL[l]}</T>
                        <T size={TYPE.caption} color={C.muted}>{l === 0 ? 'القسم لا يظهر له أبداً، ولا رابط يفتحه' : doesUpTo(k, l)}</T>
                      </View>
                    </Row>
                  </Pressable>
                )) : null}
              </View>
            );
          })}
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
      <MemberPreview perms={perms} allProps={allProps} props={props} properties={properties} />
      {!ready ? <Note>{!any ? 'اختر قسماً واحداً على الأقل' : !allProps && !props.length ? 'اختر عقاراً واحداً على الأقل' : 'اكتب إيميل قوقل صحيحاً'}</Note> : null}
      <View style={{ height: 14 }} />
    </Sheet>
  );
}

/** ما يستطيعه حتى هذا المستوى · السطور تتراكم (إدخال يشمل العرض) */
function doesUpTo(k: SectionKey, l: Level): string {
  const d = LEVEL_DOES[k] ?? {};
  return ([1, 2, 3] as Level[]).filter((x) => x <= l && d[x]).map((x) => d[x]).join('، ');
}

/** «ما سيظهر لهذا العضو» · يُحسب من الاختيارات نفسها التي تفرضها الواجهة والقواعد */
function MemberPreview({ perms, allProps, props, properties }: {
  perms: Perms; allProps: boolean; props: string[]; properties: Array<{ id: string; name: string }>;
}) {
  const a: Access = { owner: false, uid: null, perms, allProps, props };
  const tabs = ['الرئيسية', ...(canView(a, 'props') ? ['العقارات'] : []), ...(canView(a, 'contracts') ? ['العقود'] : []),
    ...(canView(a, 'collect') ? ['التحصيل'] : []), 'المزيد'];
  const screens = MORE_SCREENS.flatMap((g) => g.items).filter(([p]) => routeAllowed(a, p) && p !== '/settings').map(([, t]) => t);
  const money = GRANTABLE.filter((x) => MONEY_SECTIONS.has(x.key) && canView(a, x.key)).map((x) => x.label);
  const adds = GRANTABLE.filter((x) => level(a, x.key) === 2).map((x) => x.label);
  const full = GRANTABLE.filter((x) => level(a, x.key) === 3).map((x) => x.label);
  const names = allProps ? 'كل العقارات' : properties.filter((p) => props.includes(p.id)).map((p) => p.name).join('، ') || 'لم يُختر عقار';
  const line = (k: string, v: string) => (
    <View style={{ paddingVertical: 4 }}>
      <T size={TYPE.caption} color={C.muted}>{k}</T>
      <T size={TYPE.body}>{v}</T>
    </View>
  );
  return (
    <View style={{ marginTop: 14, padding: 12, borderRadius: 10, backgroundColor: C.paper, borderWidth: 1, borderColor: C.line }}>
      <T size={TYPE.cardTitle} bold style={{ marginBottom: 4 }}>ما سيظهر لهذا العضو</T>
      {line('الشريط السفلي', tabs.join(' · '))}
      {line('في «المزيد»', screens.length ? screens.join(' · ') : 'الإعدادات وحدها')}
      {line('العقارات', names)}
      {line('المبالغ', money.length ? 'يراها في: ' + money.join('، ') : 'لا يرى أي مبلغ')}
      {adds.length ? line('يضيف ولا يعدّل', adds.join('، ')) : null}
      {full.length ? line('يضيف ويعدّل ويلغي', full.join('، ')) : null}
      {line('لا يظهر له أبداً', 'الأعضاء والصلاحيات · النسخ الاحتياطي والاستعادة · المالية · المسح · حذف الحساب')}
    </View>
  );
}

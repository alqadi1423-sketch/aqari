/**
 * المحادثة (src/chat · قرار المالك 2026-10-07) · شاشة واحدة: قائمة المحادثات، والمحادثة المفتوحة بمعاملها t.
 * تعمل بلا اتصال: الرسالة تُحفظ فوراً «لم تُرسل» وتُرفع عند عودته · كل نصٍّ بمفتاحه في ملفي الترجمة.
 * والمالك يراجع محادثةً ليس طرفاً فيها بسببٍ إلزامي، للقراءة وحدها، وتنتهي بإغلاقها (قرار المالك 2026-10-08T04:11Z).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Screen } from '../src/ui/Screen';
import { Badge, BtnGhost, BtnPrimary, Chip, EmptyState, Field, Note, Row, SearchBox, T } from '../src/ui/components';
import { Sheet } from '../src/ui/Sheet';
import { C, FONT, TYPE } from '../src/ui/theme';
import { useApp, useFs } from '../src/ui/store';
import { useAccess } from '../src/ui/access';
import { useLang } from '../src/i18n';
import { dfmt } from '../src/domain/dates';
import {
  cloudState, subscribeCloud, chatSyncNow, chatOwnerName, chatEditGroupNow,
  chatReviewCandidatesNow, chatOpenReviewNow, chatCloseReviewNow, chatJoinGroupNow,
} from '../src/services/cloud';
import type { RemoteMessage, RemoteThread } from '../src/chat/remote';
import { useToast } from '../src/ui/Toast';
import { sectionDef } from '../src/domain/access/sections';
import { UnitDetailSheet } from '../src/ui/unitSheets';
import { AssetSheet } from '../src/ui/AssetSheets';
import { useSaveAttempt } from '../src/ui/formAttempt';
import { reportFailure } from '../src/ui/failureDialog';
import {
  chatMe, canCreateGroup, createGroup, getThread, linkCandidates, linkTarget, listMessages, listPeople, listThreads,
  markRead, onChatSynced, openDirect, sendLocal, CHAT_BODY_MAX, FORMER_MEMBER, canEditGroup,
  isGroupAdmin, canAppointAdmins, canAddMembers, canSendIn, GROUP_DEFAULTS, type GroupSettings, type GroupChange,
  type ChatLink, type ChatMe, type ChatPerson, type ChatThread,
} from '../src/chat';

/** دورة المحادثة كل بضع ثوانٍ ما دامت الشاشة مفتوحة · ومعها تجديد العرض بعد كل دورة */
function useChatPulse(threadId: string | null): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const off = onChatSynced(() => setTick((x) => x + 1));
    // أول فتح: سحب كامل مع الدليل · ثم القائمة سحباً كاملاً بلا الدليل كل ٣٠ ثانية، والمفتوحة وحدها كل ٨ ثوانٍ
    chatSyncNow(threadId ? { threadId } : { force: true }).catch(() => {});
    const run = () => chatSyncNow(threadId ? { threadId } : { full: true }).catch(() => {});
    const h = setInterval(run, threadId ? 8000 : 30000);
    return () => { off(); clearInterval(h); };
  }, [threadId]);
  return tick;
}

/** الوقت بتوقيت الجهاز لا UTC (مراجعة المحادثة #11) */
const pad = (n: number) => String(n).padStart(2, '0');
const localTime = (iso: string) => { const d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const localDay = (iso: string) => { const d = new Date(iso); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

function useChatMe(): ChatMe | null {
  const { db } = useApp();
  const [cloud, setCloud] = useState(cloudState());
  useEffect(() => subscribeCloud(() => setCloud(cloudState())), []);
  return cloud.user ? chatMe(db, cloud.user, chatOwnerName(db)) : null;
}

const LIST_SEP = '، '; // i18n-exempt: فاصل قائمة الأقسام
const PARTY_SEP = ' · '; // i18n-exempt: فاصل اسمي طرفي المحادثة
const supLabel = (sup: string[]) => sup.map((k) => { try { return sectionDef(k as never).label; } catch { return k; } }).join(LIST_SEP);

export default function Chat() {
  const { t } = useLang();
  const me = useChatMe();
  const params = useLocalSearchParams<{ t?: string }>();
  const [open, setOpen] = useState<string | null>(params.t ? String(params.t) : null);
  const [review, setReview] = useState<Review | null>(null);
  const tick = useChatPulse(open);
  if (!me) {
    return <Screen title={t('chat.title')} icon="chat"><EmptyState>{t('chat.needAccount')}</EmptyState></Screen>;
  }
  if (review) return <ReviewView review={review} onClose={() => setReview(null)} />;
  return open
    ? <ThreadView me={me} id={open} tick={tick} onBack={() => setOpen(null)} />
    : <ThreadList me={me} tick={tick} onOpen={setOpen} onReview={setReview} />;
}

/* ─── القائمة ─── */

function ThreadList({ me, tick, onOpen, onReview }: { me: ChatMe; tick: number; onOpen: (id: string) => void; onReview: (r: Review) => void }) {
  const { db, version } = useApp();
  const { t } = useLang();
  const [sheet, setSheet] = useState<'person' | 'group' | 'review' | null>(null);
  const people = useMemo(() => listPeople(db), [db, version, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const threads = useMemo(() => listThreads(db, me.uid, me.owner), [db, version, tick, me.uid, me.owner]); // eslint-disable-line react-hooks/exhaustive-deps
  const mySup = people.find((p) => p.uid === me.uid)?.sup ?? [];
  const nameOf = (uid: string) => (uid === me.uid ? t('chat.you') : people.find((p) => p.uid === uid)?.name || t('chat.member'));
  const titleOf = (th: (typeof threads)[number]) =>
    th.kind === 'group' ? th.name : nameOf(th.members.find((u) => u !== me.uid) ?? me.uid);
  return (
    <Screen title={t('chat.title')} icon="chat"
      actions={(
        <Row gap={6}>
          <BtnPrimary small icon="plus" title={t('chat.newChat')} onPress={() => setSheet('person')} />
          {canCreateGroup(me, mySup) ? <BtnGhost small title={t('chat.newGroup')} onPress={() => setSheet('group')} /> : null}
          {/* مراجعة محادثة للمالك وحده (قرار المالك 2026-10-08T04:11Z) · ولغيره لا يظهر الزر */}
          {me.owner ? <BtnGhost small title={t('chat.review')} onPress={() => setSheet('review')} /> : null}
        </Row>
      )}>
      {/* تنبيه ثابت للأعضاء (قرار المالك 2026-10-08) */}
      {!me.owner ? <Note>{t('chat.ownerSees')}</Note> : null}
      <Note>{t('chat.attachmentsLater')}</Note>
      {threads.length ? threads.map((th) => (
        <Pressable key={th.id} onPress={() => onOpen(th.id)}
          style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={TYPE.cardTitle} bold>{titleOf(th)}</T>
            {th.unread ? <Badge kind="due" label={String(th.unread)} /> : null}
          </Row>
          <Row style={{ justifyContent: 'space-between', marginTop: 2 }}>
            <T size={TYPE.caption} color={C.muted} numberOfLines={1} style={{ flex: 1 }}>{th.lastBody}</T>
            {th.lastTs ? <T size={TYPE.caption} color={C.muted}>{dfmt(localDay(th.lastTs))}</T> : null}
          </Row>
          {th.rejected ? <T size={TYPE.caption} color={C.rose}>{t('chat.rejected')}</T> : null}
        </Pressable>
      )) : <EmptyState>{t('chat.empty')}</EmptyState>}
      {sheet === 'person' ? (
        <PersonSheet me={me} people={people} onClose={() => setSheet(null)}
          onPick={(p) => { setSheet(null); onOpen(openDirect(db, me.uid, p.uid)); }} />
      ) : null}
      {sheet === 'group' ? (
        <GroupSheet me={me} people={people} onClose={() => setSheet(null)}
          onCreated={(id) => { setSheet(null); onOpen(id); }} />
      ) : null}
      {sheet === 'review' ? (
        <ReviewPickSheet people={people} onClose={() => setSheet(null)}
          onReview={(r) => { setSheet(null); onReview(r); }}
          onJoined={(id) => { setSheet(null); onOpen(id); }} />
      ) : null}
    </Screen>
  );
}

function PersonRow({ p, me, onPress, active }: { p: ChatPerson; me: ChatMe; onPress: () => void; active?: boolean }) {
  const { t } = useLang();
  return (
    <Pressable onPress={onPress} style={{ paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: active ? C.emeraldSoft : undefined }}>
      <T size={TYPE.body} bold>{p.name || t('chat.member')}</T>
      {/* الإشراف بجوار الاسم (المواصفة) · والمالك بصفته */}
      {p.uid === me.org ? <T size={TYPE.caption} color={C.muted}>{t('chat.owner')}</T> : null}
      {p.sup.length ? <T size={TYPE.caption} color={C.emerald}>{t('chat.supervisorOf', { sections: supLabel(p.sup) })}</T> : null}
    </Pressable>
  );
}

function PersonSheet({ me, people, onClose, onPick }: { me: ChatMe; people: ChatPerson[]; onClose: () => void; onPick: (p: ChatPerson) => void }) {
  const { t } = useLang();
  const [q, setQ] = useState('');
  const list = people.filter((p) => p.uid !== me.uid && (!q.trim() || p.name.includes(q.trim())));
  return (
    <Sheet visible onClose={onClose} title={t('chat.pickPerson')} tall>
      <SearchBox value={q} onChange={setQ} placeholder={t('common.search')} />
      {list.length ? list.map((p) => <PersonRow key={p.uid} p={p} me={me} onPress={() => onPick(p)} />)
        : <EmptyState>{t('chat.noPeople')}</EmptyState>}
    </Sheet>
  );
}

/** إعدادات المجموعة الثلاثة (قرار المالك 2026-10-08T05:31Z) · تُحدَّد عند الإنشاء ويعدّلها المسؤولون */
function GroupSettingsPicker({ value, onChange, disabled }: { value: Required<GroupSettings>; onChange: (v: Required<GroupSettings>) => void; disabled?: boolean }) {
  const { t } = useLang();
  const row = <K extends keyof GroupSettings>(label: string, key: K, opts: Array<[Required<GroupSettings>[K], string]>) => (
    <View style={{ marginTop: 6 }}>
      <T size={TYPE.caption} color={C.muted}>{label}</T>
      <Row style={{ flexWrap: 'wrap' }}>
        {opts.map(([v, l]) => (
          <Chip key={String(v)} label={l} active={value[key] === v} onPress={() => { if (!disabled) onChange({ ...value, [key]: v }); }} />
        ))}
      </Row>
    </View>
  );
  return (
    <View style={{ marginTop: 6 }}>
      <T size={TYPE.cardTitle} bold>{t('chat.settings')}</T>
      {row(t('chat.hist'), 'h', [['all', t('chat.histAll')], ['join', t('chat.histJoin')]])}
      {row(t('chat.whoSends'), 'w', [['all', t('chat.everyone')], ['admins', t('chat.adminsOnly')]])}
      {row(t('chat.whoAdds'), 'ad', [['admins', t('chat.adminsOnly')], ['all', t('chat.everyone')]])}
    </View>
  );
}

function GroupSheet({ me, people, onClose, onCreated }: { me: ChatMe; people: ChatPerson[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { db } = useApp();
  const { t } = useLang();
  const f = useSaveAttempt();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [settings, setSettings] = useState<Required<GroupSettings>>(GROUP_DEFAULTS);
  const [admins, setAdmins] = useState<string[]>([]);
  const others = people.filter((p) => p.uid !== me.uid);
  const save = () => {
    try { onCreated(createGroup(db, me.uid, name, picked, settings, admins.filter((u) => picked.includes(u)))); }
    catch (e) { reportFailure({ title: t('chat.sendFailed'), e }); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('chat.newGroup')} tall
      footer={<View style={{ flex: 1 }}><BtnPrimary title={t('chat.create')} onPress={() => f.attempt(!!name.trim() && picked.length > 0, save)} /></View>}>
      <Field label={t('chat.groupName')} value={name} onChange={setName} error={f.missing(name)} />
      <GroupSettingsPicker value={settings} onChange={setSettings} />
      <T size={TYPE.cardTitle} bold style={{ marginTop: 6 }}>{t('chat.groupMembers')}</T>
      {f.tried && !picked.length ? <T size={TYPE.caption} color={C.rose}>{t('chat.pickMembers')}</T> : null}
      {others.length ? others.map((p) => (
        <MemberRow key={p.uid} p={p} me={me} member={picked.includes(p.uid)} admin={admins.includes(p.uid)} canAppoint
          onToggle={() => setPicked((x) => (x.includes(p.uid) ? x.filter((u) => u !== p.uid) : [...x, p.uid]))}
          onAdmin={() => setAdmins((x) => (x.includes(p.uid) ? x.filter((u) => u !== p.uid) : [...x, p.uid]))} />
      )) : <EmptyState>{t('chat.noPeople')}</EmptyState>}
    </Sheet>
  );
}

/** عضو في ورقة المجموعة · ومعه «مسؤول» لمن يعيّن (المالك والمنشئ) */
function MemberRow({ p, me, member, admin, canAppoint, onToggle, onAdmin }: {
  p: ChatPerson; me: ChatMe; member: boolean; admin: boolean; canAppoint: boolean; onToggle: () => void; onAdmin: () => void;
}) {
  const { t } = useLang();
  return (
    <Row style={{ alignItems: 'center' }}>
      <View style={{ flex: 1 }}><PersonRow p={p} me={me} active={member} onPress={onToggle} /></View>
      {member && canAppoint ? <Chip label={t('chat.admin')} active={admin} onPress={onAdmin} /> : null}
      {member && !canAppoint && admin ? <T size={TYPE.caption} color={C.emerald}>{t('chat.admin')}</T> : null}
    </Row>
  );
}

/* ─── المحادثة المفتوحة ─── */

function ThreadView({ me, id, tick, onBack }: { me: ChatMe; id: string; tick: number; onBack: () => void }) {
  const { db, version, bump } = useApp();
  const { t } = useLang();
  const fs = useFs();
  const access = useAccess();
  const router = useRouter();
  const [text, setText] = useState('');
  const [link, setLink] = useState<ChatLink | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [unitFor, setUnitFor] = useState<string | null>(null);
  const [assetFor, setAssetFor] = useState<string | null>(null);
  const thread = useMemo(() => getThread(db, id, me.uid), [db, version, tick, id, me.uid]); // eslint-disable-line react-hooks/exhaustive-deps
  const msgs = useMemo(() => listMessages(db, id), [db, version, tick, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const people = useMemo(() => listPeople(db), [db, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { markRead(db, id); }, [db, id, msgs.length]);
  const other = people.find((p) => p.uid === thread?.members.find((u) => u !== me.uid));
  const otherUid = thread?.members.find((u) => u !== me.uid);
  const title = thread?.kind === 'group' ? thread.name : other?.name || (otherUid && people.length ? FORMER_MEMBER : t('chat.member'));
  const [editOpen, setEditOpen] = useState(false);
  const sub = thread?.kind === 'group' ? undefined
    : other?.uid === me.org ? t('chat.owner') : other?.sup.length ? t('chat.supervisorOf', { sections: supLabel(other.sup) }) : undefined;
  const senderOf = (uid: string, fallback: string) => {
    const p = people.find((x) => x.uid === uid);
    if (!p && people.length) return FORMER_MEMBER;
    const sup = uid === me.org ? t('chat.owner') : p?.sup.length ? t('chat.supervisorOf', { sections: supLabel(p.sup) }) : '';
    return (p?.name || fallback || t('chat.member')) + (sup ? ' · ' + sup : '');
  };

  const send = useCallback(() => {
    if (!text.trim() && !link) return;
    try {
      sendLocal(db, id, me, text, link);
    } catch (e) {
      reportFailure({ title: t('chat.sendFailed'), e });
      return;
    }
    setText(''); setLink(null); bump();
    chatSyncNow({ threadId: id }).catch(() => {});
  }, [db, id, me, text, link, bump, t]);

  const openLink = (l: ChatLink) => {
    const target = linkTarget(db, access, l);
    if (!target.canOpen) return;
    if (l.type === 'contract') router.push({ pathname: '/(tabs)/contracts', params: { detail: l.id } } as never);
    else if (l.type === 'unit') setUnitFor(l.id);
    else if (l.type === 'asset') setAssetFor(l.id);
  };

  return (
    <Screen title={title} sub={sub} icon="chat" scroll={false}
      actions={(
        <Row gap={6}>
          {/* المجموعة لمسؤوليها، ولمن يضيف أعضاء إن أُذن له (2026-10-08T05:31Z) · ولغيرهم لا يظهر الزر */}
          {thread?.kind === 'group' && (isGroupAdmin(me, thread) || canAddMembers(me, thread)) ? (
            <BtnGhost small title={t('chat.groupMembers')} onPress={() => setEditOpen(true)} />
          ) : null}
          <BtnGhost small title={t('chat.back')} onPress={onBack} />
        </Row>
      )}>
      {!me.owner ? <Note>{t('chat.ownerSees')}</Note> : null}
      <FlatList
        style={{ flex: 1 }}
        data={msgs}
        keyExtractor={(m) => m.id}
        renderItem={({ item: m }) => {
          const mine = m.sender === me.uid;
          const target = m.link ? linkTarget(db, access, m.link) : null;
          if (m.sys === 'join') return <SysLine label={t('chat.ownerJoined')} />;
          return (
            <View style={{ alignSelf: mine ? 'flex-start' : 'flex-end', maxWidth: '85%', marginVertical: 4,
              backgroundColor: mine ? C.emeraldSoft : C.paper, borderRadius: 12, padding: 9, borderWidth: 1, borderColor: C.line }}>
              {!mine && thread?.kind === 'group' ? <T size={TYPE.caption} bold color={C.emerald}>{senderOf(m.sender, m.senderName)}</T> : null}
              {m.body ? <T size={TYPE.body}>{m.body}</T> : null}
              {m.link ? (
                <Pressable disabled={!target?.canOpen} onPress={() => openLink(m.link!)}
                  style={{ marginTop: 4, padding: 6, borderRadius: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: C.line }}>
                  <T size={TYPE.caption} bold color={target?.canOpen ? C.emerald : C.muted}>{t('chat.link.' + m.link.type)} · {m.link.label}</T>
                  {/* من لا صلاحية له يرى الاسم وحده (المواصفة) */}
                  {!target?.canOpen ? <T size={TYPE.caption} color={C.muted}>{t('chat.nameOnly')}</T> : null}
                </Pressable>
              ) : null}
              <T size={10} color={C.muted} style={{ marginTop: 3 }}>
                {localTime(m.serverTs ?? m.localAt)}{m.rejected ? ' · ' + t('chat.rejectedMsg') : !m.sent ? ' · ' + t('chat.notSent') : ''}
              </T>
            </View>
          );
        }}
      />
      {/* من يرسل: كل الأعضاء، أو المسؤولون وحدهم (2026-10-08T05:31Z) */}
      {thread && !canSendIn(me, thread) ? <Note>{t('chat.adminsOnlySend')}</Note> : (
        <>
          {link ? (
            <Row style={{ paddingVertical: 4 }}>
              <Chip label={t('chat.link.' + link.type) + ' · ' + link.label} active onPress={() => setLink(null)} />
            </Row>
          ) : null}
          <Row style={{ paddingVertical: 6, alignItems: 'flex-end' }} gap={6}>
            <BtnGhost small icon="attach" title={t('chat.attach')} onPress={() => setLinkOpen(true)} />
            <TextInput value={text} onChangeText={setText} multiline maxLength={CHAT_BODY_MAX} placeholder={t('chat.typeMessage')} placeholderTextColor="#B9BFC9"
              style={{ flex: 1, fontFamily: FONT, fontSize: fs(TYPE.body), minHeight: 44, maxHeight: 120, borderWidth: 1, borderColor: C.line,
                borderRadius: 10, paddingHorizontal: 10, backgroundColor: '#FAFAF7', textAlign: 'right' }} />
            <BtnPrimary small title={t('chat.send')} onPress={send} />
          </Row>
        </>
      )}
      {editOpen && thread ? (
        <GroupEditSheet me={me} people={people} thread={thread} onClose={() => setEditOpen(false)} />
      ) : null}
      {linkOpen ? <LinkSheet onClose={() => setLinkOpen(false)} onPick={(l) => { setLink(l); setLinkOpen(false); }} /> : null}
      {unitFor ? <UnitDetailSheet unitId={unitFor} onClose={() => setUnitFor(null)}
        onEdit={() => { setUnitFor(null); router.push('/units' as never); }}
        onReserve={() => { setUnitFor(null); router.push('/units' as never); }} /> : null}
      {assetFor ? <AssetSheet id={assetFor} onClose={() => setAssetFor(null)} /> : null}
    </Screen>
  );
}

/**
 * المجموعة وإعداداتها ومسؤولوها · تعديلٌ يحتاج اتصالاً · كلٌّ بصلاحيته (#19 وقرار المالك 2026-10-08T05:31Z):
 * الاسم والإعدادات للمسؤولين، وتعيين المسؤولين للمالك والمنشئ، والإضافة للمسؤولين (ولكل الأعضاء إن أُذن)،
 * والإزالة للمالك والمنشئ · وما لا يحق له لا يتغير بالضغط
 */
function GroupEditSheet({ me, people, thread, onClose }: { me: ChatMe; people: ChatPerson[]; thread: ChatThread; onClose: () => void }) {
  const { t } = useLang();
  const { bump } = useApp();
  const toast = useToast();
  const f = useSaveAttempt();
  const admin = isGroupAdmin(me, thread);
  const appoint = canAppointAdmins(me, thread);
  const adder = canAddMembers(me, thread);
  const remover = canEditGroup(me, thread.createdBy);
  const [name, setName] = useState(thread.name);
  const [settings, setSettings] = useState<Required<GroupSettings>>(thread.settings);
  const [members, setMembers] = useState<string[]>(thread.members);
  const [admins, setAdmins] = useState<string[]>(thread.admins);
  const others = people.filter((p) => p.uid !== me.uid);
  const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const toggle = (uid: string) => setMembers((x) => (x.includes(uid) ? (remover ? x.filter((u) => u !== uid) : x) : (adder ? [...x, uid] : x)));
  const save = async () => {
    const change: GroupChange = {};
    if (admin && name.trim() !== thread.name) change.name = name;
    if (admin && JSON.stringify(settings) !== JSON.stringify(thread.settings)) change.s = settings;
    if (!same(members, thread.members)) change.members = members;
    if (appoint && !same(admins, thread.admins)) change.a = admins.filter((u) => members.includes(u));
    try {
      await chatEditGroupNow(thread.id, change);
      bump(); toast(t('chat.groupSaved')); onClose();
    } catch (e) { reportFailure({ title: t('chat.groupSaveFailed'), e }); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('chat.editGroup')} tall
      footer={<View style={{ flex: 1 }}><BtnPrimary title={t('common.save')} onPress={() => f.attempt(!!name.trim() && members.length > 0, save)} /></View>}>
      <Field label={t('chat.groupName')} value={name} onChange={setName} error={f.missing(name)} disabled={!admin} />
      <GroupSettingsPicker value={settings} onChange={setSettings} disabled={!admin} />
      <T size={TYPE.cardTitle} bold style={{ marginTop: 6 }}>{t('chat.groupMembers')}</T>
      {others.map((p) => (
        <MemberRow key={p.uid} p={p} me={me} member={members.includes(p.uid)} admin={admins.includes(p.uid)} canAppoint={appoint}
          onToggle={() => toggle(p.uid)}
          onAdmin={() => setAdmins((x) => (x.includes(p.uid) ? x.filter((u) => u !== p.uid) : [...x, p.uid]))} />
      ))}
    </Sheet>
  );
}

/** سطر نظام وسط المحادثة · «انضم المالك» */
function SysLine({ label }: { label: string }) {
  return (
    <View style={{ alignSelf: 'center', marginVertical: 6, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, backgroundColor: C.line }}>
      <T size={TYPE.caption} color={C.muted}>{label}</T>
    </View>
  );
}

/* ─── مراجعة المالك محادثةً بسبب، وانضمامه إلى مجموعة (قرارا المالك 2026-10-08T04:11Z) ─── */

interface Review { thread: RemoteThread; title: string; reason: string; msgs: RemoteMessage[] }

/** يختار المالك المحادثة ويكتب السبب إلزامياً · والمجموعة يقدر أن ينضم إليها فيرى الأعضاء «انضم المالك» */
function ReviewPickSheet({ people, onClose, onReview, onJoined }: {
  people: ChatPerson[]; onClose: () => void; onReview: (r: Review) => void; onJoined: (id: string) => void;
}) {
  const { t } = useLang();
  const { bump } = useApp();
  const toast = useToast();
  const f = useSaveAttempt();
  const [list, setList] = useState<RemoteThread[] | null>(null);
  const [picked, setPicked] = useState<RemoteThread | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    chatReviewCandidatesNow().then((x) => { if (live) setList(x); })
      .catch((e) => { if (live) { setList([]); reportFailure({ title: t('chat.reviewFailed'), e }); } });
    return () => { live = false; };
  }, [t]);
  const nameOf = (uid: string) => people.find((p) => p.uid === uid)?.name || t('chat.member');
  const titleOf = (th: RemoteThread) => (th.k === 'group' ? th.name : th.p.map(nameOf).join(PARTY_SEP));
  const open = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      const title = titleOf(picked);
      const msgs = await chatOpenReviewNow(picked.id, reason, title);
      onReview({ thread: picked, title, reason: reason.trim(), msgs });
    } catch (e) { reportFailure({ title: t('chat.reviewFailed'), e }); }
    setBusy(false);
  };
  const join = async (th: RemoteThread) => {
    setBusy(true);
    try {
      await chatJoinGroupNow(th);
      bump(); toast(t('chat.joined'));
      chatSyncNow({ threadId: th.id }).catch(() => {});
      onJoined(th.id);
    } catch (e) { reportFailure({ title: t('chat.joinFailed'), e }); }
    setBusy(false);
  };
  return (
    <Sheet visible onClose={onClose} title={t('chat.review')} tall
      footer={<View style={{ flex: 1 }}><BtnPrimary title={t('chat.reviewOpen')} loading={busy}
        onPress={() => f.attempt(!!reason.trim() && !!picked, open)} /></View>}>
      <T size={TYPE.cardTitle} bold>{t('chat.reviewPick')}</T>
      {f.tried && !picked ? <T size={TYPE.caption} color={C.rose}>{t('chat.reviewPickFirst')}</T> : null}
      {list === null ? <T size={TYPE.caption} color={C.muted}>{t('chat.loading')}</T>
        : list.length ? list.map((th) => (
          <Pressable key={th.id} onPress={() => setPicked(th)}
            style={{ paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: picked?.id === th.id ? C.emeraldSoft : undefined }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={TYPE.body} bold style={{ flex: 1 }}>{titleOf(th)}</T>
              {th.k === 'group' ? <BtnGhost small title={t('chat.join')} onPress={() => join(th)} /> : null}
            </Row>
          </Pressable>
        )) : <EmptyState>{t('chat.reviewNone')}</EmptyState>}
      <Field label={t('chat.reviewReason')} value={reason} onChange={setReason} error={f.missing(reason)} />
    </Sheet>
  );
}

/**
 * المراجعة للقراءة وحدها · رسائلها في الذاكرة لا على الجهاز · وتنتهي بإغلاقها (أو بالخروج من الشاشة)،
 * وكل فتح جديد بسببٍ جديد
 */
function ReviewView({ review, onClose }: { review: Review; onClose: () => void }) {
  const { t } = useLang();
  const closed = React.useRef(false);
  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    chatCloseReviewNow(review.thread.id).catch(() => {});
  }, [review.thread.id]);
  useEffect(() => close, [close]);
  return (
    <Screen title={review.title} sub={t('chat.reviewing')} icon="chat" scroll={false}
      actions={<BtnGhost small title={t('chat.reviewClose')} onPress={() => { close(); onClose(); }} />}>
      <Note>{t('chat.reviewReadOnly')}</Note>
      <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 6 }}>{t('chat.reviewReasonShown', { reason: review.reason })}</T>
      <FlatList
        style={{ flex: 1 }}
        data={review.msgs}
        keyExtractor={(m) => m.id}
        renderItem={({ item: m }) => (m.sys === 'join' ? <SysLine label={t('chat.ownerJoined')} /> : (
          <View style={{ alignSelf: 'flex-end', maxWidth: '85%', marginVertical: 4, backgroundColor: C.paper, borderRadius: 12, padding: 9, borderWidth: 1, borderColor: C.line }}>
            <T size={TYPE.caption} bold color={C.emerald}>{m.name || t('chat.member')}</T>
            {m.body ? <T size={TYPE.body}>{m.body}</T> : null}
            {m.link ? <T size={TYPE.caption} color={C.muted}>{t('chat.link.' + m.link.type)} · {m.link.label}</T> : null}
            <T size={10} color={C.muted} style={{ marginTop: 3 }}>{dfmt(localDay(m.ts))} {localTime(m.ts)}</T>
          </View>
        ))}
        ListEmptyComponent={<EmptyState>{t('chat.empty')}</EmptyState>}
      />
    </Screen>
  );
}
/* ─── نهاية المراجعة ─── */

/** ربط الرسالة بسجل من جهاز المرسل · عقد أو وحدة أو أصل · وطلب الصيانة حين يُبنى */
function LinkSheet({ onClose, onPick }: { onClose: () => void; onPick: (l: ChatLink) => void }) {
  const { db } = useApp();
  const { t } = useLang();
  const access = useAccess();
  const [type, setType] = useState<'contract' | 'unit' | 'asset'>('contract');
  const [q, setQ] = useState('');
  const list = useMemo(() => linkCandidates(db, access, type, q), [db, access, type, q]);
  return (
    <Sheet visible onClose={onClose} title={t('chat.linkTitle')} tall>
      <Row style={{ flexWrap: 'wrap', marginBottom: 6 }}>
        {(['contract', 'unit', 'asset'] as const).map((k) => (
          <Chip key={k} label={t('chat.link.' + k)} active={type === k} onPress={() => setType(k)} />
        ))}
      </Row>
      <T size={TYPE.caption} color={C.muted} style={{ marginBottom: 4 }}>{t('chat.maintenanceLater')}</T>
      <SearchBox value={q} onChange={setQ} placeholder={t('common.search')} />
      {list.length ? list.map((l) => (
        <Pressable key={l.id} onPress={() => onPick(l)} style={{ paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <T size={TYPE.body}>{l.label}</T>
        </Pressable>
      )) : <EmptyState>{t('chat.noRecords')}</EmptyState>}
    </Sheet>
  );
}

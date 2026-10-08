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
import { useAccess, usePerm } from '../src/ui/access';
import { useLang } from '../src/i18n';
import { dfmt } from '../src/domain/dates';
import {
  cloudState, subscribeCloud, chatSyncNow, chatOwnerName, chatEditGroupNow, chatPinNow, chatAckNow, chatEditMessageNow, chatEditsNow,
  chatTaskNow, chatTaskDoneNow, chatCancelTaskNow, chatVoteNow,
  chatReviewCandidatesNow, chatOpenReviewNow, chatCloseReviewNow, chatJoinGroupNow,
} from '../src/services/cloud';
import type { RemoteMessage, RemoteThread } from '../src/chat/remote';
import { useToast } from '../src/ui/Toast';
import { sectionDef, SECTION_KEYS, type SectionKey } from '../src/domain/access/sections';
import { UnitDetailSheet } from '../src/ui/unitSheets';
import { AssetSheet } from '../src/ui/AssetSheets';
import { useSaveAttempt } from '../src/ui/formAttempt';
import { reportFailure } from '../src/ui/failureDialog';
import {
  chatMe, canCreateGroup, createGroup, getThread, linkCandidates, linkTarget, listMessages, listPeople, listThreads,
  markRead, onChatSynced, openDirect, sendLocal, CHAT_BODY_MAX, FORMER_MEMBER, canEditGroup,
  isGroupAdmin, canAppointAdmins, canAddMembers, canSendIn, GROUP_DEFAULTS, type GroupSettings, type GroupChange,
  mainLine, repliesOf, replyCounts, pinnedIds, readsOf, readersOf, readersFrom, setDraft, getDraft, mentionsMe, mentionUser, mentionSection, MENTIONS_MAX,
  tsDate, acksOf, ackersFrom, searchMessages, latinDigits, CHAT_TAGS, CHAT_BODY_MAX as BODY_MAX, type ChatMessage, type ChatTag,
  tasksIn, myTasks, pollResults, POLL_MIN, POLL_MAX, type TaskRow, type ChatPoll,
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
const localTime = (iso: string) => { const d = tsDate(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const localDay = (iso: string) => { const d = tsDate(iso); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

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
  const [sheet, setSheet] = useState<'person' | 'group' | 'review' | 'search' | 'tasks' | null>(null);
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
          <BtnGhost small title={t('chat.search')} onPress={() => setSheet('search')} />
          <BtnGhost small title={t('chat.myTasks')} onPress={() => setSheet('tasks')} />
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
          {/* القناة ومحادثة العقار (الدفعة ٤) */}
          {th.channel ? <T size={TYPE.caption} color={C.muted}>{t(th.channel.t === 'prop' ? 'chat.propertyChat' : th.channel.t === 'announce' ? 'chat.announceChannel' : 'chat.sectionChannel')}</T> : null}
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
      {sheet === 'tasks' ? (
        <MyTasksSheet me={me} people={people} onClose={() => setSheet(null)} onOpen={(tid) => { setSheet(null); onOpen(tid); }} />
      ) : null}
      {sheet === 'search' ? (
        <SearchSheet me={me} people={people} onClose={() => setSheet(null)} onOpen={(tid) => { setSheet(null); onOpen(tid); }} />
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
function GroupSettingsPicker({ value, onChange, disabled, channel = false }: { value: Required<GroupSettings>; onChange: (v: Required<GroupSettings>) => void; disabled?: boolean; channel?: boolean }) {
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
      {/* القناة أعضاؤها بصلاحياتهم، فلا «من يضيف» */}
      {channel ? null : row(t('chat.whoAdds'), 'ad', [['admins', t('chat.adminsOnly')], ['all', t('chat.everyone')]])}
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
  const [text, setTextState] = useState(() => getDraft(db, id));
  const setText = useCallback((v: string) => { setTextState(v); setDraft(db, id, v); }, [db, id]);
  const [men, setMen] = useState<string[]>([]);
  const [tag, setTag] = useState<ChatTag | null>(null);
  const [ack, setAck] = useState(false);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [taskFor, setTaskFor] = useState<ChatMessage | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const claimsPerm = usePerm('claims');
  const purchasesPerm = usePerm('purchases');
  const [historyOf, setHistoryOf] = useState<ChatMessage | null>(null);
  const [menOpen, setMenOpen] = useState(false);
  const [actFor, setActFor] = useState<ChatMessage | null>(null);
  const [threadOf, setThreadOf] = useState<ChatMessage | null>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [link, setLink] = useState<ChatLink | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [unitFor, setUnitFor] = useState<string | null>(null);
  const [assetFor, setAssetFor] = useState<string | null>(null);
  const thread = useMemo(() => getThread(db, id, me.uid), [db, version, tick, id, me.uid]); // eslint-disable-line react-hooks/exhaustive-deps
  const msgs = useMemo(() => listMessages(db, id), [db, version, tick, id]); // eslint-disable-line react-hooks/exhaustive-deps
  // الدفعة ٢: الخط الرئيس بلا ردود السلاسل · وعدد ردود كل أصل · والمثبّتة
  const main = useMemo(() => mainLine(msgs), [msgs]);
  const counts = useMemo(() => replyCounts(msgs), [msgs]);
  const pins = useMemo(() => pinnedIds(db, id), [db, version, tick, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const reads = useMemo(() => readsOf(db, id), [db, version, tick, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const acks = useMemo(() => acksOf(db, id), [db, version, tick, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const tasks = useMemo(() => tasksIn(db, id), [db, version, tick, id]); // eslint-disable-line react-hooks/exhaustive-deps
  // الإعلان المهم بتأكيد الاطلاع للمسؤولين وحدهم (قرار المالك 2026-10-08T10:24Z) · ومن فقد صفته وهو يكتب لا يُرسله (تحقق الدمج ف٧)
  const canAck = me.owner || (thread?.kind === 'group' && isGroupAdmin(me, thread));
  const joinedAfter = thread?.settings.h === 'join' ? thread.joined : {};
  const mySections = useMemo(() => (access.owner ? SECTION_KEYS : SECTION_KEYS.filter((k) => ((access.perms as Record<string, number>)[k] ?? 0) >= 1)) as string[], [access]);
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
      sendLocal(db, id, me, text, link, { men, tag, ack: ack && canAck });
    } catch (e) {
      reportFailure({ title: t('chat.sendFailed'), e });
      return;
    }
    setTextState(''); setLink(null); setMen([]); setTag(null); setAck(false); bump();
    chatSyncNow({ threadId: id }).catch(() => {});
  }, [db, id, me, text, link, men, tag, ack, canAck, bump, t]);
  const vote = async (m: ChatMessage, options: number[]) => {
    try { await chatVoteNow(id, m.id, options); bump(); } catch (e) { reportFailure({ title: t('chat.voteFailed'), e }); }
  };
  const cancelTask = async (task: TaskRow) => {
    try { await chatCancelTaskNow(id, task.msgId); bump(); } catch (e) { reportFailure({ title: t('chat.taskFailed'), e }); }
  };
  const toggleTask = async (task: TaskRow) => {
    try { await chatTaskDoneNow(id, task.msgId, !task.done); bump(); }
    catch (e) { reportFailure({ title: t('chat.taskFailed'), e }); }
  };
  // التحويل إلى مطالبة أو فاتورة شراء: يفتح نموذجها بنص الرسالة، والحفظ بمسار الخدمة وصلاحيتها (الدفعة ٥)
  const toClaim = (m: ChatMessage) => router.push({ pathname: '/claims', params: { newReason: m.body, newContract: m.link?.type === 'contract' ? m.link.id : '' } } as never);
  const toPurchase = (m: ChatMessage) => router.push({ pathname: '/purchases',
    params: { newNote: m.body, newProperty: thread?.channel?.t === 'prop' ? thread.channel.id : '' } } as never);
  const acknowledge = async (m: ChatMessage) => {
    try { await chatAckNow(id, m.id); bump(); } catch (e) { reportFailure({ title: t('chat.ackFailed'), e }); }
  };
  const canPin = thread ? (thread.kind !== 'group' || isGroupAdmin(me, thread)) : false;
  const pin = async (m: ChatMessage, on: boolean) => {
    try { await chatPinNow(id, m.id, on); bump(); } catch (e) { reportFailure({ title: t('chat.pinFailed'), e }); }
  };
  const menLabel = (x: string) => (x.startsWith('s:') ? '@' + (() => { try { return sectionDef(x.slice(2) as SectionKey).label; } catch { return x.slice(2); } })()
    : '@' + (people.find((p) => p.uid === x.slice(2))?.name || t('chat.member')));

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
      {msgs.some((m) => pins.includes(m.id)) ? (
        <Pressable onPress={() => setPinsOpen(true)} style={{ paddingVertical: 6 }}>
          <T size={TYPE.caption} bold color={C.emerald}>{t('chat.pinned', { n: msgs.filter((m) => pins.includes(m.id)).length })}</T>
        </Pressable>
      ) : null}
      <FlatList
        style={{ flex: 1 }}
        data={main}
        keyExtractor={(m) => m.id}
        renderItem={({ item: m }) => {
          const mine = m.sender === me.uid;
          const target = m.link ? linkTarget(db, access, m.link) : null;
          if (m.sys === 'join') return <SysLine label={t('chat.ownerJoined')} />;
          const toMe = mentionsMe(m, me.uid, mySections);
          const seen = mine && thread ? readersFrom(reads, m, thread.members, thread.settings.h === 'join' ? thread.joined : {}) : null;
          return (
            <Pressable onLongPress={() => setActFor(m)} delayLongPress={350}
              style={{ alignSelf: mine ? 'flex-start' : 'flex-end', maxWidth: '85%', marginVertical: 4,
              backgroundColor: mine ? C.emeraldSoft : C.paper, borderRadius: 12, padding: 9, borderWidth: toMe ? 2 : 1, borderColor: toMe ? C.emerald : C.line }}>
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
              {m.men.length ? <T size={TYPE.caption} color={C.emerald}>{m.men.map(menLabel).join(' ')}</T> : null}
              {m.tag ? <Badge kind={m.tag === 'urgent' ? 'due' : 'info'} label={t('chat.tag.' + m.tag)} /> : null}
              {m.ev ? <Pressable onPress={() => setHistoryOf(m)}><T size={TYPE.caption} color={C.muted}>{t('chat.edited')}</T></Pressable> : null}
              {/* الاستطلاع ونتيجته (الدفعة ٥): الضغط على خيار يصوّت أو يغيّر الصوت */}
              {m.poll && m.sent ? <PollView m={m} threadId={id} me={me} onVote={(o) => vote(m, o)} /> : null}
              {/* المهمة من الرسالة: عنوانها ومسؤولها وموعدها · وينجزها مسؤولها أو منشئها */}
              {tasks[m.id] ? (
                <View style={{ marginTop: 4, padding: 6, borderRadius: 8, borderWidth: 1, borderColor: C.line }}>
                  <T size={TYPE.caption} bold>{t('chat.task')}: {tasks[m.id].title}</T>
                  <T size={TYPE.caption} color={C.muted}>{(people.find((p) => p.uid === tasks[m.id].as)?.name || t('chat.member'))} · {dfmt(tasks[m.id].due)} · {tasks[m.id].cx ? t('chat.taskCancelled') : tasks[m.id].done ? t('chat.taskDone') : t('chat.taskOpen')}</T>
                  <Row gap={6}>
                    {!tasks[m.id].cx && (tasks[m.id].as === me.uid || tasks[m.id].by === me.uid) ? (
                      <BtnGhost small title={tasks[m.id].done ? t('chat.taskReopen') : t('chat.taskMarkDone')} onPress={() => toggleTask(tasks[m.id])} />
                    ) : null}
                    {/* الإلغاء لمنشئها وحده · فتبقى «ملغاة» لا تُعدَّل ولا تُعاد */}
                    {!tasks[m.id].cx && tasks[m.id].by === me.uid ? (
                      <BtnGhost small title={t('chat.taskCancel')} onPress={() => cancelTask(tasks[m.id])} />
                    ) : null}
                  </Row>
                </View>
              ) : null}
              {m.ack && thread ? (mine
                ? (() => { const a = ackersFrom(acks, m, thread.members, joinedAfter); return <T size={TYPE.caption} bold color={C.emerald}>{t('chat.ackCount', { n: a.acked.length, total: a.acked.length + a.pending.length })}</T>; })()
                : (acks[m.id] ?? []).includes(me.uid)
                  ? <T size={TYPE.caption} color={C.muted}>{t('chat.acked')}</T>
                  : <BtnPrimary small title={t('chat.ackNow')} onPress={() => acknowledge(m)} />) : null}
              {pins.includes(m.id) ? <T size={TYPE.caption} color={C.muted}>{t('chat.pinnedOne')}</T> : null}
              <T size={10} color={C.muted} style={{ marginTop: 3 }}>
                {localTime(m.serverTs ?? m.localAt)}{m.rejected ? ' · ' + t('chat.rejectedMsg') : !m.sent ? ' · ' + t('chat.notSent') : ''}
                {/* إشعار القراءة: في الفردية «قُرئت»، وفي المجموعة عدد من قرأ */}
                {(() => {
                  const label = seen && m.sent ? (thread?.kind === 'group' ? t('chat.readCount', { n: seen.read.length }) : seen.read.length ? t('chat.read') : '') : '';
                  return label ? ' · ' + label : '';
                })()}
              </T>
              {counts[m.id] ? (
                <Pressable onPress={() => setThreadOf(m)}><T size={TYPE.caption} bold color={C.emerald}>{t('chat.replies', { n: counts[m.id] })}</T></Pressable>
              ) : null}
            </Pressable>
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
          {/* الوسم والإعلان المهم بتأكيد الاطلاع (الدفعة ٣) */}
          <Row style={{ flexWrap: 'wrap', paddingTop: 4 }}>
            {CHAT_TAGS.map((k) => <Chip key={k} label={t('chat.tag.' + k)} active={tag === k} onPress={() => setTag(tag === k ? null : k)} />)}
            {/* الإعلان المهم بتأكيد الاطلاع للمسؤولين وحدهم (قرار المالك 2026-10-08T10:24Z) */}
            {canAck ? (
              <Chip label={t('chat.important')} active={ack} onPress={() => setAck(!ack)} />
            ) : null}
          </Row>
          {men.length ? (
            <Row style={{ flexWrap: 'wrap', paddingVertical: 4 }}>
              {men.map((x) => <Chip key={x} label={menLabel(x)} active onPress={() => setMen((v) => v.filter((y) => y !== x))} />)}
            </Row>
          ) : null}
          <Row style={{ paddingVertical: 6, alignItems: 'flex-end' }} gap={6}>
            <BtnGhost small title={t('chat.mention')} onPress={() => setMenOpen(true)} />
            <BtnGhost small title={t('chat.poll')} onPress={() => setPollOpen(true)} />
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
      {linkOpen ? <LinkSheet propertyId={thread?.channel?.t === 'prop' ? thread.channel.id : null}
        onClose={() => setLinkOpen(false)} onPick={(l) => { setLink(l); setLinkOpen(false); }} /> : null}
      {menOpen && thread ? (
        <MentionSheet people={people.filter((p) => thread.members.includes(p.uid) && p.uid !== me.uid)} onClose={() => setMenOpen(false)}
          onPick={(x) => { setMen((v) => (v.includes(x) || v.length >= MENTIONS_MAX ? v : [...v, x])); setMenOpen(false); }} />
      ) : null}
      {actFor && thread ? (
        <MessageActions m={actFor} canReply={canSendIn(me, thread) && actFor.sent && !actFor.rejected} canPin={canPin} pinned={pins.includes(actFor.id)}
          canEdit={actFor.sender === me.uid && actFor.sent && !actFor.sys && canSendIn(me, thread)}
          canTask={actFor.sent && !actFor.sys && (tasks[actFor.id] ? !tasks[actFor.id].cx && tasks[actFor.id].by === me.uid : canSendIn(me, thread))}
          onTask={() => { setTaskFor(actFor); setActFor(null); }} hasTask={!!tasks[actFor.id]}
          canClaim={actFor.sent && !actFor.sys && claimsPerm.add} onClaim={() => { toClaim(actFor); setActFor(null); }}
          canPurchase={actFor.sent && !actFor.sys && purchasesPerm.add} onPurchase={() => { toPurchase(actFor); setActFor(null); }} acks={actFor.ack ? ackersFrom(acks, actFor, thread.members, joinedAfter) : null}
          onEdit={() => { setEditing(actFor); setActFor(null); }} onHistory={() => { setHistoryOf(actFor); setActFor(null); }}
          readers={readersFrom(reads, actFor, thread.members, thread.settings.h === 'join' ? thread.joined : {})} nameOf={(u) => people.find((p) => p.uid === u)?.name || t('chat.member')}
          onReply={() => { setThreadOf(actFor); setActFor(null); }}
          onPin={(on) => { pin(actFor, on); setActFor(null); }}
          onClose={() => setActFor(null)} />
      ) : null}
      {threadOf && thread ? (
        <ReplySheet me={me} threadId={id} parent={threadOf} replies={repliesOf(msgs, threadOf.id)} canSend={canSendIn(me, thread)}
          nameOf={(u, f) => senderOf(u, f)} onClose={() => setThreadOf(null)} />
      ) : null}
      {editing ? <EditSheet threadId={id} m={editing} onClose={() => setEditing(null)} /> : null}
      {taskFor && thread ? (
        <TaskSheet threadId={id} m={taskFor} task={tasks[taskFor.id] ?? null}
          members={people.filter((p) => thread.members.includes(p.uid))} onClose={() => setTaskFor(null)} />
      ) : null}
      {pollOpen ? <PollSheet threadId={id} me={me} onClose={() => setPollOpen(false)} /> : null}
      {historyOf ? <HistorySheet threadId={id} m={historyOf} onClose={() => setHistoryOf(null)} /> : null}
      {pinsOpen ? (
        <Sheet visible onClose={() => setPinsOpen(false)} title={t('chat.pinnedTitle')} tall>
          {msgs.filter((m) => pins.includes(m.id)).map((m) => (
            <View key={m.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <T size={TYPE.caption} bold color={C.emerald}>{senderOf(m.sender, m.senderName)}</T>
              <T size={TYPE.body}>{m.body || m.link?.label}</T>
            </View>
          ))}
        </Sheet>
      ) : null}
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
      <GroupSettingsPicker value={settings} onChange={setSettings} disabled={!admin} channel={!!thread.channel} />
      <T size={TYPE.cardTitle} bold style={{ marginTop: 6 }}>{t('chat.groupMembers')}</T>
      {/* القناة: أعضاؤها بصلاحياتهم تلقائياً · ويبقى تعيين المسؤولين (الدفعة ٤) */}
      {thread.channel ? <Note>{t('chat.channelMembersAuto')}</Note> : null}
      {(thread.channel ? others.filter((p) => thread.members.includes(p.uid)) : others).map((p) => (
        <MemberRow key={p.uid} p={p} me={me} member={members.includes(p.uid)} admin={admins.includes(p.uid)} canAppoint={appoint}
          onToggle={() => { if (!thread.channel) toggle(p.uid); }}
          onAdmin={() => setAdmins((x) => (x.includes(p.uid) ? x.filter((u) => u !== p.uid) : [...x, p.uid]))} />
      ))}
    </Sheet>
  );
}

/* ─── الدفعة ٢ (قرار المالك 2026-10-08T05:31Z): الرد في سلسلة، والتثبيت، والإشارة، ومن قرأ ─── */

/** ما يُفعل برسالة بضغطة مطوّلة · وما لا يحق لا يظهر */
function MessageActions({ m, canReply, canPin, pinned, readers, nameOf, onReply, onPin, onClose, canEdit, acks, onEdit, onHistory,
  canTask, onTask, canClaim, onClaim, canPurchase, onPurchase, hasTask = false }: {
  m: ChatMessage; canReply: boolean; canPin: boolean; pinned: boolean; readers: { read: string[]; unread: string[] };
  nameOf: (uid: string) => string; onReply: () => void; onPin: (on: boolean) => void; onClose: () => void;
  canEdit: boolean; acks: { acked: string[]; pending: string[] } | null; onEdit: () => void; onHistory: () => void;
  canTask: boolean; onTask: () => void; canClaim: boolean; onClaim: () => void; canPurchase: boolean; onPurchase: () => void; hasTask?: boolean;
}) {
  const { t } = useLang();
  return (
    <Sheet visible onClose={onClose} title={t('chat.messageActions')}>
      <T size={TYPE.body} numberOfLines={3}>{m.body || m.link?.label}</T>
      <Row style={{ flexWrap: 'wrap', marginTop: 8 }} gap={6}>
        {canReply ? <BtnGhost small title={t('chat.replyInThread')} onPress={onReply} /> : null}
        {canPin && m.sent ? <BtnGhost small title={pinned ? t('chat.unpin') : t('chat.pin')} onPress={() => onPin(!pinned)} /> : null}
        {canEdit ? <BtnGhost small title={t('chat.edit')} onPress={onEdit} /> : null}
        {canTask ? <BtnGhost small title={hasTask ? t('chat.editTask') : t('chat.toTask')} onPress={onTask} /> : null}
        {canClaim ? <BtnGhost small title={t('chat.toClaim')} onPress={onClaim} /> : null}
        {canPurchase ? <BtnGhost small title={t('chat.toPurchase')} onPress={onPurchase} /> : null}
        {m.ev ? <BtnGhost small title={t('chat.editHistory')} onPress={onHistory} /> : null}
      </Row>
      {acks ? (
        <View style={{ marginTop: 10 }}>
          <T size={TYPE.cardTitle} bold>{t('chat.ackedBy')}</T>
          <T size={TYPE.caption}>{acks.acked.length ? acks.acked.map(nameOf).join(LIST_SEP) : t('chat.nobodyYet')}</T>
          <T size={TYPE.cardTitle} bold style={{ marginTop: 6 }}>{t('chat.notAcked')}</T>
          <T size={TYPE.caption}>{acks.pending.length ? acks.pending.map(nameOf).join(LIST_SEP) : t('chat.everyoneAcked')}</T>
        </View>
      ) : null}
      {m.sent ? (
        <View style={{ marginTop: 10 }}>
          <T size={TYPE.cardTitle} bold>{t('chat.whoRead')}</T>
          <T size={TYPE.caption}>{readers.read.length ? readers.read.map(nameOf).join(LIST_SEP) : t('chat.nobodyYet')}</T>
          <T size={TYPE.cardTitle} bold style={{ marginTop: 6 }}>{t('chat.notReadYet')}</T>
          <T size={TYPE.caption}>{readers.unread.length ? readers.unread.map(nameOf).join(LIST_SEP) : t('chat.everyoneRead')}</T>
        </View>
      ) : null}
    </Sheet>
  );
}

/** سلسلة الردود على رسالة · ومعها الرد فيها لمن يرسل */
function ReplySheet({ me, threadId, parent, replies, canSend, nameOf, onClose }: {
  me: ChatMe; threadId: string; parent: ChatMessage; replies: ChatMessage[]; canSend: boolean;
  nameOf: (uid: string, fallback: string) => string; onClose: () => void;
}) {
  const { db, bump } = useApp();
  const { t } = useLang();
  const [text, setText] = useState('');
  const send = () => {
    if (!text.trim()) return;
    try { sendLocal(db, threadId, me, text, null, { re: parent.id }); } catch (e) { reportFailure({ title: t('chat.sendFailed'), e }); return; }
    setText(''); bump();
    chatSyncNow({ threadId }).catch(() => {});
  };
  const row = (m: ChatMessage) => (
    <View key={m.id} style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }}>
      <T size={TYPE.caption} bold color={C.emerald}>{nameOf(m.sender, m.senderName)}</T>
      <T size={TYPE.body}>{m.body || m.link?.label}</T>
      <T size={10} color={C.muted}>{localTime(m.serverTs ?? m.localAt)}{!m.sent ? ' · ' + t('chat.notSent') : ''}</T>
    </View>
  );
  return (
    <Sheet visible onClose={onClose} title={t('chat.thread')} tall
      footer={canSend ? (
        <Row style={{ flex: 1, alignItems: 'flex-end' }} gap={6}>
          <View style={{ flex: 1 }}><Field label={t('chat.typeReply')} value={text} onChange={setText} multiline /></View>
          <BtnPrimary small title={t('chat.send')} onPress={send} />
        </Row>
      ) : undefined}>
      {row(parent)}
      {replies.map(row)}
    </Sheet>
  );
}

/* ─── الدفعة ٣ (قرار المالك 2026-10-08T05:31Z): التعديل بسجله، والبحث ─── */

/** تعديل رسالتي ووسمها · يحتاج اتصالاً · وما قبله يُحفظ في سجلها */
function EditSheet({ threadId, m, onClose }: { threadId: string; m: ChatMessage; onClose: () => void }) {
  const { t } = useLang();
  const { bump } = useApp();
  const f = useSaveAttempt();
  const [body, setBody] = useState(m.body);
  const [tag, setTag] = useState<ChatTag | null>(m.tag);
  const changed = body.trim() !== m.body || tag !== m.tag;
  const save = async () => {
    if (!changed) { onClose(); return; }
    try { await chatEditMessageNow(threadId, m.id, body, tag); bump(); onClose(); } catch (e) { reportFailure({ title: t('chat.editFailed'), e }); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('chat.edit')} tall
      footer={<View style={{ flex: 1 }}><BtnPrimary title={t('common.save')} onPress={() => f.attempt(!!body.trim() && body.length <= BODY_MAX, save)} /></View>}>
      <Field label={t('chat.typeMessage')} value={body} onChange={(v) => setBody(v.slice(0, BODY_MAX))} multiline error={f.missing(body)} />
      <Row style={{ flexWrap: 'wrap' }}>
        {CHAT_TAGS.map((k) => <Chip key={k} label={t('chat.tag.' + k)} active={tag === k} onPress={() => setTag(tag === k ? null : k)} />)}
      </Row>
    </Sheet>
  );
}

/** سجل تعديلات رسالة: ما قبل كل تعديل، ثم نصها الآن */
function HistorySheet({ threadId, m, onClose }: { threadId: string; m: ChatMessage; onClose: () => void }) {
  const { t } = useLang();
  const [list, setList] = useState<Array<{ n: number; body: string; tag: ChatTag | null; at: string }> | null>(null);
  useEffect(() => {
    let live = true;
    chatEditsNow(threadId, m.id).then((x) => { if (live) setList(x); }).catch((e) => { if (live) { setList([]); reportFailure({ title: t('chat.historyFailed'), e }); } });
    return () => { live = false; };
  }, [threadId, m.id, t]);
  return (
    <Sheet visible onClose={onClose} title={t('chat.editHistory')} tall>
      {list === null ? <T size={TYPE.caption} color={C.muted}>{t('chat.loading')}</T> : list.map((e) => (
        <View key={e.n} style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <T size={TYPE.caption} color={C.muted}>{t('chat.beforeEdit', { n: e.n })} · {dfmt(localDay(e.at))} {localTime(e.at)}{e.tag ? ' · ' + t('chat.tag.' + e.tag) : ''}</T>
          <T size={TYPE.body}>{e.body}</T>
        </View>
      ))}
      <View style={{ paddingVertical: 6 }}>
        <T size={TYPE.caption} bold color={C.emerald}>{t('chat.nowText')}</T>
        <T size={TYPE.body}>{m.body}</T>
      </View>
    </Sheet>
  );
}

/* ─── الدفعة ٥ (قرار المالك 2026-10-08T05:31Z): المهام والاستطلاعات ─── */

/** تاريخ سنة/شهر/يوم (بالأرقام العربية أو اللاتينية) إلى سنة-شهر-يوم · null إن لم يكن يوماً موجوداً */
function dayOf(v: string): string | null {
  const s = latinDigits(v).trim();
  if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(s)) return null;
  const [y, mo, da] = s.split(/[-/]/).map(Number);
  const d = new Date(y, mo - 1, da);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(da).padStart(2, '0');
}

/** تحويل رسالة إلى مهمة بمسؤول من أطراف المحادثة وموعد · ومنشئها يعدّلها */
function TaskSheet({ threadId, m, task, members, onClose }: {
  threadId: string; m: ChatMessage; task: TaskRow | null; members: ChatPerson[]; onClose: () => void;
}) {
  const { t } = useLang();
  const { bump } = useApp();
  const f = useSaveAttempt();
  const [title, setTitle] = useState(task?.title ?? (m.body || m.link?.label || '').slice(0, 200));
  const [as, setAs] = useState<string>(task?.as ?? '');
  const [due, setDue] = useState(task?.due ? task.due.replace(/-/g, '/') : '');
  const save = async () => {
    try {
      await chatTaskNow(threadId, m.id, { title, as, due: dayOf(due)!, done: task?.done ?? false });
      bump(); onClose();
    } catch (e) { reportFailure({ title: t('chat.taskFailed'), e }); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('chat.toTask')} tall
      footer={<View style={{ flex: 1 }}><BtnPrimary title={t('common.save')} onPress={() => f.attempt(!!title.trim() && !!as && !!dayOf(due), save)} /></View>}>
      <Field label={t('chat.taskTitle')} value={title} onChange={(v) => setTitle(v.slice(0, 200))} error={f.missing(title)} />
      <T size={TYPE.cardTitle} bold style={{ marginTop: 6 }}>{t('chat.taskAssignee')}</T>
      {f.tried && !as ? <T size={TYPE.caption} color={C.rose}>{t('chat.taskPickAssignee')}</T> : null}
      <Row style={{ flexWrap: 'wrap' }}>
        {members.map((p) => <Chip key={p.uid} label={p.name || t('chat.member')} active={as === p.uid} onPress={() => setAs(p.uid)} />)}
      </Row>
      <Field label={t('chat.taskDue')} value={due} onChange={setDue} ltr error={f.tried && !dayOf(due)} />
    </Sheet>
  );
}

/** مهامي: ما أنا مسؤوله في محادثاتي · غير المنجز أولاً */
function MyTasksSheet({ me, people, onClose, onOpen }: { me: ChatMe; people: ChatPerson[]; onClose: () => void; onOpen: (threadId: string) => void }) {
  const { db, version, bump } = useApp();
  const { t } = useLang();
  const list = useMemo(() => myTasks(db, me.uid, me.owner), [db, version, me.uid, me.owner]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = async (task: TaskRow) => {
    try { await chatTaskDoneNow(task.threadId, task.msgId, !task.done); bump(); }
    catch (e) { reportFailure({ title: t('chat.taskFailed'), e }); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('chat.myTasks')} tall>
      {list.length ? list.map((task) => (
        <View key={task.threadId + task.msgId} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <Pressable onPress={() => onOpen(task.threadId)}>
            <T size={TYPE.body} bold>{task.title}</T>
            <T size={TYPE.caption} color={C.muted}>{dfmt(task.due)} · {task.cx ? t('chat.taskCancelled') : task.done ? t('chat.taskDone') : t('chat.taskOpen')} · {people.find((p) => p.uid === task.by)?.name || t('chat.member')}</T>
          </Pressable>
          {!task.cx ? <BtnGhost small title={task.done ? t('chat.taskReopen') : t('chat.taskMarkDone')} onPress={() => toggle(task)} /> : null}
        </View>
      )) : <EmptyState>{t('chat.noTasks')}</EmptyState>}
    </Sheet>
  );
}

/** نتيجة الاستطلاع وخياراته · الضغط يصوّت (أو يبدّل خياراً في متعدد الاختيار) */
function PollView({ m, threadId, me, onVote }: { m: ChatMessage; threadId: string; me: ChatMe; onVote: (o: number[]) => void }) {
  const { db, version } = useApp();
  const { t } = useLang();
  const poll = m.poll as ChatPoll;
  const r = useMemo(() => pollResults(db, threadId, m.id, poll.o.length, me.uid), [db, version, threadId, m.id, poll.o.length, me.uid]); // eslint-disable-line react-hooks/exhaustive-deps
  const press = (i: number) => onVote(poll.m ? (r.mine.includes(i) ? r.mine.filter((x) => x !== i) : [...r.mine, i]) : [i]);
  return (
    <View style={{ marginTop: 4 }}>
      {poll.o.map((o, i) => (
        <Pressable key={i} onPress={() => press(i)} disabled={poll.m && r.mine.length === 1 && r.mine[0] === i}
          style={{ marginTop: 3, padding: 6, borderRadius: 8, borderWidth: 1, borderColor: r.mine.includes(i) ? C.emerald : C.line }}>
          <T size={TYPE.caption} bold={r.mine.includes(i)}>{o} · {r.counts[i]}</T>
        </Pressable>
      ))}
      <T size={10} color={C.muted}>{t('chat.voters', { n: r.voters })}{poll.m ? ' · ' + t('chat.multiChoice') : ''}</T>
    </View>
  );
}

/** استطلاع جديد: السؤال وخياراته (٢ إلى ١٠) وهل يُختار أكثر من واحد */
function PollSheet({ threadId, me, onClose }: { threadId: string; me: ChatMe; onClose: () => void }) {
  const { db, bump } = useApp();
  const { t } = useLang();
  const f = useSaveAttempt();
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<string[]>(['', '']);
  const [multi, setMulti] = useState(false);
  const filled = opts.map((o) => o.trim()).filter(Boolean);
  const send = () => {
    try {
      sendLocal(db, threadId, me, q, null, { poll: { o: filled.map((o) => o.slice(0, 100)), m: multi } });
      bump(); chatSyncNow({ threadId }).catch(() => {}); onClose();
    } catch (e) { reportFailure({ title: t('chat.sendFailed'), e }); }
  };
  return (
    <Sheet visible onClose={onClose} title={t('chat.poll')} tall
      footer={<View style={{ flex: 1 }}><BtnPrimary title={t('chat.send')} onPress={() => f.attempt(!!q.trim() && filled.length >= POLL_MIN, send)} /></View>}>
      <Field label={t('chat.pollQuestion')} value={q} onChange={setQ} error={f.missing(q)} />
      {opts.map((o, i) => (
        <Field key={i} label={t('chat.pollOption', { n: i + 1 })} value={o} onChange={(v) => setOpts((x) => x.map((y, j) => (j === i ? v.slice(0, 100) : y)))}
          error={f.tried && i < POLL_MIN && !o.trim()} />
      ))}
      {opts.length < POLL_MAX ? <BtnGhost small title={t('chat.pollAddOption')} onPress={() => setOpts((x) => [...x, ''])} /> : null}
      <Row style={{ marginTop: 6 }}><Chip label={t('chat.multiChoice')} active={multi} onPress={() => setMulti(!multi)} /></Row>
    </Sheet>
  );
}

/** البحث في محادثاتي على الجهاز: بالنص والشخص والتاريخ والوسم */
function SearchSheet({ me, people, onClose, onOpen }: { me: ChatMe; people: ChatPerson[]; onClose: () => void; onOpen: (threadId: string) => void }) {
  const { db } = useApp();
  const { t } = useLang();
  const [text, setText] = useState('');
  const [sender, setSender] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tag, setTag] = useState<ChatTag | null>(null);
  const results = useMemo(() => searchMessages(db, me.uid, {
    text, sender: sender ?? undefined, from: latinDigits(from), to: latinDigits(to), tag,
  }, me.owner, 100), [db, me.uid, me.owner, text, sender, from, to, tag]);
  const nameOf = (uid: string) => (uid === me.uid ? t('chat.you') : people.find((p) => p.uid === uid)?.name || t('chat.member'));
  return (
    <Sheet visible onClose={onClose} title={t('chat.search')} tall>
      <SearchBox value={text} onChange={setText} placeholder={t('common.search')} />
      <T size={TYPE.caption} color={C.muted} style={{ marginTop: 6 }}>{t('chat.byPerson')}</T>
      <Row style={{ flexWrap: 'wrap' }}>
        {[{ uid: me.uid, name: t('chat.you'), sup: [] }, ...people.filter((p) => p.uid !== me.uid)].map((p) => (
          <Chip key={p.uid} label={p.name || t('chat.member')} active={sender === p.uid} onPress={() => setSender(sender === p.uid ? null : p.uid)} />
        ))}
      </Row>
      <Row gap={6}>
        <View style={{ flex: 1 }}><Field label={t('chat.fromDate')} value={from} onChange={setFrom} ltr /></View>
        <View style={{ flex: 1 }}><Field label={t('chat.toDate')} value={to} onChange={setTo} ltr /></View>
      </Row>
      <Row style={{ flexWrap: 'wrap' }}>
        {CHAT_TAGS.map((k) => <Chip key={k} label={t('chat.tag.' + k)} active={tag === k} onPress={() => setTag(tag === k ? null : k)} />)}
      </Row>
      {results.length ? results.map((m) => (
        <Pressable key={m.id} onPress={() => onOpen(m.threadId)} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <T size={TYPE.caption} color={C.muted}>{nameOf(m.sender)} · {dfmt(localDay(m.serverTs ?? m.localAt))}{m.tag ? ' · ' + t('chat.tag.' + m.tag) : ''}</T>
          <T size={TYPE.body} numberOfLines={2}>{m.body || m.link?.label}</T>
        </Pressable>
      )) : <EmptyState>{t('chat.noResults')}</EmptyState>}
    </Sheet>
  );
}

/** الإشارة: عضو في المحادثة أو قسم */
function MentionSheet({ people, onClose, onPick }: { people: ChatPerson[]; onClose: () => void; onPick: (x: string) => void }) {
  const { t } = useLang();
  return (
    <Sheet visible onClose={onClose} title={t('chat.mention')} tall>
      <T size={TYPE.cardTitle} bold>{t('chat.mentionPerson')}</T>
      {people.map((p) => (
        <Pressable key={p.uid} onPress={() => onPick(mentionUser(p.uid))} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <T size={TYPE.body}>{p.name || t('chat.member')}</T>
        </Pressable>
      ))}
      <T size={TYPE.cardTitle} bold style={{ marginTop: 8 }}>{t('chat.mentionSection')}</T>
      <Row style={{ flexWrap: 'wrap' }}>
        {SECTION_KEYS.map((k) => <Chip key={k} label={sectionDef(k).label} onPress={() => onPick(mentionSection(k))} />)}
      </Row>
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
function LinkSheet({ onClose, onPick, propertyId = null }: { onClose: () => void; onPick: (l: ChatLink) => void; propertyId?: string | null }) {
  const { db } = useApp();
  const { t } = useLang();
  const access = useAccess();
  const [type, setType] = useState<'contract' | 'unit' | 'asset'>('contract');
  const [q, setQ] = useState('');
  // محادثة العقار تجمع ما يخصه: عقوده ووحداته وأصوله (الدفعة ٤)
  const list = useMemo(() => linkCandidates(db, access, type, q, 50, propertyId), [db, access, type, q, propertyId]);
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

/**
 * المحادثة (src/chat · قرار المالك 2026-10-07) · شاشة واحدة: قائمة المحادثات، والمحادثة المفتوحة بمعاملها t.
 * تعمل بلا اتصال: الرسالة تُحفظ فوراً «لم تُرسل» وتُرفع عند عودته · كل نصٍّ بمفتاحه في ملفي الترجمة.
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
import { cloudState, subscribeCloud, chatSyncNow } from '../src/services/cloud';
import { sectionDef } from '../src/domain/access/sections';
import { UnitDetailSheet } from '../src/ui/unitSheets';
import { AssetSheet } from '../src/ui/AssetSheets';
import { useSaveAttempt } from '../src/ui/formAttempt';
import {
  chatMe, canCreateGroup, createGroup, getThread, linkCandidates, linkTarget, listMessages, listPeople, listThreads,
  markRead, onChatSynced, openDirect, sendLocal, type ChatLink, type ChatMe, type ChatPerson,
} from '../src/chat';

/** دورة المحادثة كل بضع ثوانٍ ما دامت الشاشة مفتوحة · ومعها تجديد العرض بعد كل دورة */
function useChatPulse(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const off = onChatSynced(() => setTick((x) => x + 1));
    chatSyncNow().catch(() => {});
    const h = setInterval(() => { chatSyncNow().catch(() => {}); }, 8000);
    return () => { off(); clearInterval(h); };
  }, []);
  return tick;
}

function useChatMe(): ChatMe | null {
  const { db } = useApp();
  const [cloud, setCloud] = useState(cloudState());
  useEffect(() => subscribeCloud(() => setCloud(cloudState())), []);
  const companyName = db.get<{ name: string }>(`SELECT name FROM company WHERE id = 1`)?.name ?? '';
  return cloud.user ? chatMe(db, cloud.user, companyName) : null;
}

const LIST_SEP = '، '; // i18n-exempt: فاصل قائمة الأقسام
const supLabel = (sup: string[]) => sup.map((k) => { try { return sectionDef(k as never).label; } catch { return k; } }).join(LIST_SEP);

export default function Chat() {
  const { t } = useLang();
  const me = useChatMe();
  const params = useLocalSearchParams<{ t?: string }>();
  const [open, setOpen] = useState<string | null>(params.t ? String(params.t) : null);
  const tick = useChatPulse();
  if (!me) {
    return <Screen title={t('chat.title')} icon="chat"><EmptyState>{t('chat.needAccount')}</EmptyState></Screen>;
  }
  return open
    ? <ThreadView me={me} id={open} tick={tick} onBack={() => setOpen(null)} />
    : <ThreadList me={me} tick={tick} onOpen={setOpen} />;
}

/* ─── القائمة ─── */

function ThreadList({ me, tick, onOpen }: { me: ChatMe; tick: number; onOpen: (id: string) => void }) {
  const { db, version } = useApp();
  const { t } = useLang();
  const [sheet, setSheet] = useState<'person' | 'group' | null>(null);
  const people = useMemo(() => listPeople(db), [db, version, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const threads = useMemo(() => listThreads(db, me.uid), [db, version, tick, me.uid]); // eslint-disable-line react-hooks/exhaustive-deps
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
        </Row>
      )}>
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
            {th.lastTs ? <T size={TYPE.caption} color={C.muted}>{dfmt(th.lastTs.slice(0, 10))}</T> : null}
          </Row>
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

function GroupSheet({ me, people, onClose, onCreated }: { me: ChatMe; people: ChatPerson[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { db } = useApp();
  const { t } = useLang();
  const f = useSaveAttempt();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const others = people.filter((p) => p.uid !== me.uid);
  const save = () => { onCreated(createGroup(db, me.uid, name, picked)); chatSyncNow().catch(() => {}); };
  return (
    <Sheet visible onClose={onClose} title={t('chat.newGroup')} tall
      footer={<View style={{ flex: 1 }}><BtnPrimary title={t('chat.create')} onPress={() => f.attempt(!!name.trim() && picked.length > 0, save)} /></View>}>
      <Field label={t('chat.groupName')} value={name} onChange={setName} error={f.missing(name)} />
      <T size={TYPE.cardTitle} bold style={{ marginTop: 6 }}>{t('chat.groupMembers')}</T>
      {f.tried && !picked.length ? <T size={TYPE.caption} color={C.rose}>{t('chat.pickMembers')}</T> : null}
      {others.length ? others.map((p) => (
        <PersonRow key={p.uid} p={p} me={me} active={picked.includes(p.uid)}
          onPress={() => setPicked((x) => (x.includes(p.uid) ? x.filter((u) => u !== p.uid) : [...x, p.uid]))} />
      )) : <EmptyState>{t('chat.noPeople')}</EmptyState>}
    </Sheet>
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
  const title = thread?.kind === 'group'
    ? thread.name
    : people.find((p) => p.uid === thread?.members.find((u) => u !== me.uid))?.name || t('chat.member');

  const send = useCallback(() => {
    if (!text.trim() && !link) return;
    sendLocal(db, id, me, text, link);
    setText(''); setLink(null); bump();
    chatSyncNow().catch(() => {});
  }, [db, id, me, text, link, bump]);

  const openLink = (l: ChatLink) => {
    const target = linkTarget(db, access, l);
    if (!target.canOpen) return;
    if (l.type === 'contract') router.push({ pathname: '/(tabs)/contracts', params: { detail: l.id } } as never);
    else if (l.type === 'unit') setUnitFor(l.id);
    else if (l.type === 'asset') setAssetFor(l.id);
  };

  return (
    <Screen title={title} icon="chat" scroll={false}
      actions={<BtnGhost small title={t('chat.back')} onPress={onBack} />}>
      <FlatList
        style={{ flex: 1 }}
        data={msgs}
        keyExtractor={(m) => m.id}
        renderItem={({ item: m }) => {
          const mine = m.sender === me.uid;
          const target = m.link ? linkTarget(db, access, m.link) : null;
          return (
            <View style={{ alignSelf: mine ? 'flex-start' : 'flex-end', maxWidth: '85%', marginVertical: 4,
              backgroundColor: mine ? C.emeraldSoft : C.paper, borderRadius: 12, padding: 9, borderWidth: 1, borderColor: C.line }}>
              {!mine && thread?.kind === 'group' ? <T size={TYPE.caption} bold color={C.emerald}>{m.senderName}</T> : null}
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
                {(m.serverTs ?? m.localAt).slice(11, 16)}{!m.sent ? ' · ' + t('chat.notSent') : ''}
              </T>
            </View>
          );
        }}
      />
      {link ? (
        <Row style={{ paddingVertical: 4 }}>
          <Chip label={t('chat.link.' + link.type) + ' · ' + link.label} active onPress={() => setLink(null)} />
        </Row>
      ) : null}
      <Row style={{ paddingVertical: 6, alignItems: 'flex-end' }} gap={6}>
        <BtnGhost small icon="attach" title={t('chat.attach')} onPress={() => setLinkOpen(true)} />
        <TextInput value={text} onChangeText={setText} multiline placeholder={t('chat.typeMessage')} placeholderTextColor="#B9BFC9"
          style={{ flex: 1, fontFamily: FONT, fontSize: fs(TYPE.body), minHeight: 44, maxHeight: 120, borderWidth: 1, borderColor: C.line,
            borderRadius: 10, paddingHorizontal: 10, backgroundColor: '#FAFAF7', textAlign: 'right' }} />
        <BtnPrimary small title={t('chat.send')} onPress={send} />
      </Row>
      {linkOpen ? <LinkSheet onClose={() => setLinkOpen(false)} onPick={(l) => { setLink(l); setLinkOpen(false); }} /> : null}
      {unitFor ? <UnitDetailSheet unitId={unitFor} onClose={() => setUnitFor(null)} onEdit={() => setUnitFor(null)} onReserve={() => setUnitFor(null)} /> : null}
      {assetFor ? <AssetSheet id={assetFor} onClose={() => setAssetFor(null)} /> : null}
    </Screen>
  );
}

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

/**
 * واجهة المحادثة مع بقية التطبيق · كل ما يحتاجه التطبيق من الوحدة يمرّ من هنا:
 *  - chatMe: من أنا في المحادثة (المنشأة ورقمي واسمي، وهل أنا المالك).
 *  - runChatSync: دورة مزامنة واحدة · تستدعيها دورة المزامنة العامة وشاشة المحادثة، وفشلها لا يعطّل غيرها.
 *  - setSupervisor: يكتب المالك إشراف عضو بإيميله عند الدعوة أو التعديل.
 * وما سواه (المخزن والعميل والقواعد والشاشات) داخل الوحدة.
 */
import type { DB } from '../db/adapter';
import { readMembership } from '../services/access';
import { getSyncState, setSyncState } from '../sync/engine';
import { ChatRemote } from './remote';
import { chatSyncOnce, type ChatSyncResult } from './sync';
import { ensureChannels, autoJoinChannels } from './channels';
export { ensureChannels, autoJoinChannels, qualifies, wantedChannels } from './channels';
import { CHAT_BODY_MAX, CHAT_MODULE, CHAT_NAME_MAX, FORMER_MEMBER, JOIN_ENTITY, REVIEW_ENTITY, type ChatMe, type ChatTag, type GroupSettings } from './types';
import { logAudit } from '../domain/audit';
import type { RemoteEdit, RemoteMessage, RemoteThread } from './remote';
import { applyRemoteThread, applyRemoteMessage, applyState, stateCursor } from './store';

export * from './types';
export {
  listThreads, getThread, openDirect, createGroup, listMessages, sendLocal, markRead, listPeople, personName,
  mainLine, repliesOf, replyCounts, pinnedIds, readsOf, readersOf, readersFrom, setDraft, getDraft,
  ackersOf, acksOf, ackersFrom, searchMessages, latinDigits, type ChatSearch,
} from './store';
export { linkTarget, linkCandidates } from './links';

export interface ChatSession { projectId: string; uid: string; email: string; idToken: () => Promise<string>; baseUrl?: string }

/** من أنا في المحادثة · العضو بمنشأته واسم ملفه، والمالك بمنشأته (رقمها رقمه) */
export function chatMe(db: DB, user: { uid: string; email: string }, ownerName = ''): ChatMe {
  const m = readMembership(db);
  const fallback = user.email.split('@')[0];
  // اسم العضو اسمه في عضويته حرفاً (قواعد الدليل تطابقه) · والمالك باسم منشأته
  if (m) return { org: m.org, uid: user.uid, email: user.email, name: m.profile?.name ?? '', owner: false };
  return { org: user.uid, uid: user.uid, email: user.email, name: (ownerName || fallback).slice(0, 80), owner: true };
}

const remoteFor = (s: ChatSession, org: string) =>
  new ChatRemote({ projectId: s.projectId, org, uid: s.uid, idToken: s.idToken, baseUrl: s.baseUrl });

let running: Promise<ChatSyncResult> | null = null;
const listeners = new Set<() => void>();

/** يُبلَّغ من يعرض المحادثة بعد كل دورة · فتتجدد القائمة والرسائل */
export function onChatSynced(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** دورة جارية؟ · إيقاف المزامنة قبل الاستعادة أو تبديل الحساب ينتظرها (مراجعة المحادثة #7) */
export const chatSyncRunning = () => running !== null;

const ROLE_EVERY_MS = 10 * 60_000;
const CHANNELS_EVERY_MS = 10 * 60_000;

/**
 * دورة مزامنة واحدة · دورتان معاً تصيران واحدة · threadId: المحادثة المفتوحة وحدها، force: سحب كامل الآن ·
 * وإشرافي يُقرأ كل عشر دقائق ويُحفظ (الحصة المجانية)
 */
export function runChatSync(db: DB, s: ChatSession, ownerName = '', o: { threadId?: string; full?: boolean; force?: boolean } = {}): Promise<ChatSyncResult> {
  if (running) return running;
  running = (async () => {
    const me = chatMe(db, s, ownerName);
    const remote = remoteFor(s, me.org);
    let sup: string[] = [];
    if (!me.owner) {
      const at = Number(getSyncState(db, 'chat_role_at') ?? 0);
      try { sup = JSON.parse(getSyncState(db, 'chat_role') ?? '[]'); } catch { sup = []; }
      if (o.force || Date.now() - at > ROLE_EVERY_MS) {
        try {
          sup = await remote.role(me.email);
          setSyncState(db, 'chat_role', JSON.stringify(sup));
          setSyncState(db, 'chat_role_at', String(Date.now()));
        } catch { /* يبقى المحفوظ */ }
      }
    }
    const res = await chatSyncOnce(db, remote, me, { mySup: sup, threadId: o.threadId, full: o.full, force: o.force });
    // القنوات (الدفعة ٤) بعد السحب (فيعرف الجهاز ما هو فيه): كل عشر دقائق أو عند فتح الشاشة · والمحاولة تُحسب
    // ولو فشلت فلا تتكرر كل دورة · وفشلها لا يعطّل المحادثة
    const chAt = Number(getSyncState(db, 'chat_channels_at') ?? 0);
    if (!o.threadId && (o.force || Date.now() - chAt > CHANNELS_EVERY_MS)) {
      setSyncState(db, 'chat_channels_at', String(Date.now()));
      try {
        if (me.owner) await ensureChannels(db, remote, me); else await autoJoinChannels(db, remote, me);
      } catch { /* تُعاد بعد مدتها */ }
    }
    return res;
  })().finally(() => {
    running = null;
    for (const l of listeners) { try { l(); } catch { /* عارض المحادثة مغلق */ } }
  });
  return running;
}

/* ─── قرارات المالك على مراجعة المحادثة (2026-10-07T18:06Z) ─── */

/**
 * محادثات المنشأة كلها في نافذة الحذف · «حذف حسابي» للمالك (#2) و«مسح كل البيانات» (#28) ·
 * والمحادثة على هذا الجهاز تُفرَّغ مع قاعدته
 */
export async function chatPurgeOrg(s: ChatSession, org: string, o: { keepDirectory?: boolean } = {}): Promise<number> {
  const r = remoteFor(s, org);
  await r.openDeletionWindow();
  try { return await r.purgeAll(o); } finally { await r.closeDeletionWindow().catch(() => {}); }
}

/** العضو يغادر المنشأة: يخرج من مجموعاتها ومن الدليل · محاولةٌ لا تمنع المغادرة */
export async function chatLeaveOrg(s: ChatSession, org: string): Promise<void> {
  const r = remoteFor(s, org);
  for (const t of await r.myThreads()) {
    if (t.k === 'group') await r.leaveGroup(t.id).catch(() => {});
  }
  await r.deleteIn(`chatDir/${s.uid}`).catch(() => {});
}

/** العضو يحذف حسابه: اسمه في رسائله «عضو سابق»، ويخرج من الدليل (#2) */
export async function chatForgetMe(s: ChatSession, org: string): Promise<number> {
  const r = remoteFor(s, org);
  const n = await r.anonymizeMine(FORMER_MEMBER);
  await r.deleteIn(`chatDir/${s.uid}`).catch(() => {});
  return n;
}

/** المالك يُزيل عضواً: يخرج من كل مجموعاتها ومن الدليل والإشراف (#19) */
export async function chatRemoveMember(s: ChatSession, org: string, uid: string, email: string): Promise<number> {
  const r = remoteFor(s, org);
  await r.deleteIn(`chatDir/${uid}`).catch(() => {});
  if (email) await r.deleteIn(`chatRoles/${email.trim().toLowerCase()}`).catch(() => {});
  const groups = await r.groupsOf(uid);
  let n = 0;
  for (const g of groups) {
    try { await r.removeMembers(g.id, [uid]); n++; } catch { /* تُعاد مع الإزالة التالية */ }
  }
  return n;
}

/**
 * تعديل المجموعة · يحتاج اتصالاً، ثم يُطبَّق على الجهاز كما في الخادم · كلٌّ بصلاحيته وتفرضها القواعد:
 * الاسم والإعدادات للمسؤولين، وتعيين المسؤولين للمالك والمنشئ، والإضافة للمسؤولين (ولكل الأعضاء إن أُذن)،
 * والإزالة للمالك والمنشئ (#19 وقرار المالك 2026-10-08T05:31Z)
 */
export interface GroupChange { name?: string; s?: GroupSettings; a?: string[]; members?: string[] }
export async function chatEditGroup(db: DB, s: ChatSession, org: string, threadId: string, c: GroupChange,
  r: ChatRemote = remoteFor(s, org)): Promise<void> {
  const name = c.name === undefined ? undefined : c.name.trim().slice(0, CHAT_NAME_MAX);
  try {
    if (name !== undefined || c.s) await r.setGroupMeta(threadId, { ...(name !== undefined ? { name } : {}), ...(c.s ? { s: c.s } : {}) });
    if (c.members) {
      const cur = await r.getThread(threadId);
      const all = Array.from(new Set(c.members.filter(Boolean)));
      const gone = cur.p.filter((u) => !all.includes(u));
      if (gone.length) await r.removeMembers(threadId, gone);
      for (const u of all) if (!cur.p.includes(u)) await r.addMember(threadId, u);
    }
    if (c.a) await r.setGroupMeta(threadId, { a: c.a });
  } finally {
    // ما نجح منه يظهر على الجهاز كما في الخادم
    try { applyRemoteThread(db, await r.getThread(threadId)); } catch { /* يُحدَّث في المزامنة التالية */ }
  }
}

/* ─── مراجعة المالك محادثةً بسبب، وانضمامه إلى مجموعة (قرارا المالك 2026-10-08T04:11Z) ─── */

/** محادثات المنشأة التي ليس المالك طرفاً فيها · بأطرافها واسمها دون رسائلها · عند طلبه وحده */
export async function chatReviewCandidates(s: ChatSession, org: string, r: ChatRemote = remoteFor(s, org)): Promise<RemoteThread[]> {
  return (await r.orgThreads()).filter((t) => !t.p.includes(s.uid));
}

/**
 * مراجعة محادثة بسببٍ إلزامي: سجلٌّ في الخادم (تفرض القواعد قراءتها به) وسجلٌّ في سجل العمليات بالمحادثة والسبب
 * والمراجِع ووقته · ورسائلها تُعرض ولا تُحفظ على الجهاز · وتنتهي بإغلاقها (chatCloseReview)
 */
export async function chatOpenReview(db: DB, s: ChatSession, org: string, chatId: string, reason: string, title: string,
  r: ChatRemote = remoteFor(s, org)): Promise<RemoteMessage[]> {
  const why = reason.trim().slice(0, 500);
  if (!why) throw new Error('chat: review needs a reason');
  const rid = await r.openReview(chatId, why);
  logAudit(db, CHAT_MODULE, 'create', REVIEW_ENTITY, title, null, { chat: chatId, reason: why, rid });
  try {
    return await r.allMessages(chatId);
  } catch (e) {
    await r.closeReview(chatId).catch(() => {});
    throw e;
  }
}

export async function chatCloseReview(s: ChatSession, org: string, chatId: string, r: ChatRemote = remoteFor(s, org)): Promise<void> {
  await r.closeReview(chatId);
}

/** المالك ينضم إلى مجموعة ليس فيها · ومعه سطر «انضم المالك» للأعضاء · ثم تصير من محادثاته */
export async function chatJoinGroup(db: DB, s: ChatSession, org: string, t: { id: string; p: string[]; name: string; by?: string; at?: string | null },
  myName: string, r: ChatRemote = remoteFor(s, org)): Promise<void> {
  const line = await r.joinGroup(t.id, myName);
  logAudit(db, CHAT_MODULE, 'update', JOIN_ENTITY, t.name, null, { chat: t.id, line });
  // كما في الخادم بعد الانضمام · بوقت انضمامه وإعداداتها
  applyRemoteThread(db, await r.getThread(t.id).catch(() => ({ id: t.id, k: 'group' as const, p: Array.from(new Set([...t.p, s.uid])), name: t.name, by: t.by ?? '', at: t.at ?? null })));
}

/** تثبيت رسالة أو إلغاؤه · في المجموعة لمسؤوليها، وفي الفردية لطرفيها · ثم الحال كما في الخادم (الدفعة ٢) */
export async function chatSetPin(db: DB, s: ChatSession, org: string, threadId: string, msgId: string, on: boolean,
  r: ChatRemote = remoteFor(s, org)): Promise<void> {
  await r.setPin(threadId, msgId, on);
  applyState(db, threadId, (await r.stateSince(threadId, stateCursor(db, threadId))) as unknown as Array<{ id: string; k: string; ts: string }>);
}

/** تأكيد الاطلاع على إعلان مهم · ثم الحال كما في الخادم (الدفعة ٣) */
export async function chatAcknowledge(db: DB, s: ChatSession, org: string, threadId: string, msgId: string,
  r: ChatRemote = remoteFor(s, org)): Promise<void> {
  await r.acknowledge(threadId, msgId);
  applyState(db, threadId, (await r.stateSince(threadId, stateCursor(db, threadId))) as unknown as Array<{ id: string; k: string; ts: string }>);
}

/** تعديل رسالتي بسجلها · يحتاج اتصالاً · ثم الرسالة كما في الخادم (الدفعة ٣) */
export async function chatEditMessage(db: DB, s: ChatSession, org: string, threadId: string, msgId: string, body: string, tag: ChatTag | null,
  r: ChatRemote = remoteFor(s, org)): Promise<void> {
  const text = body.trim();
  if (!text) throw new Error('chat: empty message');
  if (text.length > CHAT_BODY_MAX) throw new Error('chat: message too long');
  await r.editMessage(threadId, msgId, text, tag);
  applyRemoteMessage(db, threadId, await r.getMessage(threadId, msgId));
  applyState(db, threadId, (await r.stateSince(threadId, stateCursor(db, threadId))) as unknown as Array<{ id: string; k: string; ts: string }>);
}

/** سجل تعديلات رسالة · ما قبل كل تعديل (الدفعة ٣) */
export function chatEditsOf(s: ChatSession, org: string, threadId: string, msgId: string, r: ChatRemote = remoteFor(s, org)): Promise<RemoteEdit[]> {
  return r.editsOf(threadId, msgId);
}

/** إشراف عضو بإيميله · للمالك وحده (القواعد) */
export function setSupervisor(s: ChatSession, org: string, email: string, sections: string[]): Promise<void> {
  return remoteFor(s, org).setRole(email, sections);
}

/** إشراف أحد الأعضاء كما في دليل المحادثة · لعرضه بجوار اسمه */
export async function supervisorOf(s: ChatSession, org: string, email: string): Promise<string[]> {
  return remoteFor(s, org).role(email);
}

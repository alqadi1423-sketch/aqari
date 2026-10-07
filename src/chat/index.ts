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
import { CHAT_NAME_MAX, FORMER_MEMBER, type ChatMe } from './types';
import { applyRemoteThread, getThreadRow } from './store';

export * from './types';
export {
  listThreads, getThread, openDirect, createGroup, listMessages, sendLocal, markRead, listPeople, personName,
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
    return chatSyncOnce(db, remote, me, { mySup: sup, threadId: o.threadId, full: o.full, force: o.force });
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
    if (t.k === 'group') await r.leaveGroup(t.id, t.p, t.name).catch(() => {});
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
    try { await r.updateGroup(g.id, g.p.filter((x) => x !== uid), g.name); n++; } catch { /* تُعاد مع الإزالة التالية */ }
  }
  return n;
}

/** تعديل أعضاء المجموعة واسمها · للمالك ومنشئها · يحتاج اتصالاً، ثم يُطبَّق على الجهاز (#19) */
export async function chatUpdateGroup(db: DB, s: ChatSession, org: string, threadId: string, members: string[], name: string): Promise<void> {
  const all = Array.from(new Set(members.filter(Boolean))).sort();
  const n = name.trim().slice(0, CHAT_NAME_MAX);
  await remoteFor(s, org).updateGroup(threadId, all, n);
  applyRemoteThread(db, { ...(getThreadRow(db, threadId)), id: threadId, k: 'group', p: all, name: n });
}

/** إشراف عضو بإيميله · للمالك وحده (القواعد) */
export function setSupervisor(s: ChatSession, org: string, email: string, sections: string[]): Promise<void> {
  return remoteFor(s, org).setRole(email, sections);
}

/** إشراف أحد الأعضاء كما في دليل المحادثة · لعرضه بجوار اسمه */
export async function supervisorOf(s: ChatSession, org: string, email: string): Promise<string[]> {
  return remoteFor(s, org).role(email);
}

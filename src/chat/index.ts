/**
 * واجهة المحادثة مع بقية التطبيق · كل ما يحتاجه التطبيق من الوحدة يمرّ من هنا:
 *  - chatMe: من أنا في المحادثة (المنشأة ورقمي واسمي، وهل أنا المالك).
 *  - runChatSync: دورة مزامنة واحدة · تستدعيها دورة المزامنة العامة وشاشة المحادثة، وفشلها لا يعطّل غيرها.
 *  - setSupervisor: يكتب المالك إشراف عضو بإيميله عند الدعوة أو التعديل.
 * وما سواه (المخزن والعميل والقواعد والشاشات) داخل الوحدة.
 */
import type { DB } from '../db/adapter';
import { readMembership } from '../services/access';
import { ChatRemote } from './remote';
import { chatSyncOnce, type ChatSyncResult } from './sync';
import type { ChatMe } from './types';

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
  if (m) return { org: m.org, uid: user.uid, email: user.email, name: (m.profile?.name || fallback).slice(0, 80), owner: false };
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

/** دورة مزامنة واحدة · دورتان معاً تصيران واحدة */
export function runChatSync(db: DB, s: ChatSession, ownerName = ''): Promise<ChatSyncResult> {
  if (running) return running;
  running = (async () => {
    const me = chatMe(db, s, ownerName);
    const remote = remoteFor(s, me.org);
    let sup: string[] = [];
    if (!me.owner) { try { sup = await remote.role(me.email); } catch { sup = []; } }
    return chatSyncOnce(db, remote, me, sup);
  })().finally(() => {
    running = null;
    for (const l of listeners) { try { l(); } catch { /* عارض المحادثة مغلق */ } }
  });
  return running;
}

/** إشراف عضو بإيميله · للمالك وحده (القواعد) */
export function setSupervisor(s: ChatSession, org: string, email: string, sections: string[]): Promise<void> {
  return remoteFor(s, org).setRole(email, sections);
}

/** إشراف أحد الأعضاء كما في دليل المحادثة · لعرضه بجوار اسمه */
export async function supervisorOf(s: ChatSession, org: string, email: string): Promise<string[]> {
  return remoteFor(s, org).role(email);
}

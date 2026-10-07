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

/** إشراف عضو بإيميله · للمالك وحده (القواعد) */
export function setSupervisor(s: ChatSession, org: string, email: string, sections: string[]): Promise<void> {
  return remoteFor(s, org).setRole(email, sections);
}

/** إشراف أحد الأعضاء كما في دليل المحادثة · لعرضه بجوار اسمه */
export async function supervisorOf(s: ChatSession, org: string, email: string): Promise<string[]> {
  return remoteFor(s, org).role(email);
}

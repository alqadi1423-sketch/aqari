/**
 * مزامنة المحادثة · ترفع ما كُتب بلا اتصال ثم تسحب الجديد · كل خطوة تتحمل الانقطاع وتُعاد بلا تكرار:
 * المحادثة والرسالة بأرقام ثابتة تُنشأ بشرط ألا تكون موجودة.
 */
import type { DB } from '../db/adapter';
import type { ChatRemote } from './remote';
import type { ChatMe } from './types';
import {
  applyRemoteMessage, applyRemoteThread, markSent, markThreadPushed, pendingMessages, pendingThreads,
  savePeople, threadCursor,
} from './store';

export interface ChatSyncResult { pushedThreads: number; pushedMessages: number; pulledMessages: number; failed: number }

export async function chatSyncOnce(db: DB, remote: ChatRemote, me: ChatMe, mySup: string[] = []): Promise<ChatSyncResult> {
  const r: ChatSyncResult = { pushedThreads: 0, pushedMessages: 0, pulledMessages: 0, failed: 0 };

  // ١) الدليل: اسمي وإشرافي، ثم أسماء الأعضاء
  try {
    await remote.putMyDirectory(me.name, mySup);
    savePeople(db, await remote.directory());
  } catch { r.failed++; }

  // ٢) المحادثات المنشأة على الجهاز
  for (const t of pendingThreads(db, me.uid)) {
    try {
      await remote.createThread({ id: t.id, k: t.kind, p: t.members, name: t.name });
      markThreadPushed(db, t.id);
      r.pushedThreads++;
    } catch { r.failed++; }
  }

  // ٣) الرسائل المكتوبة بلا اتصال · ما لم تُرفع محادثتها بعد ينتظر الدورة التالية
  const unpushed = new Set(pendingThreads(db, me.uid).map((t) => t.id));
  for (const m of pendingMessages(db)) {
    if (unpushed.has(m.threadId)) continue;
    try {
      await remote.sendMessage(m.threadId, { id: m.id, name: m.senderName, body: m.body, link: m.link });
      markSent(db, m.id, null);
      r.pushedMessages++;
    } catch { r.failed++; }
  }

  // ٤) السحب: محادثاتي ثم رسائل كلٍّ بعد مؤشرها
  let threads: Awaited<ReturnType<ChatRemote['myThreads']>> = [];
  try { threads = await remote.myThreads(); } catch { r.failed++; return r; }
  for (const t of threads) {
    applyRemoteThread(db, t);
    try {
      let cursor = threadCursor(db, t.id);
      for (;;) {
        const page = await remote.messagesSince(t.id, cursor);
        for (const m of page) applyRemoteMessage(db, t.id, m);
        r.pulledMessages += page.length;
        if (page.length < 200) break;
        cursor = page[page.length - 1].ts;
      }
    } catch { r.failed++; }
  }
  return r;
}

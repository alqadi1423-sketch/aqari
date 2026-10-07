/**
 * مزامنة المحادثة · ترفع ما كُتب بلا اتصال ثم تسحب الجديد · كل خطوة تتحمل الانقطاع وتُعاد بلا تكرار:
 * المحادثة والرسالة بأرقام ثابتة تُنشأ بشرط ألا تكون موجودة.
 *
 * الحصة المجانية (مراجعة المحادثة #3): الدليل يُكتب حين يتغير وحده ويُقرأ كل عشر دقائق، والسحب الكامل
 * (محادثاتي ورسائل كلٍّ منها) كل دقيقتين في الخلفية أو بطلب الشاشة، والمحادثة المفتوحة وحدها كل بضع ثوانٍ.
 */
import type { DB } from '../db/adapter';
import { getSyncState, setSyncState } from '../sync/engine';
import type { ChatRemote } from './remote';
import type { ChatMe } from './types';
import {
  applyRemoteMessage, applyRemoteThread, markSent, markThreadPushed, markThreadRejected, pendingMessages, pendingThreads,
  savePeople, threadCursor,
} from './store';

export interface ChatSyncResult { pushedThreads: number; pushedMessages: number; pulledMessages: number; failed: number }

export interface ChatSyncOptions {
  mySup?: string[];
  /** سحب المحادثة المفتوحة وحدها */
  threadId?: string;
  /** سحب كامل الآن ولو لم تمضِ مدته */
  force?: boolean;
  now?: number;
}

const DIR_EVERY_MS = 10 * 60_000;
const FULL_EVERY_MS = 2 * 60_000;
const PAGE = 200;

const stamp = (db: DB, k: string) => Number(getSyncState(db, k) ?? 0);

/** رسائل محادثة بعد مؤشرها · «أكبر من أو يساوي» فلا تُفقد رسالة بالوقت نفسه، والمعروف منها لا يتكرر */
async function pullThread(db: DB, remote: ChatRemote, threadId: string): Promise<number> {
  let cursor = threadCursor(db, threadId);
  let n = 0;
  for (let guard = 0; guard < 50; guard++) {
    const page = await remote.messagesSince(threadId, cursor, PAGE);
    for (const m of page) applyRemoteMessage(db, threadId, m);
    n += page.length;
    if (page.length < PAGE) break;
    const last = page[page.length - 1].ts;
    if (last === cursor) break; // صفحة كاملة بوقت واحد · لا تقدّم ممكن
    cursor = last;
  }
  return n;
}

export async function chatSyncOnce(db: DB, remote: ChatRemote, me: ChatMe, o: ChatSyncOptions = {}): Promise<ChatSyncResult> {
  const r: ChatSyncResult = { pushedThreads: 0, pushedMessages: 0, pulledMessages: 0, failed: 0 };
  const now = o.now ?? Date.now();
  const mySup = o.mySup ?? [];

  // ١) الدليل: اسمي وإشرافي حين يتغيران · وأسماء الأعضاء كل عشر دقائق أو بطلب
  try {
    const sig = JSON.stringify([me.org, me.name, mySup]);
    if (getSyncState(db, 'chat_dir_sig') !== sig) {
      await remote.putMyDirectory(me.name, mySup);
      setSyncState(db, 'chat_dir_sig', sig);
    }
    if (o.force || now - stamp(db, 'chat_dir_at') > DIR_EVERY_MS) {
      savePeople(db, await remote.directory());
      setSyncState(db, 'chat_dir_at', String(now));
    }
  } catch { r.failed++; }

  // ٢) المحادثات المنشأة على الجهاز · لا تُرفع قبل أول رسالة فيها (فلا تظهر عند الطرف الآخر فارغة)
  for (const t of pendingThreads(db, me.uid)) {
    try {
      await remote.createThread({ id: t.id, k: t.kind, p: t.members, name: t.name });
      markThreadPushed(db, t.id);
      r.pushedThreads++;
    } catch (e) {
      // رفض الخادم (مشرف سُحب إشرافه مثلاً) · تُوسم فتظهر بسببها بدل «لم تُرسل» بلا تفسير
      if (/Firestore 403/.test(String(e))) markThreadRejected(db, t.id);
      r.failed++;
    }
  }

  // ٣) الرسائل المكتوبة بلا اتصال · ما لم تُرفع محادثتها بعد ينتظر الدورة التالية
  const unpushed = new Set(pendingThreads(db, me.uid, true).map((t) => t.id));
  for (const m of pendingMessages(db)) {
    if (unpushed.has(m.threadId)) continue;
    try {
      await remote.sendMessage(m.threadId, { id: m.id, name: m.senderName, body: m.body, link: m.link });
      markSent(db, m.id, null);
      r.pushedMessages++;
    } catch { r.failed++; }
  }

  // ٤) السحب: المحادثة المفتوحة وحدها، أو الكل حين يحين أو يُطلب
  if (o.threadId && !o.force) {
    try { r.pulledMessages += await pullThread(db, remote, o.threadId); } catch { r.failed++; }
    return r;
  }
  if (!o.force && now - stamp(db, 'chat_full_at') < FULL_EVERY_MS) return r;
  let threads: Awaited<ReturnType<ChatRemote['myThreads']>> = [];
  try { threads = await remote.myThreads(); } catch { r.failed++; return r; }
  for (const t of threads) {
    applyRemoteThread(db, t);
    try { r.pulledMessages += await pullThread(db, remote, t.id); } catch { r.failed++; }
  }
  setSyncState(db, 'chat_full_at', String(now));
  return r;
}

/**
 * مزامنة المحادثة · ترفع ما كُتب بلا اتصال ثم تسحب الجديد · كل خطوة تتحمل الانقطاع وتُعاد بلا تكرار:
 * المحادثة والرسالة بأرقام ثابتة تُنشأ بشرط ألا تكون موجودة.
 *
 * الحصة المجانية (مراجعة المحادثة #3): الدليل يُكتب حين يتغير وحده ويُقرأ كل عشر دقائق، والسحب الكامل
 * (محادثاتي ورسائل كلٍّ منها) كل دقيقتين في الخلفية أو بطلب الشاشة، والمحادثة المفتوحة وحدها كل بضع ثوانٍ.
 */
import type { DB } from '../db/adapter';
import { getSyncState, setSyncState } from '../sync/engine';
import type { ChatRemote, PageAfter } from './remote';
import { normTs, type ChatMe } from './types';
import {
  applyRemoteMessage, applyRemoteThread, heldThreads, markMessageRejected, markSent, markThreadPushed, markThreadRejected,
  pendingMessages, pendingThreads, forgetObserved, joinFloor, applyState, stateCursor, readToPush, markReadPushed, isUnsentLocal, isRejectedLocal, staleEdits, markEditUnreadable,
  savePeople, threadCursor,
} from './store';

export interface ChatSyncResult { pushedThreads: number; pushedMessages: number; pulledMessages: number; failed: number }

export interface ChatSyncOptions {
  mySup?: string[];
  /** سحب المحادثة المفتوحة وحدها */
  threadId?: string;
  /** سحب كامل الآن ولو لم تمضِ مدته · بلا تجديد الدليل */
  full?: boolean;
  /** سحب كامل ومعه تجديد الدليل الآن (أول فتح للشاشة) */
  force?: boolean;
  now?: number;
}

const DIR_EVERY_MS = 10 * 60_000;
const FULL_EVERY_MS = 2 * 60_000;
const STATE_EVERY_MS = 10 * 60_000;
const STATE_OPEN_EVERY_MS = 30_000;
const CHANNEL_PULL_EVERY_MS = 10 * 60_000;

/** حال المحادثة: يُسحب ما جدّ منه، وتُرفع قراءتي إن تقدّمت (الدفعة ٢ · 2026-10-08T05:31Z) */
async function syncState(db: DB, remote: ChatRemote, threadId: string, me: string): Promise<void> {
  const up = readToPush(db, threadId, me);
  if (up) { await remote.markReadUpTo(threadId, up); markReadPushed(db, threadId, me, up); }
  // حال المحادثة بوقت الطلب كذلك · فبالنافذة نفسها (التحقق المستقل على البند ٢) · صفحةً صفحة حتى صفحةٍ قصيرة
  await pullState(db, remote, threadId, rewind(stateCursor(db, threadId)));
  // ما عُدِّل في الخادم يُجلب رسالةً رسالة (الدفعة ٣) · وما لا يحق لي قراءته (قبل انضمامي) يُترك
  for (const id of staleEdits(db, threadId)) {
    try { applyRemoteMessage(db, threadId, await remote.getMessage(threadId, id)); } catch (e) {
      // لا يحق لي جلبه (قبل انضمامي): يُعدّ معروفاً فلا يُطلب كل دورة · وما سواه يُعاد في الدورة التالية
      if (/Firestore 403/.test(String(e))) markEditUnreadable(db, threadId, id);
    }
  }
}
const PAGE = 200;
/** صفحة الحال: حدّ ChatRemote.stateSince نفسه */
const STATE_PAGE = 300;

/**
 * حال المحادثة من مؤشرٍ صفحةً صفحة في الدورة الواحدة (المراجعة الشاملة · البند ٢ · تتمة المراجعة الأخيرة): الصفحة التالية تبدأ بعد آخر
 * (وقتٍ، رقمٍ) أُخذ كما تُقلَّب الرسائل، فثلاثمئة عنصرٍ أو أكثر في نافذة الرجوع لا تعيد الصفحة نفسها كل دورة فيقف المؤشر أبداً ·
 * وكل صفحةٍ تُحفظ حين تصل (applyState يقدّم المؤشر ولا يرجعه) · وكل من يسحب الحال يمرّ بها
 */
export async function pullState(db: DB, remote: ChatRemote, threadId: string, from: string | null): Promise<number> {
  let cursor = from;
  let after: PageAfter | null = null;
  let n = 0;
  for (let guard = 0; guard < 50; guard++) {
    const page = await remote.stateSince(threadId, cursor, STATE_PAGE, after);
    applyState(db, threadId, page as unknown as Array<{ id: string; k: string; ts: string }>);
    n += page.length;
    const last = page.length ? page[page.length - 1] : null;
    if (page.length < STATE_PAGE || !last?.ts || !last.id) break;
    after = { ts: last.ts, id: last.id };
    cursor = last.ts;
  }
  return n;
}

const stamp = (db: DB, k: string) => Number(getSyncState(db, k) ?? 0);

/**
 * رسائل محادثة بعد مؤشرها · «أكبر من أو يساوي» فلا تُفقد رسالة بالوقت نفسه، والمعروف منها لا يتكرر ·
 * والمجموعة التي سجلُّها «من لحظة انضمامه» من وقت انضمامي وبطريقها (2026-10-08T05:31Z)
 */
async function pullThread(db: DB, remote: ChatRemote, threadId: string, me: string, retried = false): Promise<number> {
  try {
    return await pullThreadOnce(db, remote, threadId, me);
  } catch (e) {
    // تبدّل سجل المجموعة عند غيري (أو أُخرجت): تُجلب كما في الخادم وتُعاد مرة
    if (retried || !/Firestore 403/.test(String(e))) throw e;
    applyRemoteThread(db, await remote.getThread(threadId));
    return pullThread(db, remote, threadId, me, true);
  }
}

/**
 * نافذة أمان السحب (المراجعة الشاملة · البند ٢): وقت الرسالة وقت طلبها في الخادم لا وقت التزامها، فرسالةٌ قواعدها أثقل تظهر بعد
 * رسالةٍ وقتها أكبر منه · فيُعاد الاستعلام من المؤشر ناقص النافذة في كل سحب، والمكرَّر يُعرف برقمه فلا يتكرر (applyRemoteMessage)
 */
export const CHAT_PULL_SAFETY_MS = 60_000;

/** المؤشر ناقص النافذة بصيغة وقت الخادم نفسها (أجزاء المليار) · والثواني وحدها تُحسب، فمحرّك الجوال لا يقرأ أكثر من ثلاثة أجزاء */
function rewind(cursor: string | null): string | null {
  if (!cursor) return cursor;
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{9})Z$/.exec(normTs(cursor));
  if (!m) return cursor;
  const t = Date.parse(m[1] + 'Z');
  return Number.isFinite(t) ? new Date(t - CHAT_PULL_SAFETY_MS).toISOString().slice(0, 19) + '.' + m[2] + 'Z' : cursor;
}

async function pullThreadOnce(db: DB, remote: ChatRemote, threadId: string, me: string): Promise<number> {
  const floor = joinFloor(db, threadId, me);
  let cursor = rewind(threadCursor(db, threadId));
  // ولا يسبق وقتَ انضمامي (المجموعة «من لحظة انضمامه»)
  if (floor && (!cursor || cursor < floor)) cursor = floor;
  let n = 0;
  // الصفحة التالية تبدأ بعد آخر (وقتٍ، رقمٍ) أُخذ لا عند وقته: صفحةٌ كاملة بوقتٍ واحد لا توقف السحب (المراجعة الخارجية ٧ · النتيجة ٤٠)
  let after: { ts: string; id: string } | null = null;
  for (let guard = 0; guard < 50; guard++) {
    let page: Awaited<ReturnType<ChatRemote['messagesSince']>>;
    let full: boolean;
    let last: string | null;
    let lastId: string | null;
    if (floor) {
      const j = await remote.joinedPage(threadId, cursor!, PAGE, after);
      page = j.msgs; full = j.ids >= PAGE; last = j.lastTs; lastId = j.lastId;
    } else {
      page = await remote.messagesSince(threadId, cursor, PAGE, after);
      full = page.length >= PAGE; last = page.length ? page[page.length - 1].ts : null; lastId = page.length ? page[page.length - 1].id : null;
    }
    for (const m of page) applyRemoteMessage(db, threadId, m);
    n += page.length;
    if (!full || !last || !lastId) break;
    after = { ts: last, id: lastId };
    cursor = last;
  }
  return n;
}

export async function chatSyncOnce(db: DB, remote: ChatRemote, me: ChatMe, o: ChatSyncOptions = {}): Promise<ChatSyncResult> {
  const r: ChatSyncResult = { pushedThreads: 0, pushedMessages: 0, pulledMessages: 0, failed: 0 };
  const now = o.now ?? Date.now();
  // مرة واحدة على جهاز المالك: ما سحبه الاطلاع السابق من محادثات ليس طرفاً فيها يُمحى (2026-10-08T04:11Z)
  if (me.owner && getSyncState(db, 'chat_forgot_observed') !== '1') {
    forgetObserved(db, me.uid);
    setSyncState(db, 'chat_forgot_observed', '1');
  }
  const mySup = o.mySup ?? [];

  // ١) الدليل: اسمي وإشرافي حين يتغيران · وأسماء الأعضاء كل عشر دقائق أو بطلب
  const sig = JSON.stringify([me.org, me.name, mySup]);
  try {
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
      await remote.createThread({ id: t.id, k: t.kind, p: t.members, name: t.name, ...(t.kind === 'group' ? { s: t.settings, a: t.admins } : {}) });
      markThreadPushed(db, t.id);
      r.pushedThreads++;
    } catch (e) {
      // رفض الخادم (مشرف سُحب إشرافه مثلاً) · تُوسم فتظهر بسببها بدل «لم تُرسل» بلا تفسير
      if (/Firestore 403/.test(String(e))) markThreadRejected(db, t.id);
      r.failed++;
    }
  }

  // ٣) الرسائل المكتوبة بلا اتصال · ما لم تُرفع محادثتها بعد ينتظر الدورة التالية
  const unpushed = heldThreads(db);
  // لا ترفع قبل أن يُكتب اسمي الحالي في الدليل بنجاح · فالقاعدة تطابقه، ورفضٌ لسببٍ عابر يوسم الرسالة (التحقق ج١١)
  const dirReady = getSyncState(db, 'chat_dir_sig') === sig;
  const held = new Set<string>();
  for (const m of dirReady ? pendingMessages(db) : []) {
    if (unpushed.has(m.threadId)) continue;
    // الرد في سلسلة ينتظر أصله: أصلٌ لم يُرسل بعد (أو تعثّر في هذه الدورة) يُبقي ردّه منتظراً لا مرفوضاً
    if (m.re && isRejectedLocal(db, m.re)) { markMessageRejected(db, m.id); r.failed++; continue; }
    if (m.re && (held.has(m.re) || isUnsentLocal(db, m.re))) { held.add(m.id); continue; }
    try {
      // باسمي الحالي في الدليل لا المحفوظ يوم الكتابة · فتغيّر الاسم لا يحبس الرسالة (قواعد الخادم تطابقه)
      await remote.sendMessage(m.threadId, { id: m.id, name: me.name, body: m.body, link: m.link, re: m.re, men: m.men, tag: m.tag, ack: m.ack, poll: m.poll });
      markSent(db, m.id, null);
      r.pushedMessages++;
    } catch (e) {
      if (/Firestore 403/.test(String(e))) markMessageRejected(db, m.id);
      held.add(m.id);
      r.failed++;
    }
  }

  // ٤) السحب: المحادثة المفتوحة وحدها (ومعها حالها وقراءتي)، أو الكل حين يحين أو يُطلب
  if (o.threadId && !o.force) {
    let got = 0;
    try { got = await pullThread(db, remote, o.threadId, me.uid); r.pulledMessages += got; } catch { r.failed++; }
    // حال المفتوحة كل ٣٠ ثانية، أو حين يجيء جديد (الحصة: السحب كل ٨ ثوانٍ لا يضاعف القراءة)
    const key = 'chat_st_open_' + o.threadId;
    if (got > 0 || now - stamp(db, key) > STATE_OPEN_EVERY_MS) {
      await syncState(db, remote, o.threadId, me.uid).then(() => setSyncState(db, key, String(now))).catch(() => { r.failed++; });
    }
    return r;
  }
  if (!o.force && !o.full && now - stamp(db, 'chat_full_at') < FULL_EVERY_MS) return r;
  let threads: Awaited<ReturnType<ChatRemote['myThreads']>> = [];
  // محادثاتي وحدها، والمالك كغيره: لا تحديث دوري لمحادثات المنشأة عنده، فلا تُقرأ إلا بمراجعة بسببها
  // (قرار المالك 2026-10-08T04:11Z)
  try { threads = await remote.myThreads(); } catch { r.failed++; return r; }
  // حال المحادثات (التثبيت والقراءة): لما جاءه جديد، ولكلها كل عشر دقائق أو بطلب (الحصة المجانية)
  const stateAll = o.force || now - stamp(db, 'chat_state_at') > STATE_EVERY_MS;
  // القنوات ومحادثات العقارات كثيرة (عقار لكل عقار): تُسحب كل عشر دقائق في الخلفية أو بطلب، والمفتوحة كل ثوانٍ كغيرها
  const channelsDue = o.force || now - stamp(db, 'chat_ch_pull_at') > CHANNEL_PULL_EVERY_MS;
  for (const t of threads) {
    applyRemoteThread(db, t);
    if (t.ch && !channelsDue) continue;
    let got = 0;
    try { got = await pullThread(db, remote, t.id, me.uid); r.pulledMessages += got; } catch { r.failed++; }
    if (got > 0 || stateAll) await syncState(db, remote, t.id, me.uid).catch(() => { r.failed++; });
  }
  if (stateAll) setSyncState(db, 'chat_state_at', String(now));
  if (channelsDue) setSyncState(db, 'chat_ch_pull_at', String(now));
  setSyncState(db, 'chat_full_at', String(now));
  return r;
}

/**
 * مخزن المحادثة على الجهاز (الهجرة ٣٤) · ما يُكتب بلا اتصال يبقى «لم يُرسل» حتى تُرفع · ولا حذف للرسائل.
 */
import type { DB, SqlValue } from '../db/adapter';
import { uid as newId } from '../domain/ids';
import {
  CHAT_BODY_MAX, CHAT_GROUP_MAX, CHAT_NAME_MAX, MENTIONS_MAX, POLL_MAX, directId, groupSettings, tsGte,
  type ChannelRef, type ChatPoll, type ChatTag, type ChatTask, type GroupSettings,
  type ChatKind, type ChatLink, type ChatMessage, type ChatPerson, type ChatThread,
} from './types';

const nowIso = () => new Date().toISOString();

function parseList(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/* ─── المحادثات ─── */

interface ThreadRow {
  id: string; kind: ChatKind; name: string; members: string; created_by: string; created_at: string | null;
  last_ts: string | null; last_body: string; read_ts: string | null; pending: number; unread: number; meta: string | null;
}

function metaOf(raw: string | null | undefined): { s?: GroupSettings; a?: string[]; jt?: Record<string, string>; ch?: ChannelRef | null } {
  try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

const threadOf = (r: ThreadRow): ChatThread => {
  const m = metaOf(r.meta);
  return {
    id: r.id, kind: r.kind, name: r.name, members: parseList(r.members), createdBy: r.created_by,
    createdAt: r.created_at, lastTs: r.last_ts, lastBody: r.last_body, unread: Number(r.unread || 0), pending: !!r.pending,
    rejected: Number(r.pending) === 2,
    settings: groupSettings(m.s), admins: Array.isArray(m.a) ? m.a : [], joined: m.jt && typeof m.jt === 'object' ? m.jt : {},
    channel: m.ch && typeof m.ch === 'object' ? m.ch : null,
  };
};

/**
 * من أين يقرأ عضوٌ مجموعةً سجلُّها «من لحظة انضمامه»: وقت انضمامه، والأوائل وقت إنشائها · null لما سواها
 * (قرار المالك 2026-10-08T05:31Z)
 */
export function joinFloor(db: DB, threadId: string, me: string): string | null {
  const r = db.get<ThreadRow>(`SELECT * FROM chat_threads WHERE id = ?`, [threadId]);
  if (!r) return null;
  const t = threadOf(r);
  if (t.kind !== 'group' || t.settings.h !== 'join') return null;
  return t.joined[me] ?? t.createdAt ?? '1970-01-01T00:00:00Z';
}

/**
 * محادثاتي بآخر نشاط · وغير المقروء من رسائل الآخرين · onlyMine للمالك: ما ليس طرفاً فيه لا يظهر في قائمته
 * (قرار المالك 2026-10-08T04:11Z: «قائمته محادثاته هو وحدها») · والعضو يرى مجموعةً أُخرج منها بسجلها كما كان
 */
export function listThreads(db: DB, me: string, onlyMine = false): ChatThread[] {
  return db.all<ThreadRow>(
    `SELECT t.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = t.id AND m.sender != ?
       AND COALESCE(m.server_ts, m.local_at) > COALESCE(t.read_ts, '')) AS unread
     FROM chat_threads t ORDER BY COALESCE(t.last_ts, t.created_at, '') DESC`, [me]).map(threadOf)
    .filter((t) => !onlyMine || t.members.includes(me));
}

/**
 * ما سحبه اطلاع المالك في النسخة السابقة (2026-10-08) من محادثات ليس طرفاً فيها يُمحى من جهازه · فلا يُقرأ
 * إلا بمراجعة بسببها. لا يمسّ محادثةً أنشأها أو كتب فيها (مجموعة غادرها مثلاً). والرسالة لا تُحذف بعده كما كانت.
 */
export function forgetObserved(db: DB, me: string): number {
  const ids = db.all<ThreadRow>(`SELECT * FROM chat_threads`).map(threadOf)
    .filter((t) => !t.members.includes(me) && t.createdBy !== me
      && !db.get(`SELECT 1 FROM chat_messages WHERE thread_id = ? AND sender = ? LIMIT 1`, [t.id, me]))
    .map((t) => t.id);
  if (!ids.length) return 0;
  const marks = ids.map(() => '?').join(',');
  db.transaction(() => {
    db.run(`DROP TRIGGER IF EXISTS trg_chat_msg_no_delete`);
    db.run(`DELETE FROM chat_messages WHERE thread_id IN (${marks})`, ids);
    db.run(`DELETE FROM chat_threads WHERE id IN (${marks})`, ids);
    db.run(CHAT_NO_DELETE_TRIGGER);
  });
  return ids.length;
}

/** مطابق للهجرة ٣٤ حرفاً · يُعاد بعد المحو أعلاه */
const CHAT_NO_DELETE_TRIGGER = `CREATE TRIGGER IF NOT EXISTS trg_chat_msg_no_delete BEFORE DELETE ON chat_messages
BEGIN SELECT RAISE(ABORT, 'chat message is permanent'); END;`;

export function getThread(db: DB, id: string, me: string): ChatThread | null {
  return listThreads(db, me).find((t) => t.id === id) ?? null;
}

/** محادثة فردية مع عضو · تُنشأ على الجهاز إن لم توجد وتُرفع في المزامنة */
export function openDirect(db: DB, me: string, other: string): string {
  if (!other || other === me) throw new Error('chat: direct needs another member');
  const id = directId(me, other);
  db.run(
    `INSERT OR IGNORE INTO chat_threads (id, kind, name, members, created_by, created_at, pending)
     VALUES (?, 'direct', '', ?, ?, ?, 1)`, [id, JSON.stringify([me, other].sort()), me, nowIso()]);
  return id;
}

/** مجموعة جديدة بإعداداتها ومسؤوليها · المالك والمشرفون وحدهم (تفحصه الواجهة وقواعد الخادم) */
export function createGroup(db: DB, me: string, name: string, members: string[], settings: GroupSettings = {}, admins: string[] = []): string {
  const n = name.trim().slice(0, CHAT_NAME_MAX);
  if (!n) throw new Error('chat: group name');
  const all = Array.from(new Set([me, ...members.filter(Boolean)])).sort();
  if (all.length < 2) throw new Error('chat: group needs members');
  if (all.length > CHAT_GROUP_MAX) throw new Error('chat: group too large');
  const id = 'g_' + newId();
  const meta = { s: groupSettings(settings), a: admins.filter((u) => all.includes(u) && u !== me), jt: {} };
  db.run(
    `INSERT INTO chat_threads (id, kind, name, members, created_by, created_at, pending, meta)
     VALUES (?, 'group', ?, ?, ?, ?, 1, ?)`, [id, n, JSON.stringify(all), me, nowIso(), JSON.stringify(meta)]);
  return id;
}

/** حقول المحادثة كما تُطبَّق من السحابة · لتعديلٍ محلي بعد نجاحه على الخادم */
export function getThreadRow(db: DB, id: string): { by: string; at: string | null } {
  const r = db.get<{ by: string; at: string | null }>(`SELECT created_by AS by, created_at AS at FROM chat_threads WHERE id = ?`, [id]);
  return r ?? { by: '', at: null };
}

export function markRead(db: DB, threadId: string): void {
  const last = db.get<{ t: string | null }>(
    `SELECT MAX(COALESCE(server_ts, local_at)) AS t FROM chat_messages WHERE thread_id = ?`, [threadId])?.t;
  if (last) db.run(`UPDATE chat_threads SET read_ts = ? WHERE id = ?`, [last, threadId]);
}

/* ─── الرسائل ─── */

interface MsgRow {
  id: string; thread_id: string; sender: string; sender_name: string; body: string;
  link_type: string | null; link_id: string | null; link_label: string | null;
  local_at: string; server_ts: string | null; sent: number; sys: string | null; x: string | null;
}

/** ما زاد على الرسالة في x (الدفعة ٢): الرد في سلسلة والإشارات */
interface MsgExtra { re?: string | null; men?: string[]; tag?: ChatTag | null; ack?: boolean; ev?: number; evk?: number; poll?: ChatPoll | null }
function extraOf(raw: string | null | undefined): MsgExtra {
  try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
const extraJson = (e: MsgExtra): string | null => {
  const o: MsgExtra = {};
  if (e.re) o.re = e.re;
  if (e.men?.length) o.men = e.men.slice(0, MENTIONS_MAX);
  if (e.tag) o.tag = e.tag;
  if (e.ack) o.ack = true;
  if (e.ev) o.ev = e.ev;
  if (e.evk) o.evk = e.evk;
  if (e.poll) o.poll = { o: e.poll.o.slice(0, POLL_MAX).map((x) => String(x).slice(0, 100)), m: !!e.poll.m };
  return Object.keys(o).length ? JSON.stringify(o) : null;
};

const msgOf = (r: MsgRow): ChatMessage => ({
  id: r.id, threadId: r.thread_id, sender: r.sender, senderName: r.sender_name, body: r.body,
  link: r.link_type && r.link_id ? { type: r.link_type as ChatLink['type'], id: r.link_id, label: r.link_label ?? '' } : null,
  localAt: r.local_at, serverTs: r.server_ts, sent: Number(r.sent) === 1, rejected: Number(r.sent) === -1, sys: r.sys ?? null,
  re: extraOf(r.x).re ?? null, men: extraOf(r.x).men ?? [],
  tag: extraOf(r.x).tag ?? null, ack: extraOf(r.x).ack === true, ev: Number(extraOf(r.x).ev ?? 0) || 0,
  poll: extraOf(r.x).poll ?? null,
});

/** رسائل محادثة بترتيب وقوعها · وقت الخادم للمرسَل، ووقت الكتابة لما ينتظر */
export function listMessages(db: DB, threadId: string): ChatMessage[] {
  return db.all<MsgRow>(
    `SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY COALESCE(server_ts, local_at), local_at`, [threadId]).map(msgOf);
}

/** رسالة جديدة · تُحفظ على الجهاز فوراً «لم تُرسل» وتُرفع في المزامنة */
export function sendLocal(db: DB, threadId: string, me: { uid: string; name: string }, body: string, link: ChatLink | null = null,
  extra: MsgExtra = {}): string {
  const text = body.trim();
  if (!text && !link) throw new Error('chat: empty message');
  if (link) link = { ...link, id: link.id.slice(0, 64), label: link.label.slice(0, 200) };
  if (text.length > CHAT_BODY_MAX) throw new Error('chat: message too long');
  const row = db.get<{ members: string }>(`SELECT members FROM chat_threads WHERE id = ?`, [threadId]);
  if (!row) throw new Error('chat: no such thread');
  // اطلاع المالك للقراءة وحدها: لا يكتب في محادثة ليس طرفاً فيها (قرار المالك 2026-10-08)
  if (!parseList(row.members).includes(me.uid)) throw new Error('chat: not a party');
  const id = newId();
  const at = nowIso();
  db.transaction(() => {
    db.run(
      `INSERT INTO chat_messages (id, thread_id, sender, sender_name, body, link_type, link_id, link_label, local_at, sent, x)
       VALUES (?,?,?,?,?,?,?,?,?,0,?)`,
      [id, threadId, me.uid, me.name, text, link?.type ?? null, link?.id ?? null, link?.label ?? null, at, extraJson(extra)]);
    // المسودة تُفرَّغ بالإرسال من خانة المحادثة · والرد في سلسلة لا يمسّها
    if (!extra.re && !extra.poll) db.run(`UPDATE chat_threads SET draft = '' WHERE id = ?`, [threadId]);
    db.run(`UPDATE chat_threads SET last_ts = ?, last_body = ?, read_ts = ? WHERE id = ?`, [at, text || link!.label, at, threadId]);
  });
  return id;
}

/**
 * ما ينتظر الرفع من المحادثة: رسائل لم تُرسل في محادثة لم يرفضها الخادم · لا يُفرَّغ الجهاز لتغيّر الصلاحية قبل رفعها
 * (تحقق الدمج ف٢، كطابور المزامنة العامة) · والمرفوضة لا تُعاد فلا تُحتسب
 */
export function chatUnsentCount(db: DB): number {
  return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
    WHERE m.sent = 0 AND t.pending != 2`)?.n ?? 0);
}

export function pendingMessages(db: DB): ChatMessage[] {
  return db.all<MsgRow>(`SELECT * FROM chat_messages WHERE sent = 0 ORDER BY local_at`).map(msgOf);
}

/**
 * محادثات أُنشئت على الجهاز ولم تُرفع · تُرفع بعد أول رسالة فيها (مراجعة المحادثة #20) ·
 * includeEmpty للتحقق من رسائلها: ما لم تُرفع محادثته لا تُرسل رسالته
 */
export function pendingThreads(db: DB, me: string, includeEmpty = false): ChatThread[] {
  return listThreads(db, me).filter((t) => t.pending && !t.rejected
    && (includeEmpty || !!db.get(`SELECT 1 FROM chat_messages WHERE thread_id = ? LIMIT 1`, [t.id])));
}

/** محادثات لم تُرفع (منتظرة أو مرفوضة) · لا تُرسل رسائلها (التحقق ج٤) */
export function heldThreads(db: DB): Set<string> {
  return new Set(db.all<{ id: string }>(`SELECT id FROM chat_threads WHERE pending != 0`).map((r) => r.id));
}

/** رسالة رفضها الخادم · تبقى على الجهاز موسومة ولا تُعاد (لا تُحذف) */
export function markMessageRejected(db: DB, id: string): void {
  db.run(`UPDATE chat_messages SET sent = -1 WHERE id = ?`, [id]);
}

/** رفض الخادم إنشاءها · تبقى على الجهاز بسببها ولا تُعاد محاولتها */
export function markThreadRejected(db: DB, id: string): void {
  db.run(`UPDATE chat_threads SET pending = 2 WHERE id = ?`, [id]);
}

export function markThreadPushed(db: DB, id: string): void {
  db.run(`UPDATE chat_threads SET pending = 0 WHERE id = ?`, [id]);
}

export function markSent(db: DB, id: string, serverTs: string | null): void {
  db.run(`UPDATE chat_messages SET sent = 1, server_ts = COALESCE(?, server_ts) WHERE id = ?`, [serverTs, id]);
}

/* ─── ما يصل من السحابة ─── */

export function applyRemoteThread(db: DB, t: {
  id: string; k: ChatKind; p: string[]; name: string; by: string; at: string | null;
  s?: GroupSettings; a?: string[]; jt?: Record<string, string>; ch?: ChannelRef | null;
}): void {
  const meta = JSON.stringify({ s: groupSettings(t.s), a: t.a ?? [], jt: t.jt ?? {}, ch: t.ch ?? null });
  // من «من لحظة انضمامه» إلى «كل السابق»: يُعاد المؤشر فيصل ما قبل الانضمام (قرار المالك 2026-10-08T05:31Z)
  const old = db.get<{ meta: string | null }>(`SELECT meta FROM chat_threads WHERE id = ?`, [t.id]);
  if (old && metaOf(old.meta).s?.h === 'join' && groupSettings(t.s).h === 'all') {
    db.run(`UPDATE chat_threads SET msg_cursor = NULL WHERE id = ?`, [t.id]);
  }
  db.run(
    `INSERT INTO chat_threads (id, kind, name, members, created_by, created_at, pending, meta)
     VALUES (?,?,?,?,?,?,0,?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, members = excluded.members,
       created_by = excluded.created_by, created_at = COALESCE(excluded.created_at, chat_threads.created_at), pending = 0,
       meta = excluded.meta`,
    [t.id, t.k, t.name, JSON.stringify([...t.p].sort()), t.by, t.at, meta]);
}

export function applyRemoteMessage(db: DB, threadId: string, m: {
  id: string; from: string; name: string; body: string; link: ChatLink | null; ts: string; sys?: string | null; re?: string | null; men?: string[];
  tag?: ChatTag | null; ack?: boolean; ev?: number; poll?: ChatPoll | null;
}): void {
  db.transaction(() => {
    const had = db.get<{ x: string | null }>(`SELECT x FROM chat_messages WHERE id = ?`, [m.id]);
    if (had) {
      db.run(`UPDATE chat_messages SET sent = 1, server_ts = ? WHERE id = ?`, [m.ts, m.id]);
      // ما عُدِّل في الخادم (الدفعة ٣): نصه ووسمه وعدد تعديلاته
      if ((m.ev ?? 0) > (Number(extraOf(had.x).ev ?? 0) || 0)) {
        db.run(`UPDATE chat_messages SET body = ?, x = ? WHERE id = ?`,
          [m.body, extraJson({ re: m.re, men: m.men, tag: m.tag, ack: m.ack, ev: m.ev, poll: m.poll }), m.id]);
      }
    }
    else db.run(
      `INSERT INTO chat_messages (id, thread_id, sender, sender_name, body, link_type, link_id, link_label, local_at, server_ts, sent, sys, x)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      [m.id, threadId, m.from, m.name, m.body, m.link?.type ?? null, m.link?.id ?? null, m.link?.label ?? null, m.ts, m.ts, m.sys ?? null,
        extraJson({ re: m.re, men: m.men, tag: m.tag, ack: m.ack, ev: m.ev, poll: m.poll })]);
    db.run(
      `UPDATE chat_threads SET last_ts = ?, last_body = ?, msg_cursor = ?
       WHERE id = ? AND (last_ts IS NULL OR last_ts <= ?)`,
      [m.ts, m.body || m.link?.label || '', m.ts, threadId, m.ts]);
    db.run(`UPDATE chat_threads SET msg_cursor = ? WHERE id = ? AND (msg_cursor IS NULL OR msg_cursor < ?)`, [m.ts, threadId, m.ts]);
  });
}

export function threadCursor(db: DB, id: string): string | null {
  return db.get<{ c: string | null }>(`SELECT msg_cursor AS c FROM chat_threads WHERE id = ?`, [id])?.c ?? null;
}

/* ─── الأشخاص ─── */

export function savePeople(db: DB, people: ChatPerson[]): void {
  const at = nowIso();
  db.transaction(() => {
    db.run(`DELETE FROM chat_people`);
    for (const p of people) {
      db.run(
        `INSERT INTO chat_people (uid, name, sup, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(uid) DO UPDATE SET name = excluded.name, sup = excluded.sup, updated_at = excluded.updated_at`,
        [p.uid, p.name, JSON.stringify(p.sup), at]);
    }
  });
}

export function listPeople(db: DB): ChatPerson[] {
  return db.all<{ uid: string; name: string; sup: string }>(`SELECT uid, name, sup FROM chat_people ORDER BY name`)
    .map((r) => ({ uid: r.uid, name: r.name, sup: parseList(r.sup) }));
}

export function personName(db: DB, uid: string): string {
  return db.get<{ name: string }>(`SELECT name FROM chat_people WHERE uid = ?`, [uid])?.name ?? '';
}

/* ─── الدفعة ٢ (قرار المالك 2026-10-08T05:31Z): السلاسل والتثبيت والقراءة والمسودات ─── */

/** خط المحادثة الرئيس: ما ليس ردّاً في سلسلة · والردود تُعدّ لأصلها */
export function mainLine(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.filter((m) => !m.re);
}
export function repliesOf(msgs: ChatMessage[], parentId: string): ChatMessage[] {
  return msgs.filter((m) => m.re === parentId);
}
export function replyCounts(msgs: ChatMessage[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of msgs) if (m.re) out[m.re] = (out[m.re] ?? 0) + 1;
  return out;
}

/** حال المحادثة كما في الخادم (التثبيت والقراءة) · ومؤشرها */
export function applyState(db: DB, threadId: string, items: Array<{ id: string; k: string; ts: string; [key: string]: unknown }>): void {
  if (!items.length) return;
  db.transaction(() => {
    for (const it of items) {
      const { id, k, ts, ...data } = it;
      db.run(
        `INSERT INTO chat_state (thread_id, id, k, data, ts) VALUES (?,?,?,?,?)
         ON CONFLICT(thread_id, id) DO UPDATE SET k = excluded.k, data = excluded.data, ts = excluded.ts`,
        [threadId, id, k, JSON.stringify(data), ts]);
    }
    const last = items[items.length - 1].ts;
    db.run(`UPDATE chat_threads SET st_cursor = ? WHERE id = ? AND (st_cursor IS NULL OR st_cursor < ?)`, [last, threadId, last]);
  });
}
export function stateCursor(db: DB, threadId: string): string | null {
  return db.get<{ c: string | null }>(`SELECT st_cursor AS c FROM chat_threads WHERE id = ?`, [threadId])?.c ?? null;
}
function stateRows(db: DB, threadId: string, k: string): Array<{ id: string; data: Record<string, unknown> }> {
  return db.all<{ id: string; data: string }>(`SELECT id, data FROM chat_state WHERE thread_id = ? AND k = ?`, [threadId, k])
    .map((r) => { let d: Record<string, unknown> = {}; try { d = JSON.parse(r.data); } catch { d = {}; } return { id: r.id, data: d }; });
}
/** الرسائل المثبّتة (أرقامها) */
export function pinnedIds(db: DB, threadId: string): string[] {
  return stateRows(db, threadId, 'pin').filter((r) => r.data.on === true).map((r) => r.id.slice(2));
}
/** قراءة كل عضو: رقمه ← حتى أي وقت قرأ */
export function readsOf(db: DB, threadId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of stateRows(db, threadId, 'read')) if (typeof r.data.at === 'string') out[r.id.slice(2)] = r.data.at;
  return out;
}
/** من قرأ الرسالة ومن لم يقرأ (غير مرسلها) */
export function readersOf(db: DB, threadId: string, m: { sender: string; serverTs: string | null }, members: string[]): { read: string[]; unread: string[] } {
  return readersFrom(readsOf(db, threadId), m, members);
}
/** من قرأ من خريطة القراءة نفسها · لعرضٍ لكل رسالة دون سؤال القاعدة لكلٍّ منها */
export function readersFrom(reads: Record<string, string>, m: { sender: string; serverTs: string | null }, members: string[],
  joinedAfter: Record<string, string> = {}): { read: string[]; unread: string[] } {
  // في «من لحظة انضمامه» من انضم بعد الرسالة لا يراها، فلا يُعدّ قارئاً ولا غير قارئ
  const others = members.filter((u) => u !== m.sender
    && !(joinedAfter[u] && m.serverTs && !tsGte(m.serverTs, joinedAfter[u])));
  const read = m.serverTs ? others.filter((u) => reads[u] && tsGte(reads[u], m.serverTs!)) : [];
  return { read, unread: others.filter((u) => !read.includes(u)) };
}
/**
 * قراءتي التي لم تُرفع: أحدث وقت خادمٍ لرسالةٍ قرأتها · null إن رُفعت أو لا شيء
 * (كلٌّ يكتب قراءته وحده بوقت رسالة في الخادم)
 */
export function readToPush(db: DB, threadId: string, me: string): string | null {
  const t = db.get<{ read_ts: string | null }>(`SELECT read_ts FROM chat_threads WHERE id = ?`, [threadId]);
  if (!t?.read_ts) return null;
  const upTo = db.get<{ v: string | null }>(
    // رسائل غيري وحدها: قراءتي رسالتي لا تُرفع (كتابة بلا فائدة مع كل إرسال)
    `SELECT MAX(server_ts) AS v FROM chat_messages WHERE thread_id = ? AND sender != ? AND server_ts IS NOT NULL AND server_ts <= ?`,
    [threadId, me, t.read_ts])?.v ?? null;
  if (!upTo) return null;
  const mine = readsOf(db, threadId)[me];
  return mine && tsGte(mine, upTo) ? null : upTo;
}
/** بعد رفع قراءتي: تُحفظ كما رُفعت فلا تتكرر */
export function markReadPushed(db: DB, threadId: string, me: string, at: string): void {
  db.run(
    `INSERT INTO chat_state (thread_id, id, k, data, ts) VALUES (?,?,'read',?,NULL)
     ON CONFLICT(thread_id, id) DO UPDATE SET data = excluded.data`,
    [threadId, 'r_' + me, JSON.stringify({ at })]);
}
/** المسودة على الجهاز وحده · تُحفظ بالكتابة وتُفرَّغ بالإرسال */
export function setDraft(db: DB, threadId: string, text: string): void {
  db.run(`UPDATE chat_threads SET draft = ? WHERE id = ?`, [text.slice(0, CHAT_BODY_MAX), threadId]);
}
export function getDraft(db: DB, threadId: string): string {
  return db.get<{ d: string }>(`SELECT draft AS d FROM chat_threads WHERE id = ?`, [threadId])?.d ?? '';
}

/** رسالة على الجهاز لم تُرسل بعد (أو رُفضت) · فالرد عليها ينتظرها */
export function isUnsentLocal(db: DB, id: string): boolean {
  const r = db.get<{ sent: number }>(`SELECT sent FROM chat_messages WHERE id = ?`, [id]);
  return !!r && Number(r.sent) !== 1;
}

/** رسالة على الجهاز رفضها الخادم · فالرد عليها يُرفض معها لا ينتظر بلا نهاية */
export function isRejectedLocal(db: DB, id: string): boolean {
  return Number(db.get<{ sent: number }>(`SELECT sent FROM chat_messages WHERE id = ?`, [id])?.sent ?? 0) === -1;
}

/* ─── الدفعة ٣ (قرار المالك 2026-10-08T05:31Z): تأكيد الاطلاع، والتعديل، والبحث ─── */

/** من أكّد الاطلاع على إعلان مهم ومن لم يؤكّد (غير مرسله) */
export function ackersOf(db: DB, threadId: string, m: { id: string; sender: string; serverTs: string | null }, members: string[],
  joinedAfter: Record<string, string> = {}): { acked: string[]; pending: string[] } {
  return ackersFrom(acksOf(db, threadId), m, members, joinedAfter);
}
/** تأكيدات المحادثة كلها: رقم الرسالة ← من أكّد · خريطة واحدة للعرض */
export function acksOf(db: DB, threadId: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of stateRows(db, threadId, 'ack')) {
    const m = String(r.data.m ?? '');
    (out[m] ??= []).push(String(r.data.by ?? ''));
  }
  return out;
}
/** من أكّد ومن لم يؤكّد: غير مرسله، وبلا من انضم بعد الإعلان في «من لحظة انضمامه» */
export function ackersFrom(acks: Record<string, string[]>, m: { id: string; sender: string; serverTs: string | null }, members: string[],
  joinedAfter: Record<string, string> = {}): { acked: string[]; pending: string[] } {
  const by = new Set(acks[m.id] ?? []);
  const others = members.filter((u) => u !== m.sender
    && !(joinedAfter[u] && m.serverTs && !tsGte(m.serverTs, joinedAfter[u])));
  return { acked: others.filter((u) => by.has(u)), pending: others.filter((u) => !by.has(u)) };
}

/** رسائل عُدِّلت في الخادم بعد ما على الجهاز · من إشارات التعديل في الحال */
/**
 * تعديلٌ لا يحق لي جلبه (قبل انضمامي): رقمه «معروف» (evk) فلا يُطلب كل دورة، ورقم العرض (ev) ونصه كما كانا ·
 * فلا تُوسم «معدَّلة» بلا سجل يُقرأ · وإن جاء تعديلٌ أحدث يُطلب
 */
export function markEditUnreadable(db: DB, threadId: string, msgId: string): void {
  const n = stateRows(db, threadId, 'edit').find((r) => r.data.m === msgId)?.data.n;
  const local = db.get<{ x: string | null }>(`SELECT x FROM chat_messages WHERE id = ?`, [msgId]);
  if (!local || typeof n !== 'number') return;
  db.run(`UPDATE chat_messages SET x = ? WHERE id = ?`, [extraJson({ ...extraOf(local.x), evk: n }), msgId]);
}

export function staleEdits(db: DB, threadId: string): string[] {
  return stateRows(db, threadId, 'edit').filter((r) => {
    const local = db.get<{ x: string | null }>(`SELECT x FROM chat_messages WHERE id = ?`, [String(r.data.m ?? '')]);
    const e = extraOf(local?.x);
    return !!local && Number(r.data.n ?? 0) > Math.max(Number(e.ev ?? 0) || 0, Number(e.evk ?? 0) || 0);
  }).map((r) => String(r.data.m));
}

/**
 * البحث في محادثاتي على الجهاز: بالنص، والشخص، والتاريخ (من وإلى، بتوقيت الجهاز YYYY-MM-DD)، والوسم ·
 * onlyMine للمالك (قائمته محادثاته وحدها)
 */
export interface ChatSearch { text?: string; sender?: string; from?: string; to?: string; tag?: ChatTag | null }
const AR_DIGITS = /[٠-٩۰-۹]/g;
/** الأرقام العربية والفارسية إلى لاتينية · فالتاريخ المكتوب بها يُقرأ */
export const latinDigits = (s: string) => s.replace(AR_DIGITS, (c) => String((c.charCodeAt(0) & 0xf) % 10));

export function searchMessages(db: DB, me: string, q: ChatSearch, onlyMine = false, limit = 500): ChatMessage[] {
  const threads = listThreads(db, me, onlyMine).map((t) => t.id);
  if (!threads.length) return [];
  const text = (q.text ?? '').trim().toLowerCase();
  // حدود اليوم بتوقيت الجهاز إلى وقت الخادم · فالتصفية في الاستعلام قبل الحد لا بعده
  const bound = (d: string | undefined, end: boolean): string | null => {
    const v = latinDigits(d ?? '').trim();
    if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(v)) return null;
    const [y, mo, da] = v.split(/[-/]/).map(Number);
    const day = new Date(y, mo - 1, da);
    if (day.getFullYear() !== y || day.getMonth() !== mo - 1 || day.getDate() !== da) return null;
    const t = new Date(y, mo - 1, da + (end ? 1 : 0));
    return t.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');
  };
  const from = bound(q.from, false);
  const to = bound(q.to, true);
  const where = ['sys IS NULL', `thread_id IN (${threads.map(() => '?').join(',')})`];
  const args: SqlValue[] = [...threads];
  if (q.sender) { where.push('sender = ?'); args.push(q.sender); }
  if (from) { where.push('COALESCE(server_ts, local_at) >= ?'); args.push(from); }
  if (to) { where.push('COALESCE(server_ts, local_at) < ?'); args.push(to); }
  if (q.tag) { where.push(`x LIKE ?`); args.push('%"tag":"' + q.tag + '"%'); }
  return db.all<MsgRow>(`SELECT * FROM chat_messages WHERE ${where.join(' AND ')} ORDER BY COALESCE(server_ts, local_at) DESC`, args).map(msgOf)
    .filter((m) => (!q.tag || m.tag === q.tag)
      && (!text || m.body.toLowerCase().includes(text) || (m.link?.label ?? '').toLowerCase().includes(text)))
    .slice(0, limit);
}

/* ─── الدفعة ٥ (قرار المالك 2026-10-08T05:31Z): المهام والاستطلاعات ─── */

export interface TaskRow extends ChatTask { threadId: string; msgId: string; by: string; /** ملغاة (قرار المالك 2026-10-08T10:24Z) */ cx: boolean }

/** مهام المحادثة: رقم الرسالة ← مهمتها */
export function tasksIn(db: DB, threadId: string): Record<string, TaskRow> {
  const out: Record<string, TaskRow> = {};
  for (const r of stateRows(db, threadId, 'task')) {
    const d = r.data;
    out[String(d.m)] = { threadId, msgId: String(d.m), title: String(d.title ?? ''), as: String(d.as ?? ''), due: String(d.due ?? ''),
      done: d.done === true, by: String(d.by ?? ''), cx: d.cx === true };
  }
  return out;
}

/** مهامي: ما أنا مسؤوله في محادثاتي · غير المنجز أولاً بموعده */
export function myTasks(db: DB, me: string, onlyMine = false): TaskRow[] {
  const out: TaskRow[] = [];
  for (const t of listThreads(db, me, onlyMine)) for (const task of Object.values(tasksIn(db, t.id))) if (task.as === me) out.push(task);
  // المفتوحة أولاً بموعدها، ثم المنجزة، ثم الملغاة
  const rank = (x: TaskRow) => (x.cx ? 2 : x.done ? 1 : 0);
  return out.sort((a, b) => (rank(a) - rank(b)) || a.due.localeCompare(b.due));
}

/** نتيجة الاستطلاع: عدد كل خيار، ومن صوّت، واختياري أنا */
export function pollResults(db: DB, threadId: string, msgId: string, options: number, me: string): { counts: number[]; voters: number; mine: number[] } {
  const counts = Array.from({ length: options }, () => 0);
  let voters = 0;
  let mine: number[] = [];
  for (const r of stateRows(db, threadId, 'vote')) {
    if (r.data.m !== msgId) continue;
    const o = (Array.isArray(r.data.o) ? r.data.o : []).map(Number).filter((i) => i >= 0 && i < options);
    if (!o.length) continue;
    voters++;
    for (const i of o) counts[i]++;
    if (r.data.by === me) mine = o;
  }
  return { counts, voters, mine };
}

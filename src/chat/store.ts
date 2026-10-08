/**
 * مخزن المحادثة على الجهاز (الهجرة ٣٤) · ما يُكتب بلا اتصال يبقى «لم يُرسل» حتى تُرفع · ولا حذف للرسائل.
 */
import type { DB } from '../db/adapter';
import { uid as newId } from '../domain/ids';
import {
  CHAT_BODY_MAX, CHAT_GROUP_MAX, CHAT_NAME_MAX, directId,
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
  last_ts: string | null; last_body: string; read_ts: string | null; pending: number; unread: number;
}

const threadOf = (r: ThreadRow): ChatThread => ({
  id: r.id, kind: r.kind, name: r.name, members: parseList(r.members), createdBy: r.created_by,
  createdAt: r.created_at, lastTs: r.last_ts, lastBody: r.last_body, unread: Number(r.unread || 0), pending: !!r.pending,
  rejected: Number(r.pending) === 2,
});

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

/** مجموعة جديدة · المالك والمشرفون وحدهم (تفحصه الواجهة وقواعد الخادم) */
export function createGroup(db: DB, me: string, name: string, members: string[]): string {
  const n = name.trim().slice(0, CHAT_NAME_MAX);
  if (!n) throw new Error('chat: group name');
  const all = Array.from(new Set([me, ...members.filter(Boolean)])).sort();
  if (all.length < 2) throw new Error('chat: group needs members');
  if (all.length > CHAT_GROUP_MAX) throw new Error('chat: group too large');
  const id = 'g_' + newId();
  db.run(
    `INSERT INTO chat_threads (id, kind, name, members, created_by, created_at, pending)
     VALUES (?, 'group', ?, ?, ?, ?, 1)`, [id, n, JSON.stringify(all), me, nowIso()]);
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
  local_at: string; server_ts: string | null; sent: number; sys: string | null;
}

const msgOf = (r: MsgRow): ChatMessage => ({
  id: r.id, threadId: r.thread_id, sender: r.sender, senderName: r.sender_name, body: r.body,
  link: r.link_type && r.link_id ? { type: r.link_type as ChatLink['type'], id: r.link_id, label: r.link_label ?? '' } : null,
  localAt: r.local_at, serverTs: r.server_ts, sent: Number(r.sent) === 1, rejected: Number(r.sent) === -1, sys: r.sys ?? null,
});

/** رسائل محادثة بترتيب وقوعها · وقت الخادم للمرسَل، ووقت الكتابة لما ينتظر */
export function listMessages(db: DB, threadId: string): ChatMessage[] {
  return db.all<MsgRow>(
    `SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY COALESCE(server_ts, local_at), local_at`, [threadId]).map(msgOf);
}

/** رسالة جديدة · تُحفظ على الجهاز فوراً «لم تُرسل» وتُرفع في المزامنة */
export function sendLocal(db: DB, threadId: string, me: { uid: string; name: string }, body: string, link: ChatLink | null = null): string {
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
      `INSERT INTO chat_messages (id, thread_id, sender, sender_name, body, link_type, link_id, link_label, local_at, sent)
       VALUES (?,?,?,?,?,?,?,?,?,0)`,
      [id, threadId, me.uid, me.name, text, link?.type ?? null, link?.id ?? null, link?.label ?? null, at]);
    db.run(`UPDATE chat_threads SET last_ts = ?, last_body = ?, read_ts = ? WHERE id = ?`, [at, text || link!.label, at, threadId]);
  });
  return id;
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

export function applyRemoteThread(db: DB, t: { id: string; k: ChatKind; p: string[]; name: string; by: string; at: string | null }): void {
  db.run(
    `INSERT INTO chat_threads (id, kind, name, members, created_by, created_at, pending)
     VALUES (?,?,?,?,?,?,0)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, members = excluded.members,
       created_by = excluded.created_by, created_at = COALESCE(chat_threads.created_at, excluded.created_at), pending = 0`,
    [t.id, t.k, t.name, JSON.stringify([...t.p].sort()), t.by, t.at]);
}

export function applyRemoteMessage(db: DB, threadId: string, m: { id: string; from: string; name: string; body: string; link: ChatLink | null; ts: string; sys?: string | null }): void {
  db.transaction(() => {
    const had = db.get(`SELECT 1 FROM chat_messages WHERE id = ?`, [m.id]);
    if (had) db.run(`UPDATE chat_messages SET sent = 1, server_ts = ? WHERE id = ?`, [m.ts, m.id]);
    else db.run(
      `INSERT INTO chat_messages (id, thread_id, sender, sender_name, body, link_type, link_id, link_label, local_at, server_ts, sent, sys)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
      [m.id, threadId, m.from, m.name, m.body, m.link?.type ?? null, m.link?.id ?? null, m.link?.label ?? null, m.ts, m.ts, m.sys ?? null]);
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

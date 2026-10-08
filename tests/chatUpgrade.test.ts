/**
 * دمج المحادثة (قرار المالك 2026-10-08T10:24Z): الهجرات ٣٤ فما بعدها على قاعدة فيها بيانات ·
 * قاعدة بإصدار ٣٣ (ما قبل المحادثة) وبإصدارات المحادثة الوسطى، ببيانات اصطناعية في الدفتر وفي المحادثة،
 * تترقّى إلى الأحدث فلا يتغيّر صف ولا مبلغ · والمحادثة تعمل بعدها · وجداولها خارج المزامنة العامة ولو شُغّل الالتقاط.
 */
import { SCHEMA_VERSION } from '@/db/schema';
import { migrate, currentSchemaVersion } from '@/db/migrations';
import { seed } from '@/db/seed';
import { semanticIssues } from '@/domain/backup/semantic';
import { integrityChecks } from '@/domain/accounting/integrity';
import { setCapture } from '@/sync/engine';
import { SYNC_TABLES } from '@/db/syncTables';
import { listThreads, listMessages, sendLocal, getDraft, pinnedIds } from '@/chat/store';
import type { DB } from '@/db/adapter';
import { schemaAt, fill, snapshot } from './helpers/oldSchema';

const outbox = (db: DB) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_outbox`)!.n);
const chatRows = (db: DB) => ({
  threads: db.all(`SELECT id, kind, name, members, created_by, last_ts, last_body, msg_cursor, pending FROM chat_threads ORDER BY id`),
  msgs: db.all(`SELECT id, thread_id, sender, sender_name, body, link_type, link_id, link_label, local_at, server_ts, sent FROM chat_messages ORDER BY id`),
  people: db.all(`SELECT uid, name, sup FROM chat_people ORDER BY uid`),
});

/** بيانات محادثة اصطناعية بأعمدة الهجرة ٣٤ وحدها */
function fillChat(db: DB, v: number): void {
  db.run(`INSERT INTO chat_threads (id,kind,name,members,created_by,created_at,last_ts,last_body,msg_cursor,pending)
    VALUES ('d_u-a_u-b','direct','','["u-a","u-b"]','u-a','2026-01-01T00:00:00.000000000Z','2026-01-02T00:00:00.000000000Z','ثانية','2026-01-02T00:00:00.000000000Z',0),
           ('g_x','group','مجموعة مخترعة','["u-a","u-b","u-c"]','u-a',NULL,NULL,'',NULL,1)`);
  db.run(`INSERT INTO chat_messages (id,thread_id,sender,sender_name,body,link_type,link_id,link_label,local_at,server_ts,sent)
    VALUES ('m1','d_u-a_u-b','u-a','عضو أ','أولى','contract','C1','عقد مخترع','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000000000Z',1),
           ('m2','d_u-a_u-b','u-b','عضو ب','ثانية',NULL,NULL,NULL,'2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000000000Z',1),
           ('m3','g_x','u-a','عضو أ','لم تُرسل',NULL,NULL,NULL,'2026-01-03T00:00:00.000Z',NULL,0)`);
  db.run(`INSERT INTO chat_people (uid,name,sup,updated_at) VALUES ('u-b','عضو ب','[]','x')`);
  if (v >= 35) db.run(`UPDATE chat_messages SET sys = NULL WHERE id = 'm1'`);
  if (v >= 36) db.run(`UPDATE chat_threads SET meta = '{"s":{"h":"join"}}' WHERE id = 'g_x'`);
}

test.each([33, 34, 35, 36])('قاعدة الإصدار %i ببيانات الدفتر والمحادثة تترقّى إلى الأحدث سليمةً', (v) => {
  const db = schemaAt(':memory:', v);
  fill(db);
  if (v >= 34) fillChat(db, v);
  const before = snapshot(db);
  const chatBefore = v >= 34 ? chatRows(db) : null;

  migrate(db);
  seed(db);

  expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(SCHEMA_VERSION).toBe(38);
  // الهجرة ٣٨: نوع الفاتورة بافتراضٍ لكل صفٍّ قائم، وجدول الإقرارات المقدَّمة فارغ
  expect(db.get<{ d: string }>(`SELECT dflt_value AS d FROM pragma_table_info('invoices') WHERE name = 'kind'`)!.d).toBe("'invoice'");
  expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM vat_filings`)!.n).toBe(0);
  expect(snapshot(db)).toEqual(before);
  expect(semanticIssues(db)).toEqual([]);
  expect(integrityChecks(db).filter((c) => !c.ok)).toEqual([]);
  expect(db.all(`PRAGMA foreign_key_check`)).toEqual([]);
  if (chatBefore) {
    // صفوف المحادثة كما هي، والأعمدة الجديدة بقيمها الافتراضية
    expect(chatRows(db)).toEqual(chatBefore);
    expect(db.all(`SELECT id, draft, st_cursor FROM chat_threads ORDER BY id`)).toEqual([
      { id: 'd_u-a_u-b', draft: '', st_cursor: null }, { id: 'g_x', draft: '', st_cursor: null }]);
    expect(db.get<{ meta: string }>(`SELECT meta FROM chat_threads WHERE id = 'd_u-a_u-b'`)!.meta).toBe('{}');
    if (v >= 36) expect(db.get<{ meta: string }>(`SELECT meta FROM chat_threads WHERE id = 'g_x'`)!.meta).toBe('{"s":{"h":"join"}}');
    expect(db.all(`SELECT id, sys, x FROM chat_messages ORDER BY id`)).toEqual([
      { id: 'm1', sys: null, x: null }, { id: 'm2', sys: null, x: null }, { id: 'm3', sys: null, x: null }]);
    // والمحادثة تعمل على ما رُقّي
    expect(listThreads(db, 'u-a').map((t) => t.id).sort()).toEqual(['d_u-a_u-b', 'g_x']);
    expect(listMessages(db, 'd_u-a_u-b').map((m) => m.body)).toEqual(['أولى', 'ثانية']);
    expect(getDraft(db, 'g_x')).toBe('');
    expect(pinnedIds(db, 'g_x')).toEqual([]);
    expect(() => db.run(`DELETE FROM chat_messages WHERE id = 'm1'`)).toThrow('chat message is permanent');
  }

  // تداخل المزامنتين: جداول المحادثة لا تدخل المزامنة العامة ولا محفّزات التقاطها، ولو شُغّل الالتقاط
  expect(SYNC_TABLES.map((t) => t.name).filter((n) => n.startsWith('chat_'))).toEqual([]);
  expect(db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'chat\\_%' ESCAPE '\\'`).map((t) => t.name))
    .toEqual(['trg_chat_msg_no_delete']);
  setCapture(db, true);
  const n0 = outbox(db);
  const tid = 'd_u-a_u-b';
  if (v < 34) db.run(`INSERT INTO chat_threads (id,kind,members,created_by) VALUES ('d_u-a_u-b','direct','["u-a","u-b"]','u-a')`);
  sendLocal(db, tid, { uid: 'u-a', name: 'عضو أ' }, 'بعد الترقية');
  db.run(`INSERT INTO chat_state (thread_id,id,k,data,ts) VALUES (?,?,?,?,?)`, [tid, 'p_m1', 'pin', '{}', '2026-01-04T00:00:00.000000000Z']);
  db.run(`UPDATE chat_threads SET draft = 'مسودة', meta = '{"a":[]}' WHERE id = ?`, [tid]);
  expect(outbox(db)).toBe(n0);
  // والالتقاط العام يعمل بعدها كما كان
  db.run(`UPDATE tenants SET name = 'مستأجر معدَّل' WHERE id = (SELECT id FROM tenants LIMIT 1)`);
  expect(outbox(db)).toBeGreaterThan(n0);
  db.close();
});

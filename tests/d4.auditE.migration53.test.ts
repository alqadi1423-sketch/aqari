/**
 * مدقق خارجي (هـ) · الجولة الثالثة · الهجرة ٥٣ على قاعدةٍ جرت عليها الهجرة ٥٢ القديمة (825f162، بلا شرط j.type) · بيانات مصطنعة ·
 * ما صمد: المحفّزات تُستبدل، والإدراج والتحديث (ON CONFLICT) وقلب del بحمولاتٍ مشوّهة لا ترمي، والجدول يطابق المسح المحروس.
 */
import { openNodeDb } from '@/db/nodeAdapter';
import { MIGRATIONS, SCHEMA_VERSION } from '@/db/schema';
import { migrate, currentSchemaVersion } from '@/db/migrations';
import { stageInbox } from '@/sync/engine';
import type { RemoteDoc } from '@/sync/types';

const OLD_52 = `
CREATE TABLE IF NOT EXISTS sync_inbox_lines (line_id TEXT NOT NULL, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_inbox_lines_line ON sync_inbox_lines(line_id);
CREATE INDEX IF NOT EXISTS ix_inbox_lines_doc ON sync_inbox_lines(doc);
CREATE TRIGGER IF NOT EXISTS trg_inbox_lines_ins AFTER INSERT ON sync_inbox
WHEN NEW.tbl = 'journal_entries' AND NEW.del = 0
BEGIN
  INSERT INTO sync_inbox_lines (line_id, doc)
    SELECT json_extract(j.value, '$.id'), NEW.doc FROM json_each(NEW.payload, '$.lines') j WHERE json_extract(j.value, '$.id') IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_inbox_lines_upd AFTER UPDATE OF payload, del ON sync_inbox
WHEN NEW.tbl = 'journal_entries' OR OLD.tbl = 'journal_entries'
BEGIN
  DELETE FROM sync_inbox_lines WHERE doc = OLD.doc;
  INSERT INTO sync_inbox_lines (line_id, doc)
    SELECT json_extract(j.value, '$.id'), NEW.doc FROM json_each(NEW.payload, '$.lines') j
    WHERE NEW.tbl = 'journal_entries' AND NEW.del = 0 AND json_extract(j.value, '$.id') IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_inbox_lines_del AFTER DELETE ON sync_inbox
WHEN OLD.tbl = 'journal_entries'
BEGIN
  DELETE FROM sync_inbox_lines WHERE doc = OLD.doc;
END;
DELETE FROM sync_inbox_lines;
INSERT INTO sync_inbox_lines (line_id, doc)
  SELECT json_extract(j.value, '$.id'), i.doc FROM sync_inbox i, json_each(i.payload, '$.lines') j
  WHERE i.tbl = 'journal_entries' AND i.del = 0 AND json_extract(j.value, '$.id') IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_je_reversed_by ON journal_entries(reversed_by) WHERE reversed_by IS NOT NULL;
`;

describe('مدقق هـ · الهجرة ٥٣ بعد ٥٢ القديمة', () => {
  test('٥١ ← ٥٢ القديمة ← migrate: الإصدار ٥٣، والمحفّزات محروسة', () => {
    const db = openNodeDb(':memory:');
    db.exec('PRAGMA foreign_keys = OFF');
    for (let i = 0; i < 51; i++) db.exec(MIGRATIONS[i]);
    db.exec(OLD_52);
    db.exec('PRAGMA user_version = 52');
    db.exec('PRAGMA foreign_keys = ON');
    // مستندٌ سليم في الصندوق قبل الترقية
    stageInbox(db, [{ id: 'journal_entries__m-ok', t: 'journal_entries', k: 'm-ok', del: false, u: '2026-11-01T00:00:00.000Z', dev: 'x',
      d: { id: 'm-ok', no: 'MO-1', status: 'مسودة' }, lines: [{ id: 'm-ok-l0', entry_id: 'm-ok' }] } as RemoteDoc]);
    migrate(db);
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
    const doc = (k: string, lines: unknown, u: string, del = false): RemoteDoc => ({ id: 'journal_entries__' + k, t: 'journal_entries', k, del, u, dev: 'x',
      d: del ? undefined : { id: k, no: 'N-' + k, status: 'مسودة' }, lines: del ? undefined : lines } as unknown as RemoteDoc);
    const scan = () => db.all<{ l: string; d: string }>(`SELECT json_extract(j.value, '$.id') AS l, i.doc AS d FROM sync_inbox i, json_each(i.payload, '$.lines') j
      WHERE i.tbl = 'journal_entries' AND i.del = 0 AND j.type = 'object' AND json_extract(j.value, '$.id') IS NOT NULL ORDER BY l, d`);
    const table = () => db.all<{ l: string; d: string }>(`SELECT line_id AS l, doc AS d FROM sync_inbox_lines ORDER BY l, d`);
    const steps: Array<() => void> = [
      () => stageInbox(db, [doc('e1', ['x', null, 3, [1], { id: 'a1' }], '2026-11-01T00:00:01.000Z')]),
      () => stageInbox(db, [doc('e1', ['y', { id: 'a2' }, { id: { n: 1 } }], '2026-11-01T00:00:02.000Z')]),
      () => stageInbox(db, [doc('e1', [], '2026-11-01T00:00:03.000Z', true)]),
      () => stageInbox(db, [doc('e1', ['{"id":"fake"}', { id: 'a3' }], '2026-11-01T00:00:04.000Z')]),
      () => stageInbox(db, [doc('e2', 'not-a-list', '2026-11-01T00:00:05.000Z')]),
      () => db.run(`DELETE FROM sync_inbox WHERE pk = 'e1'`),
    ];
    for (const st of steps) { st(); expect(table()).toEqual(scan()); }
    expect(table()).toEqual([{ l: 'm-ok-l0', d: 'journal_entries__m-ok' }]);
    db.close();
  });
});

/**
 * التحقق المستقل من 21ff082 (القاعدة ٣٥) · ما وجده يُصلح (القاعدة ٩٦) · بيانات مصطنعة:
 *  ١. إعادة الوارد المرفوض بعد الترقية لما رُفض لسبب المخطط وحده، فلا يُرجَع صفٌّ أحدث إلى نسخته القديمة
 *  ٢. اسم العضو لا يكون «المالك» (يُنتحل به في سجل العمليات، وترفض القواعد سطوره)
 */
import { memDb } from './helpers/testDb';
import { replayRejectsAfterUpgrade } from '@/sync/engine';
import { validateProfile } from '@/domain/access/profile';
import { SCHEMA_VERSION } from '@/db/schema';

test('١ الوارد المرفوض لسببٍ غير المخطط لا يُعاد', () => {
  const db = memDb();
  const doc = (id: string) => JSON.stringify({ id: 'properties__' + id, t: 'properties', k: id, d: { id, name: 'قديم مصطنع', created_at: '2026-01-01' }, u: '2026-01-01T00:00:00.000Z', dev: 'D2', del: false });
  db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES ('properties__A', 'properties', 'A', 'الوارد مرفوض · مبلغ سالب', ?, '2026-01-03')`, [doc('A')]);
  db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES ('properties__B', 'properties', 'B', 'CHECK constraint failed: utility_type', ?, '2026-01-03')`, [doc('B')]);
  db.run(`INSERT INTO sync_rejects (doc, tbl, pk, reason, payload, at) VALUES ('properties__C', 'properties', 'C', 'table properties has no column named extra_col', ?, '2026-01-03')`, [doc('C')]);
  expect(replayRejectsAfterUpgrade(db, SCHEMA_VERSION)).toEqual({ requeued: 0, restaged: 2 });
  expect(db.all(`SELECT doc FROM sync_inbox ORDER BY doc`)).toEqual([{ doc: 'properties__B' }, { doc: 'properties__C' }]);
  expect(db.get(`SELECT doc FROM sync_rejects`)).toEqual({ doc: 'properties__A' });
  db.close();
});

test('٢ «المالك» لا يكون اسم عضو', () => {
  expect(validateProfile({ name: 'المالك', phone: '0500001023' }, true).ok).toBe(false);
  expect(validateProfile({ name: 'عضو مصطنع', phone: '0500001023' }, true).ok).toBe(true);
});

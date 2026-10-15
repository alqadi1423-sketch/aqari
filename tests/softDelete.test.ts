/**
 * قرار المالك 2026-10-15 «٨. حذف العضو في أقسامه: الحذف الناعم وحده للعضو» · قائمة جداول الحذف الناعم تطابق المخطط · وكنس
 * الملفات على جهاز العضو لا يحذف صفوفاً · بيانات مصطنعة.
 */
import { memDb } from './helpers/testDb';
import { SYNC_TABLES } from '@/db/syncTables';
import { SOFT_DELETE_TABLES } from '@/db/softDelete';
import { gcBlobs, putAttachment, softDeleteAttachment } from '@/files/store';
import { makeBackupEnv } from './helpers/backupEnv';
import { tempDir, rmrf } from './helpers/testDb';

test('قائمة جداول الحذف الناعم = جداول المزامنة التي فيها deleted_at', () => {
  const db = memDb();
  const actual = SYNC_TABLES.map((t) => t.name).filter((t) => db.all<{ name: string }>(`PRAGMA table_info("${t}")`).some((c) => c.name === 'deleted_at'));
  expect([...SOFT_DELETE_TABLES].sort()).toEqual(actual.sort());
  db.close();
});

test('كنس الملفات على جهاز العضو يحذف الملف وحده ولا يحذف صفّ المرفق نهائياً · وعلى جهاز المالك كما كان', async () => {
  for (const member of [true, false]) {
    const dir = tempDir('aq-gc8-');
    try {
      const env = makeBackupEnv(dir);
      const fe = { db: env.db, fs: env.fs, hasher: env.hasher!, attachmentsDir: env.attachmentsDir };
      const a = await putAttachment(fe, new Uint8Array([1, 2, 3, 4]), { entityType: 'library', entityId: 'L8', kind: 'ملف', originalName: 'ث.bin', mime: 'application/octet-stream' });
      softDeleteAttachment(env.db, a.id);
      env.db.run(`UPDATE attachments SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, [a.id]);
      if (member) env.db.run(`INSERT OR REPLACE INTO sync_state (k, v) VALUES ('membership', '{"org":"OWN8"}')`);
      gcBlobs(fe, 30);
      expect(!!env.db.get(`SELECT 1 FROM attachments WHERE id = ?`, [a.id])).toBe(member);
      expect(env.fs.exists(env.attachmentsDir + '/' + a.sha256 + '.bin')).toBe(false);
      env.closeLive();
    } finally { rmrf(dir); }
  }
});

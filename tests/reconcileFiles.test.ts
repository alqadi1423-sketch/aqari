/**
 * المتحقق المستقل، الجولة ٢٩ على النتيجة ١٣ · بيانات مصطنعة: جهاز المالك لا يحذف من التخزين ملفاً مرفقه وصل ولم يُطبَّق بعد
 * (ينتظر أباه في صندوق الوارد) · ويحذفه حين لا ينتظر شيء.
 */
import { memDb } from './helpers/testDb';
import { reconcileOwnerFiles, type FilesRemote } from '@/files/cloudFiles';
import type { StorageIO } from '@/cloud/storage';

jest.mock('@/services/cloud', () => ({}));

const SHA = 'a'.repeat(64);
function fakeStorage(): { remote: FilesRemote; deleted: string[] } {
  const deleted: string[] = [];
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  const json = (o: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
  const io = {
    fetch: async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') { deleted.push(url); return { ok: true, status: 204, text: async () => '' }; }
      if (url.includes('/o?')) return json({ items: [{ name: 'orgs/OWN13/files/' + SHA + '.jpg' }] });
      return json({ name: 'orgs/OWN13/files/' + SHA + '.jpg', size: 3, md5Hash: 'x', metadata: { g: 'contracts|@' }, timeCreated: old });
    },
  } as unknown as StorageIO;
  return {
    deleted,
    remote: { io, target: { base: 'http://fake', bucket: 'b', org: 'OWN13', idToken: async () => 't' }, access: { owner: true, uid: 'OWN13', perms: {}, allProps: true, props: [] } as never },
  };
}

test('١٣ (الجولة ٢٩) لا حذف وفي صندوق الوارد مرفقٌ ينتظر · ويُحذف حين لا ينتظر شيء', async () => {
  const db = memDb();
  db.run(`INSERT INTO sync_inbox (doc, tbl, pk, rank, payload, updated_at, device_id, attempts, last_error, del)
    VALUES ('attachments__X', 'attachments', 'X', 1, ?, '2026-01-01T00:00:00.000Z', 'dev', 0, NULL, 0)`, [JSON.stringify({ d: { sha256: SHA } })]);
  const a = fakeStorage();
  expect((await reconcileOwnerFiles(db, a.remote, { force: true })).deleted).toBe(0);
  expect(a.deleted).toEqual([]);
  db.run(`DELETE FROM sync_inbox`);
  // يُسجَّل وقت صيرورته بلا مرفق أولاً · ويُحذف بعد ٩٠ يوماً منه (قرار المالك 2026-10-15 «١٤»)
  const b = fakeStorage();
  expect((await reconcileOwnerFiles(db, b.remote, { force: true })).deleted).toBe(0);
  expect((await reconcileOwnerFiles(db, b.remote, { force: true, now: new Date(Date.now() + 91 * 86400000) })).deleted).toBe(1);
  db.close();
});

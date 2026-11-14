/**
 * المدقق المستقل · C-2 (الإصلاح المرحلي) · ملفٌ غاب عند بوابة الترقية لا يُسمّى عند استعادة نسخة ما قبل الترقية.
 *
 * الخطوات (بيانات مصطنعة · بنية الإصدار ١٦):
 * ١. مرفقان: «عقد.txt» على القرص، و«هوية.txt» صفّه في القاعدة وملفه غائب عن الجهاز.
 * ٢. بوابة الترقية: نسخة ما قبل الترقية تذكر «عقد.txt» في local_files، و«هوية.txt» في missing_files وحدها.
 * ٣. تُستعاد النسخة: prepareRestore يطابق local_files وحدها، فـ plan.localMissing فارغ، وحوار «النسخة صالحة» يقول
 *    «الملفات باقية على هذا الجهاز كما هي» (restore.localFiles) ولا سطر فيه عن «هوية.txt». فتعود البيانات بمرفقٍ لا ملف له
 *    ولا يُقال ذلك للمستخدم قبل التأكيد.
 *
 * السلوك الصحيح (مهمة C-2: «إن غاب ملفٌ مذكور فقل ذلك بوضوح بدل الفشل الصامت»): كل ملفٍ تذكره نسخة ما قبل الترقية
 * (في local_files أو في missing_files) ولا يوجد على الجهاز ببصمته عند الاستعادة يُسمّى باسمه في plan.localMissing قبل التأكيد،
 * ولا تمنع الاستعادة.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { openNodeDb } from '@/db/nodeAdapter';
import { nodeFs, nodeHasher } from '@/files/nodeFs';
import type { DB } from '@/db/adapter';
import type { BackupEnv } from '@/domain/backup/types';
import { verifyArchiveAt } from '@/domain/backup/create';
import { guardedUpgrade } from '@/domain/backup/upgrade';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { tempDir, rmrf } from './helpers/testDb';
import { schemaAt, fill, ins } from './helpers/oldSchema';

function oldEnv(root: string): BackupEnv & { live(): DB } {
  const dbPath = path.join(root, 'data.db').replace(/\\/g, '/');
  let db = schemaAt(dbPath, 16);
  fill(db);
  return {
    get db() { return db; },
    dbPath, fs: nodeFs, hasher: nodeHasher,
    attachmentsDir: path.join(root, 'attachments').replace(/\\/g, '/'),
    tmpDir: path.join(root, 'tmp').replace(/\\/g, '/'),
    appVersion: '1.0.0-test',
    openDb: (p) => openNodeDb(p),
    closeLive: () => { try { db.close(); } catch { /* مغلقة */ } },
    reopenLive: () => { db = openNodeDb(dbPath); return db; },
    live: () => db,
  };
}

let root: string;
beforeEach(() => { root = tempDir('aqari-r11c2-gone-'); });
afterEach(() => rmrf(root));

test('C-2 ملفٌ سمّته النسخة مفقوداً عند البوابة وما زال غائباً يُسمّى قبل تأكيد الاستعادة', async () => {
  const env = oldEnv(root);
  fs.mkdirSync(env.attachmentsDir, { recursive: true });
  const keep = new TextEncoder().encode('عقد إيجار مصطنع · باقٍ');
  const lost = new TextEncoder().encode('صورة هوية مصطنعة · غائبة');
  const keepSha = await nodeHasher(keep);
  const lostSha = await nodeHasher(lost);
  for (const [sha, bytes, name, onDisk] of [[keepSha, keep, 'عقد.txt', true], [lostSha, lost, 'هوية.txt', false]] as const) {
    if (onDisk) fs.writeFileSync(path.join(env.attachmentsDir, `${sha}.txt`), bytes);
    ins(env.db, 'blobs', { sha256: sha, ext: 'txt', size_bytes: bytes.byteLength, created_at: '2026-01-01' });
    ins(env.db, 'attachments', { id: 'A-' + sha.slice(0, 6), sha256: sha, entity_type: 'contract', entity_id: 'C1', kind: 'عقد', original_name: name, created_at: '2026-01-01' });
  }

  const { backupPath } = await guardedUpgrade(env);
  const { manifest } = await verifyArchiveAt(env, backupPath!);
  expect(manifest.missing_files).toEqual([`${lostSha}.txt`]);
  expect(manifest.local_files!.map((f) => f.sha256)).toEqual([keepSha]);

  const plan = await prepareRestore(env, backupPath!);
  // الاستعادة لا تُمنع · لكن الغائب يُسمّى باسمه قبل التأكيد
  expect(plan.localMissing).toEqual(['هوية.txt']);
  const res = await commitRestore(env, plan);
  expect(res.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments WHERE deleted_at IS NULL`)!.n).toBe(2);
  res.db.close();
});

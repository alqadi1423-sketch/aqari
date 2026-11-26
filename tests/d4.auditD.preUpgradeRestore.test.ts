/**
 * المدقق الخارجي D · الجولة الثانية · نسخة ما قبل الترقية التي نقصها مرفق (البند ٣) تُعرض في زر «استعادة» (البند ١٧) · فهل تُستعاد؟
 * بيانات مصطنعة · بنية الإصدار ١٦.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { openNodeDb } from '@/db/nodeAdapter';
import { nodeFs, nodeHasher } from '@/files/nodeFs';
import type { DB } from '@/db/adapter';
import type { BackupEnv } from '@/domain/backup/types';
import { guardedUpgrade } from '@/domain/backup/upgrade';
import { createBackup } from '@/domain/backup/create';
import { deviceBackups, deviceBackupPath } from '@/domain/backup/deviceBackups';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { tempDir, rmrf } from './helpers/testDb';
import { schemaAt, fill, ins } from './helpers/oldSchema';

function oldEnv(root: string, v: number): BackupEnv & { live(): DB } {
  const dbPath = path.join(root, 'data.db').replace(/\\/g, '/');
  let db = schemaAt(dbPath, v);
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
beforeEach(() => { root = tempDir('aqari-auditD-preup-'); });
afterEach(() => rmrf(root));

test('نسخة ما قبل الترقية بمرفقٍ مفقود تُختار من القائمة وتُستعاد', async () => {
  const env = oldEnv(root, 16);
  const keep = new TextEncoder().encode('مرفق باقٍ مصطنع');
  const lost = new TextEncoder().encode('مرفق سيُفقد مصطنع');
  fs.mkdirSync(env.attachmentsDir, { recursive: true });
  for (const [bytes, name, onDisk] of [[keep, 'باقٍ.txt', true], [lost, 'مفقود.txt', false]] as const) {
    const sha = await nodeHasher(bytes);
    if (onDisk) fs.writeFileSync(path.join(env.attachmentsDir, `${sha}.txt`), bytes);
    ins(env.db, 'blobs', { sha256: sha, ext: 'txt', size_bytes: bytes.byteLength, created_at: '2026-01-01' });
    ins(env.db, 'attachments', { id: 'A-' + sha.slice(0, 6), sha256: sha, entity_type: 'contract', entity_id: 'C1', kind: 'عقد', original_name: name, created_at: '2026-01-01' });
  }
  const { backupPath } = await guardedUpgrade(env);
  expect(backupPath).not.toBeNull();
  const [b] = deviceBackups(env);
  expect(b.kind).toBe('pre-upgrade');

  // كما يفعل prepareRestoreFromSafety: نسخٌ إلى المؤقت ثم مسار الاستعادة نفسه
  env.fs.mkdirp(env.tmpDir);
  const tmp = path.join(env.tmpDir, 'restore-input.aqbk').replace(/\\/g, '/');
  env.fs.write(tmp, env.fs.read(deviceBackupPath(env, b.name)!));
  let outcome: string;
  try {
    const plan = await prepareRestore(env, tmp);
    await commitRestore(env, plan);
    outcome = 'استُعيدت';
  } catch (e) {
    outcome = 'رُفضت: ' + (e as Error).message;
  }
  // وأي نسخةٍ تُصدَّر أو تُرفع بعد الترقية (createBackup بلا preUpgrade) تُرفض للسبب نفسه
  const exportOutcome = await createBackup(env, path.join(env.tmpDir, 'export.aqbk').replace(/\\/g, '/')).then(() => 'أُنشئت', (e: Error) => 'رُفضت: ' + e.message);
  // eslint-disable-next-line no-console
  console.log('استعادة نسخة ما قبل الترقية الناقصة:', outcome, '\nتصدير نسخةٍ بعد الترقية:', exportOutcome);
  expect(outcome).toBe('استُعيدت');
  env.live().close();
});

import * as path from 'node:path';
import { openNodeDb } from '@/db/nodeAdapter';
import { migrate } from '@/db/migrations';
import { seed } from '@/db/seed';
import { nodeFs, nodeHasher } from '@/files/nodeFs';
import { nodeCipher } from '@/files/nodeCipher';
import type { DB } from '@/db/adapter';
import type { BackupEnv } from '@/domain/backup/types';
import type { FilesEnv } from '@/files/store';

export interface TestBackupEnv extends BackupEnv {
  root: string;
  filesEnv: FilesEnv;
  /** القاعدة الحية الحالية (تتبدل بعد الاستعادة) */
  live(): DB;
}

/** بيئة نسخ احتياطي كاملة فوق مجلد — قاعدة مهاجَرة مزروعة + مخزن مرفقات */
export function makeBackupEnv(root: string): TestBackupEnv {
  const dbPath = path.join(root, 'data.db').replace(/\\/g, '/');
  const attachmentsDir = path.join(root, 'attachments').replace(/\\/g, '/');
  const tmpDir = path.join(root, 'tmp').replace(/\\/g, '/');
  let db = openNodeDb(dbPath);
  migrate(db);
  seed(db);

  const env: TestBackupEnv = {
    get db() { return db; },
    dbPath,
    fs: nodeFs,
    hasher: nodeHasher,
    cipher: nodeCipher,
    attachmentsDir,
    tmpDir,
    appVersion: '1.0.0-test',
    openDb: (p) => openNodeDb(p),
    closeLive: () => { try { db.close(); } catch { /* مغلقة */ } },
    reopenLive: () => { db = openNodeDb(dbPath); return db; },
    root,
    get filesEnv(): FilesEnv {
      return { db, fs: nodeFs, hasher: nodeHasher, attachmentsDir };
    },
    live: () => db,
  };
  return env;
}

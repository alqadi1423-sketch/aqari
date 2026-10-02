/** بيئة الملفات داخل التطبيق · القاعدة + القرص + وحدة التجزئة */
import type { DB } from '../db/adapter';
import type { FilesEnv } from '../files/store';
import { expoFs, expoHasher, appDataRoot } from '../files/expoFs';
import { joinPath } from '../files/fsAdapter';

export function appFilesEnv(db: DB): FilesEnv {
  return {
    db,
    fs: expoFs,
    hasher: expoHasher,
    attachmentsDir: joinPath(appDataRoot(), 'attachments'),
  };
}

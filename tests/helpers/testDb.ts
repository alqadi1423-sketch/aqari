import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openNodeDb } from '@/db/nodeAdapter';
import { migrate } from '@/db/migrations';
import { seed } from '@/db/seed';
import type { DB } from '@/db/adapter';

/** قاعدة اختبار في الذاكرة — مهاجَرة ومزروعة */
export function memDb(): DB {
  const db = openNodeDb(':memory:');
  migrate(db);
  seed(db);
  return db;
}

/** قاعدة اختبار على القرص داخل مجلد مؤقت (لاختبارات النسخ الاحتياطي) */
export function tempDir(prefix = 'aqari-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function fileDb(dir: string, name = 'data.db'): { db: DB; path: string } {
  const p = path.join(dir, name);
  const db = openNodeDb(p);
  migrate(db);
  seed(db);
  return { db, path: p };
}

export function rmrf(dir: string): void {
  // تنظيف فقط — على ويندوز قد تبقى مقابض SQLite مفتوحة حين يفشل اختبار قبل الإغلاق
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch { /* لا نفشل حزمة الاختبارات على تنظيف مجلد مؤقت */ }
}

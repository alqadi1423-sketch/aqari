/**
 * نسخة كل حساب على الجهاز (src/services/accountSlots.ts) · بالترتيب الذي جرى على جهاز المالك:
 * المالك يعمل ← يخرج ← يدخل حسابٌ آخر ← يعود المالك. لا يرث الآخر شيئاً، ولا يضيع للمالك شيء
 * ولا تغييرٌ في طابوره. بيانات مصطنعة.
 */
import * as path from 'node:path';
import { tempDir, rmrf } from './helpers/testDb';
import { openNodeDb } from '@/db/nodeAdapter';
import { migrate } from '@/db/migrations';
import { seed, ensureDeviceId } from '@/db/seed';
import { nodeFs } from '@/files/nodeFs';
import type { DB } from '@/db/adapter';
import { enableSync, outboxCount, getSyncState } from '@/sync/engine';
import { addProperty } from './helpers/fixtures';
import { switchTo, parkActive, restoreParked, activeAccount, hasParked, UNBOUND, type SlotEnv } from '@/services/accountSlots';

let dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

function makeEnv(): SlotEnv & { root: string } {
  const root = tempDir('aqari-slots-').replace(/\\/g, '/');
  dirs.push(root);
  nodeFs.mkdirp(root + '/SQLite');
  const dbFile = root + '/SQLite/aqari.db';
  let db: DB = openNodeDb(dbFile);
  const prepareFresh = (d: DB) => { migrate(d); seed(d); ensureDeviceId(d); };
  prepareFresh(db);
  return {
    fs: nodeFs, root, dbFile,
    db: () => db,
    close: () => { try { db.close(); } catch { /* مغلقة */ } },
    reopen: () => { db = openNodeDb(dbFile); migrate(db); },
    prepareFresh,
  };
}

const props = (db: DB) => db.all<{ name: string }>(`SELECT name FROM properties`).map((x) => x.name);

test('المالك ← حساب آخر ← المالك: لا يرث الآخر شيئاً ولا يضيع للمالك شيء', () => {
  const env = makeEnv();
  enableSync(env.db(), 'OWNER');
  addProperty(env.db(), { name: 'عقار المالك التجريبي' });
  nodeFs.mkdirp(path.join(env.root, 'attachments'));
  nodeFs.write(path.join(env.root, 'attachments', 'f1.bin').replace(/\\/g, '/'), new Uint8Array([1, 2, 3]));
  const pending = outboxCount(env.db());
  expect(pending).toBeGreaterThan(0); // تغييرات لم تُرفع

  // يدخل حسابٌ آخر على الجهاز نفسه
  expect(switchTo(env, 'OTHER')).toBe('switched');
  expect(activeAccount(env.db())).toBeNull(); // نسخة جديدة فارغة له
  expect(props(env.db())).toEqual([]);
  expect(nodeFs.exists(path.join(env.root, 'attachments', 'f1.bin').replace(/\\/g, '/'))).toBe(false);
  expect(hasParked(env, 'OWNER')).toBe(true);
  enableSync(env.db(), 'OTHER');
  addProperty(env.db(), { name: 'عقار الحساب الآخر' });

  // يعود المالك: نسخته كما تركها بطابورها ومرفقاتها
  expect(switchTo(env, 'OWNER')).toBe('switched');
  expect(activeAccount(env.db())).toBe('OWNER');
  expect(props(env.db())).toEqual(['عقار المالك التجريبي']);
  expect(outboxCount(env.db())).toBe(pending);
  expect(nodeFs.exists(path.join(env.root, 'attachments', 'f1.bin').replace(/\\/g, '/'))).toBe(true);
  // ونسخة الآخر مركونة مقفلة كما تركها
  expect(hasParked(env, 'OTHER')).toBe(true);
  expect(switchTo(env, 'OWNER')).toBe('ready');
});

test('الخروج يركن النسخة ويترك الجهاز فارغاً · والعودة تعيدها', () => {
  const env = makeEnv();
  enableSync(env.db(), 'OWNER');
  addProperty(env.db(), { name: 'عقار تجريبي' });
  parkActive(env, 'OWNER');
  expect(activeAccount(env.db())).toBeNull();
  expect(props(env.db())).toEqual([]);
  expect(restoreParked(env, 'OWNER')).toBe(true);
  expect(props(env.db())).toEqual(['عقار تجريبي']);
  expect(getSyncState(env.db(), 'uid')).toBe('OWNER');
});

test('بيانات بلا حساب لا تُعطى لداخلٍ تلقائياً · وتُركن باسمها إن لم يربطها', () => {
  const env = makeEnv();
  addProperty(env.db(), { name: 'عقار بلا حساب' });
  expect(switchTo(env, 'SOMEONE')).toBe('unbound');
  expect(props(env.db())).toEqual(['عقار بلا حساب']); // لم يُنقل ولم يُمسح
  parkActive(env, UNBOUND);
  expect(restoreParked(env, 'SOMEONE')).toBe(false);
  expect(props(env.db())).toEqual([]);
  expect(hasParked(env, UNBOUND)).toBe(true);
});

test('لا يُكتب فوق نسخة نشطة فيها بيانات ولا فوق نسخة مركونة', () => {
  const env = makeEnv();
  enableSync(env.db(), 'A');
  parkActive(env, 'A');
  addProperty(env.db(), { name: 'بيانات بلا حساب' });
  expect(() => restoreParked(env, 'A')).toThrow();
  enableSync(env.db(), 'A');
  expect(() => parkActive(env, 'A')).toThrow();
});

/**
 * أُصلح في الجولة نفسها (D١): السرّ وعلامته باسم الحساب، والخدمات تمرّر الحساب الداخل.
 * المدقق الخارجي D · الجولة الثانية · مفتاح الاسترداد للجهاز لا للحساب.
 *
 * قرار المالك 2026-11-07 «تشفير النسخ الاحتياطي إجبارياً مع مفتاح استرداد يظهر مرة»: من تُشفَّر نسخه بالمفتاح يجب أن يكون قد رآه.
 * والتطبيق يدعم أكثر من حسابٍ على الجهاز (accountSlots.ts: «البيانات ملك الحساب لا الجهاز»، تُركن نسخة الحساب A عند دخول B).
 * لكن السرّ مخزّنٌ بمفتاحٍ ثابت في SecureStore (backupPassword.ts: KEY = 'aqari_backup_password') وعلامته في جذر ملفات التطبيق
 * (backup-password.flag) خارج ما يُركن (ITEMS = attachments, thumbs, backups) · فالحساب B يرث مفتاح A الذي لم يره قط:
 * تُختم نسخه (التصدير وDrive حسابه هو) بمفتاح A، وتقول له الإعدادات «محفوظ على هذا الجهاز» فلا يُدعى لإنشاء مفتاحه.
 * بيانات مصطنعة · القرص مجلد مؤقت، والمخزن الآمن في الذاكرة.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const kv = new Map<string, string>();
const disk = { root: '' };

jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => kv.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { kv.set(k, v); },
  deleteItemAsync: async (k: string) => { kv.delete(k); },
}));
// File(Paths.document, name) على القرص الحقيقي في جذر بيانات التطبيق المؤقت
jest.mock('expo-file-system', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nfs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const np = require('node:path');
  class F {
    p: string;
    constructor(dir: { root?: string } | string, name: string) { this.p = np.join(typeof dir === 'string' ? dir : disk.root, name); }
    get exists() { return nfs.existsSync(this.p); }
    write(s: string) { nfs.writeFileSync(this.p, s); }
    delete() { nfs.rmSync(this.p); }
    textSync() { return nfs.readFileSync(this.p, 'utf8'); }
  }
  return { File: F, Paths: { get document() { return disk.root; } } };
});
jest.mock('expo-crypto', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getRandomBytes: (n: number) => new Uint8Array(require('node:crypto').randomBytes(n)),
}));

import { tempDir, rmrf } from './helpers/testDb';
import { openNodeDb } from '@/db/nodeAdapter';
import { migrate } from '@/db/migrations';
import { seed as seedDb, ensureDeviceId } from '@/db/seed';
import { nodeFs } from '@/files/nodeFs';
import { enableSync } from '@/sync/engine';
import { addProperty } from './helpers/fixtures';
import { switchTo, activeAccount, type SlotEnv } from '@/services/accountSlots';
import { newRecoveryKey, saveRecoveryKey, backupSecretKind, backupSecretForSealing } from '@/services/backupPassword';
import { sealingSecretOf } from '@/domain/backup/recoveryKey';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

function makeEnv(): SlotEnv {
  const root = tempDir('aqari-auditD-slots-').replace(/\\/g, '/');
  dirs.push(root);
  disk.root = root;
  nodeFs.mkdirp(root + '/SQLite');
  const dbFile = root + '/SQLite/aqari.db';
  let conn: DB = openNodeDb(dbFile);
  const db = new Proxy({} as DB, {
    get: (_t, k) => {
      const v = (conn as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(conn) : v;
    },
  });
  const prepareFresh = (d: DB) => { migrate(d); seedDb(d); ensureDeviceId(d); };
  prepareFresh(db);
  return {
    fs: nodeFs, root, dbFile,
    db: () => db,
    close: () => { try { conn.close(); } catch { /* مغلقة */ } },
    reopen: () => { conn = openNodeDb(dbFile); migrate(db); },
    prepareFresh,
  };
}

test('الحساب B الداخل بعد A لا يرث مفتاح استرداد A الذي لم يره (نسخ B تُختم بسرٍّ لا يعرفه)', async () => {
  const env = makeEnv();
  const db = env.db();
  // الحساب A: بياناته ومفتاحه الذي عُرض عليه وأكّده
  enableSync(db, 'ACC-A');
  addProperty(db, { name: 'عقار الحساب أ المصطنع' });
  const keyA = newRecoveryKey();
  await saveRecoveryKey(keyA, 'ACC-A');
  expect(await backupSecretKind('ACC-A')).toBe('key');

  // يدخل B على الجهاز نفسه: تُركن نسخة A وتُفتح نسخة B الجديدة
  expect(switchTo(env, 'ACC-B')).toBe('switched');
  enableSync(db, 'ACC-B');
  expect(activeAccount(db)).toBe('ACC-B');
  // علامة السرّ بقيت في الجذر ولم تُركن مع A
  const flagInRoot = fs.existsSync(path.join(env.root, 'backup-password.flag'));

  const kindForB = await backupSecretKind(activeAccount(db));
  const sealingForB = await backupSecretForSealing(activeAccount(db)).catch((e: Error) => e.name);
  // eslint-disable-next-line no-console
  console.log('B يرى حال المفتاح:', kindForB, '· علامة السرّ في الجذر:', flagInRoot,
    '· سرّ ختم نسخ B هو مفتاح A:', sealingForB === sealingOf(keyA));

  // المتوقع: B لم يُعرض عليه مفتاح، فلا تُختم نسخه بمفتاح غيره · يُطلب منه إنشاء مفتاحه (RecoveryKeyRequiredError)
  expect(sealingForB).not.toBe(sealingSecretOf(keyA));
  expect(kindForB).not.toBe('key');
  expect(sealingForB).toBe('RecoveryKeyRequiredError');
  // ويعود A فيجد مفتاحه
  expect(await backupSecretForSealing('ACC-A')).toBe(sealingSecretOf(keyA));
  env.close();
});

const sealingOf = (k: string) => sealingSecretOf(k);

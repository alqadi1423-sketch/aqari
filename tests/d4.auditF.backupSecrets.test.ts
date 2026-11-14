/**
 * المدقق الخارجي F · الجولة الثالثة · سرّ النسخ لكل حساب (D١) والأسرار السابقة (D٢) كما هي في 1f21568.
 * قرار المالك 2026-11-07 «تشفير النسخ الاحتياطي إجبارياً مع مفتاح استرداد يظهر مرة»: لا تُختم نسخة حسابٍ بسرٍّ لم يره صاحبه (D١)،
 * والنسخ القديمة تبقى تُستعاد · وورقة «مفتاح جديد» تَعِد: «والنسخ السابقة تُفتح على هذا الجهاز تلقائياً» (ar.json: backup.key.replaceBody).
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
import { newRecoveryKey, saveRecoveryKey, backupSecretKind, backupSecretForSealing, getBackupPasswords } from '@/services/backupPassword';
import { sealingSecretOf } from '@/domain/backup/recoveryKey';
import type { DB } from '@/db/adapter';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

function makeEnv(): SlotEnv {
  const root = tempDir('aqari-auditF-slots-').replace(/\\/g, '/');
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

beforeEach(() => { kv.clear(); });

test('F6 · السرّ القديم للجهاز يأخذه الحساب الداخل ساعة التحديث ولو لم يضعه: B يختم نسخه بكلمة A، وA يفقد سرّه', async () => {
  const env = makeEnv();
  const db = env.db();
  // قبل 1f21568: الحساب A وضع كلمة مرور النسخ (السرّ الواحد للجهاز · KEY = 'aqari_backup_password' وعلامته في الجذر)
  enableSync(db, 'ACC-A');
  addProperty(db, { name: 'عقار الحساب أ المصطنع' });
  const pwA = 'كلمة-مرور-أ-المصطنعة';
  kv.set('aqari_backup_password', pwA);
  fs.writeFileSync(path.join(env.root, 'backup-password.flag'), '1');
  // ثم دخل B على الجهاز نفسه (رُكنت نسخة A) · كل هذا قبل التحديث
  expect(switchTo(env, 'ACC-B')).toBe('switched');
  enableSync(db, 'ACC-B');
  expect(activeAccount(db)).toBe('ACC-B');

  // يصل التحديث (1f21568) وB هو الداخل: أول ما يطلبه (settings.tsx: useEffect → backupSecretKind(account)) يأخذ السرّ القديم
  const kindB = await backupSecretKind(activeAccount(db));
  const sealB = await backupSecretForSealing(activeAccount(db)).catch((e: Error) => e.name);
  // ويعود A
  expect(switchTo(env, 'ACC-A')).toBe('switched');
  expect(activeAccount(db)).toBe('ACC-A');
  const kindA = await backupSecretKind('ACC-A');
  const triedForA = await getBackupPasswords('ACC-A');
  // eslint-disable-next-line no-console
  console.log('F6 · B بعد التحديث:', kindB, '· يختم نسخه بكلمة A:', sealB === pwA, '· A بعد عودته:', kindA, '· ما يُجرَّب لنسخ A القديمة:', triedForA);

  // D١: لا يختم B بسرٍّ لم يضعه · والنسخ القديمة تبقى تُفتح لصاحبها تلقائياً على جهازه
  expect(sealB).not.toBe(pwA);
  expect(triedForA).toContain(pwA);
  env.close();
});

test('F7 · «والنسخ السابقة تُفتح على هذا الجهاز تلقائياً» لا تصدق بعد المفتاح السادس: يُنسى أقدم سرٍّ (KEEP_PREVIOUS = 5)', async () => {
  disk.root = tempDir('aqari-auditF-prev-').replace(/\\/g, '/');
  dirs.push(disk.root);
  // كلمة مرورٍ قديمة وضعها المستخدم قبل المفاتيح، ونسخٌ كثيرة مشفّرة بها
  kv.set('aqari_backup_password', 'كلمة-قديمة-مصطنعة');
  fs.writeFileSync(path.join(disk.root, 'backup-password.flag'), '1');
  expect(await backupSecretKind('ACC-P')).toBe('password');
  const keys: string[] = [];
  for (let i = 0; i < 6; i++) {
    const k = newRecoveryKey();
    keys.push(k);
    await saveRecoveryKey(k, 'ACC-P'); // كل مرةٍ «مفتاح جديد» بتحذير replaceBody نفسه
  }
  const tried = await getBackupPasswords('ACC-P');
  // eslint-disable-next-line no-console
  console.log('F7 · عدد ما يُجرَّب تلقائياً:', tried.length, '· فيه كلمة المرور القديمة:', tried.includes('كلمة-قديمة-مصطنعة'),
    '· وفيه المفتاح الأول:', tried.includes(sealingSecretOf(keys[0])));
  expect(tried).toContain('كلمة-قديمة-مصطنعة');
});

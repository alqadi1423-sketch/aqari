/**
 * المدقق الخارجي H · الجولة الرابعة · السرّ القديم الواحد للجهاز بعد إصلاح F٦ كما هو في 97d0beb.
 * قرار المالك 2026-11-07 «تشفير النسخ الاحتياطي إجبارياً مع مفتاح استرداد يظهر مرة» · والنسخ القديمة تبقى تُستعاد.
 * DESIGN §١٣.١٨ ج: «السرّ القديم الواحد للجهاز لا يأخذه حساب: يُجرَّب عند الاستعادة لكل حساب» · وar.json (backup.key.fromPassword):
 * «كلمة المرور القديمة تبقى على هذا الجهاز تفتح نسخك السابقة».
 *
 * لكن تفريغ الجهاز من **حسابٍ واحد** (src/services/deviceReset.ts:37 → clearBackupSecretForReset(account)) يمحو السرّ القديم المشترك
 * (src/services/backupPassword.ts:112: LEGACY_KEY في قائمة المحو)، والحساب الآخر نسخته مركونةٌ على الجهاز نفسه وما زال يحتاجه.
 * قبل الإصلاح (2847c51) كان صاحب الحساب الذي فتح الإعدادات بعد التحديث قد أخذه إلى خانته فيسلم منه · بعده لا يأخذه أحد فيُمحى للجميع.
 * بيانات مصطنعة · المخزن الآمن في الذاكرة والقرص مجلد مؤقت.
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
import { backupSecretKind, getBackupPasswords, clearBackupSecretForReset } from '@/services/backupPassword';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });
beforeEach(() => { kv.clear(); });

test('H4 · «حذف حسابي» من الحساب B يمحو كلمة المرور القديمة التي وضعها A (ونسخته مركونةٌ على الجهاز): نسخ A القديمة لا تُفتح تلقائياً بعدها', async () => {
  disk.root = tempDir('aqari-auditH-legacy-').replace(/\\/g, '/');
  dirs.push(disk.root);
  // قبل التحديث: A وضع كلمة مرور النسخ (السرّ الواحد للجهاز وعلامته) ونسخٌ كثيرة له مشفّرة بها
  const pwA = 'كلمة-مرور-أ-المصطنعة';
  kv.set('aqari_backup_password', pwA);
  fs.writeFileSync(path.join(disk.root, 'backup-password.flag'), '1');

  // بعد التحديث يفتح A الإعدادات (settings.tsx:207 useEffect → backupSecretKind) ويستعيد إحدى نسخه القديمة (getBackupPasswords)
  const kindA0 = await backupSecretKind('ACC-A');
  const triedA0 = await getBackupPasswords('ACC-A');
  expect(triedA0).toContain(pwA);

  // ثم يدخل B على الجهاز نفسه (تُركن نسخة A مقفلة · accountSlots.parkActive) ويحذف حسابه: resetDeviceData يقرأ uid الحساب الداخل
  // (B) ويستدعي clearBackupSecretForReset(account) · deviceReset.ts:22 و:37
  await clearBackupSecretForReset('ACC-B');

  // يعود A إلى نسخته المركونة
  const kindA = await backupSecretKind('ACC-A');
  const triedA = await getBackupPasswords('ACC-A');
  // eslint-disable-next-line no-console
  console.log('H4 · A قبل حذف B:', kindA0, triedA0.length, 'سرّ · وبعده:', kindA, '· ما يُجرَّب لنسخ A القديمة:', triedA,
    '· وعلامة الجهاز القديمة باقية:', fs.existsSync(path.join(disk.root, 'backup-password.flag')));
  expect(triedA).toContain(pwA);
  expect(kindA).toBe(kindA0);
});

test('H4 · وحين لا يبقى على الجهاز حسابٌ غيره يُمحى السرّ القديم معه (dropLegacy من deviceReset)', async () => {
  disk.root = tempDir('aqari-auditH-legacy2-').replace(/\\/g, '/');
  dirs.push(disk.root);
  kv.set('aqari_backup_password', 'كلمة-مصطنعة');
  fs.writeFileSync(path.join(disk.root, 'backup-password.flag'), '1');
  await clearBackupSecretForReset('ACC-B', true);
  expect(kv.has('aqari_backup_password')).toBe(false);
  expect(fs.existsSync(path.join(disk.root, 'backup-password.flag'))).toBe(false);
  expect(await getBackupPasswords('ACC-A')).toEqual([]);
});

test('H4 · deviceReset يمرّر المحو بحسب الحسابات المركونة على الجهاز', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'deviceReset.ts'), 'utf8');
  expect(src).toMatch(/clearBackupSecretForReset\(account, !others\)/);
  expect(src).toMatch(/expoFs\.list\(dir\)\.some\(\(n\) => n !== mine && expoFs\.exists\(joinPath\(dir, n, 'aqari\.db'\)\)\)/);
});

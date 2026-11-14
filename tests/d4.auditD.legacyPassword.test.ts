/**
 * أُصلح في الجولة نفسها (D٢): السرّ السابق يُحفظ ويُجرَّب عند الاستعادة · والسرّ لكل حساب (D١) فيُمرَّر الحساب.
 * المدقق الخارجي D · الجولة الثانية · كلمة المرور القديمة تُنسى عند إنشاء المفتاح.
 *
 * قبل feb6ceb كانت كلمة مرور النسخ محفوظةً في المخزن الآمن، والاستعادة تجرّبها أولاً بلا سؤال (settings.tsx: restorePassword) ·
 * وsaveRecoveryKey يكتب المفتاح فوقها في الخانة نفسها (KEY = 'aqari_backup_password') ولا يُبقي منها شيئاً، وورقة المفتاح في حال
 * «كلمة مرور قديمة» تعرض «إنشاء مفتاح الاسترداد» مباشرةً بلا تحذيرٍ (تحذير replaceBody في فرع «مفتاح جديد» وحده) · فنسخ Drive والملفات
 * المشفّرة بالكلمة القديمة لا يفتحها بعد ذلك شيءٌ على الجهاز، وتحتاج كلمةً لم يُطلب من المستخدم كتابتها منذ وضعها.
 * بيانات مصطنعة.
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
    constructor(_dir: unknown, name: string) { this.p = np.join(disk.root, name); }
    get exists() { return nfs.existsSync(this.p); }
    write(s: string) { nfs.writeFileSync(this.p, s); }
    delete() { nfs.rmSync(this.p); }
    textSync() { return nfs.readFileSync(this.p, 'utf8'); }
  }
  return { File: F, Paths: { document: {} } };
});
jest.mock('expo-crypto', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getRandomBytes: (n: number) => new Uint8Array(require('node:crypto').randomBytes(n)),
}));

import { tempDir, rmrf } from './helpers/testDb';
import { newRecoveryKey, saveRecoveryKey, getBackupPasswords, backupSecretKind } from '@/services/backupPassword';
import { encryptArchive, decryptArchive } from '@/domain/backup/encryption';
import { nodeCipher } from '@/files/nodeCipher';

afterAll(() => rmrf(disk.root));

test('بعد إنشاء المفتاح تبقى على الجهاز وسيلةٌ تفتح النسخ المشفّرة بكلمة المرور القديمة', async () => {
  disk.root = tempDir('aqari-auditD-legacy-');
  // جهازٌ وُضعت عليه كلمة مرورٍ قبل feb6ceb (والعلامة «1»)
  kv.set('aqari_backup_password', 'كلمة-قديمة-مصطنعة');
  fs.writeFileSync(path.join(disk.root, 'backup-password.flag'), '1');
  expect(await backupSecretKind('ACC-OLD')).toBe('password');
  const old = await encryptArchive(new TextEncoder().encode('نسخة Drive قديمة مصطنعة'), 'كلمة-قديمة-مصطنعة', nodeCipher, { iterations: 1000 });
  // قبل المفتاح: الاستعادة تفتحها بالمحفوظ بلا سؤال
  expect(new TextDecoder().decode(await decryptArchive(old, (await getBackupPasswords('ACC-OLD'))[0], nodeCipher))).toContain('قديمة');

  // ينشئ المستخدم المفتاح (الورقة في حال 'password' لا تحذّر)
  await saveRecoveryKey(newRecoveryKey(), 'ACC-OLD');
  expect(await backupSecretKind('ACC-OLD')).toBe('key');
  // بعد الإصلاح: الأسرار المحفوظة الحالي ثم السابق، والاستعادة تجرّبها كلها بلا سؤال
  const stored = await getBackupPasswords('ACC-OLD');
  let opened = false;
  for (const pw of stored) if (await decryptArchive(old, pw, nodeCipher).then(() => true, () => false)) opened = true;
  expect(stored).toHaveLength(2);
  // eslint-disable-next-line no-console
  console.log('المحفوظ بعد المفتاح يفتح النسخة القديمة:', opened, '· أبقى الجهاز الكلمة القديمة:', [...kv.values()].includes('كلمة-قديمة-مصطنعة'));

  const ui = fs.readFileSync(path.join(__dirname, '..', 'app/settings.tsx'), 'utf8');
  const createBranch = ui.slice(ui.indexOf(") : secretKind === 'key' ? ("), ui.indexOf('</Sheet>', ui.indexOf(") : secretKind === 'key' ? (")));
  const warnsInCreate = /replaceBody|oldPassword|كلمة المرور القديمة/.test(createBranch.slice(createBranch.lastIndexOf(') : (')));
  // eslint-disable-next-line no-console
  console.log('تحذيرٌ في فرع «إنشاء» لحال كلمة المرور القديمة:', warnsInCreate);

  expect(opened || [...kv.values()].includes('كلمة-قديمة-مصطنعة')).toBe(true);
});

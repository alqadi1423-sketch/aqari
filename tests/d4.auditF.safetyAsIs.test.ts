/**
 * المدقق الخارجي F · الجولة الثالثة · نسخة الأمان «كما هي» (D٣ · 1f21568).
 * create.ts (CreateBackupOptions.asIs): «نسخةٌ تلقائية تحفظ الحال كما هي لتُرجع إليها، فلا يمنعها ملفٌ مفقود أو فحصٌ متعذّر (كانت ترفض
 * فتُلغى استعادة نسخة ما قبل الترقية الناقصة)» · لكن تعذّر حساب بصمة مرفقٍ (أو قراءته) ما زال يرمي في النسخة المتسامحة، فتُلغى الاستعادة.
 * بيانات مصطنعة.
 */
import { createHash } from 'crypto';
import { tempDir, rmrf } from './helpers/testDb';
import { makeBackupEnv } from './helpers/backupEnv';
import { putAttachment } from '@/files/store';
import { createBackup, makeSafetyBackup } from '@/domain/backup/create';
import { prepareRestore, commitRestore } from '@/domain/backup/restore';
import { addProperty } from './helpers/fixtures';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmrf(d); });

test('F10 · فحصٌ متعذّر لمرفقٍ واحد (تعذّر حساب بصمته) يمنع نسخة الأمان «كما هي» فتُلغى استعادة نسخةٍ سليمة', async () => {
  // نسخةٌ سليمة من جهازٍ آخر يريد المستخدم استعادتها
  const other = makeBackupEnv(tempDir('aqari-auditF-src-'));
  dirs.push(other.root);
  addProperty(other.db, { name: 'عقار النسخة السليمة المصطنع' });
  const good = other.root + '/good.aqbk';
  await createBackup(other, good);

  // الجهاز الحالي: بياناته ومرفقٌ يتعذّر حساب بصمته (قراءةٌ تفشل أو ملفٌ يتعذّر على المجزِّئ)
  const env = makeBackupEnv(tempDir('aqari-auditF-live-'));
  dirs.push(env.root);
  addProperty(env.db, { name: 'عقار الجهاز الحالي المصطنع' });
  const bad = new Uint8Array(256).fill(7);
  await putAttachment(env.filesEnv, bad, { entityType: 'library', kind: 'other', originalName: 'مرفق.bin' });
  const badSha = createHash('sha256').update(bad).digest('hex');
  const realHasher = env.hasher!;
  env.hasher = async (b: Uint8Array) => {
    if (createHash('sha256').update(b).digest('hex') === badSha) throw new Error('EIO: i/o error');
    return realHasher(b);
  };

  // نسخة الأمان «كما هي» وحدها
  const safety = await makeSafetyBackup(env, 'pre-restore').then(() => 'ok', (e: Error) => e.name + ': ' + e.message);
  // والاستعادة كلها (المراحل ٥-٧ تبدأ بنسخة الأمان)
  let restored = 'ok';
  try {
    const prep = await prepareRestore(env, good);
    await commitRestore(env, prep);
  } catch (e) { restored = (e as Error).name + ': ' + (e as Error).message; }
  // eslint-disable-next-line no-console
  console.log('F10 · نسخة الأمان كما هي:', safety, '· الاستعادة:', restored);
  expect(safety).toBe('ok');
  expect(restored).toBe('ok');
});
